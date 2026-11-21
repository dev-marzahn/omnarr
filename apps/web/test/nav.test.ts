// The sidebar: its items, the active one for a route, and the badges.
import type { JellyfinStatus, SystemStatus } from '@omnarr/contracts';
import { describe, expect, test } from 'vite-plus/test';

import { activeNav, navBadges, sidebarItems } from '../lib/nav';

const route = (path: string, query: Record<string, string> = {}) => ({ path, query });

describe('the active sidebar item for a route', () => {
  test('the library is Series, or Movies with ?kind=movies', () => {
    expect(activeNav(route('/library'))).toBe('series');
    expect(activeNav(route('/library', { kind: 'movies' }))).toBe('movies');
    expect(activeNav(route('/library', { kind: 'series', view: 'list' }))).toBe('series');
  });

  test("a Work page follows the Work's kind: a movie is under Movies", () => {
    expect(activeNav(route('/library/k123'), 'series')).toBe('series');
    expect(activeNav(route('/library/k123'), 'movie')).toBe('movies');
    expect(activeNav(route('/library/k123'))).toBe('series');
  });

  test("an item page is under its Work's library", () => {
    expect(activeNav(route('/items/u1'), 'series')).toBe('series');
    expect(activeNav(route('/items/u1'), 'movie')).toBe('movies');
  });

  test('Scan, Issues, the settings pages, System and About', () => {
    expect(activeNav(route('/scan'))).toBe('scan');
    expect(activeNav(route('/scan/unmatched'))).toBe('scan');
    expect(activeNav(route('/issues'))).toBe('issues');
    expect(activeNav(route('/settings/indexers'))).toBe('indexers');
    expect(activeNav(route('/settings/profiles'))).toBe('profiles');
    expect(activeNav(route('/settings/profiles/p1'))).toBe('profiles');
    expect(activeNav(route('/settings/blocklist'))).toBe('blocklist');
    expect(activeNav(route('/settings/metadata'))).toBe('metadata');
    expect(activeNav(route('/settings/downloads'))).toBe('downloads');
    expect(activeNav(route('/settings/playback/movies'))).toBe('playback');
    expect(activeNav(route('/system'))).toBe('system');
    expect(activeNav(route('/about'))).toBe('about');
  });

  test('the password page, opened from the user menu, has no sidebar item', () => {
    expect(activeNav(route('/account/password'))).toBeUndefined();
  });
});

const notSetUp: JellyfinStatus = { state: 'notSetUp', steps: [], pinned: false, libraries: [] };
const worker = (overrides: Partial<NonNullable<SystemStatus['worker']>> = {}): NonNullable<SystemStatus['worker']> => ({
  workerId: 'w1',
  connected: true,
  accepted: true,
  protocolVersion: 1,
  expectedVersion: 1,
  connectedAt: 0,
  lastSeenAt: 0,
  ffmpegVersion: '7.1',
  encoders: [],
  ...overrides,
});
const status = (overrides: Partial<SystemStatus>): SystemStatus => ({
  indexers: [],
  clients: [],
  jobCounts: [],
  jellyfin: notSetUp,
  release: { version: '0.1.0' },
  ...overrides,
});

describe('the sidebar badges', () => {
  test('Scan shows the untracked count in amber, grouped; none at zero', () => {
    expect(navBadges({ untracked: 1240 }).scan).toEqual({ label: '1,240', color: 'warning' });
    expect(navBadges({ untracked: 0 }).scan).toBeUndefined();
    expect(navBadges({}).scan).toBeUndefined();
  });

  test('Issues shows needs-action plus system Issues in red; none at zero or without counts', () => {
    expect(navBadges({ issues: { needsAction: 2, inProgress: 5, system: 1 } }).issues).toEqual({ label: '3', color: 'error' });
    expect(navBadges({ issues: { needsAction: 0, inProgress: 5, system: 0 } }).issues).toBeUndefined();
    expect(navBadges({}).issues).toBeUndefined();
  });

  test("System's dot: green with the worker online, red when it is offline, missing or a different version", () => {
    expect(navBadges({ system: status({ worker: worker() }) }).systemDot).toBe('success');
    expect(navBadges({ system: status({ worker: worker({ connected: false }), banner: 'workerOffline' }) }).systemDot).toBe('error');
    expect(navBadges({ system: status({ banner: 'workerOffline' }) }).systemDot).toBe('error');
    expect(navBadges({ system: status({ worker: worker({ accepted: false, protocolVersion: 2 }), banner: 'protocolMismatch' }) }).systemDot).toBe('error');
    expect(navBadges({}).systemDot).toBeUndefined();
  });
});

describe('the sidebar items', () => {
  const labels = (items: ReturnType<typeof sidebarItems>) => items.map((item) => [item.label, ...(item.children ?? []).map((c) => c.label)]);

  test('Library, Scan, Issues, Settings, System and About, with the groups open', () => {
    const items = sidebarItems('series', {});
    expect(labels(items)).toEqual([
      ['Library', 'Series', 'Movies'],
      ['Scan'],
      ['Issues'],
      ['Settings', 'Indexers', 'Release profiles', 'Blocklist', 'Metadata', 'Downloads', 'Libraries & playback'],
      ['System'],
      ['About'],
    ]);
    expect(items.filter((item) => item.children).every((item) => item.defaultOpen)).toBe(true);
  });

  test('the links: Movies is the library with ?kind=movies', () => {
    const items = sidebarItems(undefined, {});
    const library = items[0]!.children!;
    expect(library.map((c) => c.to)).toEqual(['/library', '/library?kind=movies']);
    expect(items.find((item) => item.label === 'Issues')!.to).toBe('/issues');
    expect(items.find((item) => item.label === 'Settings')!.children!.at(-1)!.to).toBe('/settings/playback/series');
  });

  test('only the active item is active, and its parent is marked too', () => {
    const items = sidebarItems('movies', {});
    const flat = items.flatMap((item) => [item, ...(item.children ?? [])]);
    expect(flat.filter((item) => item.active).map((item) => item.label)).toEqual(['Library', 'Movies']);
    expect(
      sidebarItems('playback', {})
        .flatMap((item) => [item, ...(item.children ?? [])])
        .filter((item) => item.active)
        .map((i) => i.label),
    ).toEqual(['Settings', 'Libraries & playback']);
  });

  test('the badges sit on Scan and Issues', () => {
    const items = sidebarItems('scan', { scan: { label: '8', color: 'warning' }, issues: { label: '3', color: 'error' } });
    expect(items.find((item) => item.label === 'Scan')!.badge).toEqual({ label: '8', color: 'warning', variant: 'subtle', size: 'sm' });
    expect(items.find((item) => item.label === 'Issues')!.badge).toEqual({ label: '3', color: 'error', variant: 'subtle', size: 'sm' });
    expect(sidebarItems('scan', {}).find((item) => item.label === 'Scan')!.badge).toBeUndefined();
  });
});
