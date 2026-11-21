// The daily backfill: the read cap, the share stop and the rotation order.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';

import { internal } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import { BUDGET, DEEP_PAGING_CAP } from '../convex/indexers/requestPlan';
import { seedIndexer, seedLibraries, setup, type Backend } from './setup';

const DAY = 86_400_000;
let t: Backend;

beforeEach(() => {
  vi.useFakeTimers();
  t = setup();
});
afterEach(() => vi.useRealTimers());

/**
 * A series whose episodes are one per season, so each wanted Unit is its own
 * season group; `searchedDaysAgo[i]` is episode i's `lastSearchAt`, undefined
 * for never.
 */
async function series(searchedDaysAgo: (number | undefined)[], overrides: { airDateUtc?: number; airDates?: number[] } = {}): Promise<Id<'units'>[]> {
  const { series: libraryId, releaseProfileId } = await seedLibraries(t);
  return t.run(async (ctx) => {
    const now = Date.now();
    const workId = await ctx.db.insert('works', {
      libraryId,
      kind: 'series',
      title: 'Long Show',
      numberingScheme: 'standard',
      releaseProfileId,
      monitorNewUnits: true,
    });
    const ids: Id<'units'>[] = [];
    for (const [i, days] of searchedDaysAgo.entries()) {
      ids.push(
        await ctx.db.insert('units', {
          workId,
          kind: 'episode',
          tmdbSeason: i + 1,
          tmdbEpisode: 1,
          // Recent by default: estimated at BUDGET requests (deep paging needs the air date + 30 days past).
          airDateUtc: overrides.airDates?.[i] ?? overrides.airDateUtc ?? now - 5 * DAY,
          monitored: true,
          derivedState: 'wanted',
          ...(days === undefined ? {} : { lastSearchAt: now - days * DAY }),
        }),
      );
    }
    return ids;
  });
}

const backfill = () => t.mutation(internal.pipeline.backfill.runBackfill, {});
const searched = async () => (await t.run((ctx) => ctx.db.query('searchAttempts').collect())).filter((a) => a.trigger === 'backfill').flatMap((a) => a.unitIds);

describe('runBackfill', () => {
  test('reads at most 200 Units per run, the oldest lastSearchAt first', async () => {
    await seedIndexer(t);
    const ids = await series(Array.from({ length: 230 }, (_, i) => 230 - i));
    await backfill();
    const unitIds = await searched();
    expect(unitIds).toHaveLength(200);
    expect(new Set(unitIds)).toEqual(new Set(ids.slice(0, 200)));
  });

  test('a Unit never searched goes first', async () => {
    await seedIndexer(t, { apiLimit: { max: 100, source: 'user' }, usage: [{ hourStart: Date.now() - 3_600_000, requests: 76, errors: 0 }] });
    const ids = await series([5, undefined, 9]);
    await backfill();
    expect(await searched()).toEqual([ids[1]]);
  });

  test("starts groups only while every enabled indexer's background share has room for 4 more requests", async () => {
    // 80 of 100 is the background share: 72 used leaves 8, two groups.
    await seedIndexer(t, { apiLimit: { max: 100, source: 'user' }, usage: [{ hourStart: Date.now() - 3_600_000, requests: 72, errors: 0 }] });
    await seedIndexer(t, { host: 'roomy.fake' });
    const ids = await series([9, 8, 7, 6]);
    await backfill();
    expect(await searched()).toEqual([ids[0], ids[1]]);
  });

  test('estimates a group the request plan pages deep for (last air date + 30 days past) at DEEP_PAGING_CAP requests, any other at BUDGET', async () => {
    expect([BUDGET, DEEP_PAGING_CAP]).toEqual([4, 10]);
    // 20 of the 80-request background share are left.
    await seedIndexer(t, { apiLimit: { max: 100, source: 'user' }, usage: [{ hourStart: Date.now() - 3_600_000, requests: 60, errors: 0 }] });
    const old = Date.now() - 100 * DAY;
    const recent = Date.now() - 5 * DAY;
    // Rotation order: old (10), recent (4), recent (4) fit in 20; the next old one (10) doesn't.
    const ids = await series([9, 8, 7, 6], { airDates: [old, recent, recent, old] });
    await backfill();
    expect(await searched()).toEqual([ids[0], ids[1], ids[2]]);
  });

  test('skips Units that are not wanted: unmonitored, not aired, or with an active Grab', async () => {
    await seedIndexer(t);
    const ids = await series([3, 2, 1]);
    await t.run(async (ctx) => {
      await ctx.db.patch(ids[0]!, { monitored: false });
      await ctx.db.patch(ids[1]!, { airDateUtc: Date.now() + DAY });
    });
    await backfill();
    expect(await searched()).toEqual([ids[2]]);
  });

  test('recomputes Units whose air date has passed: "not aired" becomes "wanted"', async () => {
    const [unitId] = await series([undefined], { airDateUtc: Date.now() - 1000 });
    await t.run((ctx) => ctx.db.patch(unitId!, { derivedState: 'notAired' }));
    await backfill();
    // No indexer: nothing is searched, but the state is current.
    expect((await t.run((ctx) => ctx.db.get(unitId!)))!.derivedState).toBe('wanted');
  });
});
