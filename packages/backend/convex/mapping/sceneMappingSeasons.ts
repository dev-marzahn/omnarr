import type { PartSeason, PartSeasonOrdering } from '@omnarr/contracts';

import type { NamedReading } from '../metadata/numbering';
import { type MappingRow, tmdbSeasonOf, type UnitSeason } from './project';
import type { SceneMappingName } from './sceneMappingsParse';

export type WorkSeasons = {
  ofTvdbSeason: (tvdbSeason: number) => PartSeason | undefined;
  ofSceneSeason: (sceneSeason: number) => PartSeason | undefined;
};

type SeasonRow = MappingRow & { season: number };

const hasSeason = (row: MappingRow): row is SeasonRow => row.season !== undefined;

export const NO_WORK_SEASONS: WorkSeasons = { ofTvdbSeason: () => undefined, ofSceneSeason: () => undefined };

export function workSeasons(units: UnitSeason[], rows: MappingRow[]): WorkSeasons {
  const tmdbSeasons = tmdbSeasonOf(units);
  const seasonRows = rows.filter(hasSeason);
  const tvdbRows = seasonRows.filter((row) => row.ordering === 'tvdb');
  const sceneSeasonOf = new Map(seasonRows.filter((row) => row.ordering === 'scene').map((row) => [row.key, row.season]));
  const ordering: PartSeasonOrdering = sceneSeasonOf.size > 0 ? 'scene' : 'tmdb';
  const workSeasonOf = ordering === 'scene' ? sceneSeasonOf : tmdbSeasons;
  const listed = new Set(workSeasonOf.values());
  const inWork = (season: number | undefined): PartSeason | undefined => (season !== undefined && listed.has(season) ? { season, ordering } : undefined);
  return {
    ofTvdbSeason: (tvdbSeason) => {
      if (tvdbRows.length === 0) return ordering === 'tmdb' ? inWork(tvdbSeason) : undefined;
      const seasons = new Set(tvdbRows.filter((row) => row.season === tvdbSeason).map((row) => workSeasonOf.get(row.key)));
      return seasons.size === 1 ? inWork([...seasons][0]) : undefined;
    },
    ofSceneSeason: inWork,
  };
}

export function sceneMappingAliases(names: SceneMappingName[], seasons: WorkSeasons): NamedReading[] {
  return names.flatMap(({ title, tvdbSeason, releaseSeason, filter }) => {
    const season = tvdbSeason ?? releaseSeason;
    if (season === undefined) return [{ title, filter }];
    const partSeason = tvdbSeason === undefined ? seasons.ofSceneSeason(season) : seasons.ofTvdbSeason(season);
    return partSeason ? [{ title, partSeason, releaseSeason: releaseSeason ?? partSeason.season, filter }] : [];
  });
}
