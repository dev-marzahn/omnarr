// How each derived Unit state shows: label, badge colour,
// variant and icon. Kept in .ts so the type checker sees it (no vue-tsc).
import { type StateCount, type UnitRow, UnitState, type WorkSummary } from '@omnarr/contracts';

export type BadgeColor = 'primary' | 'secondary' | 'success' | 'info' | 'warning' | 'error' | 'neutral';
export type BadgeVariant = 'solid' | 'outline' | 'soft' | 'subtle';

export type StateLook = { label: string; color: BadgeColor; variant: BadgeVariant; icon: string; spin?: boolean };

export const STATE_LOOK: Record<UnitState, StateLook> = {
  notMonitored: { label: 'Not monitored', color: 'neutral', variant: 'soft', icon: 'i-lucide-eye-off' },
  failed: { label: 'Failed', color: 'error', variant: 'subtle', icon: 'i-lucide-circle-x' },
  downloading: { label: 'Downloading', color: 'info', variant: 'subtle', icon: 'i-lucide-download' },
  repairUnpack: { label: 'Repair / unpack', color: 'info', variant: 'subtle', icon: 'i-lucide-wrench' },
  importing: { label: 'Importing', color: 'info', variant: 'subtle', icon: 'i-lucide-import' },
  grabbed: { label: 'Grabbed', color: 'info', variant: 'subtle', icon: 'i-lucide-arrow-down-to-line' },
  preparing: { label: 'Preparing', color: 'secondary', variant: 'subtle', icon: 'i-lucide-wand-sparkles' },
  ready: { label: 'Ready', color: 'success', variant: 'subtle', icon: 'i-lucide-check' },
  notInTargetFormat: { label: 'Not yet in target format', color: 'warning', variant: 'subtle', icon: 'i-lucide-triangle-alert' },
  searching: { label: 'Searching', color: 'info', variant: 'outline', icon: 'i-lucide-loader-circle', spin: true },
  notAired: { label: 'Not aired', color: 'neutral', variant: 'outline', icon: 'i-lucide-clock' },
  wanted: { label: 'Wanted', color: 'neutral', variant: 'subtle', icon: 'i-lucide-circle' },
};

/** The short label used in a count chip ("9 ready"). */
export const countLabel = (state: UnitState, count: number): string => `${count} ${STATE_LOOK[state].label.toLowerCase()}`;

const dateFormat = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' });
const timeFormat = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

/** TMDB air dates are days, stored as midnight UTC. */
export const formatAirDate = (airDateUtc: number): string => dateFormat.format(airDateUtc);

/** The second line under a Unit's state. */
export function unitDetail(unit: UnitRow, now = Date.now()): string | undefined {
  if (unit.cancelRequested) return 'Cancelling…';
  if (unit.state === 'notAired') return unit.airDateUtc === undefined || unit.airDateUtc <= now ? 'Air date unknown' : `Airs ${formatAirDate(unit.airDateUtc)}`;
  if (unit.state === 'wanted' && unit.lastSearch) {
    const at = timeFormat.format(unit.lastSearch.at);
    // Releases whose numbers couldn't be settled, which "Search and pick" can grab.
    const unclear = unit.lastSearch.unclearCount > 0 ? ` · ${unit.lastSearch.unclearCount} with unclear numbering` : '';
    if (unit.lastSearch.outcome === 'noAcceptable') return `Last search ${at}: no acceptable release${unclear}`;
    if (unit.lastSearch.outcome === 'failed') return `Last search ${at} failed: no indexer answered`;
    if (unit.lastSearch.outcome === 'offered') return `Search and pick ${at}: results to pick from${unclear}`;
  }
  if (unit.state === 'wanted') return 'Not searched yet';
  return undefined;
}

/** The tag beside a Unit's state while an upgrade Grab runs: the Unit keeps its state. */
export function upgradingTag(unit: Pick<UnitRow, 'upgrading'>): string | undefined {
  if (!unit.upgrading) return undefined;
  return `Upgrading · ${STATE_LOOK[unit.upgrading.stage].label.toLowerCase()}`;
}

export type StateBarSegment = { state: UnitState; count: number; color: BadgeColor; label: string };

/**
 * The state bar: the Work's Units by derived state, in the derivation rules'
 * order (UnitState's order), each segment as wide as its count.
 * Not aired and Not monitored are left out, so a Work with none monitored has
 * no segment and the bar shows empty.
 */
export function stateBarSegments(states: readonly StateCount[]): StateBarSegment[] {
  const order = UnitState.options;
  return states
    .filter((s) => s.count > 0 && s.state !== 'notAired' && s.state !== 'notMonitored')
    .sort((a, b) => order.indexOf(a.state) - order.indexOf(b.state))
    .map((s) => ({ state: s.state, count: s.count, color: STATE_LOOK[s.state].color, label: countLabel(s.state, s.count) }));
}

export type RowActionKind =
  | 'searchNow'
  | 'searchAndPick'
  | 'cancelGrab'
  | 'cancelPreparation'
  | 'fix'
  | 'openIssue'
  | 'jellyfin'
  | 'prepareNow'
  | 'openItem'
  | 'monitor'
  | 'stopMonitoring';
export type RowAction = { kind: RowActionKind; label: string; icon: string };

const ACTION: Record<RowActionKind, RowAction> = {
  searchNow: { kind: 'searchNow', label: 'Search now', icon: 'i-lucide-search' },
  searchAndPick: { kind: 'searchAndPick', label: 'Search and pick', icon: 'i-lucide-list-checks' },
  cancelGrab: { kind: 'cancelGrab', label: 'Cancel', icon: 'i-lucide-x' },
  cancelPreparation: { kind: 'cancelPreparation', label: 'Cancel', icon: 'i-lucide-x' },
  fix: { kind: 'fix', label: 'Fix…', icon: 'i-lucide-wrench' },
  openIssue: { kind: 'openIssue', label: 'Open issue', icon: 'i-lucide-triangle-alert' },
  jellyfin: { kind: 'jellyfin', label: 'Open in Jellyfin', icon: 'i-lucide-external-link' },
  prepareNow: { kind: 'prepareNow', label: 'Prepare now', icon: 'i-lucide-wand-sparkles' },
  openItem: { kind: 'openItem', label: 'Open', icon: 'i-lucide-arrow-right' },
  monitor: { kind: 'monitor', label: 'Monitor', icon: 'i-lucide-eye' },
  stopMonitoring: { kind: 'stopMonitoring', label: 'Stop monitoring', icon: 'i-lucide-eye-off' },
};

/** A grab state whose run the row can cancel, once it knows the Grab. */
const GRAB_STATES: readonly UnitState[] = ['grabbed', 'downloading', 'repairUnpack'];

/**
 * A Work page row's one visible action and its "…" menu: Search now, Search
 * and pick (when the last search left releases of unclear numbering),
 * Cancel, Fix…, Open issue, Open in Jellyfin, or none. Everything else the
 * row can do is in "…". Fix… and Open issue open the item, whose Timeline
 * tab holds the Issue with its fixes.
 */
export function unitRowAction(unit: UnitRow): { primary?: RowAction; menu: RowAction[] } {
  const menu: RowActionKind[] = [];
  let primary: RowActionKind | undefined;
  const inJellyfin = unit.jellyfinItemPath !== undefined;

  if (unit.state === 'failed') {
    primary = 'fix';
    menu.push('searchNow', 'searchAndPick');
  } else if (unit.openIssue) {
    primary = 'openIssue';
    if (unit.state === 'notInTargetFormat') menu.push('prepareNow');
    if (inJellyfin) menu.push('jellyfin');
  } else if (unit.state === 'wanted') {
    const unclear = (unit.lastSearch?.unclearCount ?? 0) > 0;
    primary = unclear ? 'searchAndPick' : 'searchNow';
    menu.push(unclear ? 'searchNow' : 'searchAndPick');
  } else if (unit.state === 'preparing') primary = 'cancelPreparation';
  else if (GRAB_STATES.includes(unit.state)) primary = !unit.cancelRequested && unit.download?.grabId ? 'cancelGrab' : undefined;
  else if (unit.state === 'ready' || unit.state === 'notInTargetFormat') {
    if (unit.state === 'notInTargetFormat') menu.push('prepareNow');
    primary = inJellyfin ? 'jellyfin' : undefined;
  }
  menu.push('openItem', unit.monitored ? 'stopMonitoring' : 'monitor');
  return { primary: primary ? ACTION[primary] : undefined, menu: menu.map((kind) => ACTION[kind]) };
}

/** The library list's filters. */
export type WorkFilter = 'all' | 'missing' | 'notInTargetFormat' | 'issues';

export function matchesFilter(work: WorkSummary, filter: WorkFilter): boolean {
  if (filter === 'missing') return work.present < work.monitored;
  if (filter === 'notInTargetFormat') return work.states.some((s) => s.state === 'notInTargetFormat');
  if (filter === 'issues') return work.openIssues > 0;
  return true;
}
