// Settings › Metadata's source rows: a health badge and one line per source.
import { describe, expect, test } from 'vite-plus/test';

import { sourceHealth } from '../lib/metadata';

const at = (iso: string) => Date.parse(iso);
const time = (ms: number) => new Date(ms).toISOString().slice(0, 16).replace('T', ' ');

describe('sourceHealth', () => {
  test('working: the last success and, when it has one, the version', () => {
    expect(sourceHealth({ name: 'tmdb', lastSuccessAt: at('2026-11-18T14:02:00Z') }, time)).toEqual({
      badge: { label: 'Working', color: 'success' },
      line: 'Last success 2026-11-18 14:02',
    });
    expect(sourceHealth({ name: 'xem', version: '2026-11-18T04:00:00.000Z', lastSuccessAt: at('2026-11-18T04:00:00Z') }, time).line).toBe(
      'Last success 2026-11-18 04:00 · version 2026-11-18T04:00:00',
    );
  });

  test('failing: since when, and the last success if there was one', () => {
    expect(sourceHealth({ name: 'animeLists', firstFailureAt: at('2026-11-17T04:00:00Z'), lastSuccessAt: at('2026-11-16T04:00:00Z') }, time)).toEqual({
      badge: { label: 'Failing', color: 'error' },
      line: 'Failing since 2026-11-17 04:00 · last success 2026-11-16 04:00',
      failing: true,
    });
    expect(sourceHealth({ name: 'animeLists', firstFailureAt: at('2026-11-17T04:00:00Z') }, time).line).toBe('Failing since 2026-11-17 04:00');
  });

  test('never fetched yet', () => {
    expect(sourceHealth({ name: 'xem' }, time)).toEqual({ badge: { label: 'Not fetched yet', color: 'neutral' }, line: 'Fetched on its first use' });
  });
});
