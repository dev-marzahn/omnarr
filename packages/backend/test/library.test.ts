import { MOVIES, SERIES } from '@omnarr/e2e/fakes/tmdb/fixtures';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';

import { api } from '../convex/_generated/api';
import { MKV_PROBE, PREPARED_PROBE, prepareWorker, SEASON_1, seedFile, seedShow, seedUnit } from './fakePrepare';
import { asAdmin, seedLibraries, settleSearches, setup, useMetadataFakes, worker, type Backend, type Libraries } from './setup';

let t: Backend;
let admin: Awaited<ReturnType<typeof asAdmin>>;
let libraries: Libraries;

beforeEach(async () => {
  t = setup();
  admin = await asAdmin(t);
  libraries = await seedLibraries(t);
  useMetadataFakes();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** Harbour Lights in the fake: specials (1), season 1 (6) and season 2 (6), all aired. */
const HARBOUR_LIGHTS = '900001';
/** A Japanese animation: TMDB genre Animation, origin JP. */
const STAR_LANTERN = '900002';
const QUIET_ORCHARD = '900101';

/** Subscribes, then lets the subscribe search end: with no indexer it fails, and the Units show "wanted". */
const subscribeSeries = async (tmdbId: string, seasons: number[]) => {
  const response = await admin.action(api.api.library.subscribe, {
    tmdbId,
    kind: 'series',
    libraryId: libraries.series,
    releaseProfileId: libraries.releaseProfileId,
    seasons,
  });
  await settleSearches(t);
  return response;
};

describe('library.subscribe', () => {
  test('creates the Work, which its library lists', async () => {
    const { workId } = await subscribeSeries(HARBOUR_LIGHTS, [1, 2]);
    const { works } = await admin.query(api.api.library.list, { kind: 'series' });
    expect(works).toEqual([expect.objectContaining({ workId, title: 'Harbour Lights', year: 2021, kind: 'series', numberingScheme: 'standard', units: 13 })]);
  });

  // The panel's "Monitor new episodes" switch.
  test('stores whether episodes TMDB adds later are monitored: on unless the request turns it off', async () => {
    const { workId: on } = await subscribeSeries(HARBOUR_LIGHTS, [1]);
    const { workId: off } = await admin.action(api.api.library.subscribe, {
      tmdbId: STAR_LANTERN,
      kind: 'series',
      libraryId: libraries.series,
      releaseProfileId: libraries.releaseProfileId,
      seasons: [],
      monitorNewUnits: false,
    });
    await settleSearches(t);
    expect((await admin.query(api.api.library.detail, { workId: on }))!.work.monitorNewUnits).toBe(true);
    expect((await admin.query(api.api.library.detail, { workId: off }))!.work.monitorNewUnits).toBe(false);
  });

  test('creates one Unit per episode in TMDB order; specials start unmonitored, aired episodes are wanted', async () => {
    const { workId } = await subscribeSeries(HARBOUR_LIGHTS, [1, 2]);
    const detail = await admin.query(api.api.library.detail, { workId });
    const rows = detail!.units.map((u) => [u.kind, u.tmdbSeason, u.tmdbEpisode, u.monitored, u.state]);
    expect(rows).toEqual([
      ['special', 0, 1, false, 'notMonitored'],
      ...[1, 2, 3, 4, 5, 6].map((e) => ['episode', 1, e, true, 'wanted']),
      ...[1, 2, 3, 4, 5, 6].map((e) => ['episode', 2, e, true, 'wanted']),
    ]);
    expect(detail!.units[1]).toMatchObject({ title: 'Episode 1', airDateUtc: Date.UTC(2021, 2, 4), cancelRequested: false });
  });

  // This reads the mapping tables directly rather than through release
  // matching.
  test('records the Work and Unit external IDs and an absolute mapping per regular episode', async () => {
    const { workId } = await subscribeSeries(HARBOUR_LIGHTS, [1, 2]);
    const { workIds, unitRefs, mappings } = await t.run(async (ctx) => {
      const units = await ctx.db
        .query('units')
        .withIndex('by_work', (q) => q.eq('workId', workId))
        .collect();
      const s2e6 = units.find((u) => u.tmdbSeason === 2 && u.tmdbEpisode === 6)!;
      const externalIds = await ctx.db.query('externalIds').collect();
      const mappings = await ctx.db
        .query('unitMappings')
        .withIndex('by_ordering', (q) => q.eq('workId', workId).eq('ordering', 'absolute'))
        .collect();
      return {
        workIds: externalIds.filter((row) => row.workId === workId).map((row) => [row.provider, row.value]),
        unitRefs: externalIds.filter((row) => row.unitId === s2e6._id).map((row) => [row.provider, row.value]),
        mappings: mappings
          .map((m) => {
            const unit = units.find((u) => u._id === m.unitId)!;
            return [unit.tmdbSeason, unit.tmdbEpisode, m.absolute, m.source];
          })
          .sort((a, b) => (a[2] as number) - (b[2] as number)),
      };
    });
    expect(workIds).toEqual([
      ['tmdb', '900001'],
      ['tvdb', '7700001'],
      ['imdb', 'tt9900001'],
    ]);
    expect(unitRefs).toEqual([['tmdb', '910205']]);
    expect(mappings).toEqual([...[1, 2, 3, 4, 5, 6].map((e) => [1, e, e, 'tmdb']), ...[1, 2, 3, 4, 5, 6].map((e) => [2, e, 6 + e, 'tmdb'])]);
  });

  test('subscribing to a title already in the library returns its Work and creates nothing', async () => {
    const first = await subscribeSeries(HARBOUR_LIGHTS, [1, 2]);
    const second = await subscribeSeries(HARBOUR_LIGHTS, [1]);
    expect(second).toEqual({ workId: first.workId, created: false });
    const { works } = await admin.query(api.api.library.list, { kind: 'series' });
    expect(works).toHaveLength(1);
    expect(works[0]).toMatchObject({ units: 13, monitored: 12 });
  });

  test('an episode that airs later, or has no air date, is "not aired"', async () => {
    const day = 24 * 60 * 60 * 1000;
    const date = (offsetDays: number) => new Date(Date.now() + offsetDays * day).toISOString().slice(0, 10);
    const episode = (n: number, air_date: string | null) => ({ id: 990000 + n, season_number: 1, episode_number: n, name: `Episode ${n}`, air_date });
    useMetadataFakes({
      series: [
        {
          ...SERIES[0]!,
          id: 990001,
          name: 'Tidewater',
          seasons: [
            { id: 99001, season_number: 1, name: 'Season 1', air_date: date(-7), episodes: [episode(1, date(-7)), episode(2, date(7)), episode(3, null)] },
          ],
        },
      ],
    });
    const { workId } = await subscribeSeries('990001', [1]);
    const detail = await admin.query(api.api.library.detail, { workId });
    expect(detail!.units.map((u) => u.state)).toEqual(['wanted', 'notAired', 'notAired']);
  });

  test('a season left out is not monitored', async () => {
    const { workId } = await subscribeSeries(HARBOUR_LIGHTS, [2]);
    const detail = await admin.query(api.api.library.detail, { workId });
    expect(detail!.units.filter((u) => u.tmdbSeason === 1).map((u) => u.state)).toEqual(Array(6).fill('notMonitored'));
    expect(detail!.work).toMatchObject({
      units: 13,
      monitored: 6,
      states: [
        { state: 'notMonitored', count: 7 },
        { state: 'wanted', count: 6 },
      ],
    });
  });

  test('specials are always created unmonitored: season 0 cannot be chosen at subscribe', async () => {
    await expect(subscribeSeries(HARBOUR_LIGHTS, [0, 1, 2])).rejects.toThrow();
  });

  test('open Issues show beside the state: the list counts Issues, the row carries one', async () => {
    const { workId } = await subscribeSeries(HARBOUR_LIGHTS, [1, 2]);
    const unitId = (await admin.query(api.api.library.detail, { workId }))!.units[1]!.unitId;
    await t.run(async (ctx) => {
      for (const failureCode of ['transcodeFailed', 'jellyfinUnavailable'] as const) {
        await ctx.db.insert('issues', { scope: 'unit', unitId, failureCode, class: 'preparation', state: 'open', fixActions: [] });
      }
    });
    expect((await admin.query(api.api.library.list, { kind: 'series' })).works[0]).toMatchObject({ openIssues: 2 });
    const row = (await admin.query(api.api.library.detail, { workId }))!.units[1]!;
    expect(row).toMatchObject({ state: 'wanted', openIssue: { failureCode: 'transcodeFailed' } });
  });

  test('anime numbering is preselected for a Japanese animation, and can be overridden', async () => {
    const preselected = await subscribeSeries(STAR_LANTERN, [1, 2]);
    expect((await admin.query(api.api.library.detail, { workId: preselected.workId }))!.work.numberingScheme).toBe('anime');
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query('externalIds').collect()) await ctx.db.delete(row._id);
    });
    const overridden = await admin.action(api.api.library.subscribe, {
      tmdbId: STAR_LANTERN,
      kind: 'series',
      libraryId: libraries.series,
      releaseProfileId: libraries.releaseProfileId,
      seasons: [1],
      numberingScheme: 'standard',
    });
    expect((await admin.query(api.api.library.detail, { workId: overridden.workId }))!.work.numberingScheme).toBe('standard');
  });

  test('a movie is one monitored Unit in the Movies library', async () => {
    const { workId } = await admin.action(api.api.library.subscribe, {
      tmdbId: QUIET_ORCHARD,
      kind: 'movie',
      libraryId: libraries.movies,
      releaseProfileId: libraries.releaseProfileId,
      seasons: [],
    });
    await settleSearches(t);
    const detail = await admin.query(api.api.library.detail, { workId });
    expect(detail!.work).toMatchObject({ kind: 'movie', title: 'The Quiet Orchard', year: 2020 });
    expect(detail!.units).toEqual([expect.objectContaining({ kind: 'movie', monitored: true, state: 'wanted', airDateUtc: Date.UTC(2020, 8, 18) })]);
    expect((await admin.query(api.api.library.list, { kind: 'movies' })).works.map((w) => w.workId)).toEqual([workId]);
    expect((await admin.query(api.api.library.list, { kind: 'series' })).works).toEqual([]);
  });

  describe('from an existing folder (the scan import)', () => {
    const searches = () => t.run((ctx) => ctx.db.query('searchAttempts').collect());

    test('a series stores the folder and, with seasons = [], monitors nothing and starts no search', async () => {
      const { workId } = await admin.action(api.api.library.subscribe, {
        tmdbId: HARBOUR_LIGHTS,
        kind: 'series',
        libraryId: libraries.series,
        releaseProfileId: libraries.releaseProfileId,
        seasons: [],
        monitorNewUnits: false,
        folder: 'Harbour Lights (2021)',
      });
      expect(await t.run(async (ctx) => (await ctx.db.get(workId))!.folder)).toBe('Harbour Lights (2021)');
      const detail = (await admin.query(api.api.library.detail, { workId }))!;
      expect(detail.units.every((u) => !u.monitored)).toBe(true);
      expect(detail.work.monitorNewUnits).toBe(false);
      expect(await searches()).toEqual([]);
    });

    test('a movie starts unmonitored too, with no search', async () => {
      const { workId } = await admin.action(api.api.library.subscribe, {
        tmdbId: QUIET_ORCHARD,
        kind: 'movie',
        libraryId: libraries.movies,
        releaseProfileId: libraries.releaseProfileId,
        seasons: [],
        folder: 'The Quiet Orchard (2020)',
      });
      expect(await t.run(async (ctx) => (await ctx.db.get(workId))!.folder)).toBe('The Quiet Orchard (2020)');
      expect((await admin.query(api.api.library.detail, { workId }))!.units).toEqual([expect.objectContaining({ monitored: false })]);
      expect(await searches()).toEqual([]);
    });

    test('a title already in the library keeps its own folder', async () => {
      const { workId } = await subscribeSeries(HARBOUR_LIGHTS, [1]);
      const again = await admin.action(api.api.library.subscribe, {
        tmdbId: HARBOUR_LIGHTS,
        kind: 'series',
        libraryId: libraries.series,
        releaseProfileId: libraries.releaseProfileId,
        seasons: [],
        folder: 'Elsewhere (2021)',
      });
      expect(again).toEqual({ workId, created: false });
      expect(await t.run(async (ctx) => (await ctx.db.get(workId))!.folder ?? null)).toBeNull();
    });
  });

  test('a series and a movie with the same TMDB ID are different titles', async () => {
    useMetadataFakes({ movies: [{ ...MOVIES[0]!, id: Number(HARBOUR_LIGHTS) }] });
    const series = await subscribeSeries(HARBOUR_LIGHTS, [1]);
    const movie = await admin.action(api.api.library.subscribe, {
      tmdbId: HARBOUR_LIGHTS,
      kind: 'movie',
      libraryId: libraries.movies,
      releaseProfileId: libraries.releaseProfileId,
      seasons: [],
    });
    expect(movie.created).toBe(true);
    expect(movie.workId).not.toBe(series.workId);
  });

  test('a series can only go into the Series library', async () => {
    await expect(
      admin.action(api.api.library.subscribe, {
        tmdbId: HARBOUR_LIGHTS,
        kind: 'series',
        libraryId: libraries.movies,
        releaseProfileId: libraries.releaseProfileId,
        seasons: [1],
      }),
    ).rejects.toThrow(/wrongLibrary/);
  });

  test('an ID TMDB does not know is refused', async () => {
    await expect(subscribeSeries('123', [1])).rejects.toThrow(/notFound/);
  });

  test('only an admin can subscribe, read the library or prepare all; a worker is refused', async () => {
    const workId = await seedShow(t, libraries);
    await expect(t.mutation(api.api.library.prepareAll, { workId })).rejects.toThrow(/unauthorized/);
    await expect(t.mutation(api.api.library.prepareAll, { ...worker, workId } as never)).rejects.toThrow();
    await expect(t.query(api.api.library.detail, { ...worker, workId } as never)).rejects.toThrow();
  });

  test('only an admin can subscribe or read the library', async () => {
    const args = { tmdbId: HARBOUR_LIGHTS, kind: 'series' as const, libraryId: libraries.series, releaseProfileId: libraries.releaseProfileId, seasons: [1] };
    await expect(t.action(api.api.library.subscribe, args)).rejects.toThrow(/unauthorized/);
    await expect(t.query(api.api.library.list, { kind: 'series' })).rejects.toThrow(/unauthorized/);
  });
});

describe('preparation on the Work page', () => {
  test('notInTargetCount on library.detail only: the primary versions that don’t fit', async () => {
    const workId = await seedShow(t, libraries);
    for (const [episode, probe] of [
      [1, MKV_PROBE],
      [2, MKV_PROBE],
      [3, PREPARED_PROBE],
    ] as const) {
      const unitId = await seedUnit(t, workId, episode);
      await seedFile(t, { unitIds: [unitId], probe, path: `${SEASON_1}/${episode}.mkv`, fits: probe === PREPARED_PROBE });
    }
    // A kept original that doesn't fit isn't in the library.
    await seedFile(t, { unitIds: [(await seedUnit(t, workId, 4))!], kind: 'original', published: false, path: '/data/originals/series/x.mkv' });
    expect((await admin.query(api.api.library.detail, { workId }))!.work.notInTargetCount).toBe(2);
    const { works } = await admin.query(api.api.library.list, { kind: 'series' });
    expect(works[0]!.notInTargetCount).toBeUndefined();
  });

  test('prepareAll queues one bulk job per file that doesn’t fit, and says how many; a Unit row shows its pending Rendition with the job’s progress', async () => {
    const workId = await seedShow(t, libraries);
    const units = [];
    for (const episode of [1, 2]) {
      const unitId = await seedUnit(t, workId, episode);
      units.push(unitId);
      await seedFile(t, { unitIds: [unitId], probe: MKV_PROBE, path: `${SEASON_1}/${episode}.mkv` });
    }
    expect(await admin.mutation(api.api.library.prepareAll, { workId })).toEqual({ queued: 2 });
    expect(await admin.mutation(api.api.library.prepareAll, { workId })).toEqual({ queued: 0 });

    const w = await prepareWorker(t);
    const [job] = await w.claim();
    await t.mutation(api.jobs.queue.progress, { ...worker, jobId: job!.jobId, leaseEpoch: job!.leaseEpoch, fraction: 0.4, detail: 'Remux Matroska → MP4' });
    const rows = (await admin.query(api.api.library.detail, { workId }))!.units;
    const rendition = (await t.run((ctx) => ctx.db.query('renditions').collect())).find((row) => row.jobId === job!.jobId)!;
    const leased = rows.find((row) => row.preparation?.renditionId === rendition._id)!;
    expect(leased).toMatchObject({
      state: 'preparing',
      preparation: { renditionId: rendition._id, steps: ['remux'], fraction: 0.4, detail: 'Remux Matroska → MP4' },
    });
    const queued = rows.find((row) => row.unitId !== leased.unitId)!;
    expect(queued.preparation).toMatchObject({ steps: ['remux'] });
    expect(queued.preparation?.fraction).toBeUndefined();
  });

  test("the Work's summary counts its pending preparations, with the running one's fraction once it reports", async () => {
    const workId = await seedShow(t, libraries);
    for (const episode of [1, 2]) {
      const unitId = await seedUnit(t, workId, episode);
      await seedFile(t, { unitIds: [unitId], probe: MKV_PROBE, path: `${SEASON_1}/${episode}.mkv` });
    }
    const summary = async () => (await admin.query(api.api.library.list, { kind: 'series' })).works[0]!;
    expect((await summary()).activePreparations).toBeUndefined();

    await admin.mutation(api.api.library.prepareAll, { workId });
    expect((await summary()).activePreparations).toEqual({ count: 2 });
    expect((await admin.query(api.api.library.detail, { workId }))!.work.activePreparations).toEqual({ count: 2 });

    const [job] = await (await prepareWorker(t)).claim();
    await t.mutation(api.jobs.queue.progress, { ...worker, jobId: job!.jobId, leaseEpoch: job!.leaseEpoch, fraction: 0.25, detail: 'Remux Matroska → MP4' });
    expect((await summary()).activePreparations).toEqual({ count: 2, fraction: 0.25 });
  });

  test("the Timeline carries the pending preparation's fraction and detail; none once nothing prepares", async () => {
    const workId = await seedShow(t, libraries);
    const [preparing, idle] = [await seedUnit(t, workId, 1), await seedUnit(t, workId, 2)];
    await seedFile(t, { unitIds: [preparing!], probe: MKV_PROBE, path: `${SEASON_1}/1.mkv` });
    await seedFile(t, { unitIds: [idle!], probe: PREPARED_PROBE, path: `${SEASON_1}/2.mkv`, fits: true });
    const timeline = async (unitId: typeof preparing) => (await admin.query(api.api.units.timeline, { unitId: unitId! }))!;

    await admin.mutation(api.api.library.prepareAll, { workId });
    expect((await timeline(preparing)).preparation).toEqual({});

    const [job] = await (await prepareWorker(t)).claim();
    await t.mutation(api.jobs.queue.progress, { ...worker, jobId: job!.jobId, leaseEpoch: job!.leaseEpoch, fraction: 0, detail: 'Checking the file' });
    expect((await timeline(preparing)).preparation).toEqual({ fraction: 0, detail: 'Checking the file' });
    await t.mutation(api.jobs.queue.progress, { ...worker, jobId: job!.jobId, leaseEpoch: job!.leaseEpoch, fraction: 0.6, detail: 'Remux Matroska → MP4' });
    expect((await timeline(preparing)).preparation).toEqual({ fraction: 0.6, detail: 'Remux Matroska → MP4' });
    expect((await timeline(idle)).preparation).toBeUndefined();
  });

  test('a job requeued with a progress row left from its lease counts as preparing, with no fraction or detail', async () => {
    const workId = await seedShow(t, libraries);
    const unitId = (await seedUnit(t, workId, 1))!;
    await seedFile(t, { unitIds: [unitId], probe: MKV_PROBE, path: `${SEASON_1}/1.mkv` });
    await admin.mutation(api.api.library.prepareAll, { workId });
    const [job] = await (await prepareWorker(t)).claim();
    const lease = { ...worker, jobId: job!.jobId, leaseEpoch: job!.leaseEpoch };
    await t.mutation(api.jobs.queue.progress, { ...lease, fraction: 0.4, detail: 'Video conversion HEVC → H.264' });
    await t.mutation(api.jobs.queue.release, lease);

    expect((await admin.query(api.api.units.timeline, { unitId }))!.preparation).toEqual({});
    expect((await admin.query(api.api.library.list, { kind: 'series' })).works[0]!.activePreparations).toEqual({ count: 1 });
    const [row] = (await admin.query(api.api.library.detail, { workId }))!.units;
    expect(row!.preparation).not.toHaveProperty('fraction');
    expect(row!.preparation).not.toHaveProperty('detail');
  });

  test("activePreparations' fraction is the mean of the leased jobs' fractions", async () => {
    const workId = await seedShow(t, libraries);
    for (const episode of [1, 2, 3]) {
      const unitId = await seedUnit(t, workId, episode);
      await seedFile(t, { unitIds: [unitId], probe: MKV_PROBE, path: `${SEASON_1}/${episode}.mkv` });
    }
    await admin.mutation(api.api.library.prepareAll, { workId });
    const w = await prepareWorker(t);
    const [first, second] = await w.claim(2);
    await t.mutation(api.jobs.queue.progress, { ...worker, jobId: first!.jobId, leaseEpoch: first!.leaseEpoch, fraction: 0.2 });
    await t.mutation(api.jobs.queue.progress, { ...worker, jobId: second!.jobId, leaseEpoch: second!.leaseEpoch, fraction: 0.6 });
    const { activePreparations } = (await admin.query(api.api.library.list, { kind: 'series' })).works[0]!;
    expect(activePreparations?.count).toBe(3);
    expect(activePreparations?.fraction).toBeCloseTo(0.4);
  });
});
