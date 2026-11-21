import { describe, expect, test } from 'vite-plus/test';

import type { AnimeListEntry } from '../../convex/mapping/animeListsParse';
import {
  chooseTvdbId,
  entriesStartingAtAbsoluteOne,
  projectMappings,
  type MappingRow,
  type ProjectInput,
  type ProjectUnit,
} from '../../convex/mapping/project';
import { parseMapAll } from '../../convex/mapping/xem';
import blackLagoonShape from '../fixtures/xem/blackLagoonShape.json';
import partial from '../fixtures/xem/partial.json';
import secondAddress from '../fixtures/xem/secondAddress.json';

/** Units keyed `s<season>e<episode>`, as TMDB lists them. */
const series = (...seasons: [season: number, count: number][]): ProjectUnit[] =>
  seasons.flatMap(([season, count]) =>
    Array.from({ length: count }, (_, i) => ({
      key: `s${season}e${i + 1}`,
      kind: season === 0 ? ('special' as const) : ('episode' as const),
      tmdbSeason: season,
      tmdbEpisode: i + 1,
    })),
  );

const input = (overrides: Partial<ProjectInput>): ProjectInput => ({
  units: series([1, 12], [2, 12]),
  animeListEntries: [],
  manualRows: [],
  versions: { animeLists: 'hash-1', xem: '2026-11-17T00:00:00.000Z' },
  ...overrides,
});

const entry = (fields: Partial<AnimeListEntry> & { anidbId: number }): AnimeListEntry => ({
  name: `Entry ${fields.anidbId}`,
  mappings: [],
  contentHash: 'h',
  ...fields,
});

const rowsOf = (rows: MappingRow[], ordering: string) =>
  rows.filter((r) => r.ordering === ordering).map(({ key, season, episode, absolute, source }) => ({ key, season, episode, absolute, source }));
const at = (rows: MappingRow[], ordering: string, key: string) => rowsOf(rows, ordering).filter((r) => r.key === key);

describe('absolute rows', () => {
  test('number regular episodes 1…N in TMDB order; specials get none', () => {
    const { rows, status, notes } = projectMappings(input({ units: series([0, 1], [1, 2], [2, 1]) }));
    expect(rowsOf(rows, 'absolute')).toEqual([
      { key: 's1e1', absolute: 1, source: 'tmdb' },
      { key: 's1e2', absolute: 2, source: 'tmdb' },
      { key: 's2e1', absolute: 3, source: 'tmdb' },
    ]);
    expect(rows.every((r) => r.ordering === 'absolute')).toBe(true);
    expect({ status, notes }).toEqual({ status: 'tmdbOnly', notes: [] });
  });

  test("follow the Absolute group's order when one is used", () => {
    const { rows } = projectMappings(
      input({
        units: series([1, 2]),
        absoluteOrder: [
          { tmdbSeason: 1, tmdbEpisode: 2 },
          { tmdbSeason: 1, tmdbEpisode: 1 },
        ],
      }),
    );
    expect(rowsOf(rows, 'absolute').map((r) => [r.key, r.absolute])).toEqual([
      ['s1e2', 1],
      ['s1e1', 2],
    ]);
  });
});

describe('the TVDB-to-TMDB bridge', () => {
  test('rule 3: TVDB 1 × 24 against TMDB 2 × 12 links by absolute position', () => {
    const { rows, status, notes } = projectMappings(input({ xemEntries: parseMapAll(blackLagoonShape) }));
    expect(at(rows, 'scene', 's2e1')).toEqual([{ key: 's2e1', season: 2, episode: 1, absolute: 13, source: 'xem' }]);
    expect(at(rows, 'tvdb', 's2e1')).toEqual([{ key: 's2e1', season: 1, episode: 13, source: 'xem' }]);
    expect(rowsOf(rows, 'scene')).toHaveLength(24);
    expect(rows.find((r) => r.ordering === 'scene')!.sourceVersion).toBe('2026-11-17T00:00:00.000Z');
    expect({ status, notes }).toEqual({ status: 'complete', notes: [] });
  });

  test('a partial XEM map fails rule 3 and writes nothing from XEM', () => {
    const { rows, status, notes } = projectMappings(input({ xemEntries: parseMapAll(partial) }));
    expect(rows.filter((r) => r.source === 'xem')).toEqual([]);
    expect(status).toBe('partial');
    expect(notes).toEqual(['XEM lists 23 regular episodes, TMDB 24; XEM numbers are not linked.']);
  });

  test('rule 2: seasons of the same size link number for number, specials included; a second address gives a second scene row', () => {
    const { rows, status } = projectMappings(input({ units: series([0, 1], [1, 6], [2, 6]), xemEntries: parseMapAll(secondAddress) }));
    expect(at(rows, 'scene', 's1e6')).toEqual([
      { key: 's1e6', season: 1, episode: 6, absolute: 6, source: 'xem' },
      { key: 's1e6', season: 1, episode: 7, absolute: 7, source: 'xem' },
    ]);
    expect(at(rows, 'scene', 's2e1')).toEqual([{ key: 's2e1', season: 2, episode: 1, absolute: 8, source: 'xem' }]);
    expect(at(rows, 'scene', 's0e1')).toEqual([{ key: 's0e1', season: 0, episode: 1, source: 'xem' }]);
    expect(status).toBe('complete');
  });

  test('specials are linked only by rules 1 and 2: a different special count leaves them unlinked', () => {
    const xem = parseMapAll(secondAddress);
    const { rows, status, notes } = projectMappings(input({ units: series([0, 2], [1, 6], [2, 6]), xemEntries: xem }));
    expect(rows.filter((r) => r.source === 'xem' && r.key.startsWith('s0'))).toEqual([]);
    expect(at(rows, 'scene', 's1e1')).toHaveLength(1);
    expect(status).toBe('partial');
    expect(notes).toEqual(['XEM lists 1 specials, TMDB 2; XEM special numbers are not linked.']);
  });

  test('rule 1: Anime-Lists pins link TVDB numbers where rules 2 and 3 fail', () => {
    // The partial map (23 of 24) fails rule 3, but each entry pins its cour's TVDB numbers to a TMDB season.
    const cour1 = entry({ anidbId: 8, tvdbId: 7700003, defaultTvdbSeason: 1, tmdbSeason: 1 });
    const cour2 = entry({ anidbId: 9, tvdbId: 7700003, defaultTvdbSeason: 1, episodeOffset: 12, tmdbSeason: 2 });
    const { rows, status } = projectMappings(input({ tmdbTvdbId: 7700003, animeListEntries: [cour1, cour2], xemEntries: parseMapAll(partial) }));
    expect(at(rows, 'scene', 's2e1')).toEqual([{ key: 's2e1', season: 2, episode: 1, absolute: 13, source: 'xem' }]);
    expect(at(rows, 'tvdb', 's2e1')).toEqual([
      { key: 's2e1', season: 1, episode: 13, source: 'animeLists' },
      { key: 's2e1', season: 1, episode: 13, source: 'xem' },
    ]);
    expect(rowsOf(rows, 'scene')).toHaveLength(23);
    expect(status).toBe('complete');
  });

  test('an absent xemEntries writes no xem rows and says nothing about XEM', () => {
    const { rows, status, notes } = projectMappings(input({ xemEntries: undefined }));
    expect(rows.filter((r) => r.source === 'xem')).toEqual([]);
    expect({ status, notes }).toEqual({ status: 'tmdbOnly', notes: [] });
  });
});

describe('anidb rows', () => {
  const first = entry({ anidbId: 17001, tvdbId: 7700002, defaultTvdbSeason: 1, tmdbTvId: 900002, tmdbSeason: 1 });
  const second = entry({ anidbId: 17002, tvdbId: 7700002, defaultTvdbSeason: 1, episodeOffset: 12, tmdbTvId: 900002, tmdbSeason: 2 });

  test('each entry numbers the TMDB season it names; TVDB numbers follow by rule 1', () => {
    const { rows, status } = projectMappings(input({ tmdbTvdbId: 7700002, animeListEntries: [first, second] }));
    expect(rowsOf(rows, 'anidb:17001')).toHaveLength(12);
    expect(at(rows, 'anidb:17002', 's2e1')).toEqual([{ key: 's2e1', season: 1, episode: 1, source: 'animeLists' }]);
    expect(at(rows, 'tvdb', 's2e1')).toEqual([{ key: 's2e1', season: 1, episode: 13, source: 'animeLists' }]);
    expect(rows.find((r) => r.ordering === 'anidb:17002')!.sourceVersion).toBe('hash-1');
    expect(status).toBe('complete');
  });

  test('two entries on one TMDB season split it at the later offset', () => {
    const cour1 = entry({ anidbId: 1, tmdbSeason: 1 });
    const cour2 = entry({ anidbId: 2, tmdbSeason: 1, tmdbOffset: 6 });
    const { rows } = projectMappings(input({ units: series([1, 12]), animeListEntries: [cour1, cour2] }));
    expect(rowsOf(rows, 'anidb:1').map((r) => r.key)).toEqual(['s1e1', 's1e2', 's1e3', 's1e4', 's1e5', 's1e6']);
    expect(rowsOf(rows, 'anidb:2').map((r) => [r.key, r.episode])).toEqual([
      ['s1e7', 1],
      ['s1e8', 2],
      ['s1e9', 3],
      ['s1e10', 4],
      ['s1e11', 5],
      ['s1e12', 6],
    ]);
  });

  test('an entry naming a TMDB season TMDB no longer lists writes no rows, is noted, and leaves the Work partial', () => {
    // The real JUJUTSU KAISEN shape: TMDB merged the seasons into one.
    const cour1 = entry({ anidbId: 17011, tvdbId: 7700007, defaultTvdbSeason: 1, tmdbSeason: 1 });
    const gone = entry({ anidbId: 17012, name: 'Ember Rite (2023)', tvdbId: 7700007, defaultTvdbSeason: 2, tmdbSeason: 2 });
    const cour3 = entry({ anidbId: 17013, tvdbId: 7700007, defaultTvdbSeason: 3, tmdbSeason: 1, tmdbOffset: 7 });
    const { rows, status, notes } = projectMappings(input({ units: series([1, 10]), tmdbTvdbId: 7700007, animeListEntries: [cour1, gone, cour3] }));
    expect(rows.filter((r) => r.ordering === 'anidb:17012')).toEqual([]);
    expect(notes).toEqual(["Anime-Lists maps AniDB 17012 (Ember Rite (2023)) to TMDB season 2, which TMDB doesn't list; its episodes are not mapped."]);
    expect(status).toBe('partial');
  });

  test("tmdbseason 'a': the entry's episode n is TMDB absolute n + offset", () => {
    const { rows } = projectMappings(input({ animeListEntries: [entry({ anidbId: 3, tmdbSeason: 'a', tmdbOffset: 12 })] }));
    expect(at(rows, 'anidb:3', 's2e1')).toEqual([{ key: 's2e1', season: 1, episode: 1, source: 'animeLists' }]);
    expect(rowsOf(rows, 'anidb:3')).toHaveLength(12);
  });

  test('explicit pairs win over the default, give specials season 0 rows, and a pair to several episodes covers each', () => {
    const glass = entry({
      anidbId: 4,
      tmdbSeason: 1,
      mappings: [
        { anidbSeason: 1, tmdbSeason: 2, start: 13, end: 14, offset: -12, pairs: [] },
        { anidbSeason: 0, tmdbSeason: 0, pairs: [[1, [1, 2]]] },
      ],
    });
    const { rows } = projectMappings(input({ units: series([0, 2], [1, 12], [2, 12]), animeListEntries: [glass] }));
    expect(at(rows, 'anidb:4', 's2e1')).toEqual([{ key: 's2e1', season: 1, episode: 13, source: 'animeLists' }]);
    expect(at(rows, 'anidb:4', 's0e1')).toEqual([{ key: 's0e1', season: 0, episode: 1, source: 'animeLists' }]);
    expect(at(rows, 'anidb:4', 's0e2')).toEqual([{ key: 's0e2', season: 0, episode: 1, source: 'animeLists' }]);
  });
});

describe('precedence within an ordering', () => {
  test('a manual row keeps its number: lower rows naming it on another Unit are not written', () => {
    const { rows } = projectMappings(input({ manualRows: [{ key: 's1e2', ordering: 'absolute', absolute: 1 }] }));
    expect(at(rows, 'absolute', 's1e1')).toEqual([]);
    expect(at(rows, 'absolute', 's1e2')).toEqual([{ key: 's1e2', absolute: 2, source: 'tmdb' }]);
    expect(rows.some((r) => (r.source as string) === 'manual')).toBe(false);
  });

  test('xem wins over animeLists in the tvdb ordering', () => {
    // Two entries both claim TVDB S1E1–12, one for each TMDB season. XEM follows the first pin; the second entry's tvdb rows lose.
    const a = entry({ anidbId: 5, tvdbId: 7700003, defaultTvdbSeason: 1, tmdbSeason: 1 });
    const b = entry({ anidbId: 6, tvdbId: 7700003, defaultTvdbSeason: 1, tmdbSeason: 2 });
    const { rows } = projectMappings(input({ tmdbTvdbId: 7700003, xemEntries: parseMapAll(blackLagoonShape), animeListEntries: [a, b] }));
    const tvdbS1E1 = rowsOf(rows, 'tvdb').filter((r) => r.season === 1 && r.episode === 1);
    expect(tvdbS1E1.map((r) => [r.key, r.source])).toEqual([
      ['s1e1', 'animeLists'],
      ['s1e1', 'xem'],
    ]);
  });
});

describe('entriesStartingAtAbsoluteOne', () => {
  test("an entry whose first episode is the Unit with absolute 1 starts there; a later season's entry doesn't", () => {
    const first = entry({ anidbId: 17001, tmdbSeason: 1 });
    const second = entry({ anidbId: 17002, tmdbSeason: 2 });
    const { rows } = projectMappings(input({ animeListEntries: [first, second] }));
    expect(entriesStartingAtAbsoluteOne(rows)).toEqual(new Set([17001]));
  });

  test("with tmdbseason 'a', only an entry without an offset starts at absolute 1", () => {
    const { rows } = projectMappings(
      input({ animeListEntries: [entry({ anidbId: 1, tmdbSeason: 'a' }), entry({ anidbId: 2, tmdbSeason: 'a', tmdbOffset: 12 })] }),
    );
    expect(entriesStartingAtAbsoluteOne(rows)).toEqual(new Set([1]));
  });

  test("it follows the Absolute group's order", () => {
    const absoluteOrder = [
      { tmdbSeason: 2, tmdbEpisode: 1 },
      { tmdbSeason: 1, tmdbEpisode: 1 },
    ];
    const { rows } = projectMappings(
      input({ units: series([1, 1], [2, 1]), absoluteOrder, animeListEntries: [entry({ anidbId: 1, tmdbSeason: 1 }), entry({ anidbId: 2, tmdbSeason: 2 })] }),
    );
    expect(entriesStartingAtAbsoluteOne(rows)).toEqual(new Set([2]));
  });
});

describe('chooseTvdbId (one TVDB ID per Work)', () => {
  test("TMDB's ID, else the one most Anime-Lists entries carry", () => {
    expect(chooseTvdbId(7, [entry({ anidbId: 1, tvdbId: 7 })])).toEqual({ tvdbId: 7 });
    expect(chooseTvdbId(undefined, [entry({ anidbId: 1, tvdbId: 8 }), entry({ anidbId: 2, tvdbId: 9 }), entry({ anidbId: 3, tvdbId: 9 })])).toEqual({
      tvdbId: 9,
      note: 'Anime-Lists also links TVDB ID 8; numbering uses 9.',
    });
    expect(chooseTvdbId(undefined, [])).toEqual({});
  });

  test('a disagreement is noted, and the Work is partial', () => {
    expect(chooseTvdbId(7, [entry({ anidbId: 1, tvdbId: 8 })])).toEqual({ tvdbId: 7, note: 'Anime-Lists also links TVDB ID 8; numbering uses 7.' });
    const { status, notes } = projectMappings(input({ tmdbTvdbId: 7, animeListEntries: [entry({ anidbId: 1, tvdbId: 8, tmdbSeason: 1 })] }));
    expect(status).toBe('partial');
    expect(notes).toEqual(['Anime-Lists also links TVDB ID 8; numbering uses 7.']);
  });
});
