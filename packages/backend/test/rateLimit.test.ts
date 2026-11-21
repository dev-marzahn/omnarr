// An indexer's daily total: usage per hour, the rule order for
// rateLimitedUntil, the shares and the RSS share.
import { describe, expect, test } from 'vite-plus/test';

import { computeRateLimitedUntil, effectiveRssIntervalMinutes, shareLeft } from '../convex/indexers/rateLimit';
import { addCalls, errors24h, total24h } from '../convex/indexers/usage';

const HOUR = 3_600_000;
const NOW = Date.UTC(2026, 10, 17, 12, 30);
const hour = (hoursAgo: number) => Math.floor(NOW / HOUR) * HOUR - hoursAgo * HOUR;

describe('usage', () => {
  test('adds calls to the current hour and keeps only the last 24 hours', () => {
    const old = [
      { hourStart: hour(30), requests: 5, errors: 0 },
      { hourStart: hour(2), requests: 3, errors: 1 },
    ];
    const usage = addCalls(addCalls(old, NOW, { requests: 2, errors: 0 }), NOW + 60_000, { requests: 1, errors: 1 });
    expect(usage).toEqual([
      { hourStart: hour(2), requests: 3, errors: 1 },
      { hourStart: hour(0), requests: 3, errors: 1 },
    ]);
    expect(total24h(usage, NOW)).toBe(6);
    expect(errors24h(usage, NOW)).toBe(2);
    expect(total24h(old, NOW)).toBe(3);
  });
});

describe('rateLimitedUntil: the first rule that exists', () => {
  const indexer = (overrides = {}) => ({ usage: [], consecutiveRateLimits: 1, ...overrides });

  test('1. Retry-After in seconds', () => {
    expect(computeRateLimitedUntil({ retryAfter: '120' }, indexer(), NOW)).toEqual({ until: NOW + 120_000, reason: 'retryAfter' });
  });

  test('1. Retry-After as an HTTP date', () => {
    const at = new Date(NOW + 3 * HOUR).toUTCString();
    expect(computeRateLimitedUntil({ retryAfter: at }, indexer(), NOW)).toEqual({ until: Date.parse(at), reason: 'retryAfter' });
  });

  test('2. apilimits: apiNextAvailable, else apiOldestTime + 24 h', () => {
    expect(computeRateLimitedUntil({ apiLimits: { apiCurrent: 100, apiMax: 100, apiNextAvailable: NOW + HOUR } }, indexer(), NOW)).toEqual({
      until: NOW + HOUR,
      reason: 'apilimits',
    });
    expect(computeRateLimitedUntil({ apiLimits: { apiCurrent: 100, apiMax: 100, apiOldestTime: NOW - 20 * HOUR } }, indexer(), NOW)).toEqual({
      until: NOW + 4 * HOUR,
      reason: 'apilimits',
    });
  });

  test('3. own count: the end of the earliest hour whose expiry brings the total below the limit', () => {
    const usage = [
      { hourStart: hour(23), requests: 40, errors: 0 },
      { hourStart: hour(10), requests: 40, errors: 0 },
      { hourStart: hour(1), requests: 20, errors: 0 },
    ];
    // 100 of 100: the oldest hour leaves the window at its end plus 24 h, which leaves 60.
    expect(computeRateLimitedUntil({}, indexer({ usage, apiLimit: { max: 100, source: 'user' } }), NOW)).toEqual({
      until: hour(23) + 25 * HOUR,
      reason: 'ownCount',
    });
  });

  test('4. fallback: 1 h, 2 h, 4 h … capped at 24 h', () => {
    expect(computeRateLimitedUntil({}, indexer({ consecutiveRateLimits: 1 }), NOW)).toEqual({ until: NOW + HOUR, reason: 'fallback' });
    expect(computeRateLimitedUntil({}, indexer({ consecutiveRateLimits: 3 }), NOW)).toEqual({ until: NOW + 4 * HOUR, reason: 'fallback' });
    expect(computeRateLimitedUntil({}, indexer({ consecutiveRateLimits: 9 }), NOW)).toEqual({ until: NOW + 24 * HOUR, reason: 'fallback' });
  });

  test('an unreadable Retry-After falls through to the next rule', () => {
    expect(computeRateLimitedUntil({ retryAfter: 'soon' }, indexer(), NOW).reason).toBe('fallback');
  });
});

describe('shares', () => {
  const at = (requests: number) => ({ apiLimit: { max: 100, source: 'user' as const }, usage: [{ hourStart: hour(1), requests, errors: 0 }] });

  test('background work stops at 80 % of a known limit, user-started work at 95 %', () => {
    expect(shareLeft(at(70), NOW, 'background')).toBe(10);
    expect(shareLeft(at(80), NOW, 'background')).toBe(0);
    expect(shareLeft(at(80), NOW, 'user')).toBe(15);
    expect(shareLeft(at(96), NOW, 'user')).toBe(0);
  });

  test('without a known limit there is no share', () => {
    expect(shareLeft({ usage: [] }, NOW, 'background')).toBe(Infinity);
  });

  test('RSS uses at most a quarter of a known limit: every 58 minutes at 100 a day', () => {
    expect(effectiveRssIntervalMinutes({ rssIntervalMinutes: 15, apiLimit: { max: 100, source: 'user' } })).toBe(58);
    expect(effectiveRssIntervalMinutes({ rssIntervalMinutes: 15, apiLimit: { max: 10_000, source: 'apilimits' } })).toBe(15);
    expect(effectiveRssIntervalMinutes({ rssIntervalMinutes: 20 })).toBe(20);
  });
});
