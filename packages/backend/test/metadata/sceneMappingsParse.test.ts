import { describe, expect, test } from 'vite-plus/test';

import { parseSceneMappings } from '../../convex/mapping/sceneMappingsParse';

const parsed = async (json: unknown) => (await parseSceneMappings(json)).map(({ contentHash: _hash, ...entry }) => entry);
import list from '../fixtures/sceneMappings/scenemapping.json';

describe('parseSceneMappings', () => {
  test('keeps every name with its TVDB ID, a TVDB season, the season its releases write and a filter', async () => {
    expect(await parsed(list)).toEqual([
      { mappingId: 's-0000000000000000000000a1', tvdbId: 7700001, title: 'Harbour Lights UK' },
      { mappingId: 's-0000000000000000000000a2', tvdbId: 7700001, title: 'The Harbour Lights' },
      { mappingId: 's-0000000000000000000000a3', tvdbId: 7700001, title: 'Harbour Lights Winter Tales', tvdbSeason: 0 },
      { mappingId: 's-0000000000000000000000a4', tvdbId: 7700001, title: 'Harbour Lights Reborn', tvdbSeason: 3, releaseSeason: 1 },
      { mappingId: 's-0000000000000000000000a5', tvdbId: 7700001, title: 'Harbour', filter: '(?i)^Harbour\\.S01E' },
      { mappingId: 's-0000000000000000000000a6', tvdbId: 7700003, title: 'Northbound Signal US' },
    ]);
  });

  test('a season of -1 or none names every season; a season below -1 skips the entry', async () => {
    const entry = (fields: Record<string, unknown>) => ({ mappingId: 's-1', tvdbId: 1, title: 'Name', ...fields });
    expect(
      await parsed([
        entry({ mappingId: 's-all', season: -1, sceneSeasonNumber: -1 }),
        entry({ mappingId: 's-null', season: null, sceneSeasonNumber: null }),
        entry({ mappingId: 's-scene', season: -1, sceneSeasonNumber: 2 }),
        entry({ mappingId: 's-below', season: -2 }),
        entry({ mappingId: 's-scene-below', sceneSeasonNumber: -3 }),
      ]),
    ).toEqual([
      { mappingId: 's-all', tvdbId: 1, title: 'Name' },
      { mappingId: 's-null', tvdbId: 1, title: 'Name' },
      { mappingId: 's-scene', tvdbId: 1, title: 'Name', releaseSeason: 2 },
    ]);
  });

  test("a filter RE2 can't read skips the entry; a blank one is no filter, and one is trimmed", async () => {
    const entry = (mappingId: string, filterRegex: unknown) => ({ mappingId, tvdbId: 1, title: 'Name', season: -1, filterRegex });
    expect(
      await parsed([
        entry('s-lookbehind', '(?<=x)y'),
        entry('s-backreference', '(a)\\1'),
        entry('s-dotnet-flags', '(?-)[-_. ]Danish[-_. ]'),
        entry('s-long', 'a'.repeat(501)),
        entry('s-not-text', 42),
        entry('s-blank', '   '),
        entry('s-padded', '  -NTb$  '),
      ]),
    ).toEqual([
      { mappingId: 's-blank', tvdbId: 1, title: 'Name' },
      { mappingId: 's-padded', tvdbId: 1, title: 'Name', filter: '-NTb$' },
    ]);
  });

  test('a name for one season whose releases number in another order than the scene is skipped; an all-seasons one stays', async () => {
    const entry = (fields: Record<string, unknown>) => ({ mappingId: 's-1', tvdbId: 1, title: 'American Dad', season: -1, ...fields });
    expect(
      await parsed([
        entry({ mappingId: 's-tvdb-order', sceneSeasonNumber: 17, sceneOrigin: 'tvdb', filterRegex: '(?i)-(?:CHX|TMSF)(?:-|$)' }),
        entry({ mappingId: 's-mixed-order', season: 4, sceneOrigin: 'mixed' }),
        entry({ mappingId: 's-scene-order', season: 4, sceneOrigin: 'scene' }),
        entry({ mappingId: 's-no-order', season: 5, sceneOrigin: '' }),
        entry({ mappingId: 's-every-season', sceneOrigin: 'tvdb' }),
      ]),
    ).toEqual([
      { mappingId: 's-scene-order', tvdbId: 1, title: 'American Dad', tvdbSeason: 4 },
      { mappingId: 's-no-order', tvdbId: 1, title: 'American Dad', tvdbSeason: 5 },
      { mappingId: 's-every-season', tvdbId: 1, title: 'American Dad' },
    ]);
  });

  test('skips an entry with a bad ID, a control character or an over-long title, and trims the title', async () => {
    const entry = (fields: Record<string, unknown>) => ({ mappingId: 's-1', tvdbId: 1, title: 'Name', season: -1, ...fields });
    expect(
      await parsed([
        entry({ mappingId: 's-ok', title: '  Padded Name  ' }),
        entry({ mappingId: 's-zero', tvdbId: 0 }),
        entry({ mappingId: 's-float', tvdbId: 1.5 }),
        entry({ mappingId: 'bad id with spaces' }),
        entry({ mappingId: 's-control', title: 'Name\u0007' }),
        entry({ mappingId: 's-long', title: 'x'.repeat(201) }),
        entry({ mappingId: 's-blank', title: '   ' }),
        entry({ mappingId: 's-number', title: 42 }),
        entry({ mappingId: 's-noseason', season: undefined }),
        'not an object',
      ]),
    ).toEqual([
      { mappingId: 's-ok', tvdbId: 1, title: 'Padded Name' },
      { mappingId: 's-noseason', tvdbId: 1, title: 'Name' },
    ]);
  });

  test('each entry carries a hash of what it says, which changes with its season or filter only', async () => {
    const entry = { mappingId: 's-1', tvdbId: 1, title: 'Name', season: -1 };
    const [plain, again, seasoned, filtered] = await parseSceneMappings([
      entry,
      { ...entry, comment: 'ignored' },
      { ...entry, season: 2 },
      { ...entry, filterRegex: '-NTb$' },
    ]);
    expect(again!.contentHash).toBe(plain!.contentHash);
    expect(new Set([plain!.contentHash, seasoned!.contentHash, filtered!.contentHash]).size).toBe(3);
  });

  test('refuses a body that is not a list, or an empty list, so the last good copy stays', async () => {
    await expect(parseSceneMappings({ error: 'nope' })).rejects.toThrow();
    await expect(parseSceneMappings([])).rejects.toThrow();
  });
});
