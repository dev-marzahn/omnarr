// Matching a TMDB snapshot's episodes to a Work's existing Units, so
// a Unit keeps its ID however TMDB renumbers it. Pure; no Convex imports.
import type { UnitKind } from '@omnarr/contracts';

/** A Unit as the snapshot gives it. `tmdbId` is the TMDB episode ID; a movie's Unit has none. */
export type SnapshotUnit = {
  kind: UnitKind;
  tmdbId?: string;
  tmdbSeason?: number;
  tmdbEpisode?: number;
  title?: string;
  airDateUtc?: number;
  overview?: string;
  stillPath?: string;
  runtimeMin?: number;
};

/** A Unit as the Work has it now, with its stored TMDB episode ID. */
export type ExistingUnit<Id> = {
  unitId: Id;
  tmdbId?: string;
  kind: UnitKind;
  tmdbSeason?: number;
  tmdbEpisode?: number;
  airDateUtc?: number;
  monitored: boolean;
  retired: boolean;
};

/** A `metadataChanged` event's `from` and `to`: `S01E10`-style numbers, or `retired`. */
export type UnitChange = { from: string; to: string };

export type UnitPlan<Id> = {
  /** Matched Units, with their new data; `change` when the numbers moved. */
  updates: { unitId: Id; unit: SnapshotUnit; change?: UnitChange }[];
  /** Retired Units TMDB lists again: `retiredAt` is cleared and they stay unmonitored. */
  unretires: { unitId: Id; unit: SnapshotUnit; change: UnitChange }[];
  creates: { unit: SnapshotUnit; monitored: boolean }[];
  /** Units TMDB no longer lists. */
  retires: { unitId: Id; change: UnitChange }[];
};

export type ReconcileOptions = {
  monitorNewUnits: boolean;
  /** Only on the first write: the seasons the user ticked at subscribe. */
  seasons?: number[];
  /** Only on the first write of a Work the scan created from a folder: a movie starts unmonitored too. */
  fromFolder?: boolean;
};

const pad = (n: number) => String(n).padStart(2, '0');
/** `S01E10`, as `metadataChanged` events show a Unit's numbers. */
export const numberLabel = (unit: { tmdbSeason?: number; tmdbEpisode?: number }) =>
  unit.tmdbSeason === undefined || unit.tmdbEpisode === undefined ? 'movie' : `S${pad(unit.tmdbSeason)}E${pad(unit.tmdbEpisode)}`;

/**
 * The reconcile rules: match each snapshot Unit by TMDB episode ID, else by
 * number and air date where the old ID is missing or no longer listed, else
 * create it; retire every unmatched Unit.
 */
export function reconcileUnits<Id>(existing: ExistingUnit<Id>[], snapshot: SnapshotUnit[], options: ReconcileOptions): UnitPlan<Id> {
  const listed = new Set(snapshot.flatMap((unit) => (unit.tmdbId ? [unit.tmdbId] : [])));
  const matched = new Map<SnapshotUnit, ExistingUnit<Id>>();
  const taken = new Set<ExistingUnit<Id>>();
  const take = (unit: SnapshotUnit, match: ExistingUnit<Id> | undefined) => {
    if (!match) return;
    matched.set(unit, match);
    taken.add(match);
  };

  // A movie Work has exactly one Unit, which carries no episode ID.
  for (const unit of snapshot.filter((u) => u.kind === 'movie'))
    take(
      unit,
      existing.find((e) => e.kind === 'movie' && !taken.has(e)),
    );
  for (const unit of snapshot)
    if (unit.tmdbId && !matched.has(unit))
      take(
        unit,
        existing.find((e) => e.tmdbId === unit.tmdbId && !taken.has(e)),
      );
  for (const unit of snapshot) {
    if (matched.has(unit) || unit.kind === 'movie') continue;
    take(
      unit,
      existing.find(
        (e) =>
          !taken.has(e) &&
          (e.tmdbId === undefined || !listed.has(e.tmdbId)) &&
          e.tmdbSeason === unit.tmdbSeason &&
          e.tmdbEpisode === unit.tmdbEpisode &&
          e.airDateUtc === unit.airDateUtc,
      ),
    );
  }

  // For the monitoring rule of later Units: each season's matched Units, by their new numbers.
  const seasons = new Map<number, boolean[]>();
  for (const [unit, match] of matched) {
    if (match.retired || unit.tmdbSeason === undefined) continue;
    seasons.set(unit.tmdbSeason, [...(seasons.get(unit.tmdbSeason) ?? []), match.monitored]);
  }
  const monitorNew = (unit: SnapshotUnit) => {
    if (unit.kind === 'special') return false;
    if (options.seasons) return unit.kind === 'movie' ? !options.fromFolder : options.seasons.includes(unit.tmdbSeason!);
    if (!options.monitorNewUnits) return false;
    const season = unit.tmdbSeason === undefined ? undefined : seasons.get(unit.tmdbSeason);
    return !season || season.some(Boolean);
  };

  const plan: UnitPlan<Id> = { updates: [], unretires: [], creates: [], retires: [] };
  for (const unit of snapshot) {
    const match = matched.get(unit);
    if (!match) {
      plan.creates.push({ unit, monitored: monitorNew(unit) });
    } else if (match.retired) {
      plan.unretires.push({ unitId: match.unitId, unit, change: { from: 'retired', to: numberLabel(unit) } });
    } else {
      const from = numberLabel(match);
      const to = numberLabel(unit);
      plan.updates.push(from === to ? { unitId: match.unitId, unit } : { unitId: match.unitId, unit, change: { from, to } });
    }
  }
  for (const unit of existing)
    if (!taken.has(unit) && !unit.retired) plan.retires.push({ unitId: unit.unitId, change: { from: numberLabel(unit), to: 'retired' } });
  return plan;
}
