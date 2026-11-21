// A Usenet server's monthly download limit: the billing period from the
// provider's reset day, and the check the worker pauses a server on.
import { describe, expect, test } from 'vite-plus/test';

import { limitReached, usagePeriod, UsenetLimit } from '../src/usenetLimit.ts';

const at = (iso: string) => Date.parse(iso);

describe('usagePeriod', () => {
  test('on or after the reset day, the period started this month and ends on that day next month', () => {
    expect(usagePeriod(5, at('2026-11-19T13:00:00Z'))).toEqual({ start: at('2026-11-05T00:00:00Z'), next: at('2026-12-05T00:00:00Z') });
    expect(usagePeriod(19, at('2026-11-19T00:00:00Z'))).toEqual({ start: at('2026-11-19T00:00:00Z'), next: at('2026-12-19T00:00:00Z') });
  });

  test('before the reset day, the period started last month', () => {
    expect(usagePeriod(20, at('2026-11-19T23:59:59Z'))).toEqual({ start: at('2026-10-20T00:00:00Z'), next: at('2026-11-20T00:00:00Z') });
  });

  test('across the year boundary', () => {
    expect(usagePeriod(15, at('2027-01-03T08:00:00Z'))).toEqual({ start: at('2026-12-15T00:00:00Z'), next: at('2027-01-15T00:00:00Z') });
    expect(usagePeriod(1, at('2026-12-31T12:00:00Z'))).toEqual({ start: at('2026-12-01T00:00:00Z'), next: at('2027-01-01T00:00:00Z') });
  });
});

describe('limitReached', () => {
  test('at or over the limit, in decimal GB, is reached; under it is not', () => {
    expect(limitReached(49_999_999_999, 50)).toBe(false);
    expect(limitReached(50_000_000_000, 50)).toBe(true);
    expect(limitReached(60_000_000_000, 50)).toBe(true);
  });

  test('a fractional limit counts in bytes too', () => {
    expect(limitReached(1_000_000, 0.001)).toBe(true);
    expect(limitReached(999_999, 0.001)).toBe(false);
  });
});

describe('UsenetLimit', () => {
  test('the reset day is 1–28, so every month has it; the limit is positive', () => {
    expect(UsenetLimit.parse({ monthlyLimitGb: 50, resetDay: 28 })).toEqual({ monthlyLimitGb: 50, resetDay: 28 });
    expect(() => UsenetLimit.parse({ monthlyLimitGb: 50, resetDay: 29 })).toThrow();
    expect(() => UsenetLimit.parse({ monthlyLimitGb: 50, resetDay: 0 })).toThrow();
    expect(() => UsenetLimit.parse({ monthlyLimitGb: 0, resetDay: 1 })).toThrow();
  });
});
