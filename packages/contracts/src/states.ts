// The pipeline entities' states, the allowed transitions of every
// entity (`TRANSITIONS`) and the derived Unit state.
import { z } from 'zod';

import type { ClientStage } from './jobs.ts';

/** `offered`: an interactive attempt's results wait for the user's pick. */
export const SearchAttemptState = z.enum(['running', 'offered', 'picked', 'noAcceptable', 'failed']);
export type SearchAttemptState = z.infer<typeof SearchAttemptState>;

export const GrabState = z.enum(['submitting', 'downloading', 'importing', 'publishing', 'done', 'failed', 'cancelled']);
export type GrabState = z.infer<typeof GrabState>;

/** `upgrade`: a Grab for Units that already have a playable primary. */
export const GrabKind = z.enum(['initial', 'upgrade']);
export type GrabKind = z.infer<typeof GrabKind>;

export const DownloadState = z.enum(['active', 'completed', 'failed', 'stalled', 'removed']);
export type DownloadState = z.infer<typeof DownloadState>;

export const ImportJobState = z.enum(['pending', 'recorded', 'failed', 'cancelled']);
export type ImportJobState = z.infer<typeof ImportJobState>;

export const RenditionState = z.enum(['pending', 'done', 'failed', 'cancelled']);
export type RenditionState = z.infer<typeof RenditionState>;

export const PublicationState = z.enum(['pending', 'visible', 'failed']);
export type PublicationState = z.infer<typeof PublicationState>;

/**
 * A file version's role: `primary` is what Jellyfin plays; `staged`
 * waits for its publish or an upgrade decision; `original` is a source kept
 * under /data/originals; `alternate` is reserved for v2.
 */
export const FileVersionKind = z.enum(['primary', 'staged', 'original', 'alternate']);
export type FileVersionKind = z.infer<typeof FileVersionKind>;

/** The entities `transition()` moves. */
export type StateEntity = 'searchAttempt' | 'grab' | 'download' | 'importJob' | 'rendition' | 'publication';
export type StatesOf = {
  searchAttempt: SearchAttemptState;
  grab: GrabState;
  download: DownloadState;
  importJob: ImportJobState;
  rendition: RenditionState;
  publication: PublicationState;
};

/** The allowed moves, by entity and from-state. */
export const TRANSITIONS: { [E in StateEntity]: Partial<Record<StatesOf[E], readonly StatesOf[E][]>> } = {
  // `offered`: an interactive attempt isn't picked; the user's grab picks it.
  searchAttempt: { running: ['picked', 'offered', 'noAcceptable', 'failed'], offered: ['picked'] },
  grab: {
    submitting: ['downloading', 'failed', 'cancelled'],
    downloading: ['importing', 'failed', 'cancelled'],
    importing: ['publishing', 'failed', 'cancelled'],
    publishing: ['done', 'failed', 'cancelled'],
  },
  download: { active: ['completed', 'failed', 'stalled', 'removed'], completed: ['removed'], failed: ['removed'], stalled: ['removed'] },
  importJob: { pending: ['recorded', 'failed', 'cancelled'] },
  rendition: { pending: ['done', 'failed', 'cancelled'] },
  // `visible → pending`: a re-publish after a rename or replacement.
  // `failed → pending`: a re-publish after a file Jellyfin misread was moved to library naming.
  publication: { pending: ['visible', 'failed'], visible: ['pending'], failed: ['pending'] },
};

export function canTransition<E extends StateEntity>(entity: E, from: StatesOf[E], to: StatesOf[E]): boolean {
  const allowed = (TRANSITIONS[entity] as Partial<Record<string, readonly string[]>>)[from];
  return allowed?.includes(to) ?? false;
}

/** The Unit states `deriveUnitState` gives, in rule order. */
export const UnitState = z.enum([
  'notMonitored',
  'failed',
  'downloading',
  'repairUnpack',
  'importing',
  'grabbed',
  'preparing',
  'ready',
  'notInTargetFormat',
  'searching',
  'notAired',
  'wanted',
]);
export type UnitState = z.infer<typeof UnitState>;

/**
 * What `deriveUnitState` reads about one Unit. `recomputeUnits` builds it
 * from the Unit's rows.
 */
export type UnitSnapshot = {
  /** The time the air date is compared with. */
  now: number;
  monitored: boolean;
  /** Unknown when absent. */
  airDateUtc?: number;
  /** The Grab in `units.activeGrabId`, with its Download's `clientStage` while it downloads. */
  activeGrab?: { state: GrabState; paused: boolean; clientStage?: ClientStage; kind?: GrabKind };
  /** An open unit-scope Issue for the Unit. */
  hasOpenIssue: boolean;
  /** A Rendition of one of the Unit's files is `pending`. */
  hasPendingRendition: boolean;
  /**
   * The Unit's file versions; `visible` when one of its Publications is
   * `visible` (or a re-publish), `pendingPublication` when one is `pending`.
   */
  versions: { kind: FileVersionKind; fits: boolean; visible: boolean; pendingPublication?: boolean }[];
  /** The state of `units.lastSearchAttemptId`. */
  lastSearchState?: SearchAttemptState;
};

/** Rules 6–8: what the Unit's files say, if anything. */
function filedState(unit: UnitSnapshot): UnitState | undefined {
  // Rule 6 also covers a prepared file waiting for its publish.
  if (unit.hasPendingRendition || unit.versions.some((version) => version.kind === 'staged' && version.pendingPublication)) return 'preparing';
  if (unit.versions.some((version) => version.kind === 'primary' && version.fits && version.visible)) return 'ready';
  if (unit.versions.some((version) => version.visible && !version.fits)) return 'notInTargetFormat';
  return undefined;
}

/** The Unit's state from its rows: the first matching rule wins. */
export function deriveUnitState(unit: UnitSnapshot): UnitState {
  // "The running Grab" is the active Grab unless its run is paused or it is an upgrade.
  const running = unit.activeGrab && !unit.activeGrab.paused && unit.activeGrab.kind !== 'upgrade' ? unit.activeGrab : undefined;
  const playable = unit.versions.some((version) => version.visible);

  // An unmonitored Unit with a playable file (a scanned one, tracked and not monitored) shows rules 6–8.
  if (!unit.monitored) return (playable && filedState(unit)) || 'notMonitored';
  if (unit.hasOpenIssue && !playable && !running) return 'failed';
  if (running?.state === 'downloading') return running.clientStage === 'postProcessing' ? 'repairUnpack' : 'downloading';
  if (running?.state === 'importing' || running?.state === 'publishing') return 'importing';
  if (running?.state === 'submitting') return 'grabbed';
  const filed = filedState(unit);
  if (filed) return filed;
  if (unit.lastSearchState === 'running') return 'searching';
  if (unit.airDateUtc === undefined || unit.airDateUtc > unit.now) return 'notAired';
  return 'wanted';
}
