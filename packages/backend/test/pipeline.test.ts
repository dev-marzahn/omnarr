// The Grab run end to end: from the subscribe search against
// the Newznab fake, through a fake worker that submits, downloads, imports
// and publishes, to the Unit's state: a subscribed episode reaching a
// published file (minus preparation), and a bad release recovering by itself.
import { createNewznabHandler, type FakeItem, type NewznabHandler } from '@omnarr/e2e/fakes/newznab';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';

import { api, internal } from '../convex/_generated/api';
import type { Doc, Id } from '../convex/_generated/dataModel';
import { recomputeUnits } from '../convex/lib/derivedState';
import { fakeWorker, FITTING_PROBE, WEB_DL_PROBE, type FakeWorker } from './fakeWorker';
import { asAdmin, INDEXER_KEY, seedIndexer, seedLibraries, settleSearches, setup, useFetchFakes, type Backend, type Libraries } from './setup';

const release = (guid: string, title: string, extra: Partial<FakeItem> = {}): FakeItem => ({
  guid,
  title,
  categories: [5000, 5040],
  sizeBytes: 1_500_000_000,
  publishedAt: '2026-11-10T18:30:00Z',
  ids: { tvdbid: '7700001' },
  ...extra,
});

/** Fits the default target (H.264, AAC 2.0) apart from its container. */
const E1 = release('s1e1', 'Harbour.Lights.S01E01.1080p.WEB-DL.AAC2.0.H.264-GRPB');

let t: Backend;
let admin: Awaited<ReturnType<typeof asAdmin>>;
let libraries: Libraries;
let fake: NewznabHandler;

beforeEach(async () => {
  vi.useFakeTimers();
  t = setup();
  admin = await asAdmin(t);
  libraries = await seedLibraries(t);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function indexer(items: FakeItem[]) {
  fake = createNewznabHandler({ apiKey: INDEXER_KEY, items });
  useFetchFakes({ indexers: { 'indexer.fake': fake.handle } });
  return seedIndexer(t);
}

async function subscribe(seasons = [1]): Promise<Id<'works'>> {
  const { workId } = await admin.action(api.api.library.subscribe, {
    tmdbId: '900001',
    kind: 'series',
    libraryId: libraries.series,
    releaseProfileId: libraries.releaseProfileId,
    seasons,
  });
  await settleSearches(t);
  return workId;
}

const all = <T extends 'grabs' | 'downloads' | 'jobs' | 'importJobs' | 'files' | 'fileUnits' | 'fileVersions' | 'publications' | 'issues' | 'blocklist'>(
  table: T,
) => t.run((ctx) => ctx.db.query(table).collect()) as Promise<Doc<T>[]>;

const unit = async (workId: Id<'works'>, season: number, episode: number): Promise<Doc<'units'>> =>
  (await t.run((ctx) =>
    ctx.db
      .query('units')
      .withIndex('by_work_tmdb', (q) => q.eq('workId', workId).eq('tmdbSeason', season).eq('tmdbEpisode', episode))
      .first(),
  ))!;

/** Runs the scheduled work (the workflow's steps and the searches) to its end. */
const settle = () => settleSearches(t);

describe('a subscribed episode reaches a published file (minus preparation)', () => {
  let w: FakeWorker;
  let workId: Id<'works'>;

  beforeEach(async () => {
    await indexer([E1]);
    workId = await subscribe();
    w = await fakeWorker(t);
  });

  const downloadId = async () => (await all('downloads'))[0]!._id;

  test("the submit names the candidate's indexer, so a failed fetch can say where it came from", async () => {
    const [job] = await w.claim('download.submit');
    expect(job!.payload).toMatchObject({ indexerName: 'indexer.fake', releaseTitle: E1.title, source: { kind: 'nzbUrl' } });
  });

  test('a deleted indexer is named Removed', async () => {
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query('indexers').collect()) await ctx.db.delete(row._id);
      for (const row of await ctx.db.query('jobs').collect()) await ctx.db.delete(row._id);
      const grab = (await ctx.db.query('grabs').first())!;
      for (const row of await ctx.db.query('downloads').collect()) await ctx.db.delete(row._id);
      await ctx.runMutation(internal.pipeline.steps.submitDownload, { grabId: grab._id });
    });
    const [job] = await w.claim('download.submit');
    expect(job!.payload).toMatchObject({ indexerName: 'Removed' });
  });

  test('the client accepts the release: the Grab is downloading, the Unit follows the client stage', async () => {
    await w.submitAll();
    await settle();
    expect((await unit(workId, 1, 1)).derivedState).toBe('downloading');

    await w.stage(await downloadId(), 'postProcessing');
    expect((await unit(workId, 1, 1)).derivedState).toBe('repairUnpack');
    const events = (await t.run((ctx) => ctx.db.query('events').collect())).filter((e) => e.stage === 'download' && e.data?.to === 'postProcessing');
    expect(events).toHaveLength(1);
  });

  test('a completed download is imported through an import job with the Units the Grab expects', async () => {
    await w.submitAll();
    await settle();
    await w.completed(await downloadId(), '/data/downloads/usenet/series/Harbour.Lights.S01E01');
    await settle();

    const [grab] = await all('grabs');
    expect(grab!.state).toBe('importing');
    expect((await all('downloads'))[0]!.state).toBe('completed');
    expect((await unit(workId, 1, 1)).derivedState).toBe('importing');
    const [importJob] = await all('importJobs');
    const job = (await all('jobs')).find((j) => j.class === 'import')!;
    expect(importJob).toMatchObject({ grabId: grab!._id, jobId: job._id, state: 'pending', stagingPath: `/data/staging/${job._id}` });
    const candidate = (await t.run((ctx) => ctx.db.get(grab!.candidateId)))!;
    // The Work's folder is chosen at its first import and named with its TMDB ID; names come from it.
    expect((await t.run((ctx) => ctx.db.get(workId)))!.folder).toBe('Harbour Lights (2021) [tmdbid-900001]');
    expect(job.payload).toEqual({
      class: 'import',
      grabId: grab!._id,
      importJobId: importJob!._id,
      contentPath: '/data/downloads/usenet/series/Harbour.Lights.S01E01',
      workFolderPath: '/data/library/series/Harbour Lights (2021) [tmdbid-900001]',
      expectedUnits: [{ unitId: (await unit(workId, 1, 1))._id, season: 1, episode: 1, title: 'Episode 1' }],
      naming: {
        kind: 'series',
        title: 'Harbour Lights',
        year: 2021,
        tmdbId: 900001,
        anime: false,
        release: { ...candidate.parsed, quality: 'webdl-1080p' },
      },
    });
  });

  test('a title change at TMDB after the first import never changes the folder', async () => {
    await w.submitAll();
    await settle();
    await w.completed(await downloadId());
    await settle();
    // TMDB retitles the series while its first import runs.
    await t.run((ctx) => ctx.db.patch(workId, { title: 'Harbour Lights: The Return', year: 2024 }));
    await w.importAll();
    await settle();

    expect((await t.run((ctx) => ctx.db.get(workId)))!.folder).toBe('Harbour Lights (2021) [tmdbid-900001]');
    const publishJob = (await all('jobs')).find((j) => j.class === 'publish')!;
    expect(publishJob.payload).toMatchObject({ workFolderPath: '/data/library/series/Harbour Lights (2021) [tmdbid-900001]' });
  });

  test("a Work whose folder is set (by the scan, or an earlier import) keeps it, and names come from the folder's title and year", async () => {
    await t.run((ctx) => ctx.db.patch(workId, { folder: 'Harbour Lights {tvdb-7700001}', title: 'Harbour Lights: The Return' }));
    await w.submitAll();
    await settle();
    await w.completed(await downloadId());
    await settle();

    const job = (await all('jobs')).find((j) => j.class === 'import')!;
    expect((await t.run((ctx) => ctx.db.get(workId)))!.folder).toBe('Harbour Lights {tvdb-7700001}');
    expect(job.payload).toMatchObject({ workFolderPath: '/data/library/series/Harbour Lights {tvdb-7700001}' });
    expect(job.payload?.class === 'import' && job.payload.naming).toMatchObject({ title: 'Harbour Lights', tmdbId: 900001 });
    expect(job.payload?.class === 'import' && job.payload.naming.year).toBeUndefined();
  });

  test('the import half: the WEB-DL is recorded with its release and probe, fits = false by the comparison, published and playable, and the run ends done', async () => {
    await w.submitAll();
    await settle();
    await w.completed(await downloadId());
    await settle();
    await w.importAll();
    await settle();

    const e1 = await unit(workId, 1, 1);
    const [file] = await all('files');
    const [grab] = await all('grabs');
    const candidate = (await t.run((ctx) => ctx.db.get(grab!.candidateId)))!;
    expect(file).toMatchObject({
      path: '/data/library/series/Harbour Lights (2021) [tmdbid-900001]/Season 01/Harbour Lights (2021) - S01E01 [WEBDL-1080p][EAC3 5.1][h264]-GRPB.mkv',
      origin: 'download',
      role: 'source',
      candidateId: candidate._id,
      release: candidate.parsed,
      probe: WEB_DL_PROBE,
    });
    expect(await all('fileUnits')).toEqual([expect.objectContaining({ fileId: file!._id, unitId: e1._id })]);
    const [version] = await all('fileVersions');
    // E-AC-3 5.1 in Matroska with SubRip tracks: audio, subtitle and remux steps against the default target.
    expect(version).toMatchObject({ unitId: e1._id, fileId: file!._id, kind: 'primary', fits: false });
    expect(grab!.state).toBe('publishing');
    const publishJob = (await all('jobs')).find((j) => j.class === 'publish')!;
    const [pending] = await all('publications');
    expect(pending).toMatchObject({ unitId: e1._id, fileVersionId: version!._id, state: 'pending', target: 'jellyfin', generation: 0, jobId: publishJob._id });
    // The Publication is inserted before the job, whose key names it.
    expect(publishJob.idempotencyKey).toBe(`${pending!._id}:publish:0`);
    expect(publishJob.payload).toEqual({
      class: 'publish',
      publicationIds: [pending!._id],
      workFolderPath: '/data/library/series/Harbour Lights (2021) [tmdbid-900001]',
      items: [{ publicationId: pending!._id, path: file!.path }],
      library: { libraryId: libraries.series, root: '/data/library/series', kind: 'series' },
    });

    await w.publishAll();
    await settle();
    const [publication] = await all('publications');
    expect(publication).toMatchObject({ state: 'visible', targetItemRef: `jf-${publication!._id}` });
    expect((await all('grabs'))[0]!.state).toBe('done');
    expect(await t.run((ctx) => ctx.db.query('grabUnits').collect())).toEqual([expect.objectContaining({ unitId: e1._id, outcome: 'imported' })]);
    const after = await unit(workId, 1, 1);
    expect(after.activeGrabId).toBeUndefined();
    // `finish` decided to prepare the file (preparation.test.ts takes it on to "ready").
    expect(after.derivedState).toBe('preparing');
  });

  test("a file that fits the library's target is recorded fits = true by its probe, whatever its title predicted, and the Unit is ready once visible", async () => {
    await w.submitAll();
    await settle();
    await w.completed(await downloadId());
    await settle();
    // The title predicts a remux (Matroska); the file itself is an MP4 that fits.
    await w.importAll({ probe: FITTING_PROBE, files: () => [{ relPath: 'Harbour.Lights.S01E01.1080p.WEB-DL.AAC2.0.H.264-GRPB.mp4', sizeBytes: 1_000_000 }] });
    await settle();

    expect((await all('files'))[0]!.path).toBe(
      '/data/library/series/Harbour Lights (2021) [tmdbid-900001]/Season 01/Harbour Lights (2021) - S01E01 [WEBDL-1080p][AAC 2.0][h264]-GRPB.mp4',
    );
    expect((await all('fileVersions'))[0]).toMatchObject({ kind: 'primary', fits: true });
    await w.publishAll();
    await settle();
    expect((await unit(workId, 1, 1)).derivedState).toBe('ready');
    expect(await all('jobs')).not.toContainEqual(expect.objectContaining({ class: 'prepare' }));
  });

  test("a re-publish replaces the Publication's targetItemRef, because Jellyfin's item ID follows the path", async () => {
    await w.submitAll();
    await settle();
    await w.completed(await downloadId());
    await settle();
    await w.importAll({ probe: FITTING_PROBE });
    await settle();
    await w.publishAll();
    await settle();
    const [publication] = await all('publications');
    const [file] = await all('files');
    expect((await unit(workId, 1, 1)).derivedState).toBe('ready');

    // What a rename does before it enqueues: the Publication goes back to pending under a new generation.
    await t.run(async (ctx) => {
      await ctx.db.patch(publication!._id, { state: 'pending', generation: 1 });
      await recomputeUnits(ctx, [publication!.unitId]);
      const library = (await ctx.db.get(libraries.series))!;
      const jobId = await ctx.db.insert('jobs', {
        class: 'publish',
        payload: {
          class: 'publish',
          publicationIds: [publication!._id],
          workFolderPath: '/data/library/series/Harbour Lights (2021) [tmdbid-900001]',
          items: [{ publicationId: publication!._id, path: file!.path }],
          library: { libraryId: library._id, root: library.rootPath, kind: library.kind },
        },
        status: 'queued',
        attempt: 0,
        maxAttempts: 5,
        leaseEpoch: 0,
        idempotencyKey: `${publication!._id}:publish:1`,
        protocolVersion: 1,
        cancelRequested: false,
      });
      await ctx.db.patch(publication!._id, { jobId });
    });
    // A re-publish keeps the earlier item, so it still counts as visible.
    expect((await unit(workId, 1, 1)).derivedState).toBe('ready');

    const [job] = await w.claim('publish');
    await w.complete(job!, { class: 'publish', targetItemRefs: { [publication!._id]: 'jf-renamed' } });
    expect((await all('publications'))[0]).toMatchObject({ state: 'visible', targetItemRef: 'jf-renamed', generation: 1 });
    expect((await all('fileVersions'))[0]).toMatchObject({ kind: 'primary' });
    expect((await unit(workId, 1, 1)).derivedState).toBe('ready');
  });

  test('after a Usenet import the client item is removed with its data, and the Download is removed', async () => {
    await w.submitAll();
    await settle();
    await w.completed(await downloadId());
    await settle();
    await w.importAll();
    await settle();
    await w.publishAll();
    await settle();

    const [job] = await w.claim('maintenance');
    expect(job!.payload).toMatchObject({
      action: 'removeDownload',
      downloadId: await downloadId(),
      clientKind: 'nzbget',
      deleteData: true,
      // The worker deletes the folder NZBGet leaves behind.
      contentPath: `/data/downloads/usenet/series/${await downloadId()}`,
    });
    await w.complete(job!, { class: 'maintenance', action: 'removeDownload', removed: true });
    expect((await all('downloads'))[0]!.state).toBe('removed');
  });
});

/** E1 in four releases, best first: each one the next-best search falls back to. */
const E1_RELEASES = [
  E1,
  release('s1e1-bluray', 'Harbour.Lights.S01E01.1080p.BluRay.AAC2.0.H.264-GRPC'),
  release('s1e1-webrip', 'Harbour.Lights.S01E01.1080p.WEBRip.AAC2.0.H.264-GRPD'),
  release('s1e1-720p', 'Harbour.Lights.S01E01.720p.WEB-DL.AAC2.0.H.264-GRPE'),
];

describe('a bad release recovers by itself', () => {
  let w: FakeWorker;
  let workId: Id<'works'>;

  const activeDownload = async () => (await all('downloads')).find((d) => d.state === 'active')!._id;

  /** The Unit's current Grab is submitted, then its download fails repair. */
  async function failCurrent(failureCode: 'missingArticles' | 'parFailed' = 'missingArticles') {
    await w.submitAll();
    await settle();
    await w.failed(await activeDownload(), failureCode);
    await settle();
  }

  const grabbedGuids = async () => {
    const grabs = await all('grabs');
    // The fake's GUIDs are its details URLs.
    return t.run(async (ctx) => Promise.all(grabs.map(async (grab) => [(await ctx.db.get(grab.candidateId))!.guid.split('/').at(-1), grab.state])));
  };

  beforeEach(async () => {
    await indexer(E1_RELEASES);
    workId = await subscribe();
    w = await fakeWorker(t);
  });

  test('missing articles: the release is blocklisted, its download removed, and a next-best search grabs the next release in a new run', async () => {
    await failCurrent();

    expect(await grabbedGuids()).toEqual([
      ['s1e1', 'failed'],
      ['s1e1-bluray', 'submitting'],
    ]);
    const [failed, next] = await all('grabs');
    expect(failed!.failureCode).toBe('missingArticles');
    expect(next!.workflowId).not.toBe(failed!.workflowId);
    expect(await all('blocklist')).toEqual([expect.objectContaining({ workId, reason: 'missingArticles', grabId: failed!._id, title: E1.title })]);
    const removal = (await all('jobs')).find((job) => job.payload?.class === 'maintenance');
    expect(removal!.payload).toMatchObject({ action: 'removeDownload', clientKind: 'nzbget', deleteData: true });
    const attempts = await t.run((ctx) => ctx.db.query('searchAttempts').collect());
    expect(attempts.at(-1)).toMatchObject({ trigger: 'nextBest', unitIds: [(await unit(workId, 1, 1))._id] });
    expect(await all('issues')).toEqual([]);
    expect((await unit(workId, 1, 1)).derivedState).toBe('grabbed');
  });

  test('the third failed Grab for the Unit is raised with the bad-release fix actions, and no fourth is started', async () => {
    await failCurrent();
    await failCurrent('parFailed');
    await failCurrent();

    expect((await grabbedGuids()).map(([, state]) => state)).toEqual(['failed', 'failed', 'failed']);
    const e1 = await unit(workId, 1, 1);
    expect(await all('issues')).toEqual([
      expect.objectContaining({
        scope: 'unit',
        unitId: e1._id,
        failureCode: 'missingArticles',
        class: 'badRelease',
        state: 'open',
        fixActions: ['tryNextBest', 'searchAndPick', 'retryRelease', 'blocklistRemove', 'dismiss'],
      }),
    ]);
    expect(e1.derivedState).toBe('failed');
    expect(await all('blocklist')).toHaveLength(3);
  });

  test('when the next-best search finds nothing acceptable left, the failure is raised', async () => {
    fake = createNewznabHandler({ apiKey: INDEXER_KEY, items: [E1] });
    useFetchFakes({ indexers: { 'indexer.fake': fake.handle } });
    await failCurrent();

    expect(await all('issues')).toEqual([expect.objectContaining({ failureCode: 'missingArticles', state: 'open' })]);
    expect((await unit(workId, 1, 1)).derivedState).toBe('failed');
  });

  test('a release file the worker found invalid (a dead link) is a bad release: blocklisted, and next-best grabs the next one', async () => {
    const [job] = await w.claim('download.submit');
    await w.fail(job!, 'releaseFileInvalid', 'indexer.fake answered HTTP 404 (GET /getnzb).');
    await settle();

    expect(await grabbedGuids()).toEqual([
      ['s1e1', 'failed'],
      ['s1e1-bluray', 'submitting'],
    ]);
    expect(await all('blocklist')).toEqual([expect.objectContaining({ reason: 'releaseFileInvalid', title: E1.title })]);
    expect(await all('issues')).toEqual([]);
  });
});

describe('the run ends without the release being at fault', () => {
  let w: FakeWorker;
  let workId: Id<'works'>;

  beforeEach(async () => {
    await indexer(E1_RELEASES);
    workId = await subscribe();
    w = await fakeWorker(t);
    await w.submitAll();
    await settle();
  });

  const activeDownload = async () => (await all('downloads')).find((d) => d.state === 'active')!._id;

  test('an item deleted in the client ends the Grab cancelled: no blocklist, not counted, the Unit is wanted again', async () => {
    await w.removed(await activeDownload());
    await settle();

    expect((await all('grabs')).map((grab) => grab.state)).toEqual(['cancelled']);
    expect((await all('downloads'))[0]!.state).toBe('removed');
    expect(await all('blocklist')).toEqual([]);
    expect(await all('issues')).toEqual([]);
    expect((await t.run((ctx) => ctx.db.query('grabUnits').collect()))[0]!.outcome).toBe('skipped');
    expect((await unit(workId, 1, 1)).derivedState).toBe('wanted');
  });

  test('a client state no table maps is unknownClientFailure, raised at once with the raw status; no blocklist, no next-best, the item removed', async () => {
    const downloadId = await activeDownload();
    await w.failed(downloadId, 'unknownClientFailure', 'FAILURE/SCRIPT');
    await settle();

    expect((await all('grabs')).map((grab) => [grab.state, grab.failureCode])).toEqual([['failed', 'unknownClientFailure']]);
    expect(await all('blocklist')).toEqual([]);
    expect(await all('issues')).toEqual([
      expect.objectContaining({
        scope: 'unit',
        failureCode: 'unknownClientFailure',
        class: 'system',
        state: 'open',
        fixActions: ['retryRelease', 'tryNextBest', 'dismiss'],
        detail: 'NZBGet ended the download with status FAILURE/SCRIPT.',
      }),
    ]);
    const removal = (await all('jobs')).find((job) => job.payload?.class === 'maintenance' && job.payload.action === 'removeDownload');
    expect(removal!.payload).toMatchObject({ downloadId, clientKind: 'nzbget', deleteData: true });
    expect((await unit(workId, 1, 1)).derivedState).toBe('failed');
  });

  test('a failed report without a code is unknownClientFailure, never a bad release', async () => {
    await w.failed(await activeDownload(), undefined, 'FAILURE/NEWSTATUS');
    await settle();

    expect((await all('grabs'))[0]).toMatchObject({ state: 'failed', failureCode: 'unknownClientFailure' });
    expect(await all('blocklist')).toEqual([]);
    const event = (await t.run((ctx) => ctx.db.query('events').collect())).find((e) => e.stage === 'download' && e.kind === 'stageFailed')!;
    expect(event.data).toMatchObject({ failureCode: 'unknownClientFailure', detail: 'NZBGet ended the download with status FAILURE/NEWSTATUS.' });
  });

  test('an active item missing from the client is unknownClientFailure, with its own detail', async () => {
    await w.failed(await activeDownload(), 'unknownClientFailure', 'missing');
    await settle();
    expect(await all('issues')).toEqual([
      expect.objectContaining({ failureCode: 'unknownClientFailure', detail: 'The download is no longer listed in NZBGet.' }),
    ]);
  });

  test("a later Grab's success resolves the Unit's unknownClientFailure Issue", async () => {
    await w.failed(await activeDownload(), 'unknownClientFailure', 'FAILURE/SCRIPT');
    await settle();
    const e1 = await unit(workId, 1, 1);
    await admin.mutation(api.api.units.searchNow, { unitIds: [e1._id] });
    await settle();
    await w.submitAll();
    await settle();
    await w.completed(await activeDownload());
    await settle();
    await w.importAll();
    await settle();
    await w.publishAll();
    await settle();
    expect((await all('issues')).map((issue) => [issue.failureCode, issue.state])).toEqual([['unknownClientFailure', 'resolved']]);
  });
});
