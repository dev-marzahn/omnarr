// groupUnits: how search.start splits its Units.
import { describe, expect, test } from 'vite-plus/test';

import type { Id } from '../convex/_generated/dataModel';
import { groupUnits, type GroupUnit } from '../convex/pipeline/groups';

const unit = (season: number, episode: number, wanted = true): GroupUnit => ({
  _id: `s${season}e${episode}` as Id<'units'>,
  tmdbSeason: season,
  tmdbEpisode: episode,
  wanted,
});
const season = (n: number, count: number) => Array.from({ length: count }, (_, i) => unit(n, i + 1));
const ids = (units: GroupUnit[]) => units.map((u) => u._id);

describe('groupUnits', () => {
  test('a season whose every Unit is in the input and wanted is one group', () => {
    const all = [...season(1, 3), ...season(2, 2)];
    expect(groupUnits(all, { kind: 'series', numberingScheme: 'standard', units: all })).toEqual([
      { kind: 'season', unitIds: ids(season(1, 3)) },
      { kind: 'season', unitIds: ids(season(2, 2)) },
    ]);
  });

  test('a partial season splits into one group per Unit', () => {
    const all = season(1, 3);
    expect(groupUnits(all.slice(0, 2), { kind: 'series', numberingScheme: 'standard', units: all })).toEqual([
      { kind: 'episode', unitIds: ['s1e1'] },
      { kind: 'episode', unitIds: ['s1e2'] },
    ]);
  });

  test('a season with a Unit that is not wanted splits too, and the unwanted Unit is not searched', () => {
    const all = [unit(1, 1), unit(1, 2, false)];
    expect(groupUnits(all, { kind: 'series', numberingScheme: 'standard', units: all })).toEqual([{ kind: 'episode', unitIds: ['s1e1'] }]);
  });

  test('specials are searched one by one', () => {
    const all = [unit(0, 1), unit(0, 2)];
    expect(groupUnits(all, { kind: 'series', numberingScheme: 'standard', units: all }).map((g) => g.kind)).toEqual(['episode', 'episode']);
  });

  test('an anime Work gets animeSeason and animeEpisode groups', () => {
    const all = [...season(1, 2), unit(2, 1), unit(2, 2)];
    expect(groupUnits([...season(1, 2), unit(2, 1)], { kind: 'series', numberingScheme: 'anime', units: all })).toEqual([
      { kind: 'animeSeason', unitIds: ['s1e1', 's1e2'] },
      { kind: 'animeEpisode', unitIds: ['s2e1'] },
    ]);
  });

  test('a movie is one group', () => {
    const movie: GroupUnit = { _id: 'm' as Id<'units'>, wanted: true };
    expect(groupUnits([movie], { kind: 'movie', numberingScheme: 'standard', units: [movie] })).toEqual([{ kind: 'movie', unitIds: ['m'] }]);
  });
});
