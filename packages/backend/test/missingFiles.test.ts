import { DEFAULT_LIMITS, type FileCheckPageResponse, type LeasedJob, type LibraryRootState } from '@omnarr/contracts';
import { parseRelease } from '@omnarr/parser';
import { beforeEach, describe, expect, test } from 'vite-plus/test';

import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import { recomputeUnits } from '../convex/lib/derivedState';
import { enqueueFileCheck, resolveFileMissingOnceAFileOfItPlays as primaryVisible } from '../convex/library/missingFiles';
import { retireOldVersions, start } from '../convex/pipeline/preparation';
import { playablePrimary } from '../convex/pipeline/upgrades';
import { prepareWorker, SERIES_ROOT, seedFile, seedShow, seedUnit, WEBDL_PATH, WEBDL_RELEASE } from './fakePrepare';
import { seedIndexer, seedLibraries, setup, worker, type Backend, type Libraries } from './setup';

let t: Backend;
let libraries: Libraries;
let workId: Id<'works'>;
let unitId: Id<'units'>;
let sessionId: Id<'workerSessions'>;

beforeEach(async () => {
  t = setup();
  libraries = await seedLibraries(t);
  workId = await seedShow(t, libraries);
  unitId = await seedUnit(t, workId, 2, 'Pilot');
  sessionId = (await prepareWorker(t)).sessionId;
});

const unit = () => t.run((ctx) => ctx.db.get(unitId));
const file = (fileId: Id<'files'>) => t.run((ctx) => ctx.db.get(fileId));
const openIssues = () => t.run(async (ctx) => (await ctx.db.query('issues').collect()).filter((issue) => issue.state === 'open'));
const jobsOf = async (cls: string) => (await t.run((ctx) => ctx.db.query('jobs').collect())).filter((job) => job.class === cls);

async function publishedFittingPrimary(path = WEBDL_PATH): Promise<Id<'files'>> {
  const { fileId } = await seedFile(t, { unitIds: [unitId], path, fits: true });
  await t.run((ctx) => recomputeUnits(ctx, [unitId]));
  expect((await unit())!.derivedState).toBe('ready');
  return fileId;
}

const moveFirstMissAnHourBack = (fileId: Id<'files'>) =>
  t.run(async (ctx) => {
    const row = (await ctx.db.get(fileId))!;
    await ctx.db.patch(fileId, { missingSeenAt: row.missingSeenAt! - DEFAULT_LIMITS.fileMissingConfirmMs });
  });

async function runCheckAsTheWorker(
  options: { missing?: string[]; roots?: Partial<Record<'series' | 'movies', LibraryRootState>>; goneFolders?: string[] } = {},
): Promise<void> {
  await t.run((ctx) => enqueueFileCheck(ctx));
  const claimed: LeasedJob[] = await t.mutation(api.jobs.queue.claim, { ...worker, sessionId, class: 'maintenance', max: 5 });
  const job = claimed.find((leased) => leased.payload.class === 'maintenance' && leased.payload.action === 'checkLibraryFiles')!;
  if (job.payload.class !== 'maintenance' || job.payload.action !== 'checkLibraryFiles') throw new Error('no check job');
  const lease = { jobId: job.jobId, leaseEpoch: job.leaseEpoch };
  const states = [];
  for (const root of job.payload.roots) {
    const state = options.roots?.[root.libraryId === libraries.series ? 'series' : 'movies'] ?? 'available';
    const gone = root.libraryId === libraries.series ? options.goneFolders : undefined;
    states.push({
      libraryId: root.libraryId,
      state,
      ...(state === 'mostMissing' ? { checkedWhenMostMissing: 4, missingWhenMostMissing: 3 } : {}),
      ...(state === 'available' && gone ? { goneFolders: gone } : {}),
    });
    if (state !== 'available') continue;
    let cursor: string | null = null;
    for (;;) {
      const page: FileCheckPageResponse = await t.mutation(api.library.missingFiles.page, { ...worker, ...lease, root: root.path, cursor });
      const verdicts = page.files.map((row) => ({ ...row, verdict: options.missing?.includes(row.path) ? ('missing' as const) : ('present' as const) }));
      if (verdicts.length) await t.mutation(api.library.missingFiles.report, { ...worker, ...lease, verdicts });
      if (page.done) break;
      cursor = page.cursor;
    }
  }
  await t.mutation(api.jobs.queue.complete, {
    ...worker,
    ...lease,
    result: { class: 'maintenance', action: 'checkLibraryFiles', checked: 0, missing: 0, roots: states },
  });
}

describe('a tracked file that is gone', () => {
  test('one miss changes nothing, nor does a second within the hour; one an hour later stops it playing, raises fileMissing with a search, deletes nothing and shows on the Files tab', async () => {
    const fileId = await publishedFittingPrimary();
    await runCheckAsTheWorker({ missing: [WEBDL_PATH] });
    expect((await file(fileId))!.missingSeenAt).toBeTypeOf('number');
    expect((await file(fileId))!.missingSince).toBeUndefined();
    expect((await unit())!.derivedState).toBe('ready');

    await runCheckAsTheWorker({ missing: [WEBDL_PATH] });
    expect((await file(fileId))!.missingSince).toBeUndefined();

    await moveFirstMissAnHourBack(fileId);
    await runCheckAsTheWorker({ missing: [WEBDL_PATH] });
    expect((await file(fileId))!.missingSince).toBeTypeOf('number');
    expect((await unit())!.derivedState).toBe('failed');
    expect(await t.run((ctx) => playablePrimary(ctx, unitId))).toBeNull();
    const [issue] = await openIssues();
    expect(issue).toMatchObject({ failureCode: 'fileMissing', unitId, fixActions: ['tryNextBest', 'searchAndPick', 'dismiss'] });
    expect(issue!.detail).toContain(WEBDL_PATH);
    expect(
      await jobsOf('maintenance').then((jobs) => jobs.filter((job) => job.payload?.class === 'maintenance' && job.payload.action === 'deleteLibraryFiles')),
    ).toEqual([]);

    const { files } = await itemPageFileRows();
    expect(files[0]).toMatchObject({ fileId, missingSince: expect.any(Number) });
  });

  test('a miss that the next check finds present again is forgotten: the miss after that starts over', async () => {
    const fileId = await publishedFittingPrimary();
    await runCheckAsTheWorker({ missing: [WEBDL_PATH] });
    await runCheckAsTheWorker();
    expect((await file(fileId))!.missingSeenAt).toBeUndefined();
    await runCheckAsTheWorker({ missing: [WEBDL_PATH] });
    expect((await file(fileId))!.missingSince).toBeUndefined();
  });

  test('a Unit that still plays another file: the file is missing, but no Issue offers a new release', async () => {
    const fileId = await publishedFittingPrimary();
    const other = WEBDL_PATH.replace('-GRP', '-ALT');
    await seedFile(t, { unitIds: [unitId], path: other, fits: true });
    await runCheckAsTheWorker({ missing: [WEBDL_PATH] });
    await moveFirstMissAnHourBack(fileId);
    await runCheckAsTheWorker({ missing: [WEBDL_PATH] });
    expect((await file(fileId))!.missingSince).toBeTypeOf('number');
    expect(await openIssues()).toEqual([]);
    expect((await unit())!.derivedState).toBe('ready');
  });
});

describe('too many files missing at once', () => {
  test('a mostMissing root (the worker’s mass-miss rule) marks nothing and raises libraryUnavailable with its counts', async () => {
    const fileId = await publishedFittingPrimary();
    await runCheckAsTheWorker({ roots: { series: 'mostMissing' } });
    await runCheckAsTheWorker({ roots: { series: 'mostMissing' } });
    expect((await file(fileId))!.missingSeenAt).toBeUndefined();
    expect(await openIssues()).toMatchObject([
      { failureCode: 'libraryUnavailable', detail: expect.stringContaining(`${SERIES_ROOT} has too many files missing at once (3 of 4).`) },
    ]);
  });

  test('a wholly gone folder in an available root names the folder and how to clear it, names five of six and counts the rest, and resolves once none is gone; the misses the worker sent still count', async () => {
    const fileId = await publishedFittingPrimary();
    const gone = `${SERIES_ROOT}/Old Show (2015)`;
    await runCheckAsTheWorker({ goneFolders: [gone], missing: [WEBDL_PATH] });
    await moveFirstMissAnHourBack(fileId);
    await runCheckAsTheWorker({ goneFolders: [gone], missing: [WEBDL_PATH] });
    const issues = await openIssues();
    expect(issues.map((issue) => issue.failureCode).sort()).toEqual(['fileMissing', 'libraryUnavailable']);
    const detail = issues.find((issue) => issue.failureCode === 'libraryUnavailable')!.detail!;
    expect(detail).toContain(`Every file under this folder is gone: ${gone}.`);
    expect(detail).toContain('If the share is down, bring it back. If you removed them on purpose, delete the series or movie in omnarr.');

    await runCheckAsTheWorker({ goneFolders: [1, 2, 3, 4, 5, 6].map((n) => `${SERIES_ROOT}/Gone ${n}`), missing: [WEBDL_PATH] });
    expect((await openIssues()).find((issue) => issue.failureCode === 'libraryUnavailable')!.detail).toContain(`${SERIES_ROOT}/Gone 5 and 1 more.`);
    await runCheckAsTheWorker({ missing: [WEBDL_PATH] });
    expect((await openIssues()).map((issue) => issue.failureCode)).toEqual(['fileMissing']);
  });
});

describe('a root that can’t be trusted', () => {
  for (const state of ['missing', 'empty', 'otherDevice', 'unreadable', 'mostMissing'] as const)
    test(`a ${state} Series root marks nothing and raises libraryUnavailable; the next good check resolves it`, async () => {
      const fileId = await publishedFittingPrimary();
      await runCheckAsTheWorker({ roots: { series: state } });
      await runCheckAsTheWorker({ roots: { series: state } });
      expect((await file(fileId))!.missingSeenAt).toBeUndefined();
      expect((await unit())!.derivedState).toBe('ready');
      const [issue] = await openIssues();
      expect(issue).toMatchObject({ failureCode: 'libraryUnavailable', scope: 'system', fixActions: [] });
      expect(issue!.detail).toContain(SERIES_ROOT);
      expect(issue!.detail).toContain('Is the media share mounted?');

      await runCheckAsTheWorker();
      expect(await openIssues()).toEqual([]);
    });

  test('an empty root that holds no tracked file (a new install) raises nothing', async () => {
    await runCheckAsTheWorker({ roots: { series: 'empty', movies: 'missing' } });
    expect(await openIssues()).toEqual([]);
  });
});

describe('a file that may be moving', () => {
  const twoMisses = async (fileId: Id<'files'>) => {
    await runCheckAsTheWorker({ missing: [WEBDL_PATH] });
    await t.run((ctx) => ctx.db.patch(fileId, { missingSeenAt: Date.now() - DEFAULT_LIMITS.fileMissingConfirmMs }));
    await runCheckAsTheWorker({ missing: [WEBDL_PATH] });
  };

  test('a Unit with a running Grab', async () => {
    const fileId = await publishedFittingPrimary();
    const indexerId = await seedIndexer(t);
    await t.run(async (ctx) => {
      const searchAttemptId = await ctx.db.insert('searchAttempts', {
        unitIds: [unitId],
        wantedUnitIds: [unitId],
        workId,
        groupKind: 'episode',
        trigger: 'upgrade',
        state: 'picked',
        indexerResults: [],
      });
      const candidateId = await ctx.db.insert('candidates', {
        searchAttemptId,
        indexerId,
        guid: 'g',
        title: WEBDL_RELEASE,
        downloadUrl: 'https://indexer.fake/get/g',
        sizeBytes: 1,
        protocol: 'usenet',
        publishedAt: 0,
        parsed: parseRelease(WEBDL_RELEASE, 'series'),
        unitIds: [unitId],
        alsoContainsUnitIds: [],
        quality: 'webdl-1080p',
        qualityRank: 1,
        qualityAssumed: false,
        baseScore: 0,
        score: 0,
        scoreBreakdown: [],
        preparationStep: 'none',
        preparationAssumed: false,
        outcome: 'picked',
      });
      const grabId = await ctx.db.insert('grabs', { candidateId, protocol: 'usenet', state: 'importing', kind: 'upgrade', cancelRequested: false });
      await ctx.db.patch(unitId, { activeGrabId: grabId });
    });
    await twoMisses(fileId);
    expect((await file(fileId))!.missingSince).toBeUndefined();
  });

  test('a file with a pending Rendition or a staged version', async () => {
    const fileId = await publishedFittingPrimary();
    await t.run((ctx) => start(ctx, fileId, 'import'));
    await twoMisses(fileId);
    expect((await file(fileId))!.missingSince).toBeUndefined();

    const staged = WEBDL_PATH.replace('.mkv', '.mp4');
    const { fileId: stagedId } = await seedFile(t, { unitIds: [unitId], path: staged, kind: 'staged', published: false });
    await runCheckAsTheWorker({ missing: [staged] });
    await t.run((ctx) => ctx.db.patch(stagedId, { missingSeenAt: Date.now() - DEFAULT_LIMITS.fileMissingConfirmMs }));
    await runCheckAsTheWorker({ missing: [staged] });
    expect((await file(stagedId))!.missingSince).toBeUndefined();
  });

  test('a file a queued rename is moving', async () => {
    const fileId = await publishedFittingPrimary();
    await t.run((ctx) =>
      ctx.db.insert('jobs', {
        class: 'maintenance',
        status: 'queued',
        attempt: 0,
        maxAttempts: 3,
        leaseEpoch: 0,
        protocolVersion: 3,
        cancelRequested: false,
        idempotencyKey: 'rename',
        payload: { class: 'maintenance', action: 'renameLibraryFile', fileId, from: WEBDL_PATH, to: `${WEBDL_PATH}.new`, sidecars: [] },
      } as never),
    );
    await twoMisses(fileId);
    expect((await file(fileId))!.missingSince).toBeUndefined();
  });

  test('a verdict about a path the file has left since its page was handed out (moved before the report) is ignored', async () => {
    const fileId = await publishedFittingPrimary();
    await runCheckAsTheWorker({ missing: [WEBDL_PATH] });
    await t.run((ctx) => ctx.db.patch(fileId, { missingSeenAt: Date.now() - DEFAULT_LIMITS.fileMissingConfirmMs }));
    await t.run((ctx) => enqueueFileCheck(ctx));
    const [job] = (await t.mutation(api.jobs.queue.claim, { ...worker, sessionId, class: 'maintenance', max: 1 })) as LeasedJob[];
    const lease = { jobId: job!.jobId, leaseEpoch: job!.leaseEpoch };
    const page = await t.mutation(api.library.missingFiles.page, { ...worker, ...lease, root: SERIES_ROOT, cursor: null });
    await t.run((ctx) => ctx.db.patch(fileId, { path: `${WEBDL_PATH}.moved` }));
    await t.mutation(api.library.missingFiles.report, { ...worker, ...lease, verdicts: page.files.map((row) => ({ ...row, verdict: 'missing' as const })) });
    expect((await file(fileId))!.missingSince).toBeUndefined();
  });
});

describe('a missing file that comes back', () => {
  test('clears the state, resolves the Issue and publishes the file again', async () => {
    const fileId = await publishedFittingPrimary();
    await runCheckAsTheWorker({ missing: [WEBDL_PATH] });
    await moveFirstMissAnHourBack(fileId);
    await runCheckAsTheWorker({ missing: [WEBDL_PATH] });
    expect((await unit())!.derivedState).toBe('failed');

    await runCheckAsTheWorker();
    expect((await file(fileId))!.missingSince).toBeUndefined();
    expect(await openIssues()).toEqual([]);
    expect((await unit())!.derivedState).toBe('ready');
    const [publish] = await jobsOf('publish');
    expect(publish!.payload).toMatchObject({ class: 'publish', items: [{ path: WEBDL_PATH }] });
  });
});

describe('a new release for a missing file', () => {
  const FRESH = WEBDL_PATH.replace('-GRP', '-NEW');
  const deletes = async () =>
    (await jobsOf('maintenance')).filter((job) => job.payload?.class === 'maintenance' && job.payload.action === 'deleteLibraryFiles');
  const missingThenFresh = async () => {
    const fileId = await publishedFittingPrimary();
    await runCheckAsTheWorker({ missing: [WEBDL_PATH] });
    await moveFirstMissAnHourBack(fileId);
    await runCheckAsTheWorker({ missing: [WEBDL_PATH] });
    const { fileId: freshId } = await seedFile(t, { unitIds: [unitId], path: FRESH, fits: true });
    return { fileId, freshId };
  };

  test('once the new primary plays, the Issue resolves and the missing file stays: nothing is deleted', async () => {
    const { fileId, freshId } = await missingThenFresh();
    await t.run((ctx) => primaryVisible(ctx, unitId, freshId));
    expect(await openIssues()).toEqual([]);
    expect((await file(fileId))!.missingSince).toBeTypeOf('number');
    expect(await deletes()).toEqual([]);
  });

  test('a prepared or upgrade file becoming primary (retireOldVersions) leaves a missing primary alone', async () => {
    const { fileId, freshId } = await missingThenFresh();
    await t.run((ctx) => retireOldVersions(ctx, unitId, freshId));
    expect(await file(fileId)).not.toBeNull();
    const versions = await t.run((ctx) =>
      ctx.db
        .query('fileVersions')
        .withIndex('by_file', (q) => q.eq('fileId', fileId))
        .collect(),
    );
    expect(versions.map((version) => version.kind)).toEqual(['primary']);
    expect(await deletes()).toEqual([]);
  });

  test('the missing file coming back beside the new primary is kept as an alternate, not published: one primary plays', async () => {
    const { fileId, freshId } = await missingThenFresh();
    await t.run((ctx) => primaryVisible(ctx, unitId, freshId));
    await runCheckAsTheWorker();
    expect((await file(fileId))!.missingSince).toBeUndefined();
    const versions = await t.run((ctx) =>
      ctx.db
        .query('fileVersions')
        .withIndex('by_unit', (q) => q.eq('unitId', unitId))
        .collect(),
    );
    expect(versions.map((version) => [version.fileId, version.kind])).toEqual([
      [fileId, 'alternate'],
      [freshId, 'primary'],
    ]);
    const publications = await t.run((ctx) => ctx.db.query('publications').collect());
    expect(publications.map((publication) => publication.fileVersionId)).toEqual([versions[1]!._id]);
    expect(await jobsOf('publish')).toEqual([]);
    expect(await deletes()).toEqual([]);
    expect((await unit())!.derivedState).toBe('ready');
  });
});

async function itemPageFileRows() {
  return { files: await t.run(async (ctx) => (await import('../convex/api/units')).filesOf(ctx, (await ctx.db.get(unitId))!, (await ctx.db.get(workId))!)) };
}
