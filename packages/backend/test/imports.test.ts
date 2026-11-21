// `imports.resolveFiles`: the Units each file of an
// import holds, by matchTitle on the candidate and resolveUnits, as
// search and RSS resolve a release. Works come from the real subscribe path
// with TMDB, XEM and Anime-Lists behind fakes; the import job is the one
// `steps.startImport` enqueues, claimed by the fake worker.
import { DEFAULT_LIMITS, type LeasedJob, type TargetReading } from '@omnarr/contracts';
import { createNewznabHandler, type FakeItem } from '@omnarr/e2e/fakes/newznab';
import { emberRite, jojoParts, SERIES } from '@omnarr/e2e/fakes/tmdb/fixtures';
import { parseRelease } from '@omnarr/parser';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';

import { api, internal } from '../convex/_generated/api';
import type { Doc, Id } from '../convex/_generated/dataModel';
import { recomputeUnits } from '../convex/lib/derivedState';
import { seedFile } from './fakePrepare';
import { fakeWorker, FITTING_PROBE, type FakeWorker } from './fakeWorker';
import missingSeasonXml from './fixtures/animeLists/missingSeason.xml?raw';
import jojoPartsNames from './fixtures/xem/jojoPartsNames.json';
import jojoPartsShape from './fixtures/xem/jojoPartsShape.json';
import missingSeasonShape from './fixtures/xem/missingSeasonShape.json';
import { pipelineHarness, release } from './harness';
import {
  asAdmin,
  INDEXER_KEY,
  seedAnimeLists,
  seedIndexer,
  seedLibraries,
  seedXemList,
  settleSearches,
  setup,
  useFetchFakes,
  useMetadataFakes,
  worker,
  type Backend,
  type Libraries,
} from './setup';

let t: Backend;
let admin: Awaited<ReturnType<typeof asAdmin>>;
let libraries: Libraries;

beforeEach(async () => {
  vi.useFakeTimers();
  t = setup();
  admin = await asAdmin(t, 30 * 86_400_000);
  libraries = await seedLibraries(t);
  useMetadataFakes();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

async function subscribe(tmdbId: string, seasons: number[], kind: 'series' | 'movie' = 'series'): Promise<Id<'works'>> {
  const { workId } = await admin.action(api.api.library.subscribe, {
    tmdbId,
    kind,
    libraryId: kind === 'series' ? libraries.series : libraries.movies,
    releaseProfileId: libraries.releaseProfileId,
    seasons,
  });
  await settleSearches(t);
  return workId;
}

const unitAt = async (workId: Id<'works'>, season: number, episode: number): Promise<Id<'units'>> =>
  (await t.run((ctx) =>
    ctx.db
      .query('units')
      .withIndex('by_work_tmdb', (q) => q.eq('workId', workId).eq('tmdbSeason', season).eq('tmdbEpisode', episode))
      .unique(),
  ))!._id;

/**
 * A Grab of `title` for `unitIds` (and a pack's other Units) whose download
 * finished at `contentPath`, and its import job as the worker leases it.
 */
async function leasedImport(
  workId: Id<'works'>,
  title: string,
  unitIds: Id<'units'>[],
  options: { alsoContainsUnitIds?: Id<'units'>[]; contentPath?: string } = {},
): Promise<LeasedJob> {
  const indexerId = await seedIndexer(t);
  const grabId = await t.run(async (ctx) => {
    const work = (await ctx.db.get(workId))!;
    const searchAttemptId = await ctx.db.insert('searchAttempts', {
      unitIds,
      wantedUnitIds: unitIds,
      workId,
      groupKind: 'episode',
      trigger: 'manual',
      state: 'picked',
      indexerResults: [],
    });
    const candidateId = await ctx.db.insert('candidates', {
      searchAttemptId,
      indexerId,
      guid: title,
      title,
      downloadUrl: 'https://indexer.fake/get',
      sizeBytes: 1_000_000_000,
      protocol: 'usenet',
      publishedAt: 0,
      parsed: parseRelease(title, work.kind),
      unitIds,
      alsoContainsUnitIds: options.alsoContainsUnitIds ?? [],
      quality: 'webdl-1080p',
      qualityRank: 1,
      qualityAssumed: false,
      baseScore: 0,
      score: 0,
      scoreBreakdown: [],
      preparationStep: 'remux',
      preparationAssumed: false,
      outcome: 'picked',
    });
    const grabId = await ctx.db.insert('grabs', { candidateId, protocol: 'usenet', state: 'importing', cancelRequested: false });
    for (const unitId of unitIds) await ctx.db.insert('grabUnits', { grabId, unitId, outcome: 'pending' });
    await ctx.db.insert('downloads', {
      grabId,
      clientKind: 'nzbget',
      correlationTag: grabId,
      state: 'completed',
      clientStage: 'downloading',
      contentPath: options.contentPath ?? `/data/downloads/usenet/series/${title}`,
    });
    return grabId;
  });
  await t.mutation(internal.pipeline.steps.startImport, { grabId });
  const w = await fakeWorker(t);
  const [job] = await w.claim('import');
  return job!;
}

const resolveFiles = (job: LeasedJob, relPaths: string[]) =>
  t.query(api.jobs.imports.resolveFiles, {
    ...worker,
    jobId: job.jobId,
    leaseEpoch: job.leaseEpoch,
    files: relPaths.map((relPath) => ({ relPath, sizeBytes: 1_000_000_000 })),
  });

describe('resolveFiles', () => {
  test('a scene-numbered file resolves through its scene row to the TMDB Unit the Grab wanted', async () => {
    // Ember Rite: XEM's scene S03E01 is TMDB S01E08 (TMDB merged the show into one season).
    await seedAnimeLists(t, 'fixture-v1', missingSeasonXml);
    await seedXemList(t, [7700007]);
    useMetadataFakes({ series: [...SERIES, emberRite()], xem: { shows: { 7700007: { all: missingSeasonShape } } } });
    const workId = await subscribe('900007', [1]);
    const e8 = await unitAt(workId, 1, 8);
    const job = await leasedImport(workId, 'Ember.Rite.S03E01.720p.HDTV.x264-GRP', [e8]);

    expect(await resolveFiles(job, ['Ember.Rite.S03E01.720p.HDTV.x264-GRP.mkv'])).toEqual([
      { relPath: 'Ember.Rite.S03E01.720p.HDTV.x264-GRP.mkv', unitIds: [e8] },
    ]);
  });

  test('an absolute-numbered anime file resolves to the TMDB Unit', async () => {
    await seedAnimeLists(t);
    const workId = await subscribe('900002', [1, 2]);
    const s2e1 = await unitAt(workId, 2, 1);
    const job = await leasedImport(workId, '[Group] Star Lantern - 13 [1080p]', [s2e1]);

    expect(await resolveFiles(job, ['[Group] Star Lantern - 13 [1080p].mkv'])).toEqual([{ relPath: '[Group] Star Lantern - 13 [1080p].mkv', unitIds: [s2e1] }]);
  });

  test("the alias the candidate's title matched is passed: a second-season name resolves through its AniDB entry", async () => {
    await seedAnimeLists(t);
    const workId = await subscribe('900002', [1, 2]);
    const s2e1 = await unitAt(workId, 2, 1);
    const job = await leasedImport(workId, '[Group] Star Lantern 2nd Season - 01 [1080p]', [s2e1]);

    expect(await resolveFiles(job, ['[Group] Star Lantern 2nd Season - 01 [1080p].mkv'])).toEqual([
      { relPath: '[Group] Star Lantern 2nd Season - 01 [1080p].mkv', unitIds: [s2e1] },
    ]);
  });

  test("the matched alias's scene season is passed: a Stone Ocean `- 01` file imports as S5E1, not unitNotFound", async () => {
    await seedXemList(t, [7700009]);
    useMetadataFakes({ series: [...SERIES, jojoParts()], xem: { shows: { 7700009: { all: jojoPartsShape, names: jojoPartsNames } } } });
    const { workId } = await admin.action(api.api.library.subscribe, {
      tmdbId: '900009',
      kind: 'series',
      libraryId: libraries.series,
      releaseProfileId: libraries.releaseProfileId,
      seasons: [5],
      numberingScheme: 'anime',
    });
    await settleSearches(t);
    const s5e1 = await unitAt(workId, 5, 1);
    const job = await leasedImport(workId, '[SubsPlease] JoJos Bizarre Adventure - Stone Ocean - 01 (1080p)', [s5e1]);

    expect(await resolveFiles(job, ['[SubsPlease] JoJos Bizarre Adventure - Stone Ocean - 01 (1080p) [ABCD1234].mkv'])).toEqual([
      { relPath: '[SubsPlease] JoJos Bizarre Adventure - Stone Ocean - 01 (1080p) [ABCD1234].mkv', unitIds: [s5e1] },
    ]);
  });

  test('when matchTitle fails on the candidate, no alias is passed: the same file reads as absolute 1', async () => {
    await seedAnimeLists(t);
    const workId = await subscribe('900002', [1, 2]);
    const s2e1 = await unitAt(workId, 2, 1);
    const job = await leasedImport(workId, '[Group] Lantern of Stars - 01 [1080p]', [s2e1]);

    expect(await resolveFiles(job, ['[Group] Star Lantern 2nd Season - 01 [1080p].mkv'])).toEqual([
      { relPath: '[Group] Star Lantern 2nd Season - 01 [1080p].mkv', unitIds: [await unitAt(workId, 1, 1)] },
    ]);
  });

  describe('Harbour Lights (TMDB numbers)', () => {
    let workId: Id<'works'>;
    beforeEach(async () => {
      workId = await subscribe('900001', [1]);
    });

    test("a file of a pack's other Unit (alsoContains) returns that Unit: the worker skips it", async () => {
      const [e1, e2] = [await unitAt(workId, 1, 1), await unitAt(workId, 1, 2)];
      const job = await leasedImport(workId, 'Harbour.Lights.S01.1080p.WEB-DL.AAC2.0.H.264-GRPB', [e1], { alsoContainsUnitIds: [e2] });

      expect(
        await resolveFiles(job, ['Harbour.Lights.S01E01.1080p.WEB-DL.AAC2.0.H.264-GRPB.mkv', 'Harbour.Lights.S01E02.1080p.WEB-DL.AAC2.0.H.264-GRPB.mkv']),
      ).toEqual([
        { relPath: 'Harbour.Lights.S01E01.1080p.WEB-DL.AAC2.0.H.264-GRPB.mkv', unitIds: [e1] },
        { relPath: 'Harbour.Lights.S01E02.1080p.WEB-DL.AAC2.0.H.264-GRPB.mkv', unitIds: [e2] },
      ]);
    });

    test("a proper's revision comes back, so the worker can keep the higher of two files for one Unit", async () => {
      const e1 = await unitAt(workId, 1, 1);
      const job = await leasedImport(workId, 'Harbour.Lights.S01.1080p.WEB-DL.AAC2.0.H.264-GRPB', [e1]);

      expect(
        await resolveFiles(job, [
          'Harbour.Lights.S01E01.1080p.WEB-DL.AAC2.0.H.264-GRPB.mkv',
          'Harbour.Lights.S01E01.PROPER.1080p.WEB-DL.AAC2.0.H.264-GRPB.mkv',
        ]),
      ).toEqual([
        { relPath: 'Harbour.Lights.S01E01.1080p.WEB-DL.AAC2.0.H.264-GRPB.mkv', unitIds: [e1] },
        { relPath: 'Harbour.Lights.S01E01.PROPER.1080p.WEB-DL.AAC2.0.H.264-GRPB.mkv', unitIds: [e1], revision: { version: 2, real: 0 } },
      ]);
    });

    test('a multi-episode file returns both Units, in order', async () => {
      const [e1, e2] = [await unitAt(workId, 1, 1), await unitAt(workId, 1, 2)];
      const job = await leasedImport(workId, 'Harbour.Lights.S01E01E02.1080p.WEB-DL.AAC2.0.H.264-GRPB', [e1, e2]);

      expect(await resolveFiles(job, ['Harbour.Lights.S01E01E02.1080p.WEB-DL.AAC2.0.H.264-GRPB.mkv'])).toEqual([
        { relPath: 'Harbour.Lights.S01E01E02.1080p.WEB-DL.AAC2.0.H.264-GRPB.mkv', unitIds: [e1, e2] },
      ]);
    });

    test('an obfuscated name with no numbers in its folders either returns no Units (noNumbers)', async () => {
      const e1 = await unitAt(workId, 1, 1);
      const job = await leasedImport(workId, 'Harbour.Lights.S01E01.1080p.WEB-DL.AAC2.0.H.264-GRPB', [e1], {
        contentPath: '/data/downloads/usenet/series/tigTH0xa4dVeMHQ',
      });

      // A season folder names no episode, so it is no fallback either.
      expect(await resolveFiles(job, ['tigTH0xa4dVeMHQ55EenTdeSvgRmA5Ek.mkv', 'Season 01/abc.mkv'])).toEqual([
        { relPath: 'tigTH0xa4dVeMHQ55EenTdeSvgRmA5Ek.mkv', unitIds: [], problem: 'noNumbers' },
        { relPath: 'Season 01/abc.mkv', unitIds: [], problem: 'noNumbers' },
      ]);
    });

    test("a file name without numbers falls back to its folder's name, the download's own folder for a file at its root", async () => {
      const [e1, e3] = [await unitAt(workId, 1, 1), await unitAt(workId, 1, 3)];
      const job = await leasedImport(workId, 'Harbour.Lights.S01E01.1080p.WEB-DL.AAC2.0.H.264-GRPB', [e1], {
        contentPath: '/data/downloads/usenet/series/Harbour.Lights.S01E01.1080p.WEB-DL.AAC2.0.H.264-GRPB',
      });

      expect(await resolveFiles(job, ['tigTH0xa4dVeMHQ55EenTdeSvgRmA5Ek.mkv', 'Harbour.Lights.S01E03.1080p.WEB-DL-GRP/abc.mkv'])).toEqual([
        { relPath: 'tigTH0xa4dVeMHQ55EenTdeSvgRmA5Ek.mkv', unitIds: [e1] },
        { relPath: 'Harbour.Lights.S01E03.1080p.WEB-DL-GRP/abc.mkv', unitIds: [e3] },
      ]);
    });

    test('numbers no Unit has return no Units (unitNotFound)', async () => {
      const e1 = await unitAt(workId, 1, 1);
      const job = await leasedImport(workId, 'Harbour.Lights.S01E01.1080p.WEB-DL.AAC2.0.H.264-GRPB', [e1]);

      expect(await resolveFiles(job, ['Harbour.Lights.S01E09.1080p.WEB-DL.AAC2.0.H.264-GRPB.mkv'])).toEqual([
        { relPath: 'Harbour.Lights.S01E09.1080p.WEB-DL.AAC2.0.H.264-GRPB.mkv', unitIds: [], problem: 'unitNotFound' },
      ]);
    });

    test('a stale leaseEpoch is refused', async () => {
      const job = await leasedImport(workId, 'Harbour.Lights.S01E01.1080p.WEB-DL.AAC2.0.H.264-GRPB', [await unitAt(workId, 1, 1)]);
      await expect(resolveFiles({ ...job, leaseEpoch: job.leaseEpoch + 1 }, ['a.mkv'])).rejects.toThrow(/staleLease/);
    });

    test('an admin caller is refused: the worker token is the only way in', async () => {
      const job = await leasedImport(workId, 'Harbour.Lights.S01E01.1080p.WEB-DL.AAC2.0.H.264-GRPB', [await unitAt(workId, 1, 1)]);
      await expect(
        admin.query(api.jobs.imports.resolveFiles, { ...worker, workerToken: 'session-token', jobId: job.jobId, leaseEpoch: job.leaseEpoch, files: [] }),
      ).rejects.toThrow(/unauthorized/);
    });
  });

  test('a movie has no numbers to resolve: the worker never asks, and each file comes back without Units', async () => {
    const workId = await subscribe('900101', [], 'movie');
    const unitId = (await t.run((ctx) =>
      ctx.db
        .query('units')
        .withIndex('by_work', (q) => q.eq('workId', workId))
        .first(),
    ))!._id;
    const job = await leasedImport(workId, 'Lighthouse.Keeper.2020.1080p.WEB-DL.AAC2.0.H.264-GRP', [unitId]);

    expect(await resolveFiles(job, ['Lighthouse.Keeper.2020.1080p.WEB-DL.AAC2.0.H.264-GRP.mkv'])).toEqual([
      { relPath: 'Lighthouse.Keeper.2020.1080p.WEB-DL.AAC2.0.H.264-GRP.mkv', unitIds: [] },
    ]);
  });
});

describe("a pack's also-contained Unit whose own file never played", () => {
  const h = pipelineHarness();
  const E3_NAME = 'Harbour.Lights.S01E03.1080p.WEB-DL.AAC2.0.H.264-GRPB';
  const PAIR_NAME = 'Harbour.Lights.S01E02-E03.1080p.WEB-DL.AAC2.0.H.264-GRPB';
  const E3 = release('s1e3', E3_NAME);
  const PAIR = release('s1e2e3', PAIR_NAME);
  const fitting = (name: string) => () => [{ relPath: `${name}.mp4`, sizeBytes: 1_000_000 }];
  /** Jellyfin files the pack file as S01E02 alone: a misread for E03. */
  const E02_ONLY: TargetReading = { kind: 'episode', season: 1, episode: 2 };
  let w: FakeWorker;
  let e2: Doc<'units'>;
  let e3: Doc<'units'>;

  /** The one indexer now lists these releases. */
  const list = (...items: FakeItem[]) => {
    h.fake = createNewznabHandler({ apiKey: INDEXER_KEY, items });
    useFetchFakes({ indexers: { 'indexer.fake': h.fake.handle } });
  };

  beforeEach(async () => {
    // Nothing listed yet, so subscribing grabs nothing.
    await h.indexer([]);
    w = await h.worker();
    const workId = await h.subscribe();
    e2 = await h.unit(workId, 1, 2);
    e3 = await h.unit(workId, 1, 3);
  });

  const activeDownload = async () => (await h.all('downloads')).find((d) => d.state === 'active')!._id;
  /** Puts every waiting job back in the queue, so the next claim takes its retry. */
  const requeue = () =>
    h.t.run(async (ctx) => {
      for (const row of await ctx.db.query('jobs').collect())
        if (row.status === 'waiting') await ctx.db.patch(row._id, { status: 'queued', availableAt: undefined });
    });
  /** Completes the queued publish, each Publication read as `reading` when one is given. */
  async function publishReading(reading?: (publicationId: string) => TargetReading | undefined) {
    const [job] = await w.claim('publish');
    const ids = job!.payload.class === 'publish' ? job!.payload.publicationIds : [];
    const readings = Object.fromEntries(ids.flatMap((id) => (reading?.(id) ? [[id, reading(id)!]] : [])));
    await w.complete(job!, { class: 'publish', targetItemRefs: Object.fromEntries(ids.map((id) => [id, `jf-${id}`])), readings });
    await h.settle();
  }
  /** E03's own release, downloaded and imported; its publish is left queued. */
  async function importE3() {
    list(E3);
    await h.admin.mutation(api.api.units.searchNow, { unitIds: [e3._id] });
    await h.settle();
    await w.submitAll();
    await h.settle();
    await w.completed(await activeDownload());
    await h.settle();
    await w.importAll({ probe: FITTING_PROBE, files: fitting(E3_NAME) });
    await h.settle();
  }
  /** E02's search grabs S01E02-E03, with E03 as the Grab's optional Unit; downloaded and imported, its publish left queued. */
  async function grabPair() {
    list(PAIR);
    await h.admin.mutation(api.api.units.searchNow, { unitIds: [e2._id] });
    await h.settle();
    const grab = (await h.all('grabs')).at(-1)!;
    expect((await h.all('grabUnits')).filter((row) => row.grabId === grab._id).map((row) => row.unitId)).toEqual([e2._id, e3._id]);
    await w.submitAll();
    await h.settle();
    await w.completed(await activeDownload());
    await h.settle();
    const [job] = await w.importAll({ probe: FITTING_PROBE, files: fitting(PAIR_NAME) });
    expect(job!.payload).toMatchObject({ expectedUnits: [{ unitId: e2._id }, { unitId: e3._id, optional: true }] });
    await h.settle();
  }
  const pairFile = async () => (await h.all('files')).find((file) => file.path.includes('S01E02-E03'))!;
  const e3Files = async () => (await h.all('fileUnits')).filter((link) => link.unitId === e3._id).map((link) => link.fileId);
  const deletedPaths = async () =>
    (await h.all('jobs'))
      .filter((row) => row.payload?.class === 'maintenance' && row.payload.action === 'deleteLibraryFiles')
      .flatMap((row) => (row.payload as { paths: string[] }).paths);

  test("an E03 whose own download never reached Jellyfin gets the pack's file, and its old file is retired once the pack's file is visible", async () => {
    await importE3();
    for (let attempt = 0; attempt < DEFAULT_LIMITS.maxAttempts.publish; attempt++) {
      const [job] = await w.claim('publish');
      await w.fail(job!, 'jellyfinUnavailable');
      await requeue();
    }
    await h.settle();
    const [unplayed] = await e3Files();
    expect((await h.get(e3._id))!.activeGrabId).toBeUndefined();

    await grabPair();
    // Until Jellyfin lists the pack's file, E03's old file stays.
    expect(await e3Files()).toHaveLength(2);
    await publishReading();

    expect((await h.get(e2._id))!.derivedState).toBe('ready');
    expect((await h.get(e3._id))!.derivedState).toBe('ready');
    const pair = await pairFile();
    expect(await e3Files()).toEqual([pair._id]);
    expect((await h.all('fileVersions')).filter((version) => version.unitId === e3._id).map((version) => [version.kind, version.fileId])).toEqual([
      ['primary', pair._id],
    ]);
    expect((await h.all('publications')).filter((p) => p.unitId === e3._id).map((p) => p.state)).toEqual(['visible']);
    expect(await h.get(unplayed!)).toBeNull();
    expect(await deletedPaths()).toEqual([expect.stringContaining('S01E03')]);
  });

  test('a scanned E03 whose publish failed keeps its file: the pack is linked beside it and nothing is deleted', async () => {
    const { fileId: scanned, versionIds } = await seedFile(h.t, {
      unitIds: [e3._id],
      origin: 'scan',
      keepsName: true,
      release: null,
      published: false,
      path: '/data/library/series/Harbour Lights (2024)/Season 01/Harbour Lights - S01E03.mkv',
    });
    await h.t.run(async (ctx) => {
      await ctx.db.insert('publications', { unitId: e3._id, fileVersionId: versionIds[0]!, generation: 0, target: 'jellyfin', state: 'failed' });
      await recomputeUnits(ctx, [e3._id]);
    });

    await grabPair();
    await publishReading();

    expect((await e3Files()).sort()).toEqual([scanned, (await pairFile())._id].sort());
    expect(await h.get(scanned)).not.toBeNull();
    expect(await deletedPaths()).toEqual([]);
  });

  test('an E03 whose own file Jellyfin misread keeps it: the file is in the library, so nothing is retired', async () => {
    await importE3();
    await publishReading(() => ({ kind: 'episode', season: 1, episode: 9 }));
    const [misread] = await e3Files();
    expect((await h.all('publications')).find((p) => p.unitId === e3._id)!.state).toBe('failed');
    await grabPair();
    await publishReading();

    expect((await e3Files()).sort()).toEqual([misread!, (await pairFile())._id].sort());
    expect(await h.get(misread!)).not.toBeNull();
    expect(await deletedPaths()).toEqual([]);
  });

  test("a pack file Jellyfin misreads for E03 retires nothing: E03's never-played file stays", async () => {
    await importE3();
    for (let attempt = 0; attempt < DEFAULT_LIMITS.maxAttempts.publish; attempt++) {
      const [job] = await w.claim('publish');
      await w.fail(job!, 'jellyfinUnavailable');
      await requeue();
    }
    await h.settle();
    const [unplayed] = await e3Files();

    await grabPair();
    const e3Publications = async () => (await h.all('publications')).filter((p) => p.unitId === e3._id);
    const pending = new Set<string>((await e3Publications()).filter((p) => p.state === 'pending').map((p) => p._id));
    await publishReading((id) => (pending.has(id) ? E02_ONLY : undefined));

    expect((await e3Publications()).map((p) => p.state)).toEqual(['failed', 'failed']);
    expect((await e3Files()).sort()).toEqual([unplayed!, (await pairFile())._id].sort());
    expect(await h.get(unplayed!)).not.toBeNull();
    expect(await deletedPaths()).toEqual([]);
  });

  /** E03's own file imported, and every attempt at its publish failed: a primary that never played. */
  async function failedE3() {
    await importE3();
    for (let attempt = 0; attempt < DEFAULT_LIMITS.maxAttempts.publish; attempt++) {
      const [job] = await w.claim('publish');
      await w.fail(job!, 'jellyfinUnavailable');
      await requeue();
    }
    await h.settle();
    return (await e3Files())[0]!;
  }
  /** After the pack's file is visible, E03 keeps `kept` beside it and nothing is deleted. */
  async function expectKept(kept: Id<'files'>[]) {
    expect((await h.all('publications')).find((p) => p.unitId === e3._id && p.state === 'visible')).toBeDefined();
    expect((await e3Files()).sort()).toEqual([...kept, (await pairFile())._id].sort());
    for (const fileId of kept) expect(await h.get(fileId)).not.toBeNull();
    expect(await deletedPaths()).toEqual([]);
  }

  test('a kept original that played, whose prepared output never reached Jellyfin, is kept: a Unit with an original retires nothing', async () => {
    await importE3();
    await publishReading();
    const [played] = await e3Files();
    // Preparation kept the played download as the original (its Publications deleted) and its output's publish failed.
    const output = await h.t.run(async (ctx) => {
      const versions = await ctx.db
        .query('fileVersions')
        .withIndex('by_unit', (q) => q.eq('unitId', e3._id))
        .collect();
      const original = versions.find((version) => version.fileId === played)!;
      for (const publication of await ctx.db
        .query('publications')
        .withIndex('by_unit', (q) => q.eq('unitId', e3._id))
        .collect())
        await ctx.db.delete(publication._id);
      await ctx.db.patch(original._id, { kind: 'original' });
      const source = (await ctx.db.get(played!))!;
      const outputId = await ctx.db.insert('files', {
        ...(({ _id, _creationTime, ...rest }) => rest)(source),
        path: source.path.replace(/\.mp4$/, '.m4v'),
        origin: 'prepared',
        inode: '9:prepared',
      });
      await ctx.db.insert('fileUnits', { fileId: outputId, unitId: e3._id });
      const versionId = await ctx.db.insert('fileVersions', {
        unitId: e3._id,
        fileId: outputId,
        kind: 'primary',
        playbackProfileId: original.playbackProfileId,
        fits: true,
      });
      await ctx.db.insert('publications', { unitId: e3._id, fileVersionId: versionId, generation: 0, target: 'jellyfin', state: 'failed' });
      await recomputeUnits(ctx, [e3._id]);
      return outputId;
    });

    await grabPair();
    await publishReading();
    await expectKept([played!, output]);
  });

  test("an E03 file of the pack's own release is kept", async () => {
    const unplayed = await failedE3();
    await grabPair();
    await h.t.run(async (ctx) => {
      const pair = (await ctx.db.query('files').collect()).find((file) => file.path.includes('S01E02-E03'))!;
      await ctx.db.patch(unplayed, { candidateId: pair.candidateId });
    });
    await publishReading();
    await expectKept([unplayed]);
  });

  test('an E03 file that was visible once is kept, though its Publication has failed since: the timeline says it played', async () => {
    await importE3();
    await publishReading();
    const [played] = await e3Files();
    await h.t.run(async (ctx) => {
      for (const publication of await ctx.db
        .query('publications')
        .withIndex('by_unit', (q) => q.eq('unitId', e3._id))
        .collect())
        await ctx.db.patch(publication._id, { state: 'failed', targetItemRef: undefined });
      await recomputeUnits(ctx, [e3._id]);
    });

    await grabPair();
    await publishReading();
    await expectKept([played!]);
  });

  test('an E03 file whose Publication is still pending is kept: its publish has not settled', async () => {
    const unplayed = await failedE3();
    await h.t.run(async (ctx) => {
      for (const publication of await ctx.db
        .query('publications')
        .withIndex('by_unit', (q) => q.eq('unitId', e3._id))
        .collect())
        await ctx.db.patch(publication._id, { state: 'pending' });
    });

    await grabPair();
    await publishReading();
    await expectKept([unplayed]);
  });
});
