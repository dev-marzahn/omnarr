// The template language and filters, with Prowlarr's order and
// quirks: re_replace, join, and/or/eq/ne, if/else/end (an `if` needs an
// `else`, the first `end` closes it), range, then variables.
import { describe, expect, test } from 'vite-plus/test';

import { applyFilters, type FilterContext } from '../../src/sites/filters.ts';
import { applyTemplate, type Variables } from '../../src/sites/template.ts';

const vars: Variables = {
  '.Keywords': 'Star Lantern S01E02',
  '.Query.Season': '1',
  '.Query.Ep': null,
  '.Config.sort': 'date',
  '.Config.verified': '.True',
  '.Config.empty': null,
  '.True': 'True',
  '.False': null,
  '.Categories': ['1', '7'],
  '.Today.Year': '2026',
};

describe('applyTemplate', () => {
  test('variables, with a missing or null one empty', () => {
    expect(applyTemplate('q={{ .Keywords }}&s={{.Config.sort}}&e={{ .Query.Ep }}', vars)).toBe('q=Star Lantern S01E02&s=date&e=');
  });

  test('if/else/end on a variable; an empty string and null are false', () => {
    expect(applyTemplate('{{ if .Keywords }}search{{ else }}browse{{ end }}', vars)).toBe('search');
    expect(applyTemplate('{{ if .Config.empty }}a{{ else }}b{{ end }}', vars)).toBe('b');
    expect(applyTemplate('{{ if .Categories }}cats{{ else }}none{{ end }}', vars)).toBe('cats');
  });

  test('the first end closes an if, as Prowlarr reads it', () => {
    expect(applyTemplate('{{ if .Keywords }}x{{ else }}y{{ end }}-{{ end }}', vars)).toBe('x-{{ end }}');
  });

  test('and, or, eq and ne, nested', () => {
    expect(applyTemplate('{{ if and .Keywords .Config.verified }}both{{ else }}no{{ end }}', vars)).toBe('both');
    expect(applyTemplate('{{ if or .Config.empty .Query.Ep }}any{{ else }}none{{ end }}', vars)).toBe('none');
    expect(applyTemplate('{{ if eq .Config.sort "date" }}d{{ else }}o{{ end }}', vars)).toBe('d');
    expect(applyTemplate('{{ if ne .Config.sort "date" }}d{{ else }}o{{ end }}', vars)).toBe('o');
    expect(applyTemplate('{{ if and eq (.Config.sort) "date" eq (.Query.Season) "2" }}y{{ else }}n{{ end }}', vars)).toBe('n');
  });

  test('range, with and without an index', () => {
    expect(applyTemplate('{{ range .Categories }}c[]={{.}}&{{end}}', vars)).toBe('c[]=1&c[]=7&');
    expect(applyTemplate('{{ range $i, $c := .Categories }}c{{$i}}={{.}};{{end}}', vars)).toBe('c0=1;c1=7;');
  });

  test('join and an inline re_replace with .NET semantics', () => {
    expect(applyTemplate('{{ join .Categories "," }}', vars)).toBe('1,7');
    expect(applyTemplate('{{ re_replace .Keywords "\\bS\\d+E(\\d+)\\b" "ep$1" }}', vars)).toBe('Star Lantern ep02');
  });

  test('a modifier encodes every expanded value', () => {
    expect(applyTemplate('/s/{{ .Keywords }}/', vars, encodeURIComponent)).toBe('/s/Star%20Lantern%20S01E02/');
  });

  test('an if on a non-variable condition is refused', () => {
    expect(() => applyTemplate('{{ if "x" }}a{{ else }}b{{ end }}', vars)).toThrow(/not implemented/);
  });
});

const context = (extra: Partial<FilterContext> = {}): FilterContext => ({ variables: vars, encoding: 'utf-8', now: Date.UTC(2026, 10, 20, 12), ...extra });

describe('applyFilters', () => {
  test.each([
    ['regexp returns group 1, or empty', 'Size: 1.5 GB', [{ name: 'regexp', args: 'Size: (.+)' }], '1.5 GB'],
    ['regexp without a match', 'abc', [{ name: 'regexp', args: '(\\d+)' }], ''],
    ['re_replace with $0', 'ep 7', [{ name: 're_replace', args: ['\\d+', '[$0]'] }], 'ep [7]'],
    ['replace with a templated value', 'a-b', [{ name: 'replace', args: ['-', '{{ .Config.sort }}'] }], 'adateb'],
    ['split on the first character, negative from the end', 'a/b/c', [{ name: 'split', args: ['/x', -1] }], 'c'],
    ['trim with a cutset', '--x--', [{ name: 'trim', args: '-' }], 'x'],
    [
      'prepend and append',
      'b',
      [
        { name: 'prepend', args: 'a' },
        { name: 'append', args: '{{ .Today.Year }}' },
      ],
      'ab2026',
    ],
    ['querystring', 'https://s.test/dl.php?id=42&x=1', [{ name: 'querystring', args: 'id' }], '42'],
    ['tolower and toupper', 'MiX', [{ name: 'tolower' }], 'mix'],
    ['urldecode and urlencode', 'a%20b', [{ name: 'urldecode' }, { name: 'urlencode' }], 'a+b'],
    ['htmldecode', 'Tom &amp; Jerry&#39;s', [{ name: 'htmldecode' }], "Tom & Jerry's"],
    ['base64decode (URL-safe)', 'aGk_', [{ name: 'base64decode' }], 'hi?'],
    ['diacritics replace', 'Pokémon Ša', [{ name: 'diacritics', args: 'replace' }], 'Pokemon Sa'],
    ['validate keeps the allowed tokens', 'German, english, French', [{ name: 'validate', args: 'english, french' }], 'english, french'],
    ['dateparse to RFC 1123', '2025-03-04 05:06 +00:00', [{ name: 'dateparse', args: 'yyyy-MM-dd HH:mm zzz' }], 'Tue, 04 Mar 2025 05:06:00 +0'],
    ['dateparse that fails leaves the value', 'garbage', [{ name: 'dateparse', args: 'yyyy' }], 'garbage'],
    ['timeago', '2 hours ago', [{ name: 'timeago' }], 'Fri, 20 Nov 2026 10:00:00 +0'],
    ['jsonjoinarray', '{"a":{"b":["x","y"]}}', [{ name: 'jsonjoinarray', args: ['$.a.b', '|'] }], 'x|y'],
    ['hexdump and strdump change nothing', 'v', [{ name: 'hexdump' }, { name: 'strdump' }], 'v'],
  ])('%s', (_name, value, filters, expected) => {
    expect(applyFilters(value, filters, context())).toBe(expected);
  });

  test('urlencode in a single-byte site encoding', () => {
    expect(applyFilters('Сезон', [{ name: 'urlencode' }], context({ encoding: 'windows-1251' }))).toBe('%D1%E5%E7%EE%ED');
  });
});
