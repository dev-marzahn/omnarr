// The library page: its view, filter and search in the URL, and a Work's
// status line under its poster, in its list row and in its hero. Kept in
// .ts so the type checker sees it.
import type { BlocklistEntry, FailureCode, WorkKind, WorkSummary } from '@omnarr/contracts';

import { episodeLabel, issueTitle } from './issues';
import { formatBytes } from './system';
import { shortRunId } from './timeline';
import { STATE_LOOK, type WorkFilter } from './unitStates';

export type LibraryView = 'grid' | 'list';
export type LibraryState = { view?: LibraryView; filter: WorkFilter; q: string };

const FILTERS: readonly WorkFilter[] = ['all', 'missing', 'notInTargetFormat', 'issues'];
const one = (value: unknown): string | undefined => (typeof value === 'string' ? value : undefined);

/** The page's state from `?view=`, `?filter=` and `?q=`. No view means the remembered one, or the grid. */
export function libraryState(query: Record<string, unknown>): LibraryState {
  const view = one(query.view);
  const filter = one(query.filter);
  return {
    view: view === 'grid' || view === 'list' ? view : undefined,
    filter: FILTERS.includes(filter as WorkFilter) ? (filter as WorkFilter) : 'all',
    q: one(query.q) ?? '',
  };
}

/** The query for a state: the defaults are left out, other parameters (`kind`) kept. */
export function libraryQuery(query: Record<string, unknown>, state: { view: LibraryView; filter: WorkFilter; q: string }): Record<string, unknown> {
  const { view: _view, filter: _filter, q: _q, ...rest } = query;
  const q = state.q.trim();
  return { ...rest, ...(state.view === 'list' ? { view: 'list' } : {}), ...(state.filter !== 'all' ? { filter: state.filter } : {}), ...(q ? { q } : {}) };
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

/**
 * A Work's status line: "22 of 30 ready", "22 of 22 · 2 not in
 * target format", "Searching for 6 episodes", "24 episodes · not monitored",
 * or a movie's state; open Issues are counted beside it.
 */
export function workLine(work: WorkSummary): { issues?: string; line: string } {
  const count = (state: string) => work.states.find((s) => s.state === state)?.count ?? 0;
  const issues = work.openIssues > 0 ? { issues: plural(work.openIssues, 'issue') } : {};
  if (work.kind === 'movie') {
    const state = work.states[0]?.state ?? 'notMonitored';
    return { ...issues, line: STATE_LOOK[state].label };
  }
  if (work.monitored === 0) return { ...issues, line: `${plural(work.units, 'episode')} · not monitored` };
  if (work.present === 0) {
    const wanted = count('wanted') + count('searching');
    if (wanted > 0) return { ...issues, line: `Searching for ${plural(wanted, 'episode')}` };
  }
  const notInTarget = count('notInTargetFormat');
  return {
    ...issues,
    line: notInTarget > 0 ? `${work.present} of ${work.monitored} · ${notInTarget} not in target format` : `${work.present} of ${work.monitored} ready`,
  };
}

// ---- The Work page's Blocklist tab ----

export type BlocklistTabRow = { entryId: BlocklistEntry['entryId']; title: string; episode: string; reason: string; source: string; added: string };

const episodesOf = (entry: BlocklistEntry): string => entry.units.map(episodeLabel).join(' · ');

/** Each entry with its episode, the reason in the Issue titles' words, and the run that added it. */
export function blocklistRows(entries: readonly BlocklistEntry[], formatDate: (at: number) => string): BlocklistTabRow[] {
  return entries.map((entry) => {
    const manual = entry.reason === 'manual';
    const run = entry.grabId ? shortRunId(entry.grabId) : undefined;
    const source = manual ? (run ? `Manual · cancelled by you · ${run}` : 'Manual') : run ? `Automatic · ${run}` : 'Automatic';
    return {
      entryId: entry.entryId,
      title: entry.title,
      episode: episodesOf(entry),
      reason: manual ? 'Manual' : issueTitle(entry.reason as FailureCode),
      source,
      added: formatDate(entry.addedAt),
    };
  });
}

/** "Unblock this release?": it grabs nothing. */
export function unblockConfirm(entry: BlocklistEntry): { title: string; description: string } {
  const episodes = episodesOf(entry);
  return {
    title: 'Unblock this release?',
    description: `It can be picked again by the next search${episodes ? ` for ${episodes}` : ''}. Nothing is grabbed now.`,
  };
}

// ---- The Work page's "…" (a movie's too) ----

type MenuItem = { label: string; icon: string; to?: string; target?: string; color?: 'error'; onSelect?: () => void } | { type: 'separator' };

/**
 * A Work's "…": Open in Jellyfin (once known), then a movie's own item
 * actions (Prepare now, Search and pick: its Work page is its item page),
 * Edit monitoring, a separator and "Delete series…" or "Delete movie…".
 */
export function workMenu(
  kind: WorkKind,
  jellyfin: MenuItem[],
  on: { editMonitoring: () => void; delete: () => void; prepareNow?: () => void; searchAndPick?: () => void },
): MenuItem[] {
  return [
    ...jellyfin,
    ...(on.prepareNow ? [{ label: 'Prepare now', icon: 'i-lucide-wand-sparkles', onSelect: on.prepareNow }] : []),
    ...(on.searchAndPick ? [{ label: 'Search and pick', icon: 'i-lucide-list-checks', onSelect: on.searchAndPick }] : []),
    { label: 'Edit monitoring', icon: 'i-lucide-rss', onSelect: on.editMonitoring },
    { type: 'separator' },
    { label: kind === 'movie' ? 'Delete movie…' : 'Delete series…', icon: 'i-lucide-trash', color: 'error', onSelect: on.delete },
  ];
}

// ---- "Edit monitoring" (a movie's too) ----

/** The dialog's subtitle: a series' seasons, or a movie's one switch. */
export const monitoringDescription = (kind: WorkKind): string =>
  kind === 'movie' ? 'A monitored movie is searched and kept in the target format.' : 'Monitored episodes are searched and kept in the target format.';

/** The pending key of a season's switch, shared by the Episodes tab and Edit monitoring; a movie's one group is `movie`. */
export const seasonKey = (season: number | undefined): string => (season === undefined ? 'movie' : `season:${season}`);

// ---- "Delete series…" and "Delete movie…" ----

export type DeleteWorkFacts = {
  kind: WorkKind;
  title: string;
  units: number;
  files: number;
  sizeBytes: number;
  blocklist: number;
  activeDownloads: number;
  deleteFiles: boolean;
};

/** The confirm's text: what leaves omnarr, what is cancelled, and what happens to the files. */
export function deleteWorkDialog(facts: DeleteWorkFacts) {
  const files = plural(facts.files, 'file', 'files');
  const movie = facts.kind === 'movie';
  const noun = movie ? 'movie' : 'series';
  return {
    title: `Delete ${facts.title}?`,
    subtitle: movie
      ? 'The movie and its history leave omnarr.'
      : `The series, its ${plural(facts.units, 'episode', 'episodes')} and their history leave omnarr.`,
    ...(facts.activeDownloads > 0
      ? {
          downloads: {
            title: `${plural(facts.activeDownloads, 'active download is', 'active downloads are')} cancelled`,
            description: 'Their partial downloads and staging folders are removed.',
          },
        }
      : {}),
    ...(facts.files > 0
      ? {
          files: {
            title: `${files} in the library`,
            description: 'They stay on disk and in Jellyfin unless you tick the box below. A later scan of untracked media can find them again.',
          },
          deleteFilesHelp: `Deletes the ${files} (${formatBytes(facts.sizeBytes)}) and refreshes Jellyfin, so ${movie ? 'the movie leaves' : 'the episodes leave'} Jellyfin too. Can't be undone.`,
        }
      : {}),
    ...(facts.blocklist > 0
      ? { blocklist: `The ${movie ? "movie's" : "series'"} ${plural(facts.blocklist, 'blocklist entry is', 'blocklist entries are')} deleted with it.` }
      : {}),
    confirm: facts.deleteFiles ? `Delete ${noun} and files` : `Delete ${noun}`,
    failure: `The ${noun} couldn't be deleted`,
  };
}

/** "Type the title to confirm". */
export const deleteConfirmed = (typed: string, title: string): boolean => typed.trim() === title;
