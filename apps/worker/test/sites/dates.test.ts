// Dates and sizes: `dateparse` with .NET custom format strings and Go
// layouts, `timeago`, `fuzzytime` and the `date` field's FromUnknown, and
// Prowlarr's GetBytes. Times without an offset are UTC (the worker's zone).
import { describe, expect, test } from 'vite-plus/test';

import { formatRfc1123, fromTimeAgo, fromUnknown, parseLayout } from '../../src/sites/dates.ts';
import { coerceDouble, coerceInt, parseBytes } from '../../src/sites/sizes.ts';

const NOW = Date.UTC(2026, 10, 20, 12, 0, 0);
const utc = (...parts: [number, number, number, number?, number?, number?]) =>
  Date.UTC(parts[0], parts[1] - 1, parts[2], parts[3] ?? 0, parts[4] ?? 0, parts[5] ?? 0);

describe('parseLayout (.NET custom formats)', () => {
  test.each([
    ['2025-03-04 05:06:07 +02:00', 'yyyy-MM-dd HH:mm:ss zzz', utc(2025, 3, 4, 3, 6, 7)],
    ['2025-03-04 05:06 -00:00', 'yyyy-MM-dd HH:mm zzz', utc(2025, 3, 4, 5, 6)],
    ['Tue, 04 Mar 2025 05:06:07 +00:00', 'ddd, dd MMM yyyy HH:mm:ss zzz', utc(2025, 3, 4, 5, 6, 7)],
    ['4 March 2025 05:06:07 +01:00', 'd MMMM yyyy HH:mm:ss zzz', utc(2025, 3, 4, 4, 6, 7)],
    ['Mar 4, 2025, 5 PM +00:00', 'MMM d, yyyy, h tt zzz', utc(2025, 3, 4, 17)],
    ['Mar 4 2025 - 5:06AM +00:00', 'MMM d yyyy - h:mmtt zzz', utc(2025, 3, 4, 5, 6)],
    ['04 Mar 25 05:06:07 +00:00', 'dd MMM yy HH:mm:ss zzz', utc(2025, 3, 4, 5, 6, 7)],
    ['04.03.2025', 'dd.MM.yyyy', utc(2025, 3, 4)],
    ['4-03-2025, 05:06 +00:00', 'd-MM-yyyy, HH:mm zzz', utc(2025, 3, 4, 5, 6)],
    ['2025/03/04 05:06 +00:00', 'yyyy/MM/dd HH:mm zzz', utc(2025, 3, 4, 5, 6)],
    ['12 Mar 99 +00:00', 'dd MMM yy zzz', utc(1999, 3, 12)],
  ])('%s with %s', (value, layout, expected) => {
    expect(parseLayout(value, layout)).toBe(expected);
  });

  test('a value that does not fit the layout, or names the wrong weekday, gives undefined', () => {
    expect(parseLayout('2025-03-04', 'dd.MM.yyyy')).toBeUndefined();
    expect(parseLayout('Mon, 04 Mar 2025 05:06:07 +00:00', 'ddd, dd MMM yyyy HH:mm:ss zzz')).toBeUndefined();
  });

  test('a Go layout is converted as Prowlarr does', () => {
    expect(parseLayout('2025-03-04 05:06:07', '2006-01-02 15:04:05')).toBe(utc(2025, 3, 4, 5, 6, 7));
  });
});

describe('fromTimeAgo and fromUnknown', () => {
  test('timeago sums every unit', () => {
    expect(fromTimeAgo('2 hours, 1 day ago', NOW)).toBe(NOW - 26 * 3_600_000);
    expect(fromTimeAgo('3 wk', NOW)).toBe(NOW - 21 * 86_400_000);
    expect(fromTimeAgo('just now', NOW)).toBe(NOW);
  });

  test('the formats a date field is read in', () => {
    expect(fromUnknown(formatRfc1123(utc(2025, 3, 4, 5, 6, 7)), NOW)).toBe(utc(2025, 3, 4, 5, 6, 7));
    expect(fromUnknown('1741064767', NOW)).toBe(1_741_064_767_000);
    expect(fromUnknown('5 mins ago', NOW)).toBe(NOW - 300_000);
    expect(fromUnknown('Today 14:22', NOW)).toBe(utc(2026, 11, 20, 14, 22));
    expect(fromUnknown('Yesterday, 2:30 pm', NOW)).toBe(utc(2026, 11, 19, 14, 30));
    expect(fromUnknown('2025-03-04 05:06:07', NOW)).toBe(utc(2025, 3, 4, 5, 6, 7));
    expect(fromUnknown('2025-03-04T05:06:07+02:00', NOW)).toBe(utc(2025, 3, 4, 3, 6, 7));
    expect(fromUnknown('2021-10-19T06:10:15.772Z', NOW)).toBe(utc(2021, 10, 19, 6, 10, 15) + 772);
    expect(fromUnknown('03/04/2025', NOW)).toBe(utc(2025, 3, 4));
    expect(fromUnknown('4 Mar 2025', NOW)).toBe(utc(2025, 3, 4));
    expect(fromUnknown('Mar 4, 2025 5:06 PM', NOW)).toBe(utc(2025, 3, 4, 17, 6));
    expect(fromUnknown('11-05 10:00', NOW)).toBe(utc(2026, 11, 5, 10));
  });

  test('a date nothing reads is undefined', () => {
    expect(fromUnknown('soon', NOW)).toBeUndefined();
  });
});

describe('sizes (GetBytes)', () => {
  test.each([
    ['1.5 GiB', 1_610_612_736],
    ['1.5 GB', 1_610_612_736],
    ['700 MB', 734_003_200],
    ['2 TB', 2_199_023_255_552],
    ['512 KiB', 524_288],
    ['1,5 GB', 1_610_612_736],
    ['1.234,5 MB', 1_294_467_072],
    ['12345', 12_345],
    ['n/a', 0],
  ])('%s', (text, bytes) => {
    expect(parseBytes(text)).toBe(bytes);
  });

  test('coerce reads digits and treats a dash as zero', () => {
    expect(coerceInt('1,024')).toBe(1024);
    expect(coerceInt('-')).toBe(0);
    expect(coerceDouble('0.5')).toBe(0.5);
  });
});
