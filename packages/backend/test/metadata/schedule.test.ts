import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';

import { api, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { nextSyncAt } from '../../convex/metadata/schedule';
import { asAdmin, drainPool, seedLibraries, setup, useMetadataFakes, type Backend, type FakeRequests, type Libraries } from '../setup';

const DAY = 86_400_000;
const now = Date.UTC(2026, 10, 17);

describe('nextSyncAt', () => {
  test.each(['Returning Series', 'In Production', 'Planned'])('a series that is %s syncs daily', (tmdbStatus) => {
    expect(nextSyncAt({ kind: 'series', tmdbStatus }, [], now)).toBe(now + DAY);
  });

  test('an ended series with a Unit airing within 30 days syncs daily', () => {
    expect(nextSyncAt({ kind: 'series', tmdbStatus: 'Ended' }, [{ airDateUtc: now + 29 * DAY }], now)).toBe(now + DAY);
    expect(nextSyncAt({ kind: 'series', tmdbStatus: 'Ended' }, [{ airDateUtc: now + 31 * DAY }, { airDateUtc: now - DAY }], now)).toBe(now + 30 * DAY);
  });

  test('a movie syncs daily until 180 days after its date, then every 30 days', () => {
    expect(nextSyncAt({ kind: 'movie', tmdbStatus: 'Released' }, [{ airDateUtc: now - 179 * DAY }], now)).toBe(now + DAY);
    expect(nextSyncAt({ kind: 'movie', tmdbStatus: 'Released' }, [{ airDateUtc: now - 181 * DAY }], now)).toBe(now + 30 * DAY);
  });

  test('a movie without a date syncs daily', () => {
    expect(nextSyncAt({ kind: 'movie' }, [{}], now)).toBe(now + DAY);
  });

  test('nothing waits longer than 30 days (TMDB terms)', () => {
    expect(nextSyncAt({ kind: 'series', tmdbStatus: 'Canceled' }, [], now)).toBe(now + 30 * DAY);
    expect(nextSyncAt({ kind: 'series' }, [], now)).toBe(now + 30 * DAY);
  });
});

describe('metadata.tick and metadataPool', () => {
  let t: Backend;
  let admin: Awaited<ReturnType<typeof asAdmin>>;
  let libraries: Libraries;
  let requests: FakeRequests;

  beforeEach(async () => {
    vi.useFakeTimers();
    t = setup();
    admin = await asAdmin(t);
    libraries = await seedLibraries(t);
    requests = useMetadataFakes();
  });
  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  const subscribe = () =>
    admin.action(api.api.library.subscribe, {
      tmdbId: '900001',
      kind: 'series',
      libraryId: libraries.series,
      releaseProfileId: libraries.releaseProfileId,
      seasons: [1],
    });
  const insertBuilding = () =>
    t.mutation(internal.library.works.insertWork, {
      libraryId: libraries.series,
      releaseProfileId: libraries.releaseProfileId,
      seasons: [1, 2],
      numberingScheme: 'standard',
      work: { kind: 'series', tmdbId: '900001', title: 'Harbour Lights' },
    });
  const metadataOf = (workId: Id<'works'>) =>
    t.run((ctx) =>
      ctx.db
        .query('workMetadata')
        .withIndex('by_work', (q) => q.eq('workId', workId))
        .unique(),
    );
  const makeDue = (workId: Id<'works'>) =>
    t.run(async (ctx) => {
      const row = await ctx.db
        .query('workMetadata')
        .withIndex('by_work', (q) => q.eq('workId', workId))
        .unique();
      await ctx.db.patch(row!._id, { nextSyncAt: Date.now() - 1 });
    });
  const detailCalls = () => requests.filter((url) => url.pathname === '/3/tv/900001').length;
  const runPool = () => drainPool(t);

  test('creates the settings row and a row per mapping source on its first run', async () => {
    await t.mutation(internal.metadata.schedule.tick, {});
    const { settings, sources } = await t.run(async (ctx) => ({
      settings: await ctx.db.query('metadataSettings').collect(),
      sources: (await ctx.db.query('mappingSourceState').collect()).map((row) => row.source).sort(),
    }));
    expect(settings).toEqual([expect.objectContaining({ language: 'en-US' })]);
    expect(sources).toEqual(['animeLists', 'sceneMapping', 'xem']);
  });

  test('a new Work waits an hour before its first sync', async () => {
    const before = Date.now();
    const { workId } = await insertBuilding();
    const wait = (await metadataOf(workId))!.nextSyncAt - before;
    expect(wait).toBeGreaterThanOrEqual(60 * 60 * 1000);
    expect(wait).toBeLessThan(61 * 60 * 1000);
  });

  test('enqueues each due Work once, skips one whose sync is in the pool, and clears the mark when it is done', async () => {
    const { workId } = await subscribe();
    await makeDue(workId);
    const before = detailCalls();
    await t.mutation(internal.metadata.schedule.tick, {});
    const syncWorkId = (await metadataOf(workId))!.syncWorkId;
    expect(syncWorkId).toEqual(expect.any(String));
    await t.mutation(internal.metadata.schedule.tick, {});
    expect((await metadataOf(workId))!.syncWorkId).toBe(syncWorkId);
    const tickAt = Date.now();
    await runPool();
    expect(detailCalls() - before).toBe(1);
    const after = (await metadataOf(workId))!;
    expect(after.syncWorkId).toBeUndefined();
    expect(after.nextSyncAt).toBeGreaterThanOrEqual(tickAt + DAY);
  });

  test('leaves a Work that is not due alone', async () => {
    const { workId } = await subscribe();
    await t.mutation(internal.metadata.schedule.tick, {});
    expect((await metadataOf(workId))!.syncWorkId).toBeUndefined();
  });

  test('a sync that fails every attempt leaves a never-written Work "failed", and its next sync time as it was', async () => {
    const { workId } = await insertBuilding();
    const { nextSyncAt: due } = (await metadataOf(workId))!;
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    await admin.mutation(api.api.metadata.syncNow, { workId });
    await runPool();
    const after = (await metadataOf(workId))!;
    expect(after).toMatchObject({ buildState: 'failed', nextSyncAt: due });
    expect(after.syncWorkId).toBeUndefined();
  });

  test('"Try again" (syncNow) writes the Units of a failed first write, once at a time', async () => {
    const { workId } = await insertBuilding();
    expect(await admin.mutation(api.api.metadata.syncNow, { workId })).toBe(true);
    expect(await admin.mutation(api.api.metadata.syncNow, { workId })).toBe(false);
    await runPool();
    expect(await metadataOf(workId)).toMatchObject({ buildState: 'ready' });
    expect((await admin.query(api.api.library.detail, { workId }))!.units).toHaveLength(13);
  });
});
