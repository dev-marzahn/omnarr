// Parsing Sonarr's scene mappings:
// the all-seasons names only, each bounded, from an untrusted list.
import { describe, expect, test } from 'vite-plus/test';

import { parseSceneMappings } from '../../convex/mapping/sceneMappingsParse';
import list from '../fixtures/sceneMappings/scenemapping.json';

describe('parseSceneMappings', () => {
  test('keeps the all-seasons names with their TVDB ID; leaves out the season-specific and filterRegex ones', () => {
    expect(parseSceneMappings(list)).toEqual([
      { mappingId: 's-0000000000000000000000a1', tvdbId: 7700001, title: 'Harbour Lights UK' },
      { mappingId: 's-0000000000000000000000a2', tvdbId: 7700001, title: 'The Harbour Lights' },
      { mappingId: 's-0000000000000000000000a6', tvdbId: 7700003, title: 'Northbound Signal US' },
    ]);
  });

  test('skips an entry with a bad ID, a control character or an over-long title, and trims the title', () => {
    const entry = (fields: Record<string, unknown>) => ({ mappingId: 's-1', tvdbId: 1, title: 'Name', season: -1, ...fields });
    expect(
      parseSceneMappings([
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

  test('refuses a body that is not a list, or an empty list, so the last good copy stays', () => {
    expect(() => parseSceneMappings({ error: 'nope' })).toThrow();
    expect(() => parseSceneMappings([])).toThrow();
  });
});
