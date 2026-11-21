// The regex translation: a definition's .NET pattern runs with
// .NET's meaning under JavaScript, or the definition is unsupported. The
// patterns here are written for these tests, not taken from definitions.
import { describe, expect, test } from 'vite-plus/test';

import { compileRegex, translateRegex, translateReplacement } from '../../src/sites/regex.ts';

const run = (pattern: string) => {
  const compiled = compileRegex(pattern);
  if (!compiled.ok) throw new Error(`unsupported: ${compiled.detail}`);
  return compiled.regex;
};

describe('translateRegex', () => {
  test('a leading (?i), (?s) or (?m) becomes a flag', () => {
    expect(run('(?i)season').test('SEASON 2')).toBe(true);
    expect(run('(?s)a.b').test('a\nb')).toBe(true);
    expect(run('(?im)^b').test('a\nB')).toBe(true);
  });

  test('a mid-pattern (?i) is unsupported', () => {
    expect(translateRegex('abc(?i)def')).toMatchObject({ ok: false, reason: 'inlineOption' });
  });

  test('\\d matches Arabic-Indic and full-width digits, as .NET does', () => {
    expect(run('^\\d+$').test('٣٤')).toBe(true);
    expect(run('^\\d+$').test('１２')).toBe(true);
    expect(run('^\\D$').test('٣')).toBe(false);
  });

  test('\\w and \\b see Cyrillic and CJK letters as word characters', () => {
    expect(run('^\\w+$').test('Сезон')).toBe(true);
    expect(run('\\bСезон\\b').test('Новый Сезон 2')).toBe(true);
    expect(run('\\bезон').test('Сезон')).toBe(false);
    expect(run('^\\W+$').test('Пр')).toBe(false);
    expect(run('[\\w.]+').exec('進撃の巨人.mkv')?.[0]).toBe('進撃の巨人.mkv');
  });

  test('\\W inside a class keeps its meaning, negated or not', () => {
    expect(run('[\\p{IsCyrillic}\\W]+').exec('Lantern Мир (2024)')?.[0]).toBe(' Мир (');
    expect(run('^[^\\W\\d]+').exec('Сезон2')?.[0]).toBe('Сезон');
    expect(run('^[^\\W]+$').test('a b')).toBe(false);
  });

  test('\\p{IsCyrillic} becomes the Cyrillic script; an unknown block is unsupported', () => {
    expect(run('\\p{IsCyrillic}+').exec('abc Мир')?.[0]).toBe('Мир');
    expect(run('[^\\P{IsGreek}]').test('λ')).toBe(true);
    expect(translateRegex('\\p{IsKlingon}')).toMatchObject({ ok: false, reason: 'unicodeBlock' });
  });

  test('identity escapes .NET reads as literals compile under the u flag', () => {
    expect(run('a\\-b\\_c\\ d\\#e\\\'f\\"g').test('a-b_c d#e\'f"g')).toBe(true);
    expect(run('[\\w\\-\\_]+').exec('ab-c_d!')?.[0]).toBe('ab-c_d');
  });

  test('a brace that is no quantifier is a literal', () => {
    expect(run('{(\\d+)}').exec('x{12}')?.[1]).toBe('12');
    expect(run('a{2}').test('aa')).toBe(true);
    expect(run('a{,2}').test('a{,2}')).toBe(true);
  });

  test("(?'name') groups and (?#comments) translate; atomic, conditional and balancing groups are unsupported", () => {
    expect(run("(?'year'\\d{4})(?#the year)").exec('in 2024')?.groups?.year).toBe('2024');
    expect(translateRegex('(?>abc)')).toMatchObject({ ok: false, reason: 'atomicGroup' });
    expect(translateRegex('(?(x)a|b)')).toMatchObject({ ok: false, reason: 'conditional' });
    expect(translateRegex('(?<a-b>x)')).toMatchObject({ ok: false, reason: 'balancingGroup' });
  });

  test('\\A and \\z anchor the input', () => {
    expect(run('\\Aab\\z').test('ab')).toBe(true);
    expect(run('\\Aab\\z').test('xab')).toBe(false);
  });

  test('a pattern that still does not compile is unsupported, with the error', () => {
    expect(translateRegex('(abc')).toMatchObject({ ok: false, reason: 'compile' });
  });
});

describe('translateReplacement', () => {
  test('$0 is the whole match, ${name} a named group, $n stays', () => {
    const regex = run("(?'n'\\d+)");
    expect('ep 7'.replace(regex, translateReplacement('[$0]'))).toBe('ep [7]');
    expect('ep 7'.replace(regex, translateReplacement('<${n}>'))).toBe('ep <7>');
    expect('ep 7'.replace(regex, translateReplacement('($1)'))).toBe('ep (7)');
    expect('ep 7'.replace(regex, translateReplacement('$$'))).toBe('ep $');
  });
});
