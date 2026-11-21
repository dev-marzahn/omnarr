// The support check: static, one reason per unsupported definition,
// and the catalogue metadata it reads on the way.
import { describe, expect, test } from 'vite-plus/test';

import { checkDefinition } from '../../src/sites/check.ts';
import { JSONSITE_YML, LANTERN_YML, variant } from './fixtures.ts';

const reason = (yml: string) => {
  const checked = checkDefinition(yml);
  return checked.support.ok ? 'ok' : checked.support.reason;
};

describe('checkDefinition', () => {
  test('the hand-written definitions pass, with their metadata', () => {
    const lantern = checkDefinition(LANTERN_YML);
    expect(lantern.support).toEqual({ ok: true });
    expect(lantern.definitionId).toBe('lanternsite');
    expect(lantern.meta).toMatchObject({
      name: 'Lantern Site',
      type: 'public',
      language: 'en-US',
      links: ['https://lantern.test/'],
      legacylinks: ['https://old.lantern.test/'],
      modes: { search: ['q'], 'tv-search': ['q', 'season', 'ep'], 'movie-search': ['q', 'imdbid'] },
      categories: [2000, 5000, 5070],
      requestDelay: 3,
    });
    expect(lantern.meta?.settings).toEqual([
      {
        name: 'sort',
        type: 'select',
        label: 'Sort',
        default: 'added',
        options: [
          { value: 'added', label: 'Date added' },
          { value: 'seeders', label: 'Seeders' },
        ],
      },
      { name: 'freeleech', type: 'checkbox', label: 'Free only', default: false },
      { name: 'info_note', type: 'info', label: 'About', default: 'Results are paced.' },
    ]);
    expect(reason(JSONSITE_YML)).toBe('ok');
  });

  test.each([
    [
      'needsFlareSolverr',
      variant(LANTERN_YML, '  - name: info_note', '  - name: info_flaresolverr\n    type: info_flaresolverr\n    label: FS\n  - name: info_note'),
    ],
    ['privateInP2', variant(LANTERN_YML, 'type: public', 'type: semi-private')],
    ['privateInP2', variant(LANTERN_YML, '\nsearch:\n', '\nlogin:\n  path: login.php\n  method: post\n  inputs: {}\n\nsearch:\n')],
    [
      'captcha',
      variant(LANTERN_YML, '\nsearch:\n', '\nlogin:\n  path: login.php\n  captcha:\n    type: image\n    selector: img\n    input: code\n\nsearch:\n'),
    ],
    ['unknownFilter', variant(LANTERN_YML, 'name: querystring', 'name: sparkle')],
    ['unknownKey', variant(LANTERN_YML, 'requestDelay: 3', 'requestDelay: 3\nshinyNewKey: true')],
    ['unknownKey', variant(LANTERN_YML, '      attribute: href\n      filters:', '      attribute: href\n      sparkle: 1\n      filters:')],
    ['templateConstruct', variant(LANTERN_YML, 'order: "{{ .Config.sort }}"', 'order: "{{ printf .Config.sort }}"')],
    ['regex', variant(LANTERN_YML, '"\\\\bS0?(\\\\d+)E(\\\\d+)\\\\b"', '"(?>S\\\\d+)"')],
    ['dateLayout', variant(LANTERN_YML, 'args: "yyyy-MM-dd HH:mm zzz"', 'args: "yyyy-MM-dd gg"')],
    ['selector', variant(LANTERN_YML, 'selector: td.size', 'selector: td.size[[')],
    ['unsupportedFeature', variant(LANTERN_YML, 'requestDelay: 3', 'requestDelay: 3\ncertificates:\n  - 0123456789abcdef')],
    ['unsupportedFeature', variant(LANTERN_YML, 'encoding: UTF-8', 'encoding: x-made-up')],
    ['invalidYaml', 'id: [broken'],
    ['builtIn', variant(LANTERN_YML, 'id: lanternsite', 'id: nyaasi')],
    ['replacedUpstream', variant(LANTERN_YML, 'id: lanternsite', 'id: hdbits')],
  ])('%s', (expected, yml) => {
    expect(reason(yml)).toBe(expected);
  });

  test('a file over 900 KB is tooLarge', () => {
    expect(reason(`${LANTERN_YML}\n#${'x'.repeat(900 * 1024)}`)).toBe('tooLarge');
  });

  test('the detail names what failed and where', () => {
    const checked = checkDefinition(variant(LANTERN_YML, 'name: querystring', 'name: sparkle'));
    expect(checked.support).toEqual({ ok: false, reason: 'unknownFilter', detail: 'sparkle in search.fields.category' });
  });

  test('a mid-pattern (?i) names the pattern location', () => {
    const checked = checkDefinition(variant(LANTERN_YML, '"\\\\bS0?(\\\\d+)E(\\\\d+)\\\\b"', '"S(?i)\\\\d+"'));
    expect(checked.support).toMatchObject({ ok: false, reason: 'regex' });
    expect(!checked.support.ok && checked.support.detail).toContain('search.keywordsfilters');
  });
});
