// The daily backfill: wanted Units the other triggers missed, oldest search
// first, within the indexers' background share. It also catches up after
// downtime.
import type { SearchGroupKind } from '@omnarr/contracts';
import { v } from 'convex/values';

import type { Doc, Id } from '../_generated/dataModel';
import { internalMutation, type MutationCtx } from '../_generated/server';
import { shareLeft } from '../indexers/rateLimit';
import { BUDGET, DEEP_PAGING_CAP, DEEP_PAGING_MARGIN_MS } from '../indexers/requestPlan';
import { recomputeUnits } from '../lib/derivedState';
import { groupUnits } from './groups';
import { isWanted, startSearch } from './search';

/** The most Units one run reads through `units.by_last_search`. */
export const BACKFILL_READ_CAP = 200;

const DAY = 86_400_000;

/**
 * Units whose air date passed since the last run: their state moves from
 * "not aired" to "wanted". A day's window, with a day's margin.
 */
async function recomputeAired(ctx: MutationCtx, now: number): Promise<void> {
  for (const work of await ctx.db.query('works').collect()) {
    const aired = await ctx.db
      .query('units')
      .withIndex('by_work_air_date', (q) =>
        q
          .eq('workId', work._id)
          .gt('airDateUtc', now - 2 * DAY)
          .lte('airDateUtc', now),
      )
      .collect();
    await recomputeUnits(
      ctx,
      aired.filter((unit) => unit.derivedState === 'notAired').map((unit) => unit._id),
    );
  }
}

/**
 * The requests a group may spend per indexer, by the request plan's own
 * paging rule: a series group whose every air date is known
 * pages on to DEEP_PAGING_CAP while its last air date plus the margin is in
 * the past; any other group spends at most BUDGET.
 */
export function estimate(kind: SearchGroupKind, airDates: (number | undefined)[], now: number): number {
  if (kind === 'movie' || airDates.length === 0 || airDates.some((at) => at === undefined)) return BUDGET;
  const lastAirDate = Math.max(...(airDates as number[]));
  return lastAirDate + DEEP_PAGING_MARGIN_MS < now ? DEEP_PAGING_CAP : BUDGET;
}

export const runBackfill = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    await recomputeAired(ctx, now);

    const indexers = (await ctx.db.query('indexers').collect()).filter((row) => row.enabled);
    if (indexers.length === 0) return null;
    // Requests every enabled indexer's background share still has room for.
    let requestsLeft = Math.min(...indexers.map((row) => shareLeft(row, now, 'background')));

    const read = await ctx.db.query('units').withIndex('by_last_search').order('asc').take(BACKFILL_READ_CAP);
    const wanted = read.filter((unit) => isWanted(unit, now));
    const byWork = new Map<Id<'works'>, Doc<'units'>[]>();
    for (const unit of wanted) byWork.set(unit.workId, [...(byWork.get(unit.workId) ?? []), unit]);

    // Groups in rotation order: the group of the oldest-searched Unit first.
    type Planned = { unitIds: Id<'units'>[]; requests: number };
    const groupOf = new Map<Id<'units'>, Planned>();
    for (const [workId, units] of byWork) {
      const work = (await ctx.db.get(workId))!;
      const all = await ctx.db
        .query('units')
        .withIndex('by_work', (q) => q.eq('workId', workId))
        .collect();
      const airDates = new Map(all.map((unit) => [unit._id, unit.airDateUtc]));
      const asGroupUnit = (unit: Doc<'units'>) => ({ _id: unit._id, tmdbSeason: unit.tmdbSeason, tmdbEpisode: unit.tmdbEpisode, wanted: isWanted(unit, now) });
      for (const group of groupUnits(units.map(asGroupUnit), { kind: work.kind, numberingScheme: work.numberingScheme, units: all.map(asGroupUnit) })) {
        const planned = {
          unitIds: group.unitIds,
          requests: estimate(
            group.kind,
            group.unitIds.map((unitId) => airDates.get(unitId)),
            now,
          ),
        };
        for (const unitId of group.unitIds) groupOf.set(unitId, planned);
      }
    }
    const started = new Set<Planned>();
    for (const unit of wanted) {
      const group = groupOf.get(unit._id);
      if (!group || started.has(group)) continue;
      if (requestsLeft < group.requests) break;
      started.add(group);
      requestsLeft -= group.requests;
      await startSearch(ctx, group.unitIds, 'backfill');
    }
    return null;
  },
});
