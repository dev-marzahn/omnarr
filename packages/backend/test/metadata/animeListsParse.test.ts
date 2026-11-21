import { describe, expect, test } from 'vite-plus/test';

import { parseAnimeList, parseMappingPairs } from '../../convex/mapping/animeListsParse';
import xml from '../fixtures/animeLists/anime-list.xml?raw';

describe('parseAnimeList', () => {
  test('parses every entry of the fixture', async () => {
    const entries = await parseAnimeList(xml);
    expect(entries.map((e) => [e.anidbId, e.name])).toEqual([
      [17001, 'Star Lantern'],
      [17002, 'Star Lantern 2nd Season'],
      [17003, 'Star Lantern: The Movie'],
      [17004, 'Endless Tide'],
      [17005, 'Paper Moon Harbour'],
      [17006, 'Glass Comet'],
      [17007, '1984'],
    ]);
  });

  test('reads the IDs, seasons and offsets; empty attributes are absent', async () => {
    const [first, second] = await parseAnimeList(xml);
    const { contentHash: _hash, ...entry } = first!;
    expect(entry).toEqual({ anidbId: 17001, name: 'Star Lantern', tvdbId: 7700002, defaultTvdbSeason: 1, tmdbTvId: 900002, tmdbSeason: 1, mappings: [] });
    expect(second).toMatchObject({ episodeOffset: 12, tmdbSeason: 2 });
  });

  test('a type word in tvdbid leaves the TVDB ID absent', async () => {
    const entries = await parseAnimeList(xml);
    for (const anidbId of [17003, 17005, 17007]) expect(entries.find((e) => e.anidbId === anidbId)).not.toHaveProperty('tvdbId');
  });

  test("keeps 'a' for absolute seasons", async () => {
    const tide = (await parseAnimeList(xml)).find((e) => e.anidbId === 17004)!;
    expect(tide).toMatchObject({ defaultTvdbSeason: 'a', tmdbSeason: 'a', tmdbOffset: 0 });
  });

  test('parses mappings: explicit pairs with several targets, and start, end and offset', async () => {
    const entries = await parseAnimeList(xml);
    expect(entries.find((e) => e.anidbId === 17004)!.mappings).toEqual([
      {
        anidbSeason: 0,
        tvdbSeason: 0,
        pairs: [
          [1, [1, 2]],
          [3, [4]],
        ],
      },
      { anidbSeason: 0, tmdbSeason: 0, pairs: [[1, [1]]] },
    ]);
    expect(entries.find((e) => e.anidbId === 17006)!.mappings).toEqual([
      { anidbSeason: 1, tvdbSeason: 2, start: 13, end: 24, offset: -12, pairs: [] },
      { anidbSeason: 1, tmdbSeason: 2, start: 13, end: 24, offset: -12, pairs: [] },
      {
        anidbSeason: 0,
        tmdbSeason: 0,
        pairs: [
          [1, [2]],
          [2, [0]],
        ],
      },
    ]);
  });

  test('hashes are stable, and change only for the entry that changed', async () => {
    const before = await parseAnimeList(xml);
    expect((await parseAnimeList(xml)).map((e) => e.contentHash)).toEqual(before.map((e) => e.contentHash));
    expect(before[0]!.contentHash).toMatch(/^[0-9a-f]{64}$/);
    const after = await parseAnimeList(xml.replace('episodeoffset="12"', 'episodeoffset="13"'));
    expect(after.map((e, i) => e.contentHash === before[i]!.contentHash)).toEqual([true, false, true, true, true, true, true]);
  });
});

describe('parseMappingPairs', () => {
  test.each([
    [
      ';1-5;2-6;',
      [
        [1, [5]],
        [2, [6]],
      ],
    ],
    [';1-1+2;', [[1, [1, 2]]]],
    ['', []],
    [';1+2-1;x-1;', []],
  ])('%j', (text, pairs) => {
    expect(parseMappingPairs(text)).toEqual(pairs);
  });
});
