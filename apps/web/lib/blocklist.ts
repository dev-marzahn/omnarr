// Settings › Blocklist: every Work's blocked releases,
// their rows, the kind filter and the unblock confirm. Kept in .ts so the
// type checker sees it.
import { type FailureCode, SETTINGS_BLOCKLIST_CAP, type SettingsBlocklistEntry } from '@omnarr/contracts';

import { issueTitle } from './issues';

export type BlocklistKindFilter = 'all' | 'series' | 'movies';

export type BlocklistRow = {
  entryId: SettingsBlocklistEntry['entryId'];
  title: string;
  workId: SettingsBlocklistEntry['workId'];
  workTitle: string;
  /** "Usenet" or "Torrent"; absent for an entry from before the protocol was stored, never guessed. */
  protocol?: string;
  reason: string;
  added: string;
};

const PROTOCOL = { usenet: 'Usenet', torrent: 'Torrent' } as const;

export function blocklistRows(entries: readonly SettingsBlocklistEntry[], formatDate: (at: number) => string): BlocklistRow[] {
  return entries.map((entry) => ({
    entryId: entry.entryId,
    title: entry.title,
    workId: entry.workId,
    workTitle: entry.workTitle,
    ...(entry.protocol ? { protocol: PROTOCOL[entry.protocol] } : {}),
    reason: entry.reason === 'manual' ? 'Manual' : issueTitle(entry.reason as FailureCode),
    added: formatDate(entry.addedAt),
  }));
}

/** All, Series and Movies, each with its count. */
export function blocklistFilters(entries: readonly SettingsBlocklistEntry[]): { value: BlocklistKindFilter; label: string; count: number }[] {
  const series = entries.filter((entry) => entry.workKind === 'series').length;
  return [
    { value: 'all', label: 'All', count: entries.length },
    { value: 'series', label: 'Series', count: series },
    { value: 'movies', label: 'Movies', count: entries.length - series },
  ];
}

/** The kind filter, and the text box over the release and the Work's title. */
export function matchesBlocklistFilter(entry: SettingsBlocklistEntry, kind: BlocklistKindFilter, text: string): boolean {
  if (kind === 'series' && entry.workKind !== 'series') return false;
  if (kind === 'movies' && entry.workKind !== 'movie') return false;
  const q = text.trim().toLowerCase();
  return q === '' || entry.title.toLowerCase().includes(q) || entry.workTitle.toLowerCase().includes(q);
}

/** "Unblock this release?": it grabs nothing. */
export function unblockConfirm(entry: SettingsBlocklistEntry): { title: string; description: string } {
  return {
    title: 'Unblock this release?',
    description: `It can be picked again by the next search for ${entry.workTitle}. Nothing is grabbed now.`,
  };
}

/** Under the list when the query hit its cap: only the newest entries are shown. Filters apply to those only. */
export function blocklistCapNote(count: number): string | undefined {
  return count >= SETTINGS_BLOCKLIST_CAP
    ? `Showing the newest ${SETTINGS_BLOCKLIST_CAP.toLocaleString('en-US')} entries. Older ones still apply; remove them from each series or movie's Blocklist tab.`
    : undefined;
}

export const BLOCKLIST_EMPTY = {
  title: 'No blocked releases',
  description: 'Releases that fail to download or import are blocked here automatically, per series or movie.',
};
