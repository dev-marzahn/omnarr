// An indexer's API use per hour, the last 24 hours only: the
// single source for "API use", the shares, rate-limit rule 3 and "errors (24 h)".
import type { IndexerUsageHour } from '@omnarr/contracts';

export const HOUR = 3_600_000;
export const DAY = 24 * HOUR;

const inWindow = (entry: IndexerUsageHour, now: number) => entry.hourStart > now - DAY;

/** Adds calls to the hour `now` falls in, and drops hours older than 24 hours. */
export function addCalls(usage: readonly IndexerUsageHour[], now: number, calls: { requests: number; errors: number }): IndexerUsageHour[] {
  const hourStart = Math.floor(now / HOUR) * HOUR;
  const kept = usage.filter((entry) => inWindow(entry, now));
  const current = kept.find((entry) => entry.hourStart === hourStart);
  if (current)
    return kept.map((entry) => (entry === current ? { hourStart, requests: entry.requests + calls.requests, errors: entry.errors + calls.errors } : entry));
  return [...kept, { hourStart, requests: calls.requests, errors: calls.errors }];
}

export const total24h = (usage: readonly IndexerUsageHour[], now: number) => usage.filter((e) => inWindow(e, now)).reduce((sum, e) => sum + e.requests, 0);

export const errors24h = (usage: readonly IndexerUsageHour[], now: number) => usage.filter((e) => inWindow(e, now)).reduce((sum, e) => sum + e.errors, 0);
