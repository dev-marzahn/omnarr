// Release upgrades: a Unit that already plays is searched for a better
// release, an upgrade Grab replaces its file without the Unit losing its
// state, and the cutoff, the cooldown and the transcode ordering stop
// upgrades.
import { runToCompletion } from '@convex-dev/migrations';
import migrationsComponent from '@convex-dev/migrations/test';
import { createNewznabHandler, type FakeItem } from '@omnarr/e2e/fakes/newznab';
import { beforeEach, describe, expect, test, vi } from 'vite-plus/test';

import { api, components, internal } from '../convex/_generated/api';
import type { Doc, Id } from '../convex/_generated/dataModel';
import { recomputeUnits } from '../convex/lib/derivedState';
import { raiseIssue } from '../convex/lib/issues';
import { UPGRADE_PAGE_SIZE, UPGRADE_READ_CAP, upgradeSearchPage } from '../convex/pipeline/upgrades';
import { HEVC_PROBE, prepareWorker } from './fakePrepare';
import { FITTING_PROBE, WEB_DL_PROBE, type FakeWorker } from './fakeWorker';
import { pipelineHarness, release } from './harness';
import { countingReads } from './reads';
import { INDEXER_KEY, useFetchFakes } from './setup';

const h = pipelineHarness();
let w: FakeWorker;
let workId: Id<'works'>;
let e1: Doc<'units'>;

const DAY = 86_400_000;

/** The current file: a WEB-DL 1080p from an untiered group. */
const UNTIERED = release('s1e1', 'Harbour.Lights.S01E01.1080p.WEB-DL.AAC2.0.H.264-GRPB');
/** A tier-1 group's WEB-DL with the same preparation: its score passes the cutoff. */
const TIER1 = release('s1e1-tier1', 'Harbour.Lights.S01E01.1080p.WEB-DL.AAC2.0.H.264-TIERONE');
/** A tier-2 group's WEB-DL, which is rejected once the tier-1 file meets the cutoff. */
const TIER2 = release('s1e1-tier2', 'Harbour.Lights.S01E01.1080p.WEB-DL.AAC2.0.H.264-TIERTWO');
/** A tier-1 group's HEVC release: the default target (H.264) needs a video transcode for it. */
const TIER1_HEVC = release('s1e1-hevc', 'Harbour.Lights.S01E01.1080p.WEB-DL.AAC2.0.x265-TIERONE');

const fitting = (name: string) => () => [{ relPath: `${name}.mp4`, sizeBytes: 1_000_000 }];

/** Runs the Unit's running Grab to its end: the client accepts and finishes it, the worker imports and publishes. */
async function runGrab(options: Parameters<FakeWorker['importAll']>[0] = { probe: FITTING_PROBE }) {
  await w.submitAll();
  await h.settle();
  await w.completed(await h.activeDownload());
  await h.settle();
  await w.importAll(options);
  await h.settle();
  await w.publishAll();
  await h.settle();
}

const unit = () => h.get(e1._id) as Promise<Doc<'units'>>;
const rowOf = async () => (await h.admin.query(api.api.library.detail, { workId }))!.units.find((row) => row.unitId === e1._id)!;
/** The newest candidate row of a release. */
const candidateOf = async (title: string) => (await h.all('candidates')).filter((c) => c.title === title).at(-1)!;
const grabs = () => h.all('grabs');
/** The Unit's file versions, with their file's path. */
const versions = async () =>
  Promise.all(
    (await h.all('fileVersions'))
      .filter((version) => version.unitId === e1._id)
      .map(async (version) => ({ kind: version.kind, fits: version.fits, path: (await h.get(version.fileId))!.path })),
  );
const searchNow = async () => {
  await h.admin.mutation(api.api.units.searchNow, { unitIds: [e1._id] });
  await h.settle();
};

beforeEach(async () => {
  // The shipped profile's tiers, plus this test's groups.
  await h.t.run(async (ctx) => {
    const profile = (await ctx.db.get(h.libraries.releaseProfileId))!;
    const add = (formatId: string, group: string) => (entry: Doc<'releaseProfiles'>['groupTiers'][number]) =>
      entry.formatId === formatId ? { ...entry, groups: [...entry.groups, group] } : entry;
    await ctx.db.patch(profile._id, { groupTiers: profile.groupTiers.map(add('group.tier1', 'TIERONE')).map(add('group.tier2', 'TIERTWO')) });
  });
  await h.indexer([UNTIERED]);
  w = await h.worker();
  workId = await h.subscribe();
  e1 = await h.unit(workId, 1, 1);
  await runGrab({ probe: FITTING_PROBE, files: fitting('Harbour.Lights.S01E01.1080p.WEB-DL.AAC2.0.H.264-GRPB') });
  expect((await unit()).derivedState).toBe('ready');
});

/** The one indexer now also lists these releases. */
const list = (...items: FakeItem[]) => {
  h.fake = createNewznabHandler({ apiKey: INDEXER_KEY, items: [UNTIERED, ...items] });
  useFetchFakes({ indexers: { 'indexer.fake': h.fake.handle } });
};

describe('an upgrade to a better release', () => {
  test('Search now on a ready Unit runs an upgrade search, and the better release starts an upgrade Grab', async () => {
    list(TIER1);
    await searchNow();

    const attempt = (await h.all('searchAttempts')).at(-1)!;
    expect(attempt).toMatchObject({ trigger: 'upgrade', state: 'picked' });
    expect(await candidateOf(TIER1.title)).toMatchObject({ outcome: 'picked', isUpgrade: true });
    expect((await grabs()).at(-1)).toMatchObject({ kind: 'upgrade' });
  });

  test('the Unit stays ready with an Upgrading tag while the Grab runs, and the timeline names the run an upgrade', async () => {
    list(TIER1);
    await searchNow();
    const grab = (await grabs()).at(-1)!;

    expect((await unit()).derivedState).toBe('ready');
    expect((await rowOf()).upgrading).toEqual({ grabId: grab._id, stage: 'grabbed' });
    await w.submitAll();
    await h.settle();
    expect((await unit()).derivedState).toBe('ready');
    expect((await rowOf()).upgrading).toMatchObject({ stage: 'downloading' });
    const timeline = (await h.admin.query(api.api.units.timeline, { unitId: e1._id }))!;
    expect(timeline.runs[0]).toMatchObject({ grabId: grab._id, kind: 'upgrade' });
  });

  test('a fitting upgrade file becomes the primary once published, and the old file is deleted', async () => {
    const [old] = await versions();
    list(TIER1);
    await searchNow();
    await w.submitAll();
    await h.settle();
    await w.completed(await h.activeDownload());
    await h.settle();
    await w.importAll({ probe: FITTING_PROBE, files: fitting('Harbour.Lights.S01E01.1080p.WEB-DL.AAC2.0.H.264-TIERONE') });
    await h.settle();
    // Until Jellyfin sees the new file, the old one is still the one that plays.
    expect((await unit()).derivedState).toBe('ready');
    expect(await versions()).toContainEqual({ kind: 'primary', fits: true, path: old!.path });
    await w.publishAll();
    await h.settle();

    const now = await versions();
    expect(now).toHaveLength(1);
    expect(now[0]).toMatchObject({ kind: 'primary', fits: true });
    expect(now[0]!.path).toContain('TIERONE');
    expect((await unit()).derivedState).toBe('ready');
    expect((await rowOf()).upgrading).toBeUndefined();
    const deletions = (await h.all('jobs')).filter((job) => job.payload?.class === 'maintenance' && job.payload.action === 'deleteLibraryFiles');
    expect(deletions.flatMap((job) => (job.payload as { paths: string[] }).paths)).toContain(old!.path);
  });

  test('a later tier-2 release is rejected with notAnUpgrade, because the tier-1 file meets the cutoff', async () => {
    list(TIER1);
    await searchNow();
    await runGrab({ probe: FITTING_PROBE, files: fitting('Harbour.Lights.S01E01.1080p.WEB-DL.AAC2.0.H.264-TIERONE') });
    // Past the 24-hour cooldown, so only the cutoff stops it.
    vi.advanceTimersByTime(2 * DAY);
    list(TIER1, TIER2);
    await searchNow();

    expect(await candidateOf(TIER2.title)).toMatchObject({ outcome: 'rejected', reason: 'notAnUpgrade' });
    expect((await grabs()).filter((grab) => grab.kind === 'upgrade')).toHaveLength(1);
  });
});

describe('what stops an upgrade', () => {
  test('a release that needs a video transcode never replaces a fitting file', async () => {
    list(TIER1_HEVC);
    await searchNow();
    expect(await candidateOf(TIER1_HEVC.title)).toMatchObject({ outcome: 'rejected', reason: 'notAnUpgrade' });
    expect(await grabs()).toHaveLength(1);
  });

  test('a current file that needed a video transcode is replaced by a release that does not, even a lower-scored one', async () => {
    // The Unit's file is a tier-2 HEVC encode (1050, under the cutoff) the default target (H.264) can't play: its real step is a video transcode.
    await h.t.run(async (ctx) => {
      const [file] = await ctx.db.query('files').collect();
      await ctx.db.patch(file!._id, { probe: HEVC_PROBE, release: { ...file!.release!, group: 'TIERTWO', videoCodec: 'h265' } });
    });
    const LOWER = release('s1e1-lower', 'Harbour.Lights.S01E01.1080p.WEB-DL.AAC2.0.H.264-OTHERGRP');
    list(LOWER);
    await searchNow();
    expect(await candidateOf(LOWER.title)).toMatchObject({ isUpgrade: true, baseScore: 50 });
    expect((await grabs()).at(-1)).toMatchObject({ kind: 'upgrade' });
  });

  test('the cooldown: at most one upgrade Grab per Unit per 24 hours', async () => {
    list(TIER2);
    await searchNow();
    await runGrab({ probe: FITTING_PROBE, files: fitting('Harbour.Lights.S01E01.1080p.WEB-DL.AAC2.0.H.264-TIERTWO') });
    list(TIER2, TIER1);
    await searchNow();
    expect(await candidateOf(TIER1.title)).toMatchObject({ outcome: 'rejected', reason: 'notAnUpgrade' });
    vi.advanceTimersByTime(DAY + 1);
    await searchNow();
    expect(await candidateOf(TIER1.title)).toMatchObject({ outcome: 'picked', isUpgrade: true });
  });

  test('a failed upgrade is blocklisted with no next-best search, raises no Issue and is not counted', async () => {
    list(TIER1);
    await searchNow();
    await w.submitAll();
    await h.settle();
    await w.failed(await h.activeDownload(), 'missingArticles');
    await h.settle();

    expect((await grabs()).at(-1)).toMatchObject({ kind: 'upgrade', state: 'failed' });
    expect(await h.all('issues')).toEqual([]);
    expect((await h.all('blocklist')).map((row) => row.title)).toContain(TIER1.title);
    expect((await h.all('searchAttempts')).filter((attempt) => attempt.trigger === 'nextBest')).toEqual([]);
    expect((await unit()).derivedState).toBe('ready');
  });
});

describe('an upgrade file that needs preparation waits under staging/held', () => {
  /** A Bluray release, better in quality than the WEB-DL file, whose real file needs an audio conversion. */
  const BLURAY = release('s1e1-bluray', 'Harbour.Lights.S01E01.1080p.BluRay.AAC2.0.H.264-TIERONE');

  async function heldUpgrade() {
    const [old] = await versions();
    // web-1080p ranks WEB-DL first; a profile that ranks Bluray first makes it an upgrade on quality.
    await h.t.run(async (ctx) => {
      const profile = (await ctx.db.get(h.libraries.releaseProfileId))!;
      const rank = (quality: string) => (quality === 'bluray-1080p' ? 0 : undefined);
      await ctx.db.patch(profile._id, { qualities: profile.qualities.map((q) => ({ ...q, rank: rank(q.quality) ?? q.rank })) });
    });
    list(BLURAY);
    await searchNow();
    await w.submitAll();
    await h.settle();
    await w.completed(await h.activeDownload());
    await h.settle();
    const [job] = await w.importAll({ probe: WEB_DL_PROBE });
    await h.settle();
    await w.publishAll();
    await h.settle();
    return { old: old!, job: job! };
  }

  test('the import holds the file as a staged source with no Publication, the old file stays the primary, and a prepare starts from it', async () => {
    const { old, job } = await heldUpgrade();

    expect(job.payload).toMatchObject({ holdUnlessFits: expect.any(Object) });
    const now = await versions();
    expect(now).toContainEqual({ kind: 'primary', fits: true, path: old.path });
    expect(now).toContainEqual({ kind: 'staged', fits: false, path: expect.stringMatching(`^/data/staging/held/${job.jobId}/`) });
    expect(await h.all('publications')).toHaveLength(1);
    const prepare = (await h.all('jobs')).find((row) => row.class === 'prepare')!;
    expect(prepare.payload).toMatchObject({
      sourcePath: expect.stringMatching('^/data/staging/held/'),
      outputFolder: old.path.slice(0, old.path.lastIndexOf('/')),
      replacesPath: old.path,
    });
    expect((await grabs()).at(-1)).toMatchObject({ kind: 'upgrade', state: 'done' });
  });

  test('the prepared upgrade swaps in: it becomes the primary once published, and the old file and the held source are gone', async () => {
    await heldUpgrade();
    const p = await prepareWorker(h.t);
    await p.prepareNext();
    await h.settle();
    await p.publishAll();
    await h.settle();

    const now = await versions();
    expect(now).toHaveLength(1);
    expect(now[0]).toMatchObject({ kind: 'primary', fits: true });
    expect((await unit()).derivedState).toBe('ready');
  });

  test('a failed preparation removes the held source and raises no Issue; the old file still plays', async () => {
    const { old } = await heldUpgrade();
    const p = await prepareWorker(h.t);
    const [job] = await p.claim();
    await p.fail(job!, 'transcodeFailed', 'ffmpeg exited with code 1');
    await h.settle();
    // Retried once, then terminal.
    const [again] = await p.claim();
    if (again) await p.fail(again, 'transcodeFailed', 'ffmpeg exited with code 1');
    await h.settle();

    expect(await versions()).toEqual([{ kind: 'primary', fits: true, path: old.path }]);
    expect(await h.all('issues')).toEqual([]);
    expect((await unit()).derivedState).toBe('ready');
    const cleanups = (await h.all('jobs')).filter((row) => row.payload?.class === 'maintenance' && row.payload.action === 'deleteLibraryFiles');
    expect(cleanups.flatMap((row) => (row.payload as { paths: string[] }).paths)).toContainEqual(expect.stringMatching('^/data/staging/held/'));
  });
});

describe('the other triggers', () => {
  test('RSS matches an upgradeable Unit like a wanted one, and starts an upgrade Grab', async () => {
    const indexerId = (await h.all('indexers'))[0]!._id;
    await h.t.run((ctx) => ctx.db.patch(indexerId, { rssHighWaterMark: '0:old' }));
    list({ ...TIER1, publishedAt: '2026-11-15T10:00:00Z' });
    await h.t.action(internal.pipeline.rssAction.fetch, { indexerId });
    await h.settle();

    expect((await h.all('searchAttempts')).at(-1)).toMatchObject({ trigger: 'rss', unitIds: [e1._id] });
    expect(await candidateOf(TIER1.title)).toMatchObject({ outcome: 'picked', isUpgrade: true });
    expect((await grabs()).at(-1)).toMatchObject({ kind: 'upgrade' });
  });

  test("Try next-best on a playable Unit's Issue runs an upgrade search", async () => {
    // transcodeFailed on a Unit whose file still plays.
    await h.t.run((ctx) => raiseIssue(ctx, { code: 'transcodeFailed', unitId: e1._id }));
    const issueId = (await h.all('issues'))[0]!._id;
    const row = (await h.admin.query(api.api.issues.list, {})).needsAction.find((issue) => issue.issueId === issueId)!;
    expect(row.fixActions).toEqual(expect.arrayContaining(['tryNextBest', 'searchAndPick']));
    list(TIER1);
    await h.admin.mutation(api.api.issues.act, { issueId, action: 'tryNextBest' });
    await h.settle();
    expect((await h.all('searchAttempts')).at(-1)).toMatchObject({ trigger: 'upgrade' });
    expect((await grabs()).at(-1)).toMatchObject({ kind: 'upgrade' });
  });
});

test('migration 0004: a Grab from before upgrades becomes an initial one; an upgrade keeps its kind', async () => {
  list(TIER1);
  await searchNow();
  const [first, upgrade] = await grabs();
  await h.t.run(async (ctx) => {
    const { _id, _creationTime, kind: _kind, ...rest } = (await ctx.db.get(first!._id))!;
    await ctx.db.replace(_id, rest);
  });
  migrationsComponent.register(h.t);
  await h.t.run((ctx) => runToCompletion(ctx, components.migrations, internal.migrations['0004_grab_kind'].default));
  expect((await h.get(first!._id))!.kind).toBe('initial');
  expect((await h.get(upgrade!._id))!.kind).toBe('upgrade');
});

describe('an old file that holds two episodes', () => {
  // `S01E02-E03`: the fake indexer reads a title's first number only when a word boundary follows it.
  const PAIR_NAME = 'Harbour.Lights.S01E02-E03.1080p.WEB-DL.AAC2.0.H.264-GRPB';
  const PAIR = release('s1e2e3', PAIR_NAME);
  /** A tier-1 release of E02 alone: better, but it leaves E03 on the old file. */
  const E2_TIER1 = release('s1e2-tier1', 'Harbour.Lights.S01E02.1080p.WEB-DL.AAC2.0.H.264-TIERONE');
  const E3_TIER1 = release('s1e3-tier1', 'Harbour.Lights.S01E03.1080p.WEB-DL.AAC2.0.H.264-TIERONE');
  const PAIR_TIER1 = release('s1e2e3-tier1', 'Harbour.Lights.S01E02-E03.1080p.WEB-DL.AAC2.0.H.264-TIERONE');
  let e2: Doc<'units'>;
  let e3: Doc<'units'>;
  let pairPath: string;

  const search = async (...units: Doc<'units'>[]) => {
    await h.admin.mutation(api.api.units.searchNow, { unitIds: units.map((u) => u._id) });
    await h.settle();
  };
  /** The paths of a Unit's file versions. */
  const pathsOf = async (unitId: Id<'units'>) =>
    Promise.all((await h.all('fileVersions')).filter((version) => version.unitId === unitId).map(async (version) => (await h.get(version.fileId))!.path));
  const maintenance = async (action: string) => (await h.all('jobs')).filter((job) => job.payload?.class === 'maintenance' && job.payload.action === action);

  beforeEach(async () => {
    e2 = await h.unit(workId, 1, 2);
    e3 = await h.unit(workId, 1, 3);
    list(PAIR);
    await search(e2);
    // The episode search for E02 imports the file for E03 too.
    await runGrab({ probe: FITTING_PROBE, files: fitting(PAIR_NAME) });
    expect((await h.get(e2._id))!.derivedState).toBe('ready');
    expect((await h.get(e3._id))!.derivedState).toBe('ready');
    pairPath = (await pathsOf(e2._id))[0]!;
    expect(await pathsOf(e3._id)).toEqual([pairPath]);
  });

  test("a release of one of its episodes isn't an upgrade: it is rejected with partialUpgrade, and no Grab starts", async () => {
    list(PAIR, E2_TIER1);
    await search(e2);

    expect(await candidateOf(E2_TIER1.title)).toMatchObject({ outcome: 'rejected', reason: 'partialUpgrade' });
    expect((await grabs()).filter((grab) => grab.kind === 'upgrade')).toEqual([]);
  });

  const rss = async (item: FakeItem) => {
    const indexerId = (await h.all('indexers'))[0]!._id;
    await h.t.run((ctx) => ctx.db.patch(indexerId, { rssHighWaterMark: '0:old' }));
    list(PAIR, { ...item, publishedAt: '2026-11-15T10:00:00Z' });
    await h.t.action(internal.pipeline.rssAction.fetch, { indexerId });
    await h.settle();
  };

  test('RSS skips a release of one of its episodes the same way', async () => {
    await rss(E2_TIER1);

    expect(await candidateOf(E2_TIER1.title)).toMatchObject({ outcome: 'rejected', reason: 'partialUpgrade' });
    expect((await grabs()).filter((grab) => grab.kind === 'upgrade')).toEqual([]);
  });

  test('a release of both its episodes is an upgrade', async () => {
    await rss(PAIR_TIER1);

    expect(await candidateOf(PAIR_TIER1.title)).toMatchObject({ outcome: 'picked', isUpgrade: true });
    expect((await grabs()).at(-1)).toMatchObject({ kind: 'upgrade' });
  });

  test("Try next-best on one of its episodes' Issues skips a release of that episode alone", async () => {
    await h.t.run((ctx) => raiseIssue(ctx, { code: 'transcodeFailed', unitId: e2._id }));
    const issueId = (await h.all('issues'))[0]!._id;
    list(PAIR, E2_TIER1);
    await h.admin.mutation(api.api.issues.act, { issueId, action: 'tryNextBest' });
    await h.settle();

    expect(await candidateOf(E2_TIER1.title)).toMatchObject({ outcome: 'rejected', reason: 'partialUpgrade' });
    expect((await grabs()).filter((grab) => grab.kind === 'upgrade')).toEqual([]);
  });

  test('a release of one episode the user picks: the old file is renamed to the episode it still holds, and deleted once that one has a newer primary', async () => {
    list(PAIR, E2_TIER1);
    await h.admin.mutation(api.api.units.searchInteractive, { unitIds: [e2._id] });
    await h.settle();
    const picked = await h.admin.mutation(api.api.units.grabCandidate, { candidateId: (await candidateOf(E2_TIER1.title))._id });
    expect(picked).toMatchObject({ outcome: 'grabbed' });
    await h.settle();
    await runGrab({ probe: FITTING_PROBE, files: fitting('Harbour.Lights.S01E02.1080p.WEB-DL.AAC2.0.H.264-TIERONE') });

    // E02 plays from its new file only; the old file stays for E03, under E03's name alone, so Jellyfin no longer reads it as E02.
    expect(await pathsOf(e2._id)).toEqual([expect.stringContaining('TIERONE')]);
    expect(await pathsOf(e3._id)).toEqual([pairPath]);
    const [rename] = await maintenance('renameLibraryFile');
    expect(rename?.payload).toMatchObject({ from: pairPath, to: expect.stringMatching(/S01E03[^/]*$/) });
    expect((rename!.payload as { to: string }).to).not.toMatch(/E02/);
    expect((await maintenance('deleteLibraryFiles')).flatMap((job) => (job.payload as { paths: string[] }).paths)).not.toContain(pairPath);

    // E03's own upgrade is a whole one now, and it retires the old file.
    list(PAIR, E3_TIER1);
    await search(e3);
    expect(await candidateOf(E3_TIER1.title)).toMatchObject({ outcome: 'picked', isUpgrade: true });
    await runGrab({ probe: FITTING_PROBE, files: fitting('Harbour.Lights.S01E03.1080p.WEB-DL.AAC2.0.H.264-TIERONE') });
    expect(await pathsOf(e3._id)).toEqual([expect.stringContaining('TIERONE')]);
    expect(await h.all('files')).not.toContainEqual(expect.objectContaining({ path: pairPath }));
  });
});

describe("an episode's release that also holds the next episode", () => {
  const PAIR_NAME = 'Harbour.Lights.S01E02-E03.1080p.WEB-DL.AAC2.0.H.264-GRPB';
  const PAIR = release('s1e2e3', PAIR_NAME);
  let e2: Doc<'units'>;
  let e3: Doc<'units'>;

  const search = async (target: Doc<'units'>) => {
    await h.admin.mutation(api.api.units.searchNow, { unitIds: [target._id] });
    await h.settle();
  };
  const stateOf = async (target: Doc<'units'>) => (await h.get(target._id))!.derivedState;
  /** The paths of the files a Unit is linked to. */
  const filesOf = async (target: Doc<'units'>) =>
    Promise.all((await h.all('fileUnits')).filter((link) => link.unitId === target._id).map(async (link) => (await h.get(link.fileId))!.path));
  const visibleOf = async (target: Doc<'units'>) => (await h.all('publications')).filter((p) => p.unitId === target._id && p.state === 'visible');

  beforeEach(async () => {
    e2 = await h.unit(workId, 1, 2);
    e3 = await h.unit(workId, 1, 3);
  });

  test('a search for E02 that grabs S01E02-E03 covers E03 too: not wanted during the Grab, ready after publish, from the one file', async () => {
    expect(await stateOf(e3)).toBe('wanted');
    list(PAIR);
    await search(e2);

    expect(await candidateOf(PAIR_NAME)).toMatchObject({ outcome: 'picked', unitIds: [e2._id], alsoContainsUnitIds: [e3._id] });
    expect(await stateOf(e3)).not.toBe('wanted');
    expect(await stateOf(e3)).toBe(await stateOf(e2));

    await runGrab({ probe: FITTING_PROBE, files: fitting(PAIR_NAME) });
    expect(await stateOf(e2)).toBe('ready');
    expect(await stateOf(e3)).toBe('ready');
    const [path] = await filesOf(e2);
    expect(await filesOf(e3)).toEqual([path]);
    expect(await visibleOf(e3)).toHaveLength(1);
    expect((await h.all('grabs')).filter((grab) => grab.state !== 'done')).toEqual([]);
  });

  test('an E03 that already plays keeps its own file: the Grab and the new file are E02 only', async () => {
    const E3_NAME = 'Harbour.Lights.S01E03.1080p.WEB-DL.AAC2.0.H.264-GRPB';
    list(release('s1e3', E3_NAME));
    await search(e3);
    await runGrab({ probe: FITTING_PROBE, files: fitting(E3_NAME) });
    expect(await stateOf(e3)).toBe('ready');
    const own = await filesOf(e3);

    list(PAIR);
    await search(e2);
    const grab = (await h.all('grabs')).at(-1)!;
    expect(grab).toMatchObject({ kind: 'initial' });
    expect((await h.all('grabUnits')).filter((row) => row.grabId === grab._id).map((row) => row.unitId)).toEqual([e2._id]);

    await runGrab({ probe: FITTING_PROBE, files: fitting(PAIR_NAME) });
    expect(await stateOf(e2)).toBe('ready');
    expect(await filesOf(e2)).toEqual([expect.stringContaining('S01E02')]);
    expect(await filesOf(e3)).toEqual(own);
    expect(await visibleOf(e3)).toHaveLength(1);
  });

  test('an unmonitored E03 is linked too, since the file holds it, and stays unmonitored', async () => {
    await h.t.run(async (ctx) => {
      await ctx.db.patch(e3._id, { monitored: false });
      await recomputeUnits(ctx, [e3._id]);
    });
    list(PAIR);
    await search(e2);
    expect(await candidateOf(PAIR_NAME)).toMatchObject({ outcome: 'picked', unitIds: [e2._id], alsoContainsUnitIds: [e3._id] });

    await runGrab({ probe: FITTING_PROBE, files: fitting(PAIR_NAME) });
    const [path] = await filesOf(e2);
    expect(await filesOf(e3)).toEqual([path]);
    expect(await visibleOf(e3)).toHaveLength(1);
    expect(await stateOf(e3)).toBe('ready');
    expect((await h.get(e3._id))!.monitored).toBe(false);
  });

  test("a season pack that lacks E05, grabbed for E02: E02 and the pack's other episodes import, E05 is wanted again, and nothing is blocklisted", async () => {
    const PACK_NAME = 'Harbour.Lights.S01.1080p.WEB-DL.AAC2.0.H.264-GRPB';
    const units = await Promise.all([3, 4, 5, 6].map((n) => h.unit(workId, 1, n)));
    const [e4, e5, e6] = units.slice(1) as [Doc<'units'>, Doc<'units'>, Doc<'units'>];
    list(release('s1-pack', PACK_NAME, { everyQuery: true }));
    await search(e2);
    expect(await candidateOf(PACK_NAME)).toMatchObject({ outcome: 'picked', unitIds: [e2._id] });
    expect(await stateOf(e5)).not.toBe('wanted');

    const files = [1, 2, 3, 4, 6].map((n) => ({ relPath: `${PACK_NAME}/Harbour.Lights.S01E0${n}.1080p.WEB-DL.AAC2.0.H.264-GRPB.mp4`, sizeBytes: 1_000_000 }));
    await runGrab({ probe: FITTING_PROBE, files: () => files });

    for (const target of [e2, e3, e4, e6]) {
      expect(await stateOf(target)).toBe('ready');
      expect(await filesOf(target)).toEqual([expect.stringContaining(`S01E0${target.tmdbEpisode}`)]);
    }
    expect(await stateOf(e5)).toBe('wanted');
    expect((await h.get(e5._id))!.activeGrabId).toBeUndefined();
    expect(await filesOf(e5)).toEqual([]);
    expect((await h.all('grabs')).at(-1)).toMatchObject({ state: 'done' });
    expect(await h.all('blocklist')).toEqual([]);
  });

  test("an E03 in another running Grab stays that Grab's", async () => {
    list(release('s1e3', 'Harbour.Lights.S01E03.1080p.WEB-DL.AAC2.0.H.264-GRPB'));
    await search(e3);
    const own = (await h.get(e3._id))!.activeGrabId!;
    expect(own).toBeDefined();

    list(PAIR);
    await search(e2);
    const grab = (await h.all('grabs')).at(-1)!;
    expect(grab._id).not.toBe(own);
    expect((await h.all('grabUnits')).filter((row) => row.grabId === grab._id).map((row) => row.unitId)).toEqual([e2._id]);
    expect((await h.get(e3._id))!.activeGrabId).toBe(own);
  });
});

describe('the weekly upgradeSearch', () => {
  test('searches an upgradeable Unit, stamps lastSearchAt on every Unit it checks, and skips one that meets the cutoff', async () => {
    const e2 = await h.unit(workId, 1, 2);
    list(TIER1);
    const before = (await unit()).lastSearchAt!;
    vi.advanceTimersByTime(DAY);
    await h.t.mutation(internal.pipeline.upgrades.upgradeSearch, {});
    await h.settle();

    expect((await unit()).lastSearchAt!).toBeGreaterThan(before);
    expect((await h.get(e2._id))!.lastSearchAt!).toBeGreaterThan(before);
    expect((await h.all('searchAttempts')).filter((attempt) => attempt.trigger === 'upgrade')).toHaveLength(1);
    expect((await grabs()).at(-1)).toMatchObject({ kind: 'upgrade' });
  });

  /** `count` more monitored Units with no file, searched long ago (at 1, 2, …): by_last_search lists them after the never-searched Units and before the searched ones. */
  const older = (count: number) =>
    h.t.run(async (ctx) => {
      const ids: Id<'units'>[] = [];
      for (let i = 1; i <= count; i++)
        ids.push(
          await ctx.db.insert('units', { workId, kind: 'episode', tmdbSeason: 9, tmdbEpisode: i, monitored: true, derivedState: 'wanted', lastSearchAt: i }),
        );
      return ids;
    });
  const stamps = (ids: Id<'units'>[]) => h.t.run(async (ctx) => Promise.all(ids.map(async (id) => (await ctx.db.get(id))!.lastSearchAt!)));

  test('a library larger than one page is checked page by page: every Unit is stamped, and an upgradeable Unit on a later page is searched', async () => {
    const extra = await older(2 * UPGRADE_PAGE_SIZE + 20);
    list(TIER1);
    vi.advanceTimersByTime(DAY);
    const startedAt = Date.now();
    await h.t.mutation(internal.pipeline.upgrades.upgradeSearch, {});
    await h.settle();

    // One stamp, the run's start, on every page's Units.
    const [stamp, ...others] = new Set(await stamps(extra));
    expect(others).toEqual([]);
    expect(stamp).toBeGreaterThanOrEqual(startedAt);
    expect((await h.get((await h.unit(workId, 1, 2))._id))!.lastSearchAt).toBe(stamp);
    // E01 comes after the 120 older Units, on the third page.
    const searched = (await h.all('searchAttempts')).filter((attempt) => attempt.trigger === 'upgrade');
    expect(searched.map((attempt) => attempt.unitIds)).toEqual([[e1._id]]);
    expect((await grabs()).at(-1)).toMatchObject({ kind: 'upgrade' });
  });

  test('the pages together read at most UPGRADE_READ_CAP Units, oldest search first', async () => {
    await older(UPGRADE_READ_CAP + 20);
    list(TIER1);
    vi.advanceTimersByTime(DAY);
    const startedAt = Date.now();
    // The index's order: a Unit never searched first, then the oldest search.
    const oldestFirst = (await h.t.run((ctx) => ctx.db.query('units').withIndex('by_last_search').collect())).map((u) => u._id);
    const before = (await unit()).lastSearchAt;
    await h.t.mutation(internal.pipeline.upgrades.upgradeSearch, {});
    await h.settle();

    const after = await stamps(oldestFirst);
    // The run's one stamp, its start.
    const stamp = after[0]!;
    expect(stamp).toBeGreaterThanOrEqual(startedAt);
    expect(after.slice(0, UPGRADE_READ_CAP).every((at) => at === stamp)).toBe(true);
    expect(after.slice(UPGRADE_READ_CAP).some((at) => at === stamp)).toBe(false);
    expect((await unit()).lastSearchAt).toBe(before);
    expect((await h.all('searchAttempts')).filter((attempt) => attempt.trigger === 'upgrade')).toEqual([]);
  });

  test("one page reads UPGRADE_PAGE_SIZE Units and the same number of documents, whatever the library's size", async () => {
    const pageReads = () =>
      h.t.run(async (ctx) => {
        const { ctx: counted, counter } = countingReads(ctx);
        await upgradeSearchPage(counted, {});
        return { units: counter.tables.units, reads: counter.reads };
      });
    await older(2 * UPGRADE_PAGE_SIZE);
    const small = await pageReads();
    await older(UPGRADE_READ_CAP);
    const large = await pageReads();

    expect(small.units).toBe(UPGRADE_PAGE_SIZE);
    expect(large).toEqual(small);
  });
});
