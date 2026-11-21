// The sidebar: its items, the active one for a route, and the badges from
// scan.status, issues.counts and system.status. Kept in .ts so the type
// checker sees it.
import type { SystemStatus, WorkKind } from '@omnarr/contracts';

import { untrackedBadge } from './scan';

export type NavKey =
  | 'series'
  | 'movies'
  | 'scan'
  | 'issues'
  | 'indexers'
  | 'profiles'
  | 'blocklist'
  | 'metadata'
  | 'downloads'
  | 'playback'
  | 'system'
  | 'about';

export type NavRoute = { path: string; query: Record<string, unknown> };

const PREFIXES: [string, NavKey][] = [
  ['/scan', 'scan'],
  ['/issues', 'issues'],
  ['/settings/indexers', 'indexers'],
  ['/settings/profiles', 'profiles'],
  ['/settings/blocklist', 'blocklist'],
  ['/settings/metadata', 'metadata'],
  ['/settings/downloads', 'downloads'],
  ['/settings/playback', 'playback'],
  ['/system', 'system'],
  ['/about', 'about'],
];

const under = (path: string, prefix: string) => path === prefix || path.startsWith(`${prefix}/`);

/**
 * The sidebar item a route belongs to. Series and Movies share `/library`, so
 * the query picks one; a Work or item page follows its Work's kind, which the
 * page knows once it has loaded (a series until then).
 */
export function activeNav(route: NavRoute, workKind?: WorkKind): NavKey | undefined {
  if (route.path === '/library') return route.query.kind === 'movies' ? 'movies' : 'series';
  if (under(route.path, '/library') || under(route.path, '/items')) return workKind === 'movie' ? 'movies' : 'series';
  return PREFIXES.find(([prefix]) => under(route.path, prefix))?.[1];
}

export type NavBadge = { label: string; color: 'error' | 'warning' };
export type NavCounts = {
  /** `scan.status`'s untracked files. */
  untracked?: number;
  /** `issues.counts()`. */
  issues?: { needsAction: number; inProgress: number; system: number };
  system?: SystemStatus;
};
export type NavBadges = { scan?: NavBadge; issues?: NavBadge; systemDot?: 'success' | 'error' };

export function navBadges(counts: NavCounts): NavBadges {
  const untracked = counts.untracked === undefined ? undefined : untrackedBadge(counts.untracked);
  const open = counts.issues ? counts.issues.needsAction + counts.issues.system : 0;
  return {
    scan: untracked ? { label: untracked, color: 'warning' } : undefined,
    issues: open > 0 ? { label: open.toLocaleString('en-US'), color: 'error' } : undefined,
    // Red for a missing, offline or mismatched worker: whenever the banner shows.
    systemDot: counts.system ? (counts.system.banner || !counts.system.worker?.connected ? 'error' : 'success') : undefined,
  };
}

export type SidebarItem = {
  key: NavKey | 'library' | 'settings';
  label: string;
  icon?: string;
  to?: string;
  active?: boolean;
  defaultOpen?: boolean;
  badge?: NavBadge & { variant: 'subtle'; size: 'sm' };
  children?: SidebarItem[];
};

const badge = (b: NavBadge | undefined) => (b ? { ...b, variant: 'subtle' as const, size: 'sm' as const } : undefined);

/** UNavigationMenu's items, vertical; System's dot is drawn by the sidebar from `navBadges`. */
export function sidebarItems(active: NavKey | undefined, badges: NavBadges): SidebarItem[] {
  const leaf = (key: NavKey, label: string, to: string, icon?: string): SidebarItem => ({ key, label, to, icon, active: key === active });
  const group = (key: 'library' | 'settings', label: string, icon: string, children: SidebarItem[]): SidebarItem => ({
    key,
    label,
    icon,
    defaultOpen: true,
    active: children.some((child) => child.active),
    children,
  });
  return [
    group('library', 'Library', 'i-lucide-library', [leaf('series', 'Series', '/library'), leaf('movies', 'Movies', '/library?kind=movies')]),
    { ...leaf('scan', 'Scan', '/scan', 'i-lucide-scan-line'), badge: badge(badges.scan) },
    { ...leaf('issues', 'Issues', '/issues', 'i-lucide-triangle-alert'), badge: badge(badges.issues) },
    group('settings', 'Settings', 'i-lucide-settings', [
      leaf('indexers', 'Indexers', '/settings/indexers'),
      leaf('profiles', 'Release profiles', '/settings/profiles'),
      leaf('blocklist', 'Blocklist', '/settings/blocklist'),
      leaf('metadata', 'Metadata', '/settings/metadata'),
      leaf('downloads', 'Downloads', '/settings/downloads'),
      leaf('playback', 'Libraries & playback', '/settings/playback/series'),
    ]),
    leaf('system', 'System', '/system', 'i-lucide-server'),
    leaf('about', 'About', '/about', 'i-lucide-info'),
  ];
}
