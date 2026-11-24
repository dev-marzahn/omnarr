import { describe, expect, test } from 'vite-plus/test';

import { backoff, DEFAULT_LIMITS, limitsFrom, TEST_LIMIT_KEYS } from '../src/index.ts';

describe('limitsFrom: the test-only overrides in OMNARR_TEST_LIMITS', () => {
  test('unset or empty, the limits are the defaults', () => {
    expect(limitsFrom(undefined)).toBe(DEFAULT_LIMITS);
    expect(limitsFrom('')).toBe(DEFAULT_LIMITS);
  });

  test('a lowered limit replaces its default, and every other limit stays', () => {
    const limits = limitsFrom('{"vpnDownAfterMs":3000,"torrentStallMs":60000}');
    expect(limits.vpnDownAfterMs).toBe(3000);
    expect(limits.torrentStallMs).toBe(60_000);
    expect(limits.vpnStableMs).toBe(2 * 60_000);
    expect(limits.maxAttempts).toEqual({ 'download.submit': 5, import: 5, publish: 5, prepare: 2, maintenance: 3, indexer: 1 });
  });

  test('a limit that tests may not lower is refused, by name', () => {
    expect(() => limitsFrom('{"livenessMs":1000}')).toThrow(/OMNARR_TEST_LIMITS: livenessMs can't be overridden/);
    expect(() => limitsFrom('{"vpnDownAfterMS":1000}')).toThrow(/vpnDownAfterMS/);
  });

  test('a value above its default, or not a positive whole number of ms, is refused', () => {
    expect(() => limitsFrom('{"vpnStableMs":600000}')).toThrow(/vpnStableMs must be a whole number from 1 to 120000/);
    expect(() => limitsFrom('{"vpnStableMs":0}')).toThrow(/vpnStableMs/);
    expect(() => limitsFrom('{"vpnStableMs":1.5}')).toThrow(/vpnStableMs/);
    expect(() => limitsFrom('{"vpnStableMs":"5000"}')).toThrow(/vpnStableMs/);
  });

  test("production keeps each overridable limit's default", () => {
    const SECOND = 1000;
    const MINUTE = 60 * SECOND;
    expect(Object.fromEntries(TEST_LIMIT_KEYS.map((key) => [key, DEFAULT_LIMITS[key]]))).toEqual({
      torrentStallMs: 6 * 60 * MINUTE,
      goalGraceMs: 10 * MINUTE,
      vpnDownAfterMs: 2 * MINUTE,
      vpnStableMs: 2 * MINUTE,
      vpnWaitRetryMs: 5 * MINUTE,
      reconcilerPollMs: 30 * SECOND,
      progressPollMs: 5 * SECOND,
      progressMs: 5 * SECOND,
      leaseMs: 60 * SECOND,
      heartbeatMs: 20 * SECOND,
      handshakeRetryMs: 60 * SECOND,
      jellyfinReachableMs: 3 * MINUTE,
      playbackPollMs: 30 * SECOND,
      backoffBaseMs: 30 * SECOND,
      setupLockMs: 15 * MINUTE,
      nyaaIntervalMs: 5 * SECOND,
      definitionMinIntervalMs: 2 * SECOND,
      fileMissingConfirmMs: 60 * 60 * SECOND,
    });
  });

  test('a lowered backoffBaseMs shortens the backoff', () => {
    const limits = limitsFrom('{"backoffBaseMs":1000}');
    expect(backoff(1, () => 0.5, limits)).toBe(1000);
    expect(backoff(2, () => 0.5, limits)).toBe(2000);
    expect(backoff(1, () => 0.5)).toBe(30_000);
  });

  test("Nyaa's interval is 5 s, and the e2e may lower it", () => {
    expect(DEFAULT_LIMITS.nyaaIntervalMs).toBe(5_000);
    expect(limitsFrom('{"nyaaIntervalMs":500}').nyaaIntervalMs).toBe(500);
    expect(TEST_LIMIT_KEYS).toContain('nyaaIntervalMs');
  });

  test('anything but a JSON object is refused', () => {
    expect(() => limitsFrom('vpnStableMs=5000')).toThrow(/OMNARR_TEST_LIMITS is not a JSON object/);
    expect(() => limitsFrom('[1]')).toThrow(/OMNARR_TEST_LIMITS is not a JSON object/);
  });
});
