// Search groups: the Units one SearchAttempt searches for.
// Pure.
import type { NumberingScheme, SearchGroupKind } from '@omnarr/contracts';

import type { Id } from '../_generated/dataModel';

/** A Unit as grouping sees it; `wanted` is decided by the caller (monitored, aired, nothing playable, no active Grab). */
export type GroupUnit = { _id: Id<'units'>; tmdbSeason?: number; tmdbEpisode?: number; wanted: boolean };

export type SearchGroup = { kind: SearchGroupKind; unitIds: Id<'units'>[] };

/**
 * A movie is one group. A season is one group when every Unit of it is in
 * the input and wanted; otherwise each wanted Unit is its own group. Specials
 * (season 0) are always searched one by one. Unwanted Units aren't searched.
 */
export function groupUnits(units: GroupUnit[], work: { kind: 'series' | 'movie'; numberingScheme: NumberingScheme; units: GroupUnit[] }): SearchGroup[] {
  const wanted = units.filter((unit) => unit.wanted);
  if (work.kind === 'movie') return wanted.length > 0 ? [{ kind: 'movie', unitIds: wanted.map((unit) => unit._id) }] : [];
  const anime = work.numberingScheme === 'anime';
  const input = new Set(wanted.map((unit) => unit._id));
  const groups: SearchGroup[] = [];
  const seasons = [...new Set(wanted.map((unit) => unit.tmdbSeason ?? 0))].sort((a, b) => a - b);
  for (const season of seasons) {
    const inSeason = work.units.filter((unit) => (unit.tmdbSeason ?? 0) === season).sort((a, b) => (a.tmdbEpisode ?? 0) - (b.tmdbEpisode ?? 0));
    const whole = season > 0 && inSeason.length > 0 && inSeason.every((unit) => input.has(unit._id) && unit.wanted);
    if (whole) groups.push({ kind: anime ? 'animeSeason' : 'season', unitIds: inSeason.map((unit) => unit._id) });
    else for (const unit of inSeason) if (input.has(unit._id)) groups.push({ kind: anime ? 'animeEpisode' : 'episode', unitIds: [unit._id] });
  }
  return groups;
}
