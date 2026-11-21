// The series Work page's Files and Blocklist tabs and its Delete confirm.
import type { BlocklistEntry, UnitRow, WorkFileRow } from '@omnarr/contracts';
import { describe, expect, test } from 'vite-plus/test';

import { openInJellyfinItems } from '../lib/jellyfin';
import { blocklistRows, deleteConfirmed, deleteWorkDialog, monitoringDescription, seasonKey, unblockConfirm, workMenu } from '../lib/library';
import { workFileRows } from '../lib/preparation';

const unitRow = (overrides: Partial<UnitRow>): UnitRow => ({
  unitId: 'u1' as UnitRow['unitId'],
  kind: 'episode',
  tmdbSeason: 1,
  tmdbEpisode: 1,
  monitored: true,
  state: 'notInTargetFormat',
  cancelRequested: false,
  ...overrides,
});

const file = (overrides: Partial<WorkFileRow>): WorkFileRow => ({
  fileId: 'f1' as WorkFileRow['fileId'],
  unitId: 'u1' as WorkFileRow['unitId'],
  tmdbSeason: 1,
  tmdbEpisode: 1,
  path: '/data/library/series/Show (2019)/Season 01/Show - S01E01.mkv',
  origin: 'download',
  kind: 'primary',
  fits: false,
  steps: ['audio', 'remux'],
  sidecars: [],
  sizeBytes: 2_100_000_000,
  quality: 'webdl-1080p',
  ...overrides,
});

describe('the series "…" menu\'s Open in Jellyfin', () => {
  test("opens the series' item at the Jellyfin address, in a new tab", () => {
    expect(openInJellyfinItems('http://192.168.1.20:8096', '/web/#/details?id=jf-series-1&serverId=srv1')).toEqual([
      {
        label: 'Open in Jellyfin',
        icon: 'i-lucide-external-link',
        to: 'http://192.168.1.20:8096/web/#/details?id=jf-series-1&serverId=srv1',
        target: '_blank',
      },
    ]);
  });

  test('is hidden until the backend knows the item', () => {
    expect(openInJellyfinItems('http://192.168.1.20:8096', undefined)).toEqual([]);
  });
});

describe('the Work page\'s "…" (a movie\'s too)', () => {
  const jellyfin = openInJellyfinItems('http://jf:8096', '/web/#/details?id=jf-1&serverId=srv1');
  const noop = () => {};
  const labels = (items: ReturnType<typeof workMenu>) => items.map((item) => ('label' in item ? item.label : '—'));

  test('a series: Open in Jellyfin, Edit monitoring, separator, Delete series…', () => {
    expect(labels(workMenu('series', jellyfin, { editMonitoring: noop, delete: noop }))).toEqual([
      'Open in Jellyfin',
      'Edit monitoring',
      '—',
      'Delete series…',
    ]);
  });

  test("a movie mirrors it, with its item's actions before Edit monitoring; Delete movie… in red", () => {
    const menu = workMenu('movie', jellyfin, { editMonitoring: noop, delete: noop, prepareNow: noop, searchAndPick: noop });
    expect(labels(menu)).toEqual(['Open in Jellyfin', 'Prepare now', 'Search and pick', 'Edit monitoring', '—', 'Delete movie…']);
    expect(menu.at(-1)).toMatchObject({ label: 'Delete movie…', color: 'error', icon: 'i-lucide-trash' });
  });

  test('a movie not yet in Jellyfin, nothing to prepare: Search and pick, Edit monitoring, Delete movie…', () => {
    expect(labels(workMenu('movie', [], { editMonitoring: noop, delete: noop, searchAndPick: noop }))).toEqual([
      'Search and pick',
      'Edit monitoring',
      '—',
      'Delete movie…',
    ]);
  });

  test('the items call their handlers', () => {
    const called: string[] = [];
    const menu = workMenu('movie', [], { editMonitoring: () => called.push('edit'), delete: () => called.push('delete') });
    for (const item of menu) if ('onSelect' in item) item.onSelect?.();
    expect(called).toEqual(['edit', 'delete']);
  });

  test("Edit monitoring's subtitle and switch keys: a movie's one switch is `movie`", () => {
    expect(monitoringDescription('movie')).toBe('A monitored movie is searched and kept in the target format.');
    expect(monitoringDescription('series')).toBe('Monitored episodes are searched and kept in the target format.');
    expect([seasonKey(undefined), seasonKey(0), seasonKey(2)]).toEqual(['movie', 'season:0', 'season:2']);
  });
});

describe('the Blocklist tab', () => {
  const entry = (overrides: Partial<BlocklistEntry>): BlocklistEntry => ({
    entryId: 'b1' as BlocklistEntry['entryId'],
    title: 'The.Long.Harbor.S02E09.1080p.WEB-DL.DDP5.1.H.264-GRPA',
    reason: 'missingArticles',
    grabId: 'k97f3a2cxxxxxxxxxxxc21' as BlocklistEntry['grabId'],
    units: [{ tmdbSeason: 2, tmdbEpisode: 9 }],
    addedAt: Date.UTC(2026, 10, 16, 22, 41),
    ...overrides,
  });

  test('an automatic entry: the episode, the reason in words, its run', () => {
    expect(blocklistRows([entry({})], () => '16 Nov, 22:41')).toEqual([
      {
        entryId: 'b1',
        title: 'The.Long.Harbor.S02E09.1080p.WEB-DL.DDP5.1.H.264-GRPA',
        episode: 'S02E09',
        reason: 'Missing articles',
        source: 'Automatic · k97f3a2c…c21',
        added: '16 Nov, 22:41',
      },
    ]);
  });

  test('a manual entry from a cancel names it; one with no run shows no episode', () => {
    const [cancelled, bare] = blocklistRows([entry({ reason: 'manual' }), entry({ reason: 'manual', grabId: undefined, units: [] })], () => '');
    expect([cancelled!.reason, cancelled!.source]).toEqual(['Manual', 'Manual · cancelled by you · k97f3a2c…c21']);
    expect([bare!.episode, bare!.source]).toEqual(['', 'Manual']);
  });

  test('the unblock confirm says nothing is grabbed now', () => {
    expect(unblockConfirm(entry({}))).toEqual({
      title: 'Unblock this release?',
      description: 'It can be picked again by the next search for S02E09. Nothing is grabbed now.',
    });
    expect(unblockConfirm(entry({ units: [] })).description).toBe('It can be picked again by the next search. Nothing is grabbed now.');
  });
});

describe('the Delete confirm', () => {
  const base = { kind: 'series', title: 'The Long Harbor', units: 30, files: 22, sizeBytes: 41_600_000_000, blocklist: 4, activeDownloads: 5 } as const;

  test('keeps the files by default and says what goes', () => {
    expect(deleteWorkDialog({ ...base, deleteFiles: false })).toEqual({
      title: 'Delete The Long Harbor?',
      subtitle: 'The series, its 30 episodes and their history leave omnarr.',
      downloads: { title: '5 active downloads are cancelled', description: 'Their partial downloads and staging folders are removed.' },
      files: {
        title: '22 files in the library',
        description: 'They stay on disk and in Jellyfin unless you tick the box below. A later scan of untracked media can find them again.',
      },
      deleteFilesHelp: "Deletes the 22 files (41.6 GB) and refreshes Jellyfin, so the episodes leave Jellyfin too. Can't be undone.",
      blocklist: "The series' 4 blocklist entries are deleted with it.",
      confirm: 'Delete series',
      failure: "The series couldn't be deleted",
    });
  });

  test('"Delete movie…": the movie leaves, no episodes counted', () => {
    const movie = { ...base, kind: 'movie', title: 'Paper Lanterns', units: 1, files: 1, sizeBytes: 8_400_000_000, blocklist: 1, activeDownloads: 0 } as const;
    expect(deleteWorkDialog({ ...movie, deleteFiles: false })).toEqual({
      title: 'Delete Paper Lanterns?',
      subtitle: 'The movie and its history leave omnarr.',
      files: {
        title: '1 file in the library',
        description: 'They stay on disk and in Jellyfin unless you tick the box below. A later scan of untracked media can find them again.',
      },
      deleteFilesHelp: "Deletes the 1 file (8.4 GB) and refreshes Jellyfin, so the movie leaves Jellyfin too. Can't be undone.",
      blocklist: "The movie's 1 blocklist entry is deleted with it.",
      confirm: 'Delete movie',
      failure: "The movie couldn't be deleted",
    });
    expect(deleteWorkDialog({ ...movie, deleteFiles: true }).confirm).toBe('Delete movie and files');
  });

  test('with the box ticked the confirm reads "Delete series and files"; nothing running, no files and no entries leave their lines out', () => {
    const dialog = deleteWorkDialog({ ...base, units: 1, files: 0, sizeBytes: 0, blocklist: 0, activeDownloads: 0, deleteFiles: true });
    expect(dialog.confirm).toBe('Delete series and files');
    expect(dialog.subtitle).toBe('The series, its 1 episode and their history leave omnarr.');
    expect(dialog.downloads).toBeUndefined();
    expect(dialog.files).toBeUndefined();
    expect(dialog.deleteFilesHelp).toBeUndefined();
    expect(dialog.blocklist).toBeUndefined();
  });

  test('typing the title enables Delete', () => {
    expect(deleteConfirmed('The Long Harbor', 'The Long Harbor')).toBe(true);
    expect(deleteConfirmed(' The Long Harbor ', 'The Long Harbor')).toBe(true);
    expect(deleteConfirmed('the long harbor', 'The Long Harbor')).toBe(false);
  });
});

describe('the Files tab', () => {
  test("each file names its episode, size, quality and fit, as the item page's Files tab does; Prepare now on a primary that doesn't fit", () => {
    expect(workFileRows([file({})], [unitRow({})])).toEqual([
      {
        key: 'f1:u1:primary',
        unitId: 'u1',
        unit: 'S01E01',
        name: 'Show - S01E01.mkv',
        folder: '/data/library/series/Show (2019)/Season 01',
        kind: 'In the library',
        origin: 'Downloaded',
        fit: { text: 'Needs audio conversion and remux', fits: false },
        sidecars: [],
        size: '2.1 GB',
        quality: 'WEB-DL 1080p',
        prepareNow: true,
      },
    ]);
  });

  test('a file whose torrent still seeds says how far it is', () => {
    expect(workFileRows([file({ seeding: { fraction: 0.4 } })], [unitRow({})])[0]!.seeding).toBe('Seeding 40%');
    expect(workFileRows([file({})], [unitRow({})])[0]!.seeding).toBeUndefined();
  });

  test("a file that fits, a scanned file without quality, and a Unit that is already preparing don't offer Prepare now", () => {
    const rows = workFileRows(
      [
        file({ fits: true, steps: [] }),
        file({ fileId: 'f2' as WorkFileRow['fileId'], unitId: 'u2' as WorkFileRow['unitId'], tmdbEpisode: 2, origin: 'scan', quality: undefined }),
      ],
      [
        unitRow({ state: 'ready' }),
        unitRow({
          unitId: 'u2' as UnitRow['unitId'],
          tmdbEpisode: 2,
          state: 'preparing',
          preparation: { renditionId: 'r1' as never, steps: ['audio'], fraction: 0.4 },
        }),
      ],
    );
    expect(rows.map((row) => [row.unit, row.quality, row.prepareNow, row.fit.text, row.preparing])).toEqual([
      ['S01E01', 'WEB-DL 1080p', false, 'Fits the target', undefined],
      ['S01E02', undefined, false, 'Needs audio conversion and remux', 'Preparing · Audio conversion · 40%'],
    ]);
  });
});
