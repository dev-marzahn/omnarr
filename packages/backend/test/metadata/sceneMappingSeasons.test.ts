import { describe, expect, test } from 'vite-plus/test';

import type { MappingRow } from '../../convex/mapping/project';
import { NO_WORK_SEASONS, sceneMappingAliases, workSeasons, type WorkSeasons } from '../../convex/mapping/sceneMappingSeasons';

const units = [
  { tmdbId: 'e1', tmdbSeason: 1 },
  { tmdbId: 'e2', tmdbSeason: 1 },
  { tmdbId: 'e3', tmdbSeason: 2 },
  { tmdbId: 'e4', tmdbSeason: 2 },
];
const row = (key: string, ordering: 'tvdb' | 'scene', season: number): MappingRow => ({ key, ordering, season, episode: 1, source: 'xem' });

describe('workSeasons', () => {
  test('without mapping rows, a TVDB or scene season is the TMDB season of the same number, when TMDB lists it', () => {
    const seasons = workSeasons(units, []);
    expect(seasons.ofTvdbSeason(2)).toEqual({ season: 2, ordering: 'tmdb' });
    expect(seasons.ofSceneSeason(1)).toEqual({ season: 1, ordering: 'tmdb' });
    expect(seasons.ofTvdbSeason(6)).toBeUndefined();
    expect(seasons.ofSceneSeason(6)).toBeUndefined();
  });

  test("with XEM's rows, a TVDB season is the one scene season its episodes have, and a scene season must be one XEM lists", () => {
    const rows = [row('e1', 'tvdb', 1), row('e2', 'tvdb', 1), row('e3', 'tvdb', 2), row('e4', 'tvdb', 2), row('e3', 'scene', 5), row('e4', 'scene', 5)];
    const seasons = workSeasons(units, rows);
    expect(seasons.ofTvdbSeason(2)).toEqual({ season: 5, ordering: 'scene' });
    expect(seasons.ofSceneSeason(5)).toEqual({ season: 5, ordering: 'scene' });
    expect(seasons.ofSceneSeason(2)).toBeUndefined();
  });

  test('with TVDB rows but no scene rows, a TVDB season is the TMDB season its episodes have', () => {
    expect(workSeasons(units, [row('e3', 'tvdb', 7), row('e4', 'tvdb', 7)]).ofTvdbSeason(7)).toEqual({ season: 2, ordering: 'tmdb' });
  });

  test('a TVDB season split over two seasons, or one no episode has, has none', () => {
    const seasons = workSeasons(units, [row('e2', 'tvdb', 3), row('e3', 'tvdb', 3), row('e2', 'scene', 1), row('e3', 'scene', 2)]);
    expect(seasons.ofTvdbSeason(3)).toBeUndefined();
    expect(seasons.ofTvdbSeason(9)).toBeUndefined();
  });

  test('scene rows without TVDB rows place no TVDB season', () => {
    expect(workSeasons(units, [row('e1', 'scene', 1)]).ofTvdbSeason(1)).toBeUndefined();
  });
});

describe('sceneMappingAliases', () => {
  const placed = (season: number): WorkSeasons => ({
    ofTvdbSeason: () => ({ season, ordering: 'scene' }),
    ofSceneSeason: () => ({ season, ordering: 'tmdb' }),
  });

  test('an all-seasons name stays a plain alias, its filter kept', () => {
    expect(sceneMappingAliases([{ title: 'Harbour Lights UK' }, { title: 'Harbour', filter: '(?i)^Harbour\\.S01E' }], NO_WORK_SEASONS)).toEqual([
      { title: 'Harbour Lights UK' },
      { title: 'Harbour', filter: '(?i)^Harbour\\.S01E' },
    ]);
  });

  test("a TVDB season's name carries the Work's season and the season its releases write", () => {
    expect(sceneMappingAliases([{ title: 'Food Safari', tvdbSeason: 6, releaseSeason: 4 }], placed(16))).toEqual([
      { title: 'Food Safari', partSeason: { season: 16, ordering: 'scene' }, releaseSeason: 4 },
    ]);
  });

  test("a TVDB season's name with no release season of its own expects its releases to write the season it is placed in", () => {
    expect(sceneMappingAliases([{ title: 'Harbour Lights Winter Tales', tvdbSeason: 0 }], placed(3))).toEqual([
      { title: 'Harbour Lights Winter Tales', partSeason: { season: 3, ordering: 'scene' }, releaseSeason: 3 },
    ]);
  });

  test('a season the Work cannot place leaves its name out: read across every season it would name a wrong episode', () => {
    expect(
      sceneMappingAliases(
        [
          { title: 'Aqua Unit Patrol Squad', tvdbSeason: 8 },
          { title: 'Digimon Adventure:', releaseSeason: 3 },
        ],
        NO_WORK_SEASONS,
      ),
    ).toEqual([]);
  });

  test('a name with only a release season is read in that scene season', () => {
    expect(sceneMappingAliases([{ title: 'Digimon Adventure:', releaseSeason: 1 }], placed(1))).toEqual([
      { title: 'Digimon Adventure:', partSeason: { season: 1, ordering: 'tmdb' }, releaseSeason: 1 },
    ]);
  });
});
