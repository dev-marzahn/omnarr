// Rate limits and the daily total. Pure.
import type { ApiLimit, ApiLimits, IndexerUsageHour, RateLimitReason } from '@omnarr/contracts';

import { DAY, HOUR, total24h } from './usage';

export type RateLimitSignal = { retryAfter?: string; apiLimits?: ApiLimits };

/** `apilimits` that say the day's requests are spent: the next request waits. */
export const atLimit = (limits: ApiLimits | undefined): limits is ApiLimits => limits !== undefined && limits.apiCurrent >= limits.apiMax;

/** The fields the rules read. `consecutiveRateLimits` counts this limit too. */
export type IndexerLimits = { apiLimit?: ApiLimit; usage: readonly IndexerUsageHour[]; consecutiveRateLimits: number };

/** `Retry-After` as seconds or an HTTP date; undefined when it's neither. */
function retryAfterAt(header: string | undefined, now: number): number | undefined {
  if (header === undefined) return undefined;
  const value = header.trim();
  if (/^\d+$/.test(value)) return now + Number(value) * 1000;
  const date = Date.parse(value);
  return Number.isNaN(date) ? undefined : date;
}

/** Rule 3: the end of the earliest hour whose expiry from the 24-hour window brings the total below the limit. */
function ownCountUntil(indexer: IndexerLimits, now: number): number | undefined {
  const max = indexer.apiLimit?.max;
  if (max === undefined) return undefined;
  const hours = indexer.usage.filter((e) => e.hourStart > now - DAY).sort((a, b) => a.hourStart - b.hourStart);
  let total = total24h(hours, now);
  if (total < max) return undefined;
  for (const entry of hours) {
    total -= entry.requests;
    if (total < max) return entry.hourStart + HOUR + DAY;
  }
  return undefined;
}

/** When a rate-limited indexer may be asked again, by the first of four rules that exists. */
export function computeRateLimitedUntil(signal: RateLimitSignal, indexer: IndexerLimits, now: number): { until: number; reason: RateLimitReason } {
  const retryAfter = retryAfterAt(signal.retryAfter, now);
  if (retryAfter !== undefined) return { until: retryAfter, reason: 'retryAfter' };
  const limits = signal.apiLimits;
  const fromLimits = limits?.apiNextAvailable ?? (limits?.apiOldestTime !== undefined ? limits.apiOldestTime + DAY : undefined);
  if (fromLimits !== undefined) return { until: fromLimits, reason: 'apilimits' };
  const ownCount = ownCountUntil(indexer, now);
  if (ownCount !== undefined) return { until: ownCount, reason: 'ownCount' };
  const backoff = Math.min(HOUR * 2 ** Math.max(0, indexer.consecutiveRateLimits - 1), DAY);
  return { until: now + backoff, reason: 'fallback' };
}

/** Background work (RSS, backfill, upgrade search, nextBest) and work the user starts (subscribe, "Search now", test). */
export type Origin = 'background' | 'user';

const SHARE: Record<Origin, number> = { background: 0.8, user: 0.95 };

/** Requests left before the origin's share of a known daily limit is spent; unlimited without one. */
export function shareLeft(indexer: { apiLimit?: ApiLimit; usage: readonly IndexerUsageHour[] }, now: number, origin: Origin): number {
  if (!indexer.apiLimit) return Infinity;
  return Math.max(0, Math.floor(indexer.apiLimit.max * SHARE[origin]) - total24h(indexer.usage, now));
}

/** RSS spends at most a quarter of a known limit: the interval is raised to fit. */
export function effectiveRssIntervalMinutes(indexer: { rssIntervalMinutes: number; apiLimit?: ApiLimit }): number {
  if (!indexer.apiLimit) return indexer.rssIntervalMinutes;
  return Math.max(indexer.rssIntervalMinutes, Math.ceil(1440 / (0.25 * indexer.apiLimit.max)));
}
