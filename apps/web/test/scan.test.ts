// The scan's wording: the tabs, the last-scan line, the run's states, the
// grouped rows, the selection and the import, the unmatched cards and
// "Match by hand".
import type { ScanCounts, ScanGroup, ScanItemRow, ScanStatus } from '@omnarr/contracts';
import { describe, expect, test } from 'vite-plus/test';

import {
  allChecked,
  assignedFiles,
  assignmentProblem,
  cardHeading,
  defaultAssignments,
  episodeItems,
  matchButton,
  matchedToast,
  matchHeading,
  MOVIE_CHOICES,
  seasonItems,
  suggestionLine,
  cardImportButton,
  cardImportLine,
  fileName,
  numberingHint,
  conflictLine,
  fileRow,
  filesPreview,
  folderKey,
  groupHeading,
  ignoredLine,
  ignoreToast,
  importPanelText,
  importFooter,
  importToast,
  lastScanLine,
  MONITOR_ITEMS,
  monitorHelp,
  moreFiles,
  NUMBERING_ITEMS,
  numberingOf,
  numberingToast,
  previewAlert,
  readAsLine,
  rescanConfirm,
  SCHEDULE_ITEMS,
  scheduleHelp,
  trackedLine,
  unignoreToast,
  untrackedBadge,
  scanBusy,
  scanTabs,
  scanView,
} from '../lib/scan';

const counts = (overrides: Partial<ScanCounts> = {}): ScanCounts => ({
  read: 1204,
  tracked: 1135,
  matched: 52,
  unmatched: 17,
  ignored: 0,
  imported: 0,
  ...overrides,
});

describe('the tabs', () => {
  test('each tab carries its count; Unmatched adds its folders once they are known', () => {
    expect(scanTabs(counts(), 3)).toEqual([
      { value: 'matched', label: 'Matched', count: '52', to: '/scan' },
      { value: 'unmatched', label: 'Unmatched', count: '3 folders · 17 files', to: '/scan/unmatched' },
      { value: 'tracked', label: 'Already tracked', count: '1,135', to: '/scan?tab=tracked' },
    ]);
    expect(scanTabs(counts({ unmatched: 1 }), undefined)[1]!.count).toBe('1 file');
    expect(scanTabs(counts({ unmatched: 1 }), 1)[1]!.count).toBe('1 folder · 1 file');
  });
});

describe("the run's states", () => {
  const status = (run: Partial<NonNullable<ScanStatus['run']>> | null, untracked = 0): ScanStatus => ({
    run:
      run === null
        ? null
        : {
            scanRunId: 'r1' as NonNullable<ScanStatus['run']>['scanRunId'],
            trigger: 'manual',
            state: 'ready',
            counts: counts({ matched: 0, unmatched: 0 }),
            startedAt: 1,
            hasDecisions: false,
            ...run,
          },
    untracked,
    schedule: 'off',
  });

  test('before the first scan', () => {
    expect(scanView(status(null))).toEqual({
      kind: 'never',
      title: 'No scan yet',
      description: "Scan now reads the library folders for videos the platform didn't import.",
    });
  });

  test("reading shows the worker's progress, or waits for it", () => {
    expect(scanView(status({ state: 'reading', progress: { fraction: 0.532, detail: '640 / 1,204' } }))).toEqual({
      kind: 'reading',
      title: 'Reading the library folders…',
      progress: { text: '640 / 1,204 files', percent: 53 },
      description: 'You can leave this page. Results appear here when the scan ends.',
    });
    expect(scanView(status({ state: 'reading' }))).toMatchObject({ kind: 'reading', progress: { text: 'Waiting for the worker' } });
    expect(scanView(status({ state: 'reading', progress: { fraction: 0.25 } }))).toMatchObject({ progress: { text: '25 %', percent: 25 } });
  });

  test('matching', () => {
    expect(scanView(status({ state: 'matching' }))).toEqual({
      kind: 'matching',
      title: 'Matching the files to titles…',
      description: 'Each folder is looked up in the library, then on TMDB. You can leave this page.',
    });
  });

  test('a ready run is reviewed while it has untracked files', () => {
    expect(scanView(status({ counts: counts() }, 69))).toEqual({ kind: 'review' });
  });

  test('nothing untracked', () => {
    expect(scanView(status({}))).toEqual({
      kind: 'nothing',
      title: 'Everything in the library folders is in the library',
      description: '1,204 files read, all already tracked.',
    });
    expect(scanView(status({ counts: counts({ matched: 0, unmatched: 0, tracked: 1190, ignored: 14 }) }))).toMatchObject({
      description: '1,204 files read: 1,190 already tracked, 14 in ignored folders.',
    });
  });

  test('everything imported', () => {
    expect(scanView(status({ counts: counts({ matched: 0, unmatched: 0, imported: 69 }) }))).toEqual({
      kind: 'nothing',
      title: 'Everything in the library folders is in the library',
      description: '69 files were imported from this scan. Nothing is left to review.',
    });
  });

  test('failed and cancelled', () => {
    expect(scanView(status({ state: 'failed' }))).toEqual({
      kind: 'failed',
      title: 'The scan failed',
      description: "The worker couldn't finish reading the library folders. The System page lists its failed jobs. Scan again once it is fixed.",
    });
    expect(scanView(status({ state: 'cancelled' }))).toEqual({
      kind: 'cancelled',
      title: 'The scan was cancelled',
      description: 'Nothing was imported. Scan again to read the library folders.',
    });
  });

  test('Scan now waits while a run reads or matches, and asks before it drops review decisions', () => {
    expect(scanBusy(status({ state: 'reading' }))).toBe(true);
    expect(scanBusy(status({ state: 'matching' }))).toBe(true);
    expect(scanBusy(status({ state: 'ready' }))).toBe(false);
    expect(rescanConfirm(status({ state: 'ready', hasDecisions: false }, 3))).toBeUndefined();
    expect(rescanConfirm(status({ state: 'ready', hasDecisions: true }, 3))).toEqual({
      title: 'Scan again?',
      description: 'A new scan replaces this review. The numberings you chose and the folders you matched by hand are lost.',
      confirm: 'Scan again',
    });
  });
});

type Group = ScanGroup;
type Item = ScanItemRow;

const item = (overrides: Partial<Item> = {}): Item => ({
  scanItemId: 'i1' as Item['scanItemId'],
  path: '/data/library/series/Old Show (2015)/Season 1/Old Show - S01E01 - Pilot.mkv',
  relPath: 'Old Show (2015)/Season 1/Old Show - S01E01 - Pilot.mkv',
  sizeBytes: 1_500_000_000,
  status: 'matched',
  units: [{ season: 1, episode: 1, title: 'Pilot' }],
  fits: false,
  step: 'video',
  format: { video: 'hevc', audio: 'eac3', container: 'matroska' },
  ...overrides,
});

const groupCounts = (overrides: Partial<Group['counts']> = {}): Group['counts'] => ({
  files: 24,
  matched: 24,
  unmatched: 0,
  conflict: 0,
  ignored: 0,
  imported: 0,
  notFit: 24,
  ...overrides,
});

const group = (overrides: Partial<Group> = {}): Group => ({
  libraryId: 'l1' as Group['libraryId'],
  libraryKind: 'series',
  folder: 'Old Show (2015)',
  match: { tmdbId: '100', kind: 'series', title: 'Old Show', year: 2015, ordering: 'tvdb', readAs: 'sonarr' },
  suggestions: [],
  counts: groupCounts(),
  files: [item(), item({ scanItemId: 'i2' as Item['scanItemId'], units: [{ season: 1, episode: 2, title: 'Second' }] })],
  ...overrides,
});

describe("the Matched tab's rows", () => {
  test("a group's heading: the title, kind, numbering, file count and library", () => {
    expect(groupHeading(group())).toEqual({
      title: 'Old Show (2015)',
      line: 'Series · TVDB numbering · 24 files → Series library',
      tags: [{ label: '24 not in target format', color: 'warning', icon: 'i-lucide-triangle-alert' }],
    });
    expect(
      groupHeading(
        group({
          libraryKind: 'movies',
          folder: 'Some Film (2019)',
          match: { tmdbId: '7', kind: 'movie', title: 'Some Film', year: 2019, ordering: 'tmdb', readAs: 'radarr' },
          counts: groupCounts({ files: 1, matched: 1, notFit: 0 }),
        }),
      ),
    ).toEqual({ title: 'Some Film (2019)', line: 'Movie · 1 file → Movies library', tags: [{ label: 'Fits', color: 'success', icon: 'i-lucide-check' }] });
  });

  test("a group's tags: already in the library, files on the Unmatched tab, conflicts", () => {
    const heading = groupHeading(
      group({
        match: { workId: 'w1' as never, tmdbId: '3', kind: 'series', title: 'Sky Courier', year: 2021, ordering: 'absolute', readAs: 'unknown' },
        counts: groupCounts({ files: 30, matched: 27, unmatched: 2, conflict: 1, notFit: 0 }),
      }),
    );
    expect(heading.line).toBe('Series · absolute numbering · 27 files → Series library');
    expect(heading.tags.map((tag) => tag.label)).toEqual(['Fits', 'Already in library', '2 unmatched', '1 already has a file']);
    expect(groupHeading(group({ match: { ...group().match!, ordering: 'manual' } })).line).toBe('Series · matched by hand · 24 files → Series library');
  });

  test('a file row: the path under the root, what it matched, how it was read and its format', () => {
    expect(fileRow(item(), group())).toEqual({
      file: 'Old Show (2015)/Season 1/Old Show - S01E01 - Pilot.mkv',
      matchedTo: 'S01E01 Pilot',
      readAs: 'Sonarr naming',
      target: { text: 'Not yet', fits: false, format: 'HEVC · E-AC-3 · MKV' },
    });
    const movie = group({ match: { tmdbId: '7', kind: 'movie', title: 'Some Film', ordering: 'tmdb', readAs: 'radarr' } });
    expect(fileRow(item({ units: [{ title: 'Some Film' }], fits: true, format: { video: 'h264', audio: 'aac', container: 'mp4' } }), movie)).toMatchObject({
      matchedTo: 'Movie',
      readAs: 'Radarr naming',
      target: { text: 'Fits', fits: true, format: 'H.264 · AAC · MP4' },
    });
    expect(
      fileRow(
        item({
          units: [
            { season: 1, episode: 1 },
            { season: 1, episode: 2 },
          ],
        }),
        group(),
      ).matchedTo,
    ).toBe('S01E01 · S01E02');
  });

  test("a file row for a file that isn't imported with the folder", () => {
    expect(fileRow(item({ status: 'conflict' }), group()).matchedTo).toBe('S01E01 already has a file');
    expect(fileRow(item({ status: 'unmatched', unmatchedReason: 'noNumbers', units: [] }), group()).matchedTo).toBe(
      'Not matched: no episode number in its name',
    );
    expect(fileRow(item({ status: 'unmatched', unmatchedReason: 'unreadable', units: [], fits: undefined, format: undefined }), group())).toMatchObject({
      matchedTo: "Not matched: ffprobe couldn't read it",
      target: { text: 'Unknown' },
    });
    expect(fileRow(item({ status: 'imported' }), group()).matchedTo).toBe('S01E01 Pilot · imported');
    expect(fileRow(item({ status: 'ignored' }), group()).matchedTo).toBe('Ignored');
    expect(fileRow(item(), group({ match: { ...group().match!, readAs: 'unknown' } })).readAs).toBe('Unrecognised naming');
  });

  test('a matched file Jellyfin would misread says it is renamed to library naming; the others say nothing', () => {
    const renamed = 'renamed to library naming';
    expect(fileRow(item(), group({ match: { ...group().match!, readAs: 'unknown' } })).naming).toBe(renamed);
    expect(fileRow(item(), group({ match: { ...group().match!, ordering: 'manual' } })).naming).toBe(renamed);
    expect(fileRow(item(), group({ match: { ...group().match!, ordering: 'absolute' } })).naming).toBe(renamed);
    expect(fileRow(item(), group())).not.toHaveProperty('naming');
    // Sonarr naming outside the Work's folder moves into it.
    expect(fileRow(item(), group({ match: { ...group().match!, workId: 'w1' as never, workFolder: 'Old Show (2015) [tmdbid-100]' } })).naming).toBe(renamed);
    expect(fileRow(item(), group({ match: { ...group().match!, workId: 'w1' as never, workFolder: 'Old Show (2015)' } }))).not.toHaveProperty('naming');
    expect(fileRow(item({ status: 'conflict' }), group({ match: { ...group().match!, readAs: 'unknown' } }))).not.toHaveProperty('naming');
  });

  test('the files a group leaves out', () => {
    expect(moreFiles(group())).toBe('22 more files');
    expect(moreFiles(group({ counts: groupCounts({ files: 2 }) }))).toBeUndefined();
  });
});

describe('the selection and the import', () => {
  const oldShow = group();
  const film = group({ folder: 'Some Film (2019)', libraryId: 'l2' as Group['libraryId'], counts: groupCounts({ files: 1, matched: 1, notFit: 0 }) });
  const sky = group({ folder: 'Sky Courier', counts: groupCounts({ files: 30, matched: 27, unmatched: 2, conflict: 1, notFit: 3 }) });
  const keys = (...groups: Group[]) => new Set(groups.map(folderKey));

  test("the footer counts the selected folders' matched files, and which of them keep their path and name or are renamed", () => {
    expect(importFooter([oldShow, film, sky], keys(oldShow, film, sky))).toEqual({
      line: '52 files selected · 52 keep their path and name',
      button: 'Import 52 files',
      files: 52,
    });
    expect(importFooter([oldShow, film], keys(film))).toEqual({ line: '1 file selected · 1 keeps its path and name', button: 'Import 1 file', files: 1 });
    expect(importFooter([oldShow], keys())).toEqual({ line: 'No folders selected', button: 'Import', files: 0 });
    const unrecognised = { ...sky, match: { ...sky.match!, readAs: 'unknown' as const } };
    expect(importFooter([oldShow, film, unrecognised], keys(oldShow, film, unrecognised)).line).toBe(
      '52 files selected · 25 keep their path and name · 27 renamed to library naming',
    );
    expect(importFooter([unrecognised], keys(unrecognised)).line).toBe('27 files selected · 27 renamed to library naming');
    const elsewhere = { ...oldShow, match: { ...oldShow.match!, workId: 'w1' as never, workFolder: 'Old Show (2015) [tmdbid-100]' } };
    expect(importFooter([elsewhere, film], keys(elsewhere, film)).line).toBe('25 files selected · 1 keeps its path and name · 24 renamed to library naming');
  });

  // Finding 21: the import panel names what is selected.
  test('only series selected: the panel says series', () => {
    expect(importPanelText({ series: 2, movies: 0 }, 'tracked')).toEqual({
      profileLabel: 'Release profile for imported series',
      profileHelp: "Every series needs one. It's used for upgrades and missing episodes.",
      monitorLabel: 'After import, series are',
      monitorHelp: 'Their episodes are tracked, nothing is searched. Monitor them later on their pages.',
    });
    expect(importPanelText({ series: 1, movies: 0 }, 'monitored').monitorHelp).toBe('Monitored series search for missing episodes right away.');
  });

  test('only one movie selected: the panel says "the movie"', () => {
    expect(importPanelText({ series: 0, movies: 1 }, 'tracked')).toEqual({
      profileLabel: 'Release profile for the imported movie',
      profileHelp: 'Used for upgrades.',
      monitorLabel: 'After import, the movie is',
      monitorHelp: 'Its file is tracked; nothing is searched. Monitor it later on its page.',
    });
    expect(importPanelText({ series: 0, movies: 1 }, 'monitored').monitorHelp).toBe('A monitored movie is searched for upgrades.');
  });

  test('several movies: "movies"', () => {
    expect(importPanelText({ series: 0, movies: 3 }, 'tracked')).toEqual({
      profileLabel: 'Release profile for imported movies',
      profileHelp: 'Used for upgrades.',
      monitorLabel: 'After import, movies are',
      monitorHelp: 'Their files are tracked; nothing is searched. Monitor them later on their pages.',
    });
    expect(importPanelText({ series: 0, movies: 3 }, 'monitored').monitorHelp).toBe('Monitored movies are searched for upgrades.');
  });

  test('series and movies, or nothing selected: "titles"', () => {
    const both = {
      profileLabel: 'Release profile for imported titles',
      profileHelp: 'Used for upgrades and, for series, missing episodes.',
      monitorLabel: 'After import, titles are',
      monitorHelp: 'Files are tracked; nothing is searched. Monitor them later on their pages.',
    };
    expect(importPanelText({ series: 1, movies: 1 }, 'tracked')).toEqual(both);
    expect(importPanelText({ series: 0, movies: 0 }, 'tracked')).toEqual(both);
    expect(importPanelText({ series: 2, movies: 1 }, 'monitored').monitorHelp).toBe(
      'Monitored series search for missing episodes right away; monitored movies are searched for upgrades.',
    );
  });

  test('the header checkbox is on, off or mixed', () => {
    expect(allChecked([oldShow, film], keys(oldShow, film))).toBe(true);
    expect(allChecked([oldShow, film], keys(film))).toBe('indeterminate');
    expect(allChecked([oldShow, film], keys())).toBe(false);
    expect(allChecked([], keys())).toBe(false);
  });

  test('the options say what they do', () => {
    expect(MONITOR_ITEMS).toEqual([
      { value: 'tracked', label: 'Tracked, not monitored' },
      { value: 'monitored', label: 'Monitored' },
    ]);
    expect(monitorHelp('tracked')).toBe('Their episodes are tracked, nothing is searched. Monitor them later on their pages.');
    expect(monitorHelp('monitored')).toBe('Monitored series search for missing episodes right away.');
  });

  test('after import: how many, how many new titles, and how many are not in target format', () => {
    expect(importToast({ imported: 52, works: 2, failed: [] }, 24, () => '')).toEqual([
      {
        color: 'success',
        title: 'Imported 52 files',
        description: '2 new titles. 24 are not in target format. They play as they are and show "Not yet in target format".',
      },
    ]);
    expect(importToast({ imported: 1, works: 0, failed: [] }, 1, () => '')[0]!.description).toBe(
      '1 is not in target format. It plays as it is and shows "Not yet in target format".',
    );
    expect(importToast({ imported: 1, works: 1, failed: [] }, 0, () => '')[0]!.description).toBe('1 new title. All of them fit the target format.');
  });

  test('a folder that failed gets its own toast, and nothing imported says so', () => {
    const failed = { libraryId: oldShow.libraryId, folder: oldShow.folder, message: 'TMDB did not answer.' };
    expect(importToast({ imported: 0, works: 0, failed: [failed] }, 0, (ref) => `${ref.folder}!`)).toEqual([
      { color: 'error', title: "Old Show (2015)! wasn't imported", description: 'TMDB did not answer.' },
    ]);
    expect(importToast({ imported: 0, works: 0, failed: [] }, 0, () => '')).toEqual([
      { color: 'neutral', title: 'Nothing was imported', description: 'The selected files were imported or tracked meanwhile.' },
    ]);
  });
});

describe("the Unmatched tab's cards", () => {
  const sky = (overrides: Partial<Group> = {}) =>
    group({
      folder: 'Sky Courier S2',
      match: undefined,
      reason: 'noWork',
      counts: groupCounts({ files: 12, matched: 0, unmatched: 12, notFit: 0 }),
      files: [13, 14, 15].map((n) =>
        item({
          scanItemId: `i${n}` as Item['scanItemId'],
          path: `/data/library/series/Sky Courier S2/Sky.Courier.${n}.1080p.mkv`,
          relPath: `Sky Courier S2/Sky.Courier.${n}.1080p.mkv`,
          status: 'unmatched',
          unmatchedReason: 'noWork',
          units: [],
          read: { episodes: [], absolute: [n] },
        }),
      ),
      ...overrides,
    });

  test("a card's heading: the folder's full path, its files and why it is unmatched", () => {
    expect(cardHeading(sky())).toEqual({
      path: '/data/library/series/Sky Courier S2/',
      files: '12 files',
      tag: 'No title matched',
      help: 'No title in the library or on TMDB matches the folder name. Match it by hand.',
    });
    expect(cardHeading(sky({ reason: 'ambiguous' }))).toMatchObject({
      tag: 'The numberings disagree',
      help: 'More than one numbering reads every file, each to different episodes. Choose the numbering.',
    });
    expect(cardHeading(sky({ reason: undefined, counts: groupCounts({ files: 12, matched: 9, unmatched: 2, conflict: 1 }) }))).toMatchObject({
      tag: '2 unmatched · 1 already has a file',
    });
    const loose = sky({ folder: '', files: [item({ path: '/data/library/movies/rip.mkv', relPath: 'rip.mkv' })] });
    expect(cardHeading(loose).path).toBe('/data/library/movies/');
  });

  test("the card lists the first files' names", () => {
    expect(filesPreview(sky())).toBe('Sky.Courier.13.1080p.mkv · Sky.Courier.14.1080p.mkv · Sky.Courier.15.1080p.mkv · … 9 more');
    expect(filesPreview(sky({ counts: groupCounts({ files: 3 }) }))).toBe('Sky.Courier.13.1080p.mkv · Sky.Courier.14.1080p.mkv · Sky.Courier.15.1080p.mkv');
  });

  test('the numbering select (replaces "Naming scheme")', () => {
    expect(NUMBERING_ITEMS).toEqual([
      { value: 'tmdb', label: 'TMDB' },
      { value: 'tvdb', label: 'TVDB (Sonarr)' },
      { value: 'absolute', label: 'Absolute' },
    ]);
    expect(numberingOf(sky())).toBeUndefined();
    expect(numberingOf(group())).toBe('tvdb');
    expect(numberingOf(group({ match: { ...group().match!, ordering: 'manual' } }))).toBeUndefined();
  });

  test('the preview: every file read, or only part of the folder', () => {
    const read = group({
      match: { workId: 'w3' as never, tmdbId: '3', kind: 'series', title: 'Sky Courier', year: 2021, ordering: 'absolute', readAs: 'unknown' },
      counts: groupCounts({ files: 12, matched: 9, unmatched: 3, notFit: 0 }),
    });
    expect(previewAlert(read)).toEqual({
      color: 'warning',
      title: '9 of 12 files read with absolute numbering',
      description: "3 files couldn't be read and stay unmatched. Import the 9, then match the rest by hand.",
    });
    expect(previewAlert(group({ counts: groupCounts({ files: 2, matched: 1, unmatched: 0, conflict: 1 }) }))).toEqual({
      color: 'info',
      title: 'Preview: 1 of 2 files read',
      description: 'Old Show (2015), TVDB numbering. 1 file is for an episode that already has one.',
    });
    expect(previewAlert(sky())).toBeUndefined();
  });

  test('a preview row says how the name was read', () => {
    const at = (read: Item['read'], units: Item['units']) => item({ read, units });
    expect(readAsLine(at({ episodes: [], absolute: [13] }, [{ season: 2, episode: 1 }]), 'absolute')).toBe('Absolute 13 → S02E01');
    expect(readAsLine(at({ season: 1, episodes: [13], absolute: [] }, [{ season: 2, episode: 1 }]), 'tvdb')).toBe('TVDB S01E13 → S02E01');
    expect(readAsLine(at({ season: 2, episodes: [1], absolute: [] }, [{ season: 2, episode: 1, title: 'Return' }]), 'tvdb')).toBe('S02E01 Return');
    expect(readAsLine(at(undefined, [{ season: 2, episode: 1 }]), 'manual')).toBe('S02E01');
  });

  test('the card imports into the title it matched', () => {
    expect(cardImportLine(group({ match: { ...group().match!, workId: 'w1' as never } }), '1080p WEB')).toBe('Into Old Show (already in library)');
    expect(cardImportLine(group(), '1080p WEB')).toBe('As a new series, tracked and not monitored, with the release profile 1080p WEB');
    expect(cardImportLine(group(), undefined)).toBe("As a new series, tracked and not monitored, with the library's default release profile");
    expect(cardImportButton(group())).toBe('Import 24 files');
  });

  test('the numbering needs a title first', () => {
    expect(numberingHint(group())).toBeUndefined();
    expect(numberingHint(sky())).toBe('Match a title first: the numbering reads the files against it.');
    expect(fileName('Sky Courier S2/Sky.Courier.13.1080p.mkv')).toBe('Sky.Courier.13.1080p.mkv');
  });

  test('conflict rows and ignoring', () => {
    expect(conflictLine({ units: [{ season: 1, episode: 1 }] })).toBe('S01E01 already has a file');
    expect(conflictLine({ units: [{}] })).toBe('Movie already has a file');
    expect(ignoreToast('/data/library/movies/new/')).toEqual({ title: 'Ignored /data/library/movies/new/', description: 'Later scans skip this folder.' });
    expect(ignoredLine(2)).toBe('2 folders are ignored. Scans skip them.');
    expect(ignoredLine(1)).toBe('1 folder is ignored. Scans skip it.');
    expect(unignoreToast('/data/library/movies/new/')).toEqual({ title: '/data/library/movies/new/ is read again', description: 'The next scan includes it.' });
  });

  test('after a numbering change', () => {
    expect(numberingToast('Sky Courier S2', 'absolute')).toEqual({
      title: 'Sky Courier S2 is read with absolute numbering',
      description: 'Matched files move to the Matched tab.',
    });
    expect(numberingToast('Old Show', 'tvdb').title).toBe('Old Show is read with TVDB numbering');
  });
});

describe('Match by hand', () => {
  const rips = [
    item({ scanItemId: 'd3' as Item['scanItemId'], relPath: 'rips/disc1_t03.mkv', sizeBytes: 28_400_000_000, status: 'unmatched', units: [], read: undefined }),
    item({ scanItemId: 'd4' as Item['scanItemId'], relPath: 'rips/disc1_t04.mkv', sizeBytes: 600_000_000, status: 'unmatched', units: [], read: undefined }),
  ];
  const episodes = [
    item({ scanItemId: 'e1' as Item['scanItemId'], status: 'unmatched', units: [], read: { season: 1, episodes: [1], absolute: [] } }),
    item({ scanItemId: 'e2' as Item['scanItemId'], status: 'unmatched', units: [], read: { episodes: [], absolute: [13] } }),
    item({ scanItemId: 'e3' as Item['scanItemId'], status: 'conflict', units: [{ season: 2, episode: 4 }], read: { season: 2, episodes: [4], absolute: [] } }),
  ];

  test('the heading and the step counter', () => {
    expect(matchHeading('/data/library/movies/rips/', 'title')).toEqual({ title: 'Match /data/library/movies/rips/', step: 'Step 1 of 2 · Title' });
    expect(matchHeading('/data/library/movies/rips/', 'files').step).toBe('Step 2 of 2 · Files');
  });

  test('a title result', () => {
    expect(suggestionLine({ tmdbId: '1', kind: 'movie', title: 'Northern Line', year: 2023 })).toEqual({ title: 'Northern Line (2023)', line: 'Movie · TMDB' });
    expect(suggestionLine({ tmdbId: '2', kind: 'series', title: 'Northern Lines', workId: 'w' as never })).toEqual({
      title: 'Northern Lines',
      line: 'Series · in the library',
    });
  });

  test('a movie folder starts with its largest file as the movie', () => {
    expect(defaultAssignments('movie', rips)).toEqual([
      { scanItemId: 'd3', choice: 'movie' },
      { scanItemId: 'd4', choice: 'none' },
    ]);
    expect(MOVIE_CHOICES).toEqual([
      { value: 'movie', label: 'The movie' },
      { value: 'none', label: 'Not this title' },
    ]);
  });

  test('a series folder starts with the numbers each name gives, or what the file matched', () => {
    expect(defaultAssignments('series', episodes)).toEqual([
      { scanItemId: 'e1', choice: 'episode', season: 1, episode: 1 },
      { scanItemId: 'e2', choice: 'none' },
      { scanItemId: 'e3', choice: 'episode', season: 2, episode: 4 },
    ]);
  });

  test('only assigned files go to matchFolder', () => {
    expect(
      assignedFiles([
        { scanItemId: 'd3' as Item['scanItemId'], choice: 'movie' },
        { scanItemId: 'd4' as Item['scanItemId'], choice: 'none' },
      ]),
    ).toEqual([{ scanItemId: 'd3', movie: true }]);
    expect(
      assignedFiles([
        { scanItemId: 'e1' as Item['scanItemId'], choice: 'episode', season: 1, episode: 1 },
        { scanItemId: 'e2' as Item['scanItemId'], choice: 'episode', season: 1 },
      ]),
    ).toEqual([{ scanItemId: 'e1', season: 1, episode: 1 }]);
    expect(matchButton(1)).toBe('Match 1 file');
    expect(matchButton(3)).toBe('Match 3 files');
    expect(matchButton(0)).toBe('Match');
  });

  test('two files for one movie or one episode are refused', () => {
    const a = 'a' as Item['scanItemId'];
    const b = 'b' as Item['scanItemId'];
    expect(
      assignmentProblem([
        { scanItemId: a, choice: 'movie' },
        { scanItemId: b, choice: 'movie' },
      ]),
    ).toBe('Only one file can be the movie.');
    expect(
      assignmentProblem([
        { scanItemId: a, choice: 'episode', season: 1, episode: 2 },
        { scanItemId: b, choice: 'episode', season: 1, episode: 2 },
      ]),
    ).toBe('S01E02 is chosen for 2 files.');
    expect(assignmentProblem([{ scanItemId: a, choice: 'episode', season: 1, episode: 2 }])).toBeUndefined();
  });

  test('the season and episode pickers come from TMDB', () => {
    const seasons = [
      { season: 0, episodes: 2, aired: 2 },
      { season: 1, episodes: 3, aired: 3 },
    ];
    expect(seasonItems(seasons)).toEqual([
      { value: 'none', label: 'Not this title' },
      { value: 0, label: 'Specials' },
      { value: 1, label: 'Season 1' },
    ]);
    expect(episodeItems(seasons, 1)).toEqual([
      { value: 1, label: 'E01' },
      { value: 2, label: 'E02' },
      { value: 3, label: 'E03' },
    ]);
    expect(episodeItems(seasons, 5)).toEqual([]);
  });

  test('after the match', () => {
    expect(matchedToast('Northern Line (2023)', 1)).toEqual({
      title: 'Matched 1 file to Northern Line (2023)',
      description: 'Import it from the Matched tab.',
    });
    expect(matchedToast('Old Show (2015)', 3).description).toBe('Import them from the Matched tab.');
    expect(matchedToast('Old Show (2015)', undefined)).toEqual({
      title: 'The folder is read as Old Show (2015)',
      description: 'Files whose names give an episode move to the Matched tab.',
    });
  });
});

describe('the header, the Repeat select and the Already tracked tab', () => {
  test("the header's count shows only when something is untracked", () => {
    expect(untrackedBadge(0)).toBeUndefined();
    expect(untrackedBadge(1204)).toBe('1,204');
  });

  test('Repeat: off, daily or weekly', () => {
    expect(SCHEDULE_ITEMS).toEqual([
      { value: 'off', label: 'Off' },
      { value: 'daily', label: 'Daily' },
      { value: 'weekly', label: 'Weekly' },
    ]);
    expect(scheduleHelp('off')).toBe('Scans run only when you start them.');
    expect(scheduleHelp('daily')).toBe('A scan runs every day. It never imports, and waits while a review has your decisions.');
  });

  test('Already tracked only counts', () => {
    expect(trackedLine(counts())).toEqual({
      title: '1,135 files are already in the library',
      description: 'They were read and found tracked, by path or as a hard link. Find them on the library pages.',
    });
    expect(trackedLine(counts({ tracked: 1 })).title).toBe('1 file is already in the library');
  });
});

describe('the last-scan line', () => {
  const now = new Date(2026, 10, 18, 18, 0).getTime();
  const run = (finishedAt: number, overrides: Partial<ScanCounts> = {}) => ({ startedAt: finishedAt - 60_000, finishedAt, counts: counts(overrides) });

  test('when, how many files were read, how many were tracked', () => {
    expect(lastScanLine(run(new Date(2026, 10, 18, 15, 10).getTime()), now)).toBe('Last scan today 15:10 · read 1,204 files · 1,135 already tracked');
    expect(lastScanLine(run(new Date(2026, 10, 17, 9, 5).getTime()), now)).toBe('Last scan yesterday 09:05 · read 1,204 files · 1,135 already tracked');
    expect(lastScanLine(run(new Date(2026, 10, 2, 21, 30).getTime()), now)).toBe('Last scan 2 Nov 21:30 · read 1,204 files · 1,135 already tracked');
    expect(lastScanLine(run(new Date(2025, 11, 30, 8, 0).getTime()), now)).toBe('Last scan 30 Dec 2025 08:00 · read 1,204 files · 1,135 already tracked');
  });

  test('ignored files are counted when there are some', () => {
    expect(lastScanLine(run(new Date(2026, 10, 18, 15, 10).getTime(), { read: 1, tracked: 0, ignored: 1 }), now)).toBe(
      'Last scan today 15:10 · read 1 file · 0 already tracked · 1 in ignored folders',
    );
  });
});
