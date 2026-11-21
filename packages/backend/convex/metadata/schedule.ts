// When metadata syncs run: the hourly tick and each Work's next sync.
import { MappingSourceName, type WorkKind } from '@omnarr/contracts';
import { zodToConvex, zodToConvexFields } from 'convex-helpers/server/zod4';
import { z } from 'zod';

import { internal } from '../_generated/api';
import { internalMutation } from '../_generated/server';
import { ensureSettings } from './keys';
import { enqueueSourceFetch, enqueueSync } from './pool';

const DAY = 86_400_000;
/** How often the mapping sources are fetched. */
const SOURCE_INTERVAL = DAY;

/** TMDB statuses of a series that is still producing episodes. */
const ACTIVE = new Set(['Returning Series', 'In Production', 'Planned']);

/**
 * A Work's next sync after a successful one: a day later for a series
 * still in production or with a Unit airing within 30 days, and for a movie
 * until 180 days after its date (or while it has none); 30 days otherwise,
 * so TMDB data is never older than TMDB's terms allow.
 */
export function nextSyncAt(work: { kind: WorkKind; tmdbStatus?: string }, units: { airDateUtc?: number }[], now: number): number {
  const daily =
    work.kind === 'movie'
      ? units.some((u) => u.airDateUtc === undefined || now < u.airDateUtc + 180 * DAY)
      : (work.tmdbStatus !== undefined && ACTIVE.has(work.tmdbStatus)) ||
        units.some((u) => u.airDateUtc !== undefined && u.airDateUtc >= now && u.airDateUtc <= now + 30 * DAY);
  return now + (daily ? DAY : 30 * DAY);
}

/** Due Works read per tick call; a longer list continues in a scheduled call. */
const PAGE = 100;

/**
 * The hourly tick: creates the settings and source rows when missing,
 * enqueues each mapping source's fetch when its last attempt is over 24 h
 * old, and enqueues a sync for every due Work that has none in the pool, a
 * page at a time.
 */
export const tick = internalMutation({
  args: zodToConvexFields({ cursor: z.string().optional() }),
  returns: zodToConvex(z.null()),
  handler: async (ctx, { cursor }) => {
    const now = Date.now();
    if (cursor === undefined) {
      await ensureSettings(ctx);
      for (const source of MappingSourceName.options) {
        const state = await ctx.db
          .query('mappingSourceState')
          .withIndex('by_source', (q) => q.eq('source', source))
          .unique();
        // Each installation fetches 24 h after its own last attempt, not at a shared clock time.
        if (!state?.lastAttemptAt || now - state.lastAttemptAt > SOURCE_INTERVAL) await enqueueSourceFetch(ctx, source);
      }
    }

    const page = await ctx.db
      .query('workMetadata')
      .withIndex('by_next_sync', (q) => q.lte('nextSyncAt', now))
      .paginate({ cursor: cursor ?? null, numItems: PAGE });
    for (const metadata of page.page) if (metadata.syncWorkId === undefined) await enqueueSync(ctx, metadata.workId);
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.metadata.schedule.tick, { cursor: page.continueCursor });
    return null;
  },
});
