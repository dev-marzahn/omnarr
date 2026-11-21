// The Issues page's wording and structure: each Issue's title, context and
// explanation, its fix buttons and their confirms, the tabs and the class
// filter. Kept in .ts so the type checker sees it.
import type { FailureClass, FailureCode, FixAction, IssueList, IssueRow } from '@omnarr/contracts';

import type { BadgeColor } from './unitStates';

const TITLES: Record<FailureCode, string> = {
  clientUnreachable: "Couldn't reach the download client",
  leaseExpired: 'The worker stopped responding during this step',
  jellyfinUnavailable: "Jellyfin didn't respond",
  releaseFetchFailed: "Couldn't fetch the release file",
  missingArticles: 'Missing articles',
  parFailed: 'Repair failed',
  unpackFailed: 'Unpack failed',
  passwordProtected: 'Archive is password-protected',
  noMediaFile: 'No video file in the download',
  fakeOrWrongContent: 'Fake or wrong content',
  torrentStalled: 'Torrent stalled (no progress for 6 h)',
  importMismatch: 'Wrong episode in the download',
  releaseFileInvalid: 'The release file is missing or invalid',
  transcodeFailed: 'Preparation failed',
  diskFull: 'Not enough free space',
  workerOffline: 'Worker offline',
  protocolMismatch: "Worker version doesn't match",
  orphanClientItem: 'Unknown item in the download client',
  orphanAfterDelete: 'A deleted series or movie left records behind',
  pipelineError: 'The run stopped with an internal error',
  workflowPaused: 'Run paused after an upgrade',
  jellyfinSetupNeeded: 'Jellyfin needs to be set up again',
  jellyfinPasswordNotPushed: "Your new password didn't reach Jellyfin",
  jellyfinMisread: 'Jellyfin reads the file as something else',
  unknownClientFailure: "The download client answered in a way omnarr doesn't know",
  storageUnavailable: "A storage folder can't be used",
  vpnDown: 'The VPN is down',
  metadataKeyRejected: 'TMDB rejected the metadata key',
  metadataSourceUnavailable: 'A metadata source is unreachable',
  indexerTimeout: 'Indexer timed out',
  indexerError: 'Indexer error',
  indexerRateLimited: 'Indexer rate-limited',
};
export const issueTitle = (code: FailureCode): string => TITLES[code];

/** What to do, for the Issues that come with no detail. */
const HELP: Partial<Record<FailureCode, string>> = {
  workerOffline: 'Restart the worker container: docker compose up -d worker.',
  protocolMismatch: 'Run the worker of the same omnarr release as the backend, then restart it.',
  storageUnavailable: 'Put staging, originals and the libraries on the /data volume, and check their owner.',
  vpnDown: 'Check the VPN settings under Settings › Downloads, then run docker compose up -d.',
};
export const issueExplanation = (row: IssueRow): string | undefined => row.detail ?? HELP[row.failureCode];

/** The class badge. */
export const CLASS_LOOK: Record<FailureClass, { label: string; color: BadgeColor }> = {
  badRelease: { label: 'bad release', color: 'error' },
  preparation: { label: 'preparation', color: 'warning' },
  transient: { label: 'transient', color: 'info' },
  system: { label: 'system', color: 'neutral' },
};

const pad = (n: number | undefined) => String(n ?? 0).padStart(2, '0');

/** "S02E09", as rows and confirms name an episode. */
export const episodeLabel = (unit: { tmdbSeason?: number; tmdbEpisode?: number }): string => `S${pad(unit.tmdbSeason)}E${pad(unit.tmdbEpisode)}`;

/** The line above the title: "The Long Harbor · S02E09 Breakwater · since 14:21", a movie "Northern Line (2023) · Movie · since 13:55". */
export function issueContext(row: IssueRow, formatTime: (ms: number) => string): string {
  const since = `since ${formatTime(row.raisedAt)}`;
  const unit = row.unit;
  if (!unit) return since;
  if (unit.workKind === 'movie') return `${unit.workTitle}${unit.year !== undefined ? ` (${unit.year})` : ''} · Movie · ${since}`;
  return `${unit.workTitle} · ${episodeLabel(unit)}${unit.title ? ` ${unit.title}` : ''} · ${since}`;
}

/** Where a unit-scope Issue's item is: the episode page, or a movie's Work page. */
export function issueItemLink(row: IssueRow): string | undefined {
  if (!row.unit) return undefined;
  return row.unit.workKind === 'movie' ? `/library/${row.unit.workId}` : `/items/${row.unit.unitId}`;
}

export const FIX_LABELS: Record<FixAction, string> = {
  retryNow: 'Retry now',
  tryNextBest: 'Try next-best release',
  searchAndPick: 'Search and pick',
  retryRelease: 'Retry this release',
  blocklistRemove: 'Unblock release',
  retryPreparation: 'Retry preparation',
  downloadLog: 'Download ffmpeg log',
  rerunJellyfinSetup: 'Set up Jellyfin again',
  resumeRun: 'Resume run',
  cancelRun: 'Cancel run',
  removeClientItem: 'Remove from client',
  removeOrphans: 'Remove the records',
  enterMetadataKey: 'Enter a metadata key',
  moveToLibraryNaming: 'Move to library naming',
  dismiss: 'Dismiss',
};

export const FIX_ICONS: Record<FixAction | 'openTimeline', string> = {
  retryNow: 'i-lucide-rotate-cw',
  tryNextBest: 'i-lucide-skip-forward',
  searchAndPick: 'i-lucide-list-checks',
  retryRelease: 'i-lucide-repeat',
  blocklistRemove: 'i-lucide-circle-slash',
  retryPreparation: 'i-lucide-wand-sparkles',
  downloadLog: 'i-lucide-file-down',
  rerunJellyfinSetup: 'i-lucide-settings',
  resumeRun: 'i-lucide-play',
  cancelRun: 'i-lucide-x',
  removeClientItem: 'i-lucide-trash-2',
  removeOrphans: 'i-lucide-eraser',
  enterMetadataKey: 'i-lucide-key-round',
  moveToLibraryNaming: 'i-lucide-folder-input',
  dismiss: 'i-lucide-eye-off',
  openTimeline: 'i-lucide-history',
};

export type IssueButton = FixAction | 'openTimeline';

/**
 * The row's fixes: the first fix is its button; the others
 * go into "More fixes", with "Open timeline" before Dismiss on the Issues
 * page for an Issue about a Unit.
 */
export function issueActions(row: IssueRow, options: { onItem?: boolean } = {}): { primary?: FixAction; more: IssueButton[] } {
  const [primary, ...rest] = row.fixActions;
  const more: IssueButton[] = rest.filter((action) => action !== 'dismiss');
  if (row.unit && !options.onItem) more.push('openTimeline');
  if (rest.includes('dismiss')) more.push('dismiss');
  return { primary, more };
}

export type FixConfirm = { title: string; description: string; note?: string; confirm: string; destructive?: boolean };

/** The confirms before a fix. Try next-best names no release: its search picks one later. */
export function fixConfirm(action: FixAction, row: IssueRow): FixConfirm | undefined {
  const episode = row.unit ? (row.unit.workKind === 'movie' ? row.unit.workTitle : episodeLabel(row.unit)) : 'the episode';
  switch (action) {
    case 'tryNextBest':
      return {
        title: 'Try the next-best release?',
        description: `omnarr searches your indexers again and grabs the best release for ${episode} that isn't blocklisted. That starts a new run.`,
        note: 'The failed releases stay blocklisted. The Issue moves to In progress and closes when the new run succeeds.',
        confirm: 'Try next-best release',
      };
    case 'retryRelease':
      return {
        title: 'Retry this release?',
        description: `omnarr takes ${row.release ?? 'the release'} off the blocklist and grabs it again for ${episode}, in a new run.`,
        confirm: 'Retry this release',
      };
    case 'cancelRun':
      return {
        title: 'Cancel the paused run?',
        description: 'The run ends as cancelled, its download is removed, and its paused-run Issue closes. The release is not blocklisted.',
        confirm: 'Cancel run',
        destructive: true,
      };
    case 'removeClientItem':
      return {
        title: 'Remove from the download client?',
        description: `omnarr removes these items and their data from the download client:\n${row.detail ?? ''}`,
        confirm: 'Remove from client',
        destructive: true,
      };
    case 'removeOrphans':
      return {
        title: 'Remove the leftover records?',
        description: `${row.detail ?? 'A deleted series or movie left records behind.'} omnarr deletes them now, finished or not.`,
        note: 'Files on disk and items in the download client stay as they are.',
        confirm: 'Remove the records',
        destructive: true,
      };
    default:
      return undefined;
  }
}

const TOASTS: Partial<Record<FixAction, string>> = {
  retryNow: 'Retrying now',
  tryNextBest: 'Searching for the next-best release · a new run starts when one is found',
  retryRelease: 'Grabbing the release again',
  blocklistRemove: 'Removed from the blocklist',
  retryPreparation: 'Preparing the file again',
  resumeRun: 'Replaying the run',
  cancelRun: 'Cancelling the run',
  removeClientItem: 'Removing from the download client',
  removeOrphans: 'Leftover records removed',
  moveToLibraryNaming: 'Moving the file to library naming',
  dismiss: 'Issue dismissed',
};
export const fixToast = (action: FixAction): string => TOASTS[action] ?? FIX_LABELS[action];

/** A refused `issues.act` throws its reason as the ConvexError's data. */
export function actErrorMessage(error: unknown): string {
  const data = (error as { data?: unknown } | null)?.data;
  return typeof data === 'string' && data.length > 0 ? data : 'Try again.';
}

export type IssueTab = 'needsAction' | 'inProgress' | 'system' | 'resolved';

/** The page's tabs, with counts; Resolved & dismissed shows none. */
export function issueTabs(list: IssueList): { value: IssueTab; label: string; icon: string; count?: number; color: 'error' | 'neutral' }[] {
  return [
    { value: 'needsAction', label: 'Needs action', icon: 'i-lucide-triangle-alert', count: list.needsAction.length, color: 'error' },
    { value: 'inProgress', label: 'In progress', icon: 'i-lucide-loader-circle', count: list.inProgress.length, color: 'neutral' },
    { value: 'system', label: 'System', icon: 'i-lucide-server', count: list.system.length, color: 'error' },
    { value: 'resolved', label: 'Resolved & dismissed', icon: 'i-lucide-check', count: undefined, color: 'neutral' },
  ];
}

export type ClassFilter = 'all' | 'badRelease' | 'preparation' | 'transient' | 'run';

const FILTERS: { value: ClassFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'badRelease', label: 'Bad release' },
  { value: 'preparation', label: 'Preparation' },
  { value: 'transient', label: 'Transient' },
  { value: 'run', label: 'Run' },
];

const inClass = (row: IssueRow, filter: ClassFilter): boolean => {
  if (filter === 'all') return true;
  // "Run": a Unit's system errors, such as a paused run or a pipeline error.
  if (filter === 'run') return row.class === 'system' && row.scope === 'unit';
  return row.class === filter;
};

/** The class filter, with the tab's counts. */
export const classFilters = (rows: readonly IssueRow[]) => FILTERS.map((f) => ({ ...f, count: rows.filter((row) => inClass(row, f.value)).length }));

/** The class filter and the title filter: the Work, the episode number, the episode title, the Issue's title and the release. */
export function matchesIssueFilter(row: IssueRow, filter: ClassFilter, text: string): boolean {
  if (!inClass(row, filter)) return false;
  const query = text.trim().toLowerCase();
  if (!query) return true;
  const unit = row.unit;
  const haystack = [unit?.workTitle, unit && unit.workKind === 'series' ? episodeLabel(unit) : undefined, unit?.title, issueTitle(row.failureCode), row.release]
    .filter(Boolean)
    .join(' ')
    .toLowerCase();
  return haystack.includes(query);
}

export const ISSUES_EMPTY = { title: 'No issues', description: "Failures that fix themselves show only on the item's timeline." };
