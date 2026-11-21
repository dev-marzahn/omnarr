import { describe, expect, test } from 'vite-plus/test';

import { aliasList, movieAirDate, seasonNames, selectAbsoluteOrder, suggestNumbering } from '../../convex/metadata/numbering';

describe('suggestNumbering', () => {
  const series = { kind: 'series' as const, genreIds: [16], originCountry: ['JP'] };

  test('anime from Anime-Lists when the series has an entry', () => {
    expect(suggestNumbering({ ...series, genreIds: [18], originCountry: ['US'] }, true)).toEqual({ scheme: 'anime', reason: 'animeLists' });
  });

  test('anime from TMDB genre Animation plus Japanese origin otherwise', () => {
    expect(suggestNumbering(series, false)).toEqual({ scheme: 'anime', reason: 'genreOrigin' });
  });

  test('standard when neither holds', () => {
    expect(suggestNumbering({ ...series, originCountry: ['US'] }, false)).toEqual({ scheme: 'standard', reason: 'none' });
    expect(suggestNumbering({ ...series, genreIds: [18] }, false)).toEqual({ scheme: 'standard', reason: 'none' });
  });

  test('a movie is always standard', () => {
    expect(suggestNumbering({ ...series, kind: 'movie' }, true)).toEqual({ scheme: 'standard', reason: 'none' });
  });
});

describe('movieAirDate', () => {
  const at = (date: string) => Date.parse(`${date}T00:00:00Z`);
  const release = (type: number, date: string) => ({ type, releaseDate: `${date}T00:00:00.000Z` });

  test('the earliest theatrical date in any country', () => {
    const dates = [release(1, '2020-09-01'), release(3, '2020-10-02'), release(3, '2020-09-18'), release(4, '2020-08-01')];
    expect(movieAirDate(dates, '2020-12-24')).toBe(at('2020-09-18'));
  });

  test('else the earliest limited theatrical date, then the earliest premiere', () => {
    expect(movieAirDate([release(1, '2020-09-01'), release(2, '2020-09-20'), release(2, '2020-09-15')], undefined)).toBe(at('2020-09-15'));
    expect(movieAirDate([release(1, '2020-09-05'), release(1, '2020-09-01'), release(5, '2020-01-01')], undefined)).toBe(at('2020-09-01'));
  });

  test('else the top-level release date; with none, unknown', () => {
    expect(movieAirDate([release(4, '2020-01-01')], '2020-03-03')).toBe(at('2020-03-03'));
    expect(movieAirDate([], null)).toBeUndefined();
  });

  test('a time of day on the release date is dropped: dates count from 00:00 UTC', () => {
    expect(movieAirDate([{ type: 3, releaseDate: '2020-09-18T21:00:00.000Z' }], undefined)).toBe(at('2020-09-18'));
  });
});

describe('selectAbsoluteOrder (the Absolute group)', () => {
  const regular = [
    { tmdbSeason: 1, tmdbEpisode: 1 },
    { tmdbSeason: 1, tmdbEpisode: 2 },
    { tmdbSeason: 2, tmdbEpisode: 1 },
  ];
  const order = [regular[2]!, regular[0]!, regular[1]!];

  test('uses the one Absolute group when it covers every regular episode', () => {
    expect(selectAbsoluteOrder(regular, { count: 1, episodes: order })).toEqual({ order });
  });

  test('without an Absolute group, TMDB order and no note', () => {
    expect(selectAbsoluteOrder(regular, undefined)).toEqual({});
    expect(selectAbsoluteOrder(regular, { count: 0 })).toEqual({});
  });

  test('two Absolute groups: TMDB order, with a note', () => {
    expect(selectAbsoluteOrder(regular, { count: 2 })).toEqual({ note: 'TMDB lists 2 Absolute episode groups; absolute numbers follow TMDB order.' });
  });

  test('an incomplete group: TMDB order, with a note', () => {
    expect(selectAbsoluteOrder(regular, { count: 1, episodes: order.slice(0, 2) })).toEqual({
      note: "TMDB's Absolute episode group leaves out 1 of 3 regular episodes; absolute numbers follow TMDB order.",
    });
  });
});

describe('aliasList', () => {
  test('TMDB titles, then each linked Anime-Lists name with its AniDB ID, then XEM names; normalized and without repeats', () => {
    const aliases = aliasList({
      tmdbTitles: ['Star Lantern', 'Star Lantern', 'Hoshi no Chōchin', 'Star Lantern 2nd Season'],
      animeLists: [
        { anidbId: 17001, name: 'Star Lantern', startsAtAbsoluteOne: true },
        { anidbId: 17002, name: 'Star Lantern 2nd Season', startsAtAbsoluteOne: false },
      ],
      xemNames: [{ title: 'Star Lantern!' }, { title: 'Hoshi no Chochin' }],
    });
    expect(aliases).toEqual([
      { title: 'Star Lantern', normalized: 'star lantern', source: 'tmdb' },
      { title: 'Hoshi no Chōchin', normalized: 'hoshi no chochin', source: 'tmdb' },
      { title: 'Star Lantern', normalized: 'star lantern', source: 'animeLists', anidbId: 17001 },
      { title: 'Star Lantern 2nd Season', normalized: 'star lantern 2nd season', source: 'animeLists', anidbId: 17002 },
      { title: 'Star Lantern!', normalized: 'star lantern', source: 'xem' },
      { title: 'Hoshi no Chochin', normalized: 'hoshi no chochin', source: 'xem' },
    ]);
  });

  test('a TMDB title equal to the name of an entry that starts at absolute 1 is kept beside it', () => {
    const aliases = aliasList({
      tmdbTitles: ['Star Lantern'],
      animeLists: [{ anidbId: 17001, name: 'Star Lantern', startsAtAbsoluteOne: true }],
      xemNames: [],
    });
    expect(aliases.map((a) => [a.source, a.anidbId])).toEqual([
      ['tmdb', undefined],
      ['animeLists', 17001],
    ]);
  });

  test('a TMDB title equal to the name of an entry that starts later is not written: only the entry alias remains', () => {
    const aliases = aliasList({
      tmdbTitles: ['Star Lantern', 'Star Lantern: 2nd Season'],
      animeLists: [{ anidbId: 17002, name: 'Star Lantern 2nd Season', startsAtAbsoluteOne: false }],
      xemNames: [{ title: 'Star Lantern 2nd Season' }],
    });
    expect(aliases).toEqual([
      { title: 'Star Lantern', normalized: 'star lantern', source: 'tmdb' },
      { title: 'Star Lantern 2nd Season', normalized: 'star lantern 2nd season', source: 'animeLists', anidbId: 17002 },
      { title: 'Star Lantern 2nd Season', normalized: 'star lantern 2nd season', source: 'xem' },
    ]);
  });

  test("Sonarr's scene-mapping names come last, without a scene season, once each", () => {
    const aliases = aliasList({
      tmdbTitles: ['Harbour Lights'],
      animeLists: [],
      xemNames: [],
      sceneMappings: ['Harbour Lights UK', 'Harbour Lights', 'Harbour Lights (UK)', '!!!'],
    });
    expect(aliases).toEqual([
      { title: 'Harbour Lights', normalized: 'harbour lights', source: 'tmdb' },
      { title: 'Harbour Lights UK', normalized: 'harbour lights uk', source: 'sceneMapping' },
      { title: 'Harbour Lights', normalized: 'harbour lights', source: 'sceneMapping' },
    ]);
  });

  test('a title that normalizes to nothing is left out', () => {
    expect(aliasList({ tmdbTitles: ['!!!', 'Harbour Lights'], animeLists: [], xemNames: [] })).toEqual([
      { title: 'Harbour Lights', normalized: 'harbour lights', source: 'tmdb' },
    ]);
  });

  test("a general alias made of another alias and a season's name carries that season's scene season (the part-title fix)", () => {
    const aliases = aliasList({
      tmdbTitles: ["JoJo's Bizarre Adventure", "STEEL BALL RUN JoJo's Bizarre Adventure"],
      animeLists: [],
      xemNames: [],
      seasonNames: [{ normalized: 'steel ball run', sceneSeason: 6 }],
    });
    expect(aliases).toEqual([
      { title: "JoJo's Bizarre Adventure", normalized: 'jojos bizarre adventure', source: 'tmdb' },
      { title: "STEEL BALL RUN JoJo's Bizarre Adventure", normalized: 'steel ball run jojos bizarre adventure', source: 'tmdb', sceneSeason: 6 },
    ]);
  });

  test("a scene-mapping name made of an alias and a season's name gets the season's scene season too; one naming an unplaced cour is left out", () => {
    const aliases = aliasList({
      tmdbTitles: ["JoJo's Bizarre Adventure"],
      animeLists: [],
      xemNames: [],
      sceneMappings: ["JoJo's Bizarre Adventure Steel Ball Run", "JoJo's Bizarre Adventure Steel Ball Run Part 2"],
      seasonNames: [{ normalized: 'steel ball run', sceneSeason: 6 }],
    });
    expect(aliases.map(({ normalized, source, sceneSeason }) => ({ normalized, source, sceneSeason }))).toEqual([
      { normalized: 'jojos bizarre adventure', source: 'tmdb', sceneSeason: undefined },
      { normalized: 'jojos bizarre adventure steel ball run', source: 'sceneMapping', sceneSeason: 6 },
    ]);
  });

  test('a general alias naming a cour (another alias, then … Part N) is left out; a part name with its own scene season stays', () => {
    const aliases = aliasList({
      tmdbTitles: ['Attack on Titan', 'Attack on Titan: The Final Season Part 2'],
      animeLists: [],
      xemNames: [{ title: 'Shingeki no Kyojin: The Final Season Part 2', sceneSeason: 5 }],
      seasonNames: [{ normalized: 'the final season', sceneSeason: 4 }],
    });
    expect(aliases.map(({ normalized, sceneSeason }) => ({ normalized, sceneSeason }))).toEqual([
      { normalized: 'attack on titan', sceneSeason: undefined },
      { normalized: 'shingeki no kyojin the final season part 2', sceneSeason: 5 },
    ]);
  });
});

describe('seasonNames', () => {
  const sceneSeasons = new Map([1, 2, 3, 4, 5, 6].map((season) => [season, new Set([season])]));
  const names = (seasons: { season: number; name?: string }[], titles = ["JoJo's Bizarre Adventure"]) =>
    seasonNames({ seasons, sceneSeasons, titles }).map(({ season, sceneSeason }) => ({ season, sceneSeason }));

  test("a named season gets its one scene season, from XEM's rows for its Units", () => {
    expect(seasonNames({ seasons: [{ season: 6, name: 'Steel Ball Run' }], sceneSeasons: new Map([[6, new Set([7])]]), titles: [] })).toEqual([
      { season: 6, name: 'Steel Ball Run', normalized: 'steel ball run', sceneSeason: 7 },
    ]);
  });

  test("placeholder names never make one: Season 1, Part 2, 2nd Season, Season 3 Part 2, Specials, the show's own name", () => {
    expect(
      names([
        { season: 0, name: 'Specials' },
        { season: 1, name: 'Season 1' },
        { season: 2, name: 'Part 2' },
        { season: 3, name: '2nd Season' },
        { season: 4, name: 'Season 3 Part 2' },
        { season: 5, name: "JoJo's Bizarre Adventure" },
        { season: 6 },
      ]),
    ).toEqual([]);
  });

  test("The Final Season is a name, not a placeholder (Attack on Titan's season 4)", () => {
    expect(names([{ season: 4, name: 'The Final Season' }])).toEqual([{ season: 4, sceneSeason: 4 }]);
  });

  test('a season XEM has no scene rows for, or splits over two scene seasons, gets none', () => {
    expect(
      seasonNames({
        seasons: [
          { season: 5, name: 'Stone Ocean' },
          { season: 6, name: 'Steel Ball Run' },
        ],
        sceneSeasons: new Map([[5, new Set([5, 6])]]),
        titles: [],
      }),
    ).toEqual([]);
  });
});
