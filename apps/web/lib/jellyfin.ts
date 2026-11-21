// "Open in Jellyfin": the backend gives the item's path;
// the web app puts the origin the user's device reaches in front of it. And
// the choice of Jellyfin fixes, which first run's finish step, System and the
// Issues page share.
import type { FailureCode, IssueList } from '@omnarr/contracts';

export type JellyfinAction = { action: 'rerunJellyfinSetup' | 'retryNow'; label: string };

/**
 * "Set up Jellyfin again" for a setup or password Issue, which opens the
 * password dialog; only "Retry now" for Jellyfin not answering. First run
 * imports it from here.
 */
export function jellyfinActions(code: FailureCode): JellyfinAction[] {
  if (code === 'jellyfinSetupNeeded' || code === 'jellyfinPasswordNotPushed') return [{ action: 'rerunJellyfinSetup', label: 'Set up Jellyfin again' }];
  if (code === 'jellyfinUnavailable') return [{ action: 'retryNow', label: 'Retry now' }];
  return [];
}

/** System's Jellyfin card: one button per fix the open Jellyfin Issues need, with the Issues it acts on. */
export function jellyfinCardActions(list: IssueList): (JellyfinAction & { issueIds: string[] })[] {
  const found = new Map<JellyfinAction['action'], JellyfinAction & { issueIds: string[] }>();
  for (const row of [...list.system, ...list.needsAction, ...list.inProgress])
    for (const action of jellyfinActions(row.failureCode)) {
      const entry = found.get(action.action) ?? { ...action, issueIds: [] };
      entry.issueIds.push(row.issueId);
      found.set(action.action, entry);
    }
  return [...found.values()];
}

export const jellyfinItemUrl = (origin: string, itemPath: string): string => `${origin}${itemPath}`;

/** A "…" menu's "Open in Jellyfin": none until the backend knows the item's path. */
export const openInJellyfinItems = (origin: string, itemPath: string | undefined) =>
  itemPath ? [{ label: 'Open in Jellyfin', icon: 'i-lucide-external-link', to: jellyfinItemUrl(origin, itemPath), target: '_blank' }] : [];
