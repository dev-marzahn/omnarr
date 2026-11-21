// Groups a Work's Units by TMDB season for the Work page, with
// the season's monitoring and its states rolled up.
import type { UnitRow, UnitState } from '@omnarr/contracts';

export type SeasonGroup = {
  /** TMDB season; 0 is specials. Undefined for a movie. */
  season: number | undefined;
  label: string;
  units: UnitRow[];
  /** Drives the season switch: on when all are monitored, mixed when some are. */
  monitoring: 'all' | 'some' | 'none';
  states: { state: UnitState; count: number }[];
};

export function groupBySeason(units: UnitRow[]): SeasonGroup[] {
  const groups = new Map<number | undefined, UnitRow[]>();
  for (const unit of units) groups.set(unit.tmdbSeason, [...(groups.get(unit.tmdbSeason) ?? []), unit]);

  return [...groups.entries()]
    .sort(([a], [b]) => seasonOrder(a) - seasonOrder(b))
    .map(([season, rows]) => {
      const monitored = rows.filter((unit) => unit.monitored).length;
      const counts = new Map<UnitState, number>();
      for (const unit of rows) counts.set(unit.state, (counts.get(unit.state) ?? 0) + 1);
      return {
        season,
        label: season === undefined ? 'Movie' : seasonLabel(season),
        units: rows,
        monitoring: monitored === rows.length ? 'all' : monitored === 0 ? 'none' : 'some',
        states: [...counts.entries()].map(([state, count]) => ({ state, count })),
      };
    });
}

/** TMDB season 0 is specials. */
export const seasonLabel = (season: number): string => (season === 0 ? 'Specials' : `Season ${season}`);

/** Specials go last, as in TMDB's apps. */
const seasonOrder = (season: number | undefined) => (season === undefined ? -1 : season === 0 ? Number.MAX_SAFE_INTEGER : season);
