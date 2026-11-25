import { createNyaaHandler, type NyaaHandler } from '@omnarr/e2e/fakes/nyaa';
import { jojoParts, SERIES } from '@omnarr/e2e/fakes/tmdb/fixtures';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';

import { api, internal } from '../convex/_generated/api';
import type { Doc, Id } from '../convex/_generated/dataModel';
import { CONVEX_ACTION_LIMIT_MS } from '../convex/lib/limits';
import { type SearchTrigger, startSearch } from '../convex/pipeline/search';
import jojoPartsNames from './fixtures/xem/jojoPartsNames.json';
import jojoPartsShape from './fixtures/xem/jojoPartsShape.json';
import {
  asAdmin,
  fetchXem,
  seedAnimeLists,
  seedLibraries,
  seedIndexer,
  seedNyaa,
  seedXemList,
  settleSearches,
  setup,
  shippedProfile,
  useFetchFakes,
  type Backend,
  type Libraries,
} from './setup';

const MINUTE = 60_000;

let t: Backend;
let admin: Awaited<ReturnType<typeof asAdmin>>;
let libraries: Libraries;

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

const unitsOf = (workId: Id<'works'>) =>
  t.run((ctx) =>
    ctx.db
      .query('units')
      .withIndex('by_work', (q) => q.eq('workId', workId))
      .collect(),
  );
const attemptsOf = (unitId: Id<'units'>) =>
  t.run(async (ctx) => (await ctx.db.query('searchAttempts').collect()).filter((attempt) => attempt.unitIds.includes(unitId)));
const attempt = (attemptId: Id<'searchAttempts'>) => t.run(async (ctx) => (await ctx.db.get(attemptId))!);
const unit = (unitId: Id<'units'>) => t.run(async (ctx) => (await ctx.db.get(unitId))!);
const timelineOf = (unitId: Id<'units'>) =>
  t.run((ctx) =>
    ctx.db
      .query('events')
      .withIndex('by_unit_at', (q) => q.eq('unitId', unitId))
      .collect(),
  );
const playable = (unitIds: Id<'units'>[]) =>
  t.run(async (ctx) => {
    const library = (await ctx.db.query('libraries').first())!;
    for (const unitId of unitIds) {
      const fileId = await ctx.db.insert('files', {
        path: `/data/library/series/${unitId}.mp4`,
        sizeBytes: 1,
        inode: `1:${unitId}`,
        origin: 'scan',
        role: 'source',
      });
      await ctx.db.insert('fileUnits', { fileId, unitId });
      const fileVersionId = await ctx.db.insert('fileVersions', { unitId, fileId, kind: 'primary', playbackProfileId: library.playbackProfileId, fits: true });
      await ctx.db.insert('publications', { unitId, fileVersionId, generation: 0, target: 'jellyfin', state: 'visible' });
    }
  });
const endStoppedSearches = () => t.mutation(internal.pipeline.search.endStoppedSearches, {});

async function runClockFor(ms: number) {
  const until = Date.now() + ms;
  while (Date.now() < until) await vi.advanceTimersByTimeAsync(1_000);
}

const bookNyaaSlotsAhead = (ms: number) =>
  t.run(async (ctx) => {
    const row = (await ctx.db.query('indexerPacing').first())!;
    await ctx.db.patch(row._id, { nextAt: Date.now() + ms });
  });

type SteelBallRun = {
  fake: NyaaHandler;
  s6e2: Doc<'units'>;
  otherSearchesKeepNyaaSlotsBookedFor: (slotWaitMs: number) => Promise<void>;
  nyaaStopsAnswering: () => void;
};

async function steelBallRunWhoseEpisodeSearchSendsThreeNyaaRequests(): Promise<SteelBallRun> {
  let otherSearchesBookAheadMs = 0;
  let answering = true;
  const fake = createNyaaHandler({ items: [], origin: 'https://nyaa.fake' });
  const nyaaWithOtherSearches = async (request: Request) => {
    if (!answering) return new Promise<Response>(() => {});
    const response = await fake.handle(request);
    if (otherSearchesBookAheadMs > 0) await bookNyaaSlotsAhead(otherSearchesBookAheadMs);
    return response;
  };
  await seedAnimeLists(t);
  await seedXemList(t, [7700009]);
  useFetchFakes({
    series: [...SERIES, jojoParts()],
    xem: { shows: { 7700009: { all: jojoPartsShape, names: jojoPartsNames } } },
    indexers: { 'nyaa.fake': nyaaWithOtherSearches },
  });
  await fetchXem(t);
  await seedNyaa(t);
  const releaseProfileId = await t.run((ctx) => ctx.db.insert('releaseProfiles', shippedProfile('anime-1080p')));
  const { workId } = await admin.action(api.api.library.subscribe, {
    tmdbId: '900009',
    kind: 'series',
    libraryId: libraries.series,
    releaseProfileId,
    seasons: [6],
    numberingScheme: 'anime',
  });
  await settleSearches(t);
  const s6e2 = (await unitsOf(workId)).find((u) => u.tmdbSeason === 6 && u.tmdbEpisode === 2)!;
  return {
    fake,
    s6e2,
    otherSearchesKeepNyaaSlotsBookedFor: async (slotWaitMs) => {
      otherSearchesBookAheadMs = slotWaitMs;
      await bookNyaaSlotsAhead(slotWaitMs);
    },
    nyaaStopsAnswering: () => {
      answering = false;
    },
  };
}

describe('an anime episode search behind a full Nyaa queue', () => {
  test('ends before Convex stops its action at 10 minutes, so the episode does not stay Searching', async () => {
    const { fake, s6e2, otherSearchesKeepNyaaSlotsBookedFor } = await steelBallRunWhoseEpisodeSearchSendsThreeNyaaRequests();
    await otherSearchesKeepNyaaSlotsBookedFor(4.5 * MINUTE);
    const asked = fake.requests.length;

    const [attemptId] = await t.mutation(internal.pipeline.search.start, { unitIds: [s6e2._id], trigger: 'manual' });
    await runClockFor(CONVEX_ACTION_LIMIT_MS);

    const ended = await attempt(attemptId!);
    expect(ended.state).toBe('noAcceptable');
    expect(ended.indexerResults).toEqual([expect.objectContaining({ status: 'ok', pages: 2 })]);
    expect(ended.indexerResults[0]!.truncated).toBeUndefined();
    expect(fake.requests.length - asked).toBe(2);
    expect((await unit(s6e2._id)).derivedState).toBe('wanted');
  });

  test('with free slots, all three requests are sent', async () => {
    const { fake, s6e2 } = await steelBallRunWhoseEpisodeSearchSendsThreeNyaaRequests();
    const asked = fake.requests.length;
    await t.mutation(internal.pipeline.search.start, { unitIds: [s6e2._id], trigger: 'manual' });
    await settleSearches(t);
    expect(fake.requests.length - asked).toBe(3);
  });
});

describe('a search whose action stopped', () => {
  test('ends failed with a Timeline event, and its Unit is Wanted again', async () => {
    const { s6e2 } = await steelBallRunWhoseEpisodeSearchSendsThreeNyaaRequests();
    const [attemptId] = await t.mutation(internal.pipeline.search.start, { unitIds: [s6e2._id], trigger: 'manual' });
    const { searchRunId } = await attempt(attemptId!);
    await t.run((ctx) => ctx.scheduler.cancel(searchRunId!));
    expect((await unit(s6e2._id)).derivedState).toBe('searching');

    await endStoppedSearches();

    expect((await attempt(attemptId!)).state).toBe('failed');
    expect((await timelineOf(s6e2._id)).at(-1)).toMatchObject({ kind: 'stageFailed', message: 'The search stopped before it finished.' });
    expect((await unit(s6e2._id)).derivedState).toBe('wanted');
  });

  test('a search still waiting to run, or still running however slow, is not ended', async () => {
    const { s6e2, otherSearchesKeepNyaaSlotsBookedFor } = await steelBallRunWhoseEpisodeSearchSendsThreeNyaaRequests();
    await otherSearchesKeepNyaaSlotsBookedFor(4.5 * MINUTE);
    const [attemptId] = await t.mutation(internal.pipeline.search.start, { unitIds: [s6e2._id], trigger: 'manual' });

    await endStoppedSearches();
    expect((await attempt(attemptId!)).state).toBe('running');

    await runClockFor(4 * MINUTE);
    const { searchRunId } = await attempt(attemptId!);
    expect((await t.run((ctx) => ctx.db.system.get(searchRunId!)))!.state.kind).toBe('inProgress');
    await endStoppedSearches();
    expect((await attempt(attemptId!)).state).toBe('running');
  });

  test('a run that waited in the queue past the margin, then runs within its limit, is not ended', async () => {
    const { s6e2, otherSearchesKeepNyaaSlotsBookedFor } = await steelBallRunWhoseEpisodeSearchSendsThreeNyaaRequests();
    const [attemptId] = await t.mutation(internal.pipeline.search.start, { unitIds: [s6e2._id], trigger: 'manual' });
    vi.setSystemTime(Date.now() + 25 * MINUTE);
    await otherSearchesKeepNyaaSlotsBookedFor(4.5 * MINUTE);

    await runClockFor(8 * MINUTE);
    const { searchRunId } = await attempt(attemptId!);
    expect((await t.run((ctx) => ctx.db.system.get(searchRunId!)))!.state.kind).toBe('inProgress');
    await endStoppedSearches();
    expect((await attempt(attemptId!)).state).toBe('running');
  });

  test('a run Convex still lists as in progress long past the action limit, as after a restart, is ended', async () => {
    const { s6e2, nyaaStopsAnswering } = await steelBallRunWhoseEpisodeSearchSendsThreeNyaaRequests();
    nyaaStopsAnswering();
    const [attemptId] = await t.mutation(internal.pipeline.search.start, { unitIds: [s6e2._id], trigger: 'manual' });
    await runClockFor(CONVEX_ACTION_LIMIT_MS);
    const { searchRunId } = await attempt(attemptId!);
    expect((await t.run((ctx) => ctx.db.system.get(searchRunId!)))!.state.kind).toBe('inProgress');
    await endStoppedSearches();
    expect((await attempt(attemptId!)).state).toBe('running');

    await vi.advanceTimersByTimeAsync(11 * MINUTE);
    await endStoppedSearches();
    expect((await attempt(attemptId!)).state).toBe('failed');
  });

  test('on an install updated with a search stuck from before, it ends once the action limit has passed, with no manual step', async () => {
    const { s6e2 } = await steelBallRunWhoseEpisodeSearchSendsThreeNyaaRequests();
    const insertStuck = () =>
      t.run(async (ctx) => {
        const attemptId = await ctx.db.insert('searchAttempts', {
          unitIds: [s6e2._id],
          wantedUnitIds: [s6e2._id],
          workId: s6e2.workId,
          groupKind: 'animeEpisode',
          trigger: 'manual',
          state: 'running',
          indexerResults: [],
        });
        await ctx.db.patch(s6e2._id, { lastSearchAttemptId: attemptId, derivedState: 'searching' });
        return attemptId;
      });
    const stuck = await insertStuck();
    await vi.advanceTimersByTimeAsync(CONVEX_ACTION_LIMIT_MS);
    await endStoppedSearches();
    expect((await attempt(stuck)).state).toBe('running');

    await vi.advanceTimersByTimeAsync(11 * MINUTE);
    await endStoppedSearches();
    expect((await attempt(stuck)).state).toBe('failed');
    expect((await unit(s6e2._id)).derivedState).toBe('wanted');
  });
});

describe('a Unit already being searched', () => {
  const subscribeHarbourLights = async () => {
    useFetchFakes();
    const { workId } = await admin.action(api.api.library.subscribe, {
      tmdbId: '900001',
      kind: 'series',
      libraryId: libraries.series,
      releaseProfileId: libraries.releaseProfileId,
      seasons: [1],
    });
    return (await unitsOf(workId)).filter((u) => u.tmdbSeason === 1).map((u) => u._id);
  };

  test('"Search wanted" over a running season search starts nothing and says how many it skipped', async () => {
    const season = await subscribeHarbourLights();
    const [seasonSearch] = await attemptsOf(season[0]!);
    expect(seasonSearch).toMatchObject({ groupKind: 'season', state: 'running' });

    expect(await admin.mutation(api.api.units.searchNow, { unitIds: season })).toEqual({ attempts: 0, skippedAlreadySearching: season.length });
    expect(await attemptsOf(season[0]!)).toHaveLength(1);
  });

  test.each<SearchTrigger>(['subscribe', 'manual', 'backfill', 'nextBest'])('a %s search starts no second attempt for it', async (trigger) => {
    const season = await subscribeHarbourLights();
    expect(await t.mutation(internal.pipeline.search.start, { unitIds: season, trigger })).toEqual([]);
  });

  test('an upgrade search of the playing season starts no second attempt for it', async () => {
    const season = await subscribeHarbourLights();
    await playable(season);
    expect(await t.mutation(internal.pipeline.search.start, { unitIds: season, trigger: 'upgrade' })).toEqual([]);
    await t.run(async (ctx) => {
      for (const attempt of await ctx.db.query('searchAttempts').collect()) await ctx.db.patch(attempt._id, { state: 'failed' });
    });
    expect(await t.mutation(internal.pipeline.search.start, { unitIds: season, trigger: 'upgrade' })).toHaveLength(1);
  });

  test('per-episode follow-ups skip it too', async () => {
    const season = await subscribeHarbourLights();
    expect(await t.run((ctx) => startSearch(ctx, season, 'manual', { perUnit: true }))).toEqual({ attemptIds: [], alreadySearching: season });
  });

  test('the daily backfill plans no group for it, so it spends none of the share on it', async () => {
    const season = await subscribeHarbourLights();
    await seedIndexer(t);
    const before = (await t.run((ctx) => ctx.db.query('searchAttempts').collect())).length;
    await t.mutation(internal.pipeline.backfill.runBackfill, {});
    expect(await t.run((ctx) => ctx.db.query('searchAttempts').collect())).toHaveLength(before);
    expect(await attemptsOf(season[0]!)).toHaveLength(1);
  });

  test('"Search and pick" still opens its own search, which does not hold the Unit for others', async () => {
    const season = await subscribeHarbourLights();
    expect(await t.mutation(internal.pipeline.search.start, { unitIds: [season[0]!], trigger: 'interactive' })).toHaveLength(1);
    await t.run(async (ctx) => {
      const seasonSearch = (await ctx.db.query('searchAttempts').collect()).find((a) => a.groupKind === 'season')!;
      await ctx.db.patch(seasonSearch._id, { state: 'failed' });
    });
    expect(await t.mutation(internal.pipeline.search.start, { unitIds: [season[0]!], trigger: 'manual' })).toHaveLength(1);
  });

  test('once its search ended, the Unit is searched again', async () => {
    const season = await subscribeHarbourLights();
    await settleSearches(t);
    expect(await admin.mutation(api.api.units.searchNow, { unitIds: [season[0]!] })).toEqual({ attempts: 1, skippedAlreadySearching: 0 });
  });
});
