// Settings › Blocklist: its rows, the kind filter and the unblock confirm.
import { SETTINGS_BLOCKLIST_CAP, type SettingsBlocklistEntry } from '@omnarr/contracts';
import { describe, expect, test } from 'vite-plus/test';

import { blocklistCapNote, blocklistFilters, blocklistRows, matchesBlocklistFilter, unblockConfirm } from '../lib/blocklist';

const entry = (overrides: Partial<SettingsBlocklistEntry> = {}): SettingsBlocklistEntry => ({
  entryId: 'b1' as SettingsBlocklistEntry['entryId'],
  workId: 'w1' as SettingsBlocklistEntry['workId'],
  workTitle: 'The Long Harbor',
  workKind: 'series',
  title: 'The.Long.Harbor.S02E09.1080p.WEB-DL.DDP5.1.H.264-GRPA',
  protocol: 'usenet',
  reason: 'missingArticles',
  addedAt: 1_700_000_000_000,
  ...overrides,
});
const MOVIE = entry({
  entryId: 'b2' as SettingsBlocklistEntry['entryId'],
  workId: 'w2' as SettingsBlocklistEntry['workId'],
  workTitle: 'Northern Line',
  workKind: 'movie',
  title: 'Northern.Line.2023.1080p.WEB-DL.DDP5.1.HEVC-GRPE',
  protocol: 'torrent',
  reason: 'manual',
});

describe('the rows', () => {
  test('each shows its Work, protocol, reason in words and when it was added', () => {
    expect(blocklistRows([entry(), MOVIE], () => '14 Nov')).toEqual([
      {
        entryId: 'b1',
        title: 'The.Long.Harbor.S02E09.1080p.WEB-DL.DDP5.1.H.264-GRPA',
        workId: 'w1',
        workTitle: 'The Long Harbor',
        protocol: 'Usenet',
        reason: 'Missing articles',
        added: '14 Nov',
      },
      { entryId: 'b2', title: MOVIE.title, workId: 'w2', workTitle: 'Northern Line', protocol: 'Torrent', reason: 'Manual', added: '14 Nov' },
    ]);
  });

  test('an entry from before the protocol was stored shows none, never a guessed one', () => {
    const { protocol: _protocol, ...old } = entry();
    expect(blocklistRows([old], () => '')[0]).not.toHaveProperty('protocol');
  });
});

describe('the filter', () => {
  test('All, Series and Movies count their entries', () => {
    expect(blocklistFilters([entry(), MOVIE, entry()])).toEqual([
      { value: 'all', label: 'All', count: 3 },
      { value: 'series', label: 'Series', count: 2 },
      { value: 'movies', label: 'Movies', count: 1 },
    ]);
  });

  test('picks by kind, and by text in the release or the Work title', () => {
    expect(matchesBlocklistFilter(MOVIE, 'series', '')).toBe(false);
    expect(matchesBlocklistFilter(MOVIE, 'movies', '')).toBe(true);
    expect(matchesBlocklistFilter(entry(), 'all', 'long harbor')).toBe(true);
    expect(matchesBlocklistFilter(entry(), 'all', 'grpa')).toBe(true);
    expect(matchesBlocklistFilter(entry(), 'all', 'northern')).toBe(false);
  });
});

test('at the cap, a note says only the newest entries are shown', () => {
  expect(blocklistCapNote(SETTINGS_BLOCKLIST_CAP - 1)).toBeUndefined();
  expect(blocklistCapNote(SETTINGS_BLOCKLIST_CAP)).toMatch(/^Showing the newest 500 entries\./);
});

test('the unblock confirm says it grabs nothing, for that Work', () => {
  expect(unblockConfirm(MOVIE)).toEqual({
    title: 'Unblock this release?',
    description: 'It can be picked again by the next search for Northern Line. Nothing is grabbed now.',
  });
});
