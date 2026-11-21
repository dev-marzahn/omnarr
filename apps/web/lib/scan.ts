// The untracked-media scan's wording: the tabs, the last-scan line, the
// run's states, the grouped rows, the selection and the import, the
// unmatched cards and "Match by hand". Kept in .ts so the type checker sees
// it.
import type {
  LibraryKind,
  ReadAs,
  ScanCounts,
  ScanFolderRef,
  ScanGroup,
  ScanImportResponse,
  ScanItemRow,
  ScanMatchFolderRequest,
  ScanNumbering,
  ScanOrdering,
  ScanSchedule,
  ScanStatus,
  ScanSuggestion,
  ScanUnitLabel,
  SeasonPreview,
  UnmatchedReason,
  WorkKind,
} from '@omnarr/contracts';
import { movesToLibraryNaming } from '@omnarr/contracts';

import { codecLabel } from './playback';
import { seasonLabel } from './seasons';

const grouped = (n: number): string => n.toLocaleString('en-US');
/** "1 file", "1,204 files". */
const plural = (n: number, one: string, many = `${one}s`): string => `${grouped(n)} ${n === 1 ? one : many}`;

export type ScanTabValue = 'matched' | 'unmatched' | 'tracked';
export type ScanTabItem = { value: ScanTabValue; label: string; count: string; to: string };

/** The three tabs; Unmatched counts folders once its groups are loaded. Already tracked only counts: the platform keeps no list of them. */
export function scanTabs(counts: ScanCounts, unmatchedFolders: number | undefined): ScanTabItem[] {
  const files = plural(counts.unmatched, 'file');
  return [
    { value: 'matched', label: 'Matched', count: grouped(counts.matched), to: '/scan' },
    {
      value: 'unmatched',
      label: 'Unmatched',
      count: unmatchedFolders === undefined ? files : `${plural(unmatchedFolders, 'folder')} · ${files}`,
      to: '/scan/unmatched',
    },
    { value: 'tracked', label: 'Already tracked', count: grouped(counts.tracked), to: '/scan?tab=tracked' },
  ];
}

// ---- The run's states ----

export type ScanView =
  | { kind: 'review' }
  | { kind: 'reading'; title: string; progress: { text: string; percent?: number }; description: string }
  | { kind: 'never' | 'matching' | 'nothing' | 'failed' | 'cancelled'; title: string; description: string };

const LEAVE = 'You can leave this page. Results appear here when the scan ends.';

/** What the scan page shows for the latest run: its progress, the review, or why there is nothing to review. */
export function scanView(status: ScanStatus): ScanView {
  const { run } = status;
  if (!run) return { kind: 'never', title: 'No scan yet', description: "Scan now reads the library folders for videos the platform didn't import." };
  switch (run.state) {
    case 'reading': {
      const progress = run.progress;
      const percent = progress ? { percent: Math.floor(progress.fraction * 100) } : {};
      const text = progress?.detail ? `${progress.detail} files` : progress ? `${percent.percent} %` : 'Waiting for the worker';
      return { kind: 'reading', title: 'Reading the library folders…', progress: { text, ...percent }, description: LEAVE };
    }
    case 'matching':
      return {
        kind: 'matching',
        title: 'Matching the files to titles…',
        description: 'Each folder is looked up in the library, then on TMDB. You can leave this page.',
      };
    case 'failed':
      return {
        kind: 'failed',
        title: 'The scan failed',
        description: "The worker couldn't finish reading the library folders. The System page lists its failed jobs. Scan again once it is fixed.",
      };
    case 'cancelled':
      return { kind: 'cancelled', title: 'The scan was cancelled', description: 'Nothing was imported. Scan again to read the library folders.' };
    case 'ready': {
      if (status.untracked > 0) return { kind: 'review' };
      const { counts } = run;
      const description =
        counts.imported > 0
          ? `${plural(counts.imported, 'file was', 'files were')} imported from this scan. Nothing is left to review.`
          : counts.ignored > 0
            ? `${plural(counts.read, 'file')} read: ${grouped(counts.tracked)} already tracked, ${grouped(counts.ignored)} in ignored folders.`
            : `${plural(counts.read, 'file')} read, all already tracked.`;
      return { kind: 'nothing', title: 'Everything in the library folders is in the library', description };
    }
  }
}

/** A run that reads or matches; Scan now waits for it. */
export const scanBusy = (status: ScanStatus): boolean => status.run?.state === 'reading' || status.run?.state === 'matching';

/** Scan now replaces the latest run's items, so it asks first when the user has made decisions in the review. */
export function rescanConfirm(status: ScanStatus): { title: string; description: string; confirm: string } | undefined {
  if (status.run?.state !== 'ready' || !status.run.hasDecisions || status.untracked === 0) return undefined;
  return {
    title: 'Scan again?',
    description: 'A new scan replaces this review. The numberings you chose and the folders you matched by hand are lost.',
    confirm: 'Scan again',
  };
}

// ---- The Matched tab's rows ----

export type Tag = { label: string; color: 'warning' | 'success' | 'neutral' | 'error'; icon?: string };

const KIND_LABEL: Record<WorkKind, string> = { series: 'Series', movie: 'Movie' };
const LIBRARY_LABEL: Record<LibraryKind, string> = { series: 'Series library', movies: 'Movies library' };
/** The numbering a group was read in; TMDB's needs no word. */
const ORDERING_NOTE: Partial<Record<ScanOrdering, string>> = { tvdb: 'TVDB numbering', absolute: 'absolute numbering', manual: 'matched by hand' };
const READ_AS_LABEL: Record<ReadAs, string> = {
  sonarr: 'Sonarr naming',
  radarr: 'Radarr naming',
  jellyfin: 'Jellyfin naming',
  unknown: 'Unrecognised naming',
};

/** The file's reason as a row says it after "Not matched: ". */
const ITEM_REASON: Record<UnmatchedReason, string> = {
  unreadable: "ffprobe couldn't read it",
  noWork: 'no title for its folder',
  noNumbers: 'no episode number in its name',
  unitNotFound: 'no episode has these numbers',
  ambiguous: 'the numberings disagree',
};

const pad = (n: number): string => String(n).padStart(2, '0');

/** "S01E01 Pilot", "S01E01 · S01E02" for a double episode, "Movie" for the film. */
export function unitsLabel(units: readonly ScanUnitLabel[]): string {
  if (units.length === 0) return '';
  if (units.every((unit) => unit.episode === undefined)) return 'Movie';
  if (units.length === 1) {
    const [unit] = units as [ScanUnitLabel];
    return `S${pad(unit.season ?? 0)}E${pad(unit.episode ?? 0)}${unit.title ? ` ${unit.title}` : ''}`;
  }
  return units.map((unit) => `S${pad(unit.season ?? 0)}E${pad(unit.episode ?? 0)}`).join(' · ');
}

/** "Old Show (2015)"; a folder without a match shows its name, and loose files say so. */
export const groupTitle = (group: { match?: { title: string; year?: number }; folder: string }): string =>
  group.match ? `${group.match.title}${group.match.year === undefined ? '' : ` (${group.match.year})`}` : group.folder || 'Loose files';

export function groupHeading(group: ScanGroup): { title: string; line: string; tags: Tag[] } {
  const kind = group.match?.kind ?? (group.libraryKind === 'movies' ? 'movie' : 'series');
  const ordering = group.match ? ORDERING_NOTE[group.match.ordering] : undefined;
  const { counts } = group;
  const tags: Tag[] = [
    counts.notFit > 0
      ? { label: `${grouped(counts.notFit)} not in target format`, color: 'warning', icon: 'i-lucide-triangle-alert' }
      : { label: 'Fits', color: 'success', icon: 'i-lucide-check' },
  ];
  if (group.match?.workId) tags.push({ label: 'Already in library', color: 'neutral' });
  if (counts.unmatched > 0) tags.push({ label: `${grouped(counts.unmatched)} unmatched`, color: 'neutral' });
  if (counts.conflict > 0) tags.push({ label: `${grouped(counts.conflict)} already ${counts.conflict === 1 ? 'has' : 'have'} a file`, color: 'neutral' });
  return {
    title: groupTitle(group),
    line: [KIND_LABEL[kind], ...(ordering ? [ordering] : []), `${plural(counts.matched, 'file')} → ${LIBRARY_LABEL[group.libraryKind]}`].join(' · '),
    tags,
  };
}

/** "HEVC · E-AC-3 · MKV". */
const formatLabel = (format: NonNullable<ScanItemRow['format']>): string =>
  [format.video, format.audio]
    .flatMap((codec) => (codec ? [codecLabel(codec)] : []))
    .concat(format.container === 'matroska' ? 'MKV' : codecLabel(format.container))
    .join(' · ');

export type FileRowText = {
  file: string;
  matchedTo: string;
  readAs: string;
  /** "renamed to library naming" for a matched file the import moves, so Jellyfin reads it right. */
  naming?: string;
  target: { text: string; fits?: boolean; format?: string };
};

const RENAMED = 'renamed to library naming';
/** Whether the import moves the group's matched files to library naming (`movesToLibraryNaming`). */
const renames = (group: Pick<ScanGroup, 'match' | 'folder'>): boolean =>
  group.match !== undefined && movesToLibraryNaming(group.match, group.folder, group.match.workFolder);

/** "S01E01 already has a file": a scan conflict. */
export const conflictLine = (item: Pick<ScanItemRow, 'units'>): string => `${unitsLabel(item.units) || 'Its episode'} already has a file`;

function matchedTo(item: ScanItemRow): string {
  switch (item.status) {
    case 'matched':
      return unitsLabel(item.units);
    case 'imported':
      return `${unitsLabel(item.units)} · imported`;
    case 'conflict':
      return conflictLine({ units: item.units.slice(0, 1).map(({ season, episode }) => ({ season, episode })) });
    case 'ignored':
      return 'Ignored';
    case 'unmatched':
      return item.unmatchedReason ? `Not matched: ${ITEM_REASON[item.unmatchedReason]}` : 'Not matched';
  }
}

/** One file of a group: its path under the root, the Unit it matched, the group's naming and its fit. */
export function fileRow(item: ScanItemRow, group: Pick<ScanGroup, 'match' | 'folder'>): FileRowText {
  const format = item.format ? { format: formatLabel(item.format) } : {};
  return {
    file: item.relPath,
    matchedTo: matchedTo(item),
    readAs: READ_AS_LABEL[group.match?.readAs ?? 'unknown'],
    ...(item.status === 'matched' && renames(group) ? { naming: RENAMED } : {}),
    target: item.fits === undefined ? { text: 'Unknown', ...format } : { text: item.fits ? 'Fits' : 'Not yet', fits: item.fits, ...format },
  };
}

/** "22 more files", for the group's "Show all". */
export function moreFiles(group: Pick<ScanGroup, 'counts' | 'files'>): string | undefined {
  const rest = group.counts.files - group.files.length;
  return rest > 0 ? `${plural(rest, 'more file', 'more files')}` : undefined;
}

// ---- The selection and the import ----

/** A folder's key in the selection: `scan.import` takes folders, not files. */
export const folderKey = (ref: Pick<ScanFolderRef, 'libraryId' | 'folder'>): string => JSON.stringify([ref.libraryId, ref.folder]);

/**
 * The scan page's footer: the selected folders' matched files (conflicts
 * and unmatched files stay behind), and how many keep their path and name
 * or are renamed to library naming.
 */
export function importFooter(groups: readonly ScanGroup[], selected: ReadonlySet<string>): { line: string; button: string; files: number } {
  const chosen = groups.filter((group) => selected.has(folderKey(group)));
  const files = chosen.reduce((sum, group) => sum + group.counts.matched, 0);
  if (files === 0) return { line: 'No folders selected', button: 'Import', files };
  const renamed = chosen.filter(renames).reduce((sum, group) => sum + group.counts.matched, 0);
  const kept = files - renamed;
  const parts = [
    ...(kept > 0 ? [`${grouped(kept)} ${kept === 1 ? 'keeps its' : 'keep their'} path and name`] : []),
    ...(renamed > 0 ? [`${grouped(renamed)} ${RENAMED}`] : []),
  ];
  return { line: [`${plural(files, 'file')} selected`, ...parts].join(' · '), button: `Import ${plural(files, 'file')}`, files };
}

/** The header checkbox over the loaded groups. */
export function allChecked(groups: readonly ScanGroup[], selected: ReadonlySet<string>): boolean | 'indeterminate' {
  const on = groups.filter((group) => selected.has(folderKey(group))).length;
  return on === 0 ? false : on === groups.length ? true : 'indeterminate';
}

export type MonitorChoice = 'tracked' | 'monitored';
/** "After import, series are": tracked is the default. */
export const MONITOR_ITEMS: { value: MonitorChoice; label: string }[] = [
  { value: 'tracked', label: 'Tracked, not monitored' },
  { value: 'monitored', label: 'Monitored' },
];
export const monitorHelp = (choice: MonitorChoice): string =>
  choice === 'monitored'
    ? 'Monitored series search for missing episodes right away.'
    : 'Their episodes are tracked, nothing is searched. Monitor them later on their pages.';

export type ImportPanelText = { profileLabel: string; profileHelp: string; monitorLabel: string; monitorHelp: string };

/**
 * The import panel's labels and help, from the kinds selected:
 * only series "series", only movies "the movie" or "movies", both (or none)
 * "titles".
 */
export function importPanelText(selected: { series: number; movies: number }, choice: MonitorChoice): ImportPanelText {
  const monitored = choice === 'monitored';
  if (selected.series > 0 && selected.movies === 0)
    return {
      profileLabel: 'Release profile for imported series',
      profileHelp: "Every series needs one. It's used for upgrades and missing episodes.",
      monitorLabel: 'After import, series are',
      monitorHelp: monitorHelp(choice),
    };
  if (selected.movies === 1 && selected.series === 0)
    return {
      profileLabel: 'Release profile for the imported movie',
      profileHelp: 'Used for upgrades.',
      monitorLabel: 'After import, the movie is',
      monitorHelp: monitored ? 'A monitored movie is searched for upgrades.' : 'Its file is tracked; nothing is searched. Monitor it later on its page.',
    };
  if (selected.movies > 1 && selected.series === 0)
    return {
      profileLabel: 'Release profile for imported movies',
      profileHelp: 'Used for upgrades.',
      monitorLabel: 'After import, movies are',
      monitorHelp: monitored
        ? 'Monitored movies are searched for upgrades.'
        : 'Their files are tracked; nothing is searched. Monitor them later on their pages.',
    };
  return {
    profileLabel: 'Release profile for imported titles',
    profileHelp: 'Used for upgrades and, for series, missing episodes.',
    monitorLabel: 'After import, titles are',
    monitorHelp: monitored
      ? 'Monitored series search for missing episodes right away; monitored movies are searched for upgrades.'
      : 'Files are tracked; nothing is searched. Monitor them later on their pages.',
  };
}

export type ImportToast = { color: 'success' | 'error' | 'neutral'; title: string; description: string };

/**
 * The scan page's "after import" state: a success toast with the new titles and
 * the files not in target format (counted from the selected groups before the
 * import), and one error toast per folder that failed.
 */
export function importToast(response: ScanImportResponse, notFit: number, titleOf: (ref: ScanFolderRef) => string): ImportToast[] {
  const toasts: ImportToast[] = [];
  if (response.imported > 0) {
    const works = response.works > 0 ? `${plural(response.works, 'new title')}. ` : '';
    const fit =
      notFit === 0
        ? 'All of them fit the target format.'
        : notFit === 1
          ? '1 is not in target format. It plays as it is and shows "Not yet in target format".'
          : `${grouped(notFit)} are not in target format. They play as they are and show "Not yet in target format".`;
    toasts.push({ color: 'success', title: `Imported ${plural(response.imported, 'file')}`, description: `${works}${fit}` });
  }
  for (const failed of response.failed) toasts.push({ color: 'error', title: `${titleOf(failed)} wasn't imported`, description: failed.message });
  if (toasts.length === 0)
    toasts.push({ color: 'neutral', title: 'Nothing was imported', description: 'The selected files were imported or tracked meanwhile.' });
  return toasts;
}

// ---- The Unmatched tab's cards ----

const FOLDER_REASON: Partial<Record<UnmatchedReason, { tag: string; help: string }>> = {
  noWork: { tag: 'No title matched', help: 'No title in the library or on TMDB matches the folder name. Match it by hand.' },
  ambiguous: {
    tag: 'The numberings disagree',
    help: 'More than one numbering reads every file, each to different episodes. Choose the numbering.',
  },
};

/** The folder's full path: its files carry the path and the path under the root. */
export function folderPath(group: Pick<ScanGroup, 'folder' | 'files'>): string {
  const file = group.files[0];
  const root = file ? file.path.slice(0, file.path.length - file.relPath.length - 1) : '';
  return group.folder ? `${root}/${group.folder}/` : `${root}/`;
}

export function cardHeading(group: ScanGroup): { path: string; files: string; tag: string; help?: string } {
  const reason = group.reason ? FOLDER_REASON[group.reason] : undefined;
  const { counts } = group;
  const tag =
    reason?.tag ??
    [
      ...(counts.unmatched > 0 ? [`${grouped(counts.unmatched)} unmatched`] : []),
      ...(counts.conflict > 0 ? [`${grouped(counts.conflict)} already ${counts.conflict === 1 ? 'has' : 'have'} a file`] : []),
    ].join(' · ');
  return { path: folderPath(group), files: plural(counts.files, 'file'), tag, ...(reason ? { help: reason.help } : {}) };
}

/** The last part of a path. */
export const fileName = (path: string): string => path.slice(path.lastIndexOf('/') + 1);

/** "a.mkv · b.mkv · … 10 more". */
export function filesPreview(group: Pick<ScanGroup, 'counts' | 'files'>): string {
  const rest = group.counts.files - group.files.length;
  return [...group.files.map((file) => fileName(file.relPath)), ...(rest > 0 ? [`… ${grouped(rest)} more`] : [])].join(' · ');
}

/** "Numbering: TMDB / TVDB (Sonarr) / Absolute". */
export const NUMBERING_ITEMS: { value: ScanNumbering; label: string }[] = [
  { value: 'tmdb', label: 'TMDB' },
  { value: 'tvdb', label: 'TVDB (Sonarr)' },
  { value: 'absolute', label: 'Absolute' },
];

/** The select's value: the folder's numbering, none before a match or after "Match by hand". */
export const numberingOf = (group: Pick<ScanGroup, 'match'>): ScanNumbering | undefined =>
  group.match && group.match.ordering !== 'manual' ? group.match.ordering : undefined;

const ORDERING_PHRASE: Record<ScanOrdering, string> = {
  tmdb: 'TMDB numbering',
  tvdb: 'TVDB numbering',
  absolute: 'absolute numbering',
  manual: 'matched by hand',
};

/** A folder's preview alert, for a folder of which some files are read: blue when only conflicts are left, amber when files stay unmatched. */
export function previewAlert(group: ScanGroup): { color: 'info' | 'warning'; title: string; description: string } | undefined {
  const { match, counts } = group;
  if (!match || counts.matched === 0) return undefined;
  const conflicts =
    counts.conflict > 0
      ? `${plural(counts.conflict, 'file is', 'files are')} for ${counts.conflict === 1 ? 'an episode that already has one' : 'episodes that already have one'}.`
      : '';
  const phrase = ORDERING_PHRASE[match.ordering];
  if (counts.unmatched > 0) {
    const how = match.ordering === 'manual' ? phrase : `read with ${phrase}`;
    return {
      color: 'warning',
      title: `${grouped(counts.matched)} of ${plural(counts.files, 'file')} ${how}`,
      description: [
        `${plural(counts.unmatched, "file couldn't", "files couldn't")} be read and stay unmatched. Import the ${grouped(counts.matched)}, then match the rest by hand.`,
        ...(conflicts ? [conflicts] : []),
      ].join(' '),
    };
  }
  return {
    color: 'info',
    title: `Preview: ${grouped(counts.matched)} of ${plural(counts.files, 'file')} read`,
    description: [`${groupTitle(group)}, ${phrase}.`, ...(conflicts ? [conflicts] : [])].join(' '),
  };
}

const numbersOnly = (units: readonly ScanUnitLabel[]): ScanUnitLabel[] => units.map(({ season, episode }) => ({ season, episode }));

/** A preview row's "Read as": "Absolute 13 → S02E01", "TVDB S01E13 → S02E01", or the episode when the name already says it. */
export function readAsLine(item: Pick<ScanItemRow, 'read' | 'units'>, ordering: ScanOrdering): string {
  const { read, units } = item;
  const target = unitsLabel(numbersOnly(units));
  if (read && ordering === 'absolute' && read.absolute.length > 0) return `Absolute ${read.absolute.join(', ')} → ${target}`;
  if (read && ordering === 'tvdb' && read.episodes.length > 0) {
    const named = unitsLabel(read.episodes.map((episode) => ({ season: read.season ?? 1, episode })));
    if (named !== target) return `TVDB ${named} → ${target}`;
  }
  return unitsLabel(units);
}

/** The card's footer, beside "Import N files": the title the files go into. New titles get the library's default profile and stay tracked. */
export function cardImportLine(group: Pick<ScanGroup, 'match' | 'libraryKind'>, profileName: string | undefined): string {
  const { match } = group;
  if (match?.workId) return `Into ${match.title} (already in library)`;
  const kind = match?.kind ?? (group.libraryKind === 'movies' ? 'movie' : 'series');
  const profile = profileName === undefined ? "the library's default release profile" : `the release profile ${profileName}`;
  return `As a new ${kind}, tracked and not monitored, with ${profile}`;
}

/** The card's "Import N files": its matched files. */
export const cardImportButton = (group: ScanGroup): string => importFooter([group], new Set([folderKey(group)])).button;

/** Why the numbering select waits: `scan.setNumbering` reads the files against the folder's title. */
export const numberingHint = (group: Pick<ScanGroup, 'match'>): string | undefined =>
  group.match ? undefined : 'Match a title first: the numbering reads the files against it.';

export const ignoreToast = (path: string): { title: string; description: string } => ({
  title: `Ignored ${path}`,
  description: 'Later scans skip this folder.',
});

export const unignoreToast = (path: string): { title: string; description: string } => ({
  title: `${path} is read again`,
  description: 'The next scan includes it.',
});

export const ignoredLine = (count: number): string =>
  count === 1 ? '1 folder is ignored. Scans skip it.' : `${grouped(count)} folders are ignored. Scans skip them.`;

export const numberingToast = (title: string, ordering: ScanNumbering): { title: string; description: string } => ({
  title: `${title} is read with ${ORDERING_PHRASE[ordering]}`,
  description: 'Matched files move to the Matched tab.',
});

// ---- Match by hand ----

export type MatchStep = 'title' | 'files';

export const matchHeading = (path: string, step: MatchStep): { title: string; step: string } => ({
  title: `Match ${path}`,
  step: step === 'title' ? 'Step 1 of 2 · Title' : 'Step 2 of 2 · Files',
});

/** A TMDB result in the title step. */
export const suggestionLine = (suggestion: ScanSuggestion): { title: string; line: string } => ({
  title: groupTitle({ match: suggestion, folder: '' }),
  line: `${KIND_LABEL[suggestion.kind]} · ${suggestion.workId ? 'in the library' : 'TMDB'}`,
});

/** What the user says a file is: the movie, an episode, or not part of the title. */
export type Assignment = { scanItemId: ScanItemRow['scanItemId']; choice: 'movie' | 'episode' | 'none'; season?: number; episode?: number };

export const MOVIE_CHOICES: { value: 'movie' | 'none'; label: string }[] = [
  { value: 'movie', label: 'The movie' },
  { value: 'none', label: 'Not this title' },
];

/** The pickers' first values: a movie folder's largest file is the film (as the scan matches it); an episode takes the numbers its name gives, else what it matched. */
export function defaultAssignments(kind: WorkKind, files: readonly ScanItemRow[]): Assignment[] {
  if (kind === 'movie') {
    const largest = files.reduce<ScanItemRow | undefined>((max, file) => (max && max.sizeBytes >= file.sizeBytes ? max : file), undefined);
    return files.map((file) => ({ scanItemId: file.scanItemId, choice: file === largest ? 'movie' : 'none' }));
  }
  return files.map((file) => {
    const named = file.read?.episodes[0] === undefined ? undefined : { season: file.read.season ?? 1, episode: file.read.episodes[0] };
    const matched = file.units[0];
    const numbers =
      named ?? (matched?.season !== undefined && matched.episode !== undefined ? { season: matched.season, episode: matched.episode } : undefined);
    return numbers ? { scanItemId: file.scanItemId, choice: 'episode', ...numbers } : { scanItemId: file.scanItemId, choice: 'none' };
  });
}

/** `scan.matchFolder`'s `files`: the assigned ones only; the rest stay unmatched. */
export function assignedFiles(assignments: readonly Assignment[]): NonNullable<ScanMatchFolderRequest['files']> {
  return assignments.flatMap((row): NonNullable<ScanMatchFolderRequest['files']> => {
    if (row.choice === 'movie') return [{ scanItemId: row.scanItemId, movie: true }];
    if (row.choice === 'episode' && row.season !== undefined && row.episode !== undefined)
      return [{ scanItemId: row.scanItemId, season: row.season, episode: row.episode }];
    return [];
  });
}

/** Two files for one movie or one episode. */
export function assignmentProblem(assignments: readonly Assignment[]): string | undefined {
  const files = assignedFiles(assignments);
  if (files.filter((file) => file.movie).length > 1) return 'Only one file can be the movie.';
  const seen = new Map<string, number>();
  for (const file of files) {
    if (file.movie) continue;
    const label = unitsLabel([{ season: file.season, episode: file.episode }]);
    seen.set(label, (seen.get(label) ?? 0) + 1);
  }
  for (const [label, count] of seen) if (count > 1) return `${label} is chosen for ${count} files.`;
  return undefined;
}

export const matchButton = (count: number): string => (count === 0 ? 'Match' : `Match ${plural(count, 'file')}`);

export const MATCH_HELP = 'Only assigned files are matched. The others stay listed as unmatched.';

/** The season picker: TMDB's seasons, and "Not this title". */
export const seasonItems = (seasons: readonly SeasonPreview[]): { value: number | 'none'; label: string }[] => [
  { value: 'none', label: 'Not this title' },
  ...seasons.map((season) => ({ value: season.season, label: seasonLabel(season.season) })),
];

/** The episode picker of a season: "E01" to its last episode. */
export function episodeItems(seasons: readonly SeasonPreview[], season: number): { value: number; label: string }[] {
  const count = seasons.find((entry) => entry.season === season)?.episodes ?? 0;
  return Array.from({ length: count }, (_, i) => ({ value: i + 1, label: `E${pad(i + 1)}` }));
}

/** After `scan.matchFolder`: with files assigned, or with the folder read against the title (`count` undefined). */
export function matchedToast(title: string, count: number | undefined): { title: string; description: string } {
  if (count === undefined) return { title: `The folder is read as ${title}`, description: 'Files whose names give an episode move to the Matched tab.' };
  return { title: `Matched ${plural(count, 'file')} to ${title}`, description: `Import ${count === 1 ? 'it' : 'them'} from the Matched tab.` };
}

// ---- The header, the Repeat select and the Already tracked tab ----

/** The header's "Scan untracked" count (`scan.status.untracked`), shown when above 0. */
export const untrackedBadge = (untracked: number): string | undefined => (untracked > 0 ? grouped(untracked) : undefined);

/** "Repeat": off by default. */
export const SCHEDULE_ITEMS: { value: ScanSchedule; label: string }[] = [
  { value: 'off', label: 'Off' },
  { value: 'daily', label: 'Daily' },
  { value: 'weekly', label: 'Weekly' },
];

export const scheduleHelp = (schedule: ScanSchedule): string =>
  schedule === 'off'
    ? 'Scans run only when you start them.'
    : `A scan runs every ${schedule === 'daily' ? 'day' : 'week'}. It never imports, and waits while a review has your decisions.`;

/** The Already tracked tab: a count, since the platform keeps no list of them. */
export const trackedLine = (counts: ScanCounts): { title: string; description: string } => ({
  title: `${plural(counts.tracked, 'file is', 'files are')} already in the library`,
  description: 'They were read and found tracked, by path or as a hard link. Find them on the library pages.',
});

// ---- The last-scan line ----

const clock = new Intl.DateTimeFormat('en-GB', { hour: '2-digit', minute: '2-digit', hourCycle: 'h23' });
const dayMonth = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });
const dayMonthYear = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });

const sameDay = (a: Date, b: Date): boolean => a.getFullYear() === b.getFullYear() && a.getMonth() === b.getMonth() && a.getDate() === b.getDate();

/** "today 15:10", "yesterday 09:05", "2 Nov 21:30", "30 Dec 2025 08:00", in local time. */
export function whenLabel(at: number, now: number): string {
  const date = new Date(at);
  const today = new Date(now);
  const yesterday = new Date(today.getFullYear(), today.getMonth(), today.getDate() - 1);
  const day = sameDay(date, today)
    ? 'today'
    : sameDay(date, yesterday)
      ? 'yesterday'
      : (date.getFullYear() === today.getFullYear() ? dayMonth : dayMonthYear).format(date);
  return `${day} ${clock.format(date)}`;
}

/** The scan page's line under the top bar, for a run that has ended. */
export function lastScanLine(run: { startedAt: number; finishedAt?: number; counts: ScanCounts }, now: number): string {
  const { counts } = run;
  return [
    `Last scan ${whenLabel(run.finishedAt ?? run.startedAt, now)}`,
    `read ${plural(counts.read, 'file')}`,
    `${grouped(counts.tracked)} already tracked`,
    ...(counts.ignored > 0 ? [`${grouped(counts.ignored)} in ignored folders`] : []),
  ].join(' · ');
}
