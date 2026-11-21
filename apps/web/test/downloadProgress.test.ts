// DownloadProgress's text: percent, size, speed and time left.
import type { UnitDownload, WorkSummary } from '@omnarr/contracts';
import { describe, expect, test } from 'vite-plus/test';

import { activeDownloadsLine, downloadLine, seedingBadge, seedingLine, seedingSummary } from '../lib/downloads';

const download = (overrides: Partial<UnitDownload> = {}): UnitDownload =>
  ({ grabId: 'g1', protocol: 'usenet', stage: 'downloading', fraction: 0.43, ...overrides }) as UnitDownload;

describe('downloadLine', () => {
  test('percent, "x of y GB", speed and time left', () => {
    expect(downloadLine(download({ doneBytes: 900_000_000, totalBytes: 2_100_000_000, bytesPerSec: 18_200_000 }))).toEqual({
      stage: 'Downloading',
      percent: 43,
      line: '0.9 of 2.1 GB · 18.2 MB/s · 1 min left',
    });
  });

  test('a torrent says so', () => {
    expect(
      downloadLine(download({ protocol: 'torrent', fraction: 0.08, doneBytes: 100_000_000, totalBytes: 1_600_000_000, bytesPerSec: 12_600_000 })).line,
    ).toBe('Torrent · 0.1 of 1.6 GB · 12.6 MB/s · 2 min left');
  });

  test('sizes under a GB in MB, slow rates in KB/s, long waits in hours', () => {
    expect(downloadLine(download({ doneBytes: 120_000_000, totalBytes: 480_000_000, bytesPerSec: 850_000 })).line).toBe(
      '120 of 480 MB · 850 KB/s · 7 min left',
    );
    expect(downloadLine(download({ doneBytes: 1e9, totalBytes: 40e9, bytesPerSec: 5e6 })).line).toBe('1.0 of 40.0 GB · 5.0 MB/s · 2 h 10 min left');
    expect(downloadLine(download({ doneBytes: 1_960_000_000, totalBytes: 2e9, bytesPerSec: 1e6 })).line).toBe('2.0 of 2.0 GB · 1.0 MB/s · 40 s left');
  });

  test('missing bytes or speed leave those parts out; no speed, no time left', () => {
    expect(downloadLine(download()).line).toBe('');
    expect(downloadLine(download({ doneBytes: 900_000_000, totalBytes: 2_100_000_000 })).line).toBe('0.9 of 2.1 GB');
    expect(downloadLine(download({ bytesPerSec: 18_200_000 })).line).toBe('18.2 MB/s');
    expect(downloadLine(download({ doneBytes: 900_000_000, totalBytes: 2_100_000_000, bytesPerSec: 0 })).line).toBe('0.9 of 2.1 GB · 0 KB/s');
  });

  test('before the first report: waiting for the client, and no percent', () => {
    expect(downloadLine(download({ fraction: undefined, stage: 'queued' }))).toEqual({ stage: 'Queued', line: 'Waiting for NZBGet…' });
    expect(downloadLine(download({ fraction: undefined, protocol: 'torrent' }))).toEqual({ stage: 'Downloading', line: 'Waiting for qBittorrent…' });
  });

  test('a release under 1 MB in KB', () => {
    expect(downloadLine(download({ stage: 'queued', fraction: 0, totalBytes: 165_351 })).line).toBe('Queued in NZBGet · 165 KB');
    expect(downloadLine(download({ doneBytes: 40_000, totalBytes: 165_351 })).line).toBe('40 of 165 KB');
  });

  test('queued in the client, with its size once known', () => {
    expect(downloadLine(download({ stage: 'queued', fraction: 0, totalBytes: 2_100_000_000 }))).toEqual({
      stage: 'Queued',
      percent: 0,
      line: 'Queued in NZBGet · 2.1 GB',
    });
  });

  test('post-processing: repair and unpack, with no percent or speed', () => {
    expect(downloadLine(download({ stage: 'postProcessing', fraction: 1, bytesPerSec: 0 }))).toEqual({
      stage: 'Repair / unpack',
      line: 'NZBGet is checking and unpacking the files',
    });
  });
});

describe('seedingLine: a seeding torrent on the item page', () => {
  const DAY = 86_400_000;
  const GOAL = { ratio: 2, seedTimeMs: 14 * DAY };

  test('ratio of its goal, days of its goal, uploaded; the percent is the closer goal', () => {
    expect(seedingLine({ ratio: 0.8, seedTimeMs: 3 * DAY, uploadedBytes: 1_200_000_000, goal: GOAL, fraction: 0.4 })).toEqual({
      stage: 'Seeding',
      percent: 40,
      line: 'ratio 0.8 of 2.0 · 3 of 14 days · 1.2 GB uploaded',
    });
  });

  test("a goal without a ratio or a time leaves that part's goal out", () => {
    expect(seedingLine({ ratio: 0.8, seedTimeMs: 3 * DAY, uploadedBytes: 0, goal: { seedTimeMs: 14 * DAY }, fraction: 3 / 14 }).line).toBe(
      'ratio 0.8 · 3 of 14 days · 0 KB uploaded',
    );
    expect(seedingLine({ ratio: 0.8, seedTimeMs: 3 * DAY, goal: { ratio: 2 }, fraction: 0.4 }).line).toBe('ratio 0.8 of 2.0 · 3 days');
  });

  test("a goal under a day counts in its own unit: the e2e's one-minute goal", () => {
    expect(seedingLine({ ratio: 0, seedTimeMs: 30_000, goal: { seedTimeMs: 60_000 }, fraction: 0.5 }).line).toBe('ratio 0.0 · 0 of 1 min');
    expect(seedingLine({ seedTimeMs: 5 * 3_600_000, goal: { seedTimeMs: 12 * 3_600_000 }, fraction: 5 / 12 }).line).toBe('5 of 12 h');
  });

  test('before the first reading: waiting for qBittorrent, no percent', () => {
    expect(seedingLine({ goal: GOAL })).toEqual({ stage: 'Seeding', line: 'Waiting for qBittorrent…' });
  });
});

describe('seedingBadge and seedingSummary', () => {
  test('a Files row: "Seeding 40%", or "Seeding" before the first reading', () => {
    expect(seedingBadge({ fraction: 0.4 })).toBe('Seeding 40%');
    expect(seedingBadge({})).toBe('Seeding');
  });

  test('the Torrents card: how many seed and what they uploaded; nothing while none does', () => {
    expect(seedingSummary({ count: 3, uploadedBytes: 4_200_000_000 })).toBe('Seeding 3 torrents · 4.2 GB uploaded');
    expect(seedingSummary({ count: 1, uploadedBytes: 0 })).toBe('Seeding 1 torrent · 0 KB uploaded');
    expect(seedingSummary({ count: 0, uploadedBytes: 0 })).toBeUndefined();
    expect(seedingSummary(undefined)).toBeUndefined();
  });
});

describe('activeDownloadsLine', () => {
  const active = (overrides: Partial<NonNullable<WorkSummary['activeDownloads']>> = {}) => ({ count: 1, fraction: 0.614, ...overrides });

  test('one download: "Downloading", its percent and speed; the poster badge is the percent', () => {
    expect(activeDownloadsLine(active({ bytesPerSec: 12_000_000 }))).toEqual({ line: 'Downloading · 61% · 12.0 MB/s', badge: '61%' });
  });

  test('several: their count', () => {
    expect(activeDownloadsLine(active({ count: 2, fraction: 0.43, bytesPerSec: 31_000_000 }))).toEqual({
      line: '2 downloading · 43% · 31.0 MB/s',
      badge: '2 · 43%',
    });
  });

  test('before any report: the count only', () => {
    expect(activeDownloadsLine(active({ count: 2, fraction: undefined }))).toEqual({ line: '2 downloading', badge: '2' });
    expect(activeDownloadsLine(undefined)).toBeUndefined();
  });
});
