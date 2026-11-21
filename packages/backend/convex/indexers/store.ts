// Indexer rows: every call's usage and health in one write,
// the rows the API saves, and the reads the actions make. `apiKey` leaves
// this file only through `getForAction`, which is internal.
import {
  ApiLimit,
  IndexerCall,
  type IndexerCallStatus,
  IndexerCaps,
  IndexerCategories,
  IndexerDetail,
  type IndexerHealth,
  IndexerKind,
  IndexerSite,
  IndexerUsageHour,
} from '@omnarr/contracts';
import { zid, zodToConvex, zodToConvexFields } from 'convex-helpers/server/zod4';
import { ConvexError } from 'convex/values';
import { z } from 'zod';

import type { Doc, Id } from '../_generated/dataModel';
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from '../_generated/server';
import { definitionRow } from '../sites/definitions';
import { toDetail } from './dto';
import { atLimit, computeRateLimitedUntil, effectiveRssIntervalMinutes } from './rateLimit';
import { addCalls, total24h } from './usage';

const statusOf = (call: IndexerCall): IndexerCallStatus => {
  if (!call.failure) return 'ok';
  if (call.failure.kind === 'timeout') return 'timeout';
  if (call.failure.kind === 'rateLimited' || call.failure.kind === 'challenged') return 'rateLimited';
  return 'error';
};

/** A rate limit, or a site's browser check, which omnarr can't pass and so backs off from. */
const isRateLimit = (call: IndexerCall) => call.failure?.kind === 'rateLimited' || call.failure?.kind === 'challenged';

/**
 * Records calls into `usage`, `health` and the rate-limit fields, in one
 * write. A rate limit sets `rateLimitedUntil` by `computeRateLimitedUntil`; a
 * successful call resets `consecutiveRateLimits`, and a passing test also
 * clears the limit at once. Returns the 24-hour total, for the action's own
 * count; null when the indexer is gone.
 */
export async function recordCallsIn(ctx: MutationCtx, indexerId: Id<'indexers'>, calls: IndexerCall[]): Promise<{ total24h: number } | null> {
  const indexer = await ctx.db.get(indexerId);
  if (!indexer) return null;
  const now = Date.now();
  if (calls.length === 0) return { total24h: total24h(indexer.usage, now) };

  const usage = addCalls(indexer.usage, now, { requests: calls.length, errors: calls.filter((call) => !call.ok).length });
  const last = calls.at(-1)!;
  const status = statusOf(last);
  const health: IndexerHealth = {
    ...indexer.health,
    status,
    checkedAt: last.at,
    latencyMs: last.latencyMs,
    failureCode: last.failure?.code,
    detail: last.failure
      ? {
          kind: last.failure.kind,
          ...(last.failure.httpStatus === undefined ? {} : { httpStatus: last.failure.httpStatus }),
          ...(last.failure.errorCode === undefined ? {} : { errorCode: last.failure.errorCode }),
          ...(last.failure.challenge === undefined ? {} : { challenge: last.failure.challenge }),
          ...(last.failure.redirectHost === undefined ? {} : { redirectHost: last.failure.redirectHost }),
        }
      : undefined,
  };
  const lastSearch = calls.filter((call) => call.kind === 'search').at(-1);
  if (lastSearch) health.lastSearch = { at: lastSearch.at, status: statusOf(lastSearch), count: lastSearch.count ?? 0 };
  const lastRss = calls.filter((call) => call.kind === 'rss').at(-1);
  if (lastRss) health.lastRss = { at: lastRss.at, newItems: lastRss.newItems ?? 0, matched: lastRss.matched ?? 0 };

  const patch: Partial<Doc<'indexers'>> = { usage, health };
  // A limit the indexer reports, unless the user entered one.
  const reported = calls
    .map((call) => call.apiLimits ?? call.failure?.apiLimits)
    .filter((limits) => limits !== undefined)
    .at(-1);
  if (reported && indexer.apiLimit?.source !== 'user') patch.apiLimit = { max: reported.apiMax, source: 'apilimits' };

  // A rate-limited call, or a good page whose `apilimits` are at their maximum:
  // that page counts as served, but the next request waits.
  const limited = calls.filter((call) => isRateLimit(call) || (call.ok && atLimit(call.apiLimits))).at(-1);
  if (limited) {
    const consecutiveRateLimits = indexer.consecutiveRateLimits + 1;
    const { until, reason } = computeRateLimitedUntil(
      { retryAfter: limited.failure?.retryAfter, apiLimits: limited.failure?.apiLimits ?? limited.apiLimits },
      { apiLimit: patch.apiLimit ?? indexer.apiLimit, usage, consecutiveRateLimits },
      now,
    );
    Object.assign(patch, { consecutiveRateLimits, rateLimitedUntil: until, rateLimitReason: reason });
  } else if (calls.some((call) => call.ok)) {
    patch.consecutiveRateLimits = 0;
    if (calls.some((call) => call.ok && call.kind === 'test')) Object.assign(patch, { rateLimitedUntil: undefined, rateLimitReason: undefined });
  }
  await ctx.db.patch(indexerId, patch);
  return { total24h: total24h(usage, now) };
}

export const recordCalls = internalMutation({
  args: zodToConvexFields({ indexerId: zid('indexers'), calls: z.array(IndexerCall) }),
  returns: zodToConvex(z.object({ total24h: z.number() }).nullable()),
  handler: (ctx, { indexerId, calls }) => recordCallsIn(ctx, indexerId, calls),
});

/** What an action needs to call the indexer, key included. Internal only. */
export const getForAction = internalQuery({
  args: zodToConvexFields({ indexerId: zid('indexers') }),
  returns: zodToConvex(
    z
      .object({
        apiUrl: z.string(),
        apiKey: z.string(),
        id: zid('indexers'),
        kind: IndexerKind,
        categories: z.object({ series: z.array(z.number()), movies: z.array(z.number()) }),
        caps: IndexerCaps,
        rssHighWaterMark: z.string().optional(),
        usage: z.array(IndexerUsageHour),
        apiLimit: ApiLimit.optional(),
        site: IndexerSite.optional(),
      })
      .nullable(),
  ),
  handler: async (ctx, { indexerId }) => {
    const indexer = await ctx.db.get(indexerId);
    if (!indexer) return null;
    const { apiUrl, apiKey, kind, categories, caps, rssHighWaterMark, usage, apiLimit, site } = indexer;
    return { id: indexerId, apiUrl, apiKey, kind, categories, caps, rssHighWaterMark, usage, apiLimit, site };
  },
});

/** The stored indexer of a site kind, if any: there is at most one Nyaa. */
export const siteIndexerId = internalQuery({
  args: zodToConvexFields({ kind: z.literal('nyaa') }),
  returns: zodToConvex(zid('indexers').nullable()),
  handler: async (ctx, { kind }) => (await ctx.db.query('indexers').collect()).find((indexer) => indexer.kind === kind)?._id ?? null,
});

/** Names are unique among indexers (checked here, not by the schema). */
async function assertNameFree(ctx: MutationCtx, name: string, except?: Id<'indexers'>): Promise<void> {
  const taken = (await ctx.db.query('indexers').collect()).some(
    (indexer) => indexer._id !== except && indexer.name.trim().toLowerCase() === name.trim().toLowerCase(),
  );
  if (taken) throw new ConvexError({ code: 'nameTaken' });
}

const NewIndexer = z.object({
  name: z.string(),
  kind: IndexerKind,
  apiUrl: z.string(),
  apiKey: z.string(),
  priority: z.number(),
  categories: IndexerCategories,
  caps: IndexerCaps,
  rssIntervalMinutes: z.number(),
  apiLimit: ApiLimit.optional(),
  site: IndexerSite.optional(),
});

/** Saves an indexer whose test passed. */
export const insertIndexer = internalMutation({
  args: zodToConvexFields(NewIndexer.shape),
  returns: zodToConvex(zid('indexers')),
  handler: async (ctx, indexer) => {
    await assertNameFree(ctx, indexer.name);
    // One Nyaa at most, also when two adds race past createSite's check.
    if (indexer.kind === 'nyaa' && (await ctx.db.query('indexers').collect()).some((row) => row.kind === 'nyaa'))
      throw new ConvexError({ code: 'alreadyExists' });
    return await ctx.db.insert('indexers', { ...indexer, enabled: true, usage: [], consecutiveRateLimits: 0, health: { status: 'unknown' } });
  },
});

export const patchIndexer = internalMutation({
  args: zodToConvexFields({ indexerId: zid('indexers'), patch: NewIndexer.partial() }),
  returns: zodToConvex(z.null()),
  handler: async (ctx, { indexerId, patch }) => {
    if (!(await ctx.db.get(indexerId))) throw new ConvexError({ code: 'notFound' });
    if (patch.name !== undefined) await assertNameFree(ctx, patch.name, indexerId);
    await ctx.db.patch(indexerId, patch);
    return null;
  },
});

/** The detail DTO, for the actions that save. */
export const detail = internalQuery({
  args: zodToConvexFields({ indexerId: zid('indexers') }),
  returns: zodToConvex(IndexerDetail.nullable()),
  handler: async (ctx, { indexerId }) => {
    const indexer = await ctx.db.get(indexerId);
    return indexer && detailOf(ctx, indexer);
  },
});

/** The detail, with a definition indexer's setting types read from its definition (secret ones stay hidden). */
export async function detailOf(ctx: QueryCtx, indexer: Doc<'indexers'>): Promise<IndexerDetail> {
  const types = new Map<string, string>();
  if (indexer.site) {
    const definition = await definitionRow(ctx, indexer.site.definitionId);
    for (const setting of definition?.meta?.settings ?? []) types.set(setting.name, setting.type);
  }
  return toDetail(indexer, Date.now(), types);
}

export const saveCaps = internalMutation({
  args: zodToConvexFields({ indexerId: zid('indexers'), caps: IndexerCaps }),
  returns: zodToConvex(z.null()),
  handler: async (ctx, { indexerId, caps }) => {
    if (await ctx.db.get(indexerId)) await ctx.db.patch(indexerId, { caps });
    return null;
  },
});

/** Set when an RSS fetch starts, so a failing indexer is retried at its interval. */
export const markRssStarted = internalMutation({
  args: zodToConvexFields({ indexerId: zid('indexers'), now: z.number() }),
  returns: zodToConvex(z.null()),
  handler: async (ctx, { indexerId, now }) => {
    if (await ctx.db.get(indexerId)) await ctx.db.patch(indexerId, { rssLastFetchAt: now });
    return null;
  },
});

/** Enabled, not rate-limited indexers whose effective RSS interval has passed since their last fetch. */
export async function dueIndexers(ctx: QueryCtx, now: number): Promise<Id<'indexers'>[]> {
  const enabled = await ctx.db
    .query('indexers')
    .withIndex('by_enabled', (q) => q.eq('enabled', true))
    .collect();
  return enabled
    .filter((indexer) => (indexer.rateLimitedUntil ?? 0) <= now)
    .filter((indexer) => indexer.rssLastFetchAt === undefined || now - indexer.rssLastFetchAt >= effectiveRssIntervalMinutes(indexer) * 60_000)
    .map((indexer) => indexer._id);
}

export const dueForRss = internalQuery({
  args: zodToConvexFields({ now: z.number() }),
  returns: zodToConvex(z.array(zid('indexers'))),
  handler: (ctx, { now }) => dueIndexers(ctx, now),
});
