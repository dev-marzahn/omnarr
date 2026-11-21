// .NET regexes under JavaScript. A definition's patterns are
// .NET's: `\d`, `\w` and `\b` are Unicode-aware, `\p{IsCyrillic}` names a
// block, identity escapes such as `\-` and `\_` are literals, and `$0` is the
// whole match. Each pattern is translated once, when the definition is
// loaded, and compiled with the `u` flag. What can't be translated is
// unsupported, never run with another meaning.

export type RegexUnsupported = 'inlineOption' | 'atomicGroup' | 'conditional' | 'balancingGroup' | 'unicodeBlock' | 'anchor' | 'classEscape' | 'compile';

export type Translated = { ok: true; source: string; flags: string } | { ok: false; reason: RegexUnsupported; detail: string };

/** .NET's `\w`: letters, non-spacing marks, decimal digits and connector punctuation. */
const WORD = '\\p{L}\\p{Mn}\\p{Nd}\\p{Pc}';
const WORD_CLASS = `[${WORD}]`;
const NOT_WORD_CLASS = `[^${WORD}]`;
const BOUNDARY = `(?:(?<=${WORD_CLASS})(?!${WORD_CLASS})|(?<!${WORD_CLASS})(?=${WORD_CLASS}))`;
const NOT_BOUNDARY = `(?:(?<=${WORD_CLASS})(?=${WORD_CLASS})|(?<!${WORD_CLASS})(?!${WORD_CLASS}))`;

/** .NET named blocks the definitions use, as the script that fills them. */
const BLOCKS: Record<string, string> = {
  IsCyrillic: 'Script=Cyrillic',
  IsCyrillicSupplement: 'Script=Cyrillic',
  IsGreek: 'Script=Greek',
  IsGreekandCoptic: 'Script=Greek',
  IsArabic: 'Script=Arabic',
  IsHebrew: 'Script=Hebrew',
  IsThai: 'Script=Thai',
  IsArmenian: 'Script=Armenian',
  IsGeorgian: 'Script=Georgian',
  IsHiragana: 'Script=Hiragana',
  IsKatakana: 'Script=Katakana',
  IsHangulSyllables: 'Script=Hangul',
  IsHangulJamo: 'Script=Hangul',
  IsCJKUnifiedIdeographs: 'Script=Han',
  IsDevanagari: 'Script=Devanagari',
};

/** Characters a `u`-mode pattern may escape outside a class. */
const SYNTAX = new Set('^$\\.*+?()[]{}|/');
/** Letter escapes that mean the same in both dialects. */
const SAME_LETTERS = new Set('tnrfvsSkpPcxu0123456789');

const fail = (reason: RegexUnsupported, detail: string): Translated => ({ ok: false, reason, detail });

/** A `{` that starts a quantifier: `{n}`, `{n,}` or `{n,m}`. */
const QUANTIFIER = /^\{\d+(,\d*)?\}/;

export function translateRegex(pattern: string): Translated {
  let rest = pattern;
  let flags = '';
  // Leading inline options, as many groups as there are.
  for (let lead = /^\(\?([imsx]+)\)/.exec(rest); lead; lead = /^\(\?([imsx]+)\)/.exec(rest)) {
    if (lead[1]!.includes('x')) return fail('inlineOption', `(?${lead[1]}) at the start`);
    for (const flag of lead[1]!) if (!flags.includes(flag)) flags += flag;
    rest = rest.slice(lead[0].length);
  }
  let out = '';
  let inClass = false;
  // Where the open class's body starts in `out`, whether it is negated, and whether it held `\W`.
  let classStart = 0;
  let classNegated = false;
  let classNotWord = false;
  /**
   * A class with `\W` can't hold the negated union under `u`, so it becomes
   * an alternation: `[A\W]` → `(?:[A]|[^w])`, and `[^A\W]` (a word character
   * not in A) → `(?:(?![A])[w])`.
   */
  const closeClass = () => {
    if (!classNotWord) return;
    const body = out.slice(classStart);
    out = out.slice(0, classStart - (classNegated ? 2 : 1));
    if (classNegated) out += body ? `(?:(?![${body}])${WORD_CLASS})` : WORD_CLASS;
    else out += body ? `(?:[${body}]|${NOT_WORD_CLASS})` : NOT_WORD_CLASS;
  };
  for (let i = 0; i < rest.length; i++) {
    const char = rest[i]!;
    const at = `at ${i + pattern.length - rest.length}`;
    if (char === '\\') {
      const next = rest[i + 1];
      if (next === undefined) return fail('compile', `a trailing backslash ${at}`);
      i++;
      if (next === 'd') out += '\\p{Nd}';
      else if (next === 'D') out += inClass ? '\\P{Nd}' : '\\P{Nd}';
      else if (next === 'w') out += inClass ? WORD : WORD_CLASS;
      else if (next === 'W') {
        if (inClass) classNotWord = true;
        else out += NOT_WORD_CLASS;
      } else if (next === 'b') out += inClass ? '\\x08' : BOUNDARY;
      else if (next === 'B') {
        if (inClass) return fail('classEscape', `\\B inside a character class ${at}`);
        out += NOT_BOUNDARY;
      } else if (next === 'p' || next === 'P') {
        const name = /^\{([^}]*)\}/.exec(rest.slice(i + 1));
        if (!name) return fail('compile', `\\${next} without a name ${at}`);
        i += name[0].length;
        const block = name[1]!.startsWith('Is') ? BLOCKS[name[1]!] : name[1];
        if (!block) return fail('unicodeBlock', `\\${next}{${name[1]}} ${at}`);
        out += `\\${next}{${block}}`;
      } else if (next === 'A') {
        if (inClass || flags.includes('m')) return fail('anchor', `\\A ${at}`);
        out += '^';
      } else if (next === 'z') {
        if (inClass || flags.includes('m')) return fail('anchor', `\\z ${at}`);
        out += '$';
      } else if (next === 'Z') {
        if (inClass || flags.includes('m')) return fail('anchor', `\\Z ${at}`);
        out += '(?=\\n?$)';
      } else if (next === 'G') return fail('anchor', `\\G ${at}`);
      else if (next === 'e') out += '\\x1B';
      else if (next === 'a') out += '\\x07';
      else if (SAME_LETTERS.has(next)) out += `\\${next}`;
      else if (/[A-Za-z]/.test(next)) return fail('compile', `the escape \\${next} ${at}`);
      else if (inClass) out += next === '-' || next === ']' || next === '\\' || next === '^' ? `\\${next}` : SYNTAX.has(next) ? `\\${next}` : next;
      else out += SYNTAX.has(next) ? `\\${next}` : next;
      continue;
    }
    if (inClass) {
      if (char === ']') {
        inClass = false;
        if (classNotWord) {
          closeClass();
          continue;
        }
      }
      out += char;
      continue;
    }
    if (char === '[') {
      inClass = true;
      classNotWord = false;
      out += char;
      classNegated = rest[i + 1] === '^';
      // A `]` right after `[` or `[^` is a literal in .NET.
      if (classNegated) {
        out += '^';
        i++;
      }
      classStart = out.length;
      if (rest[i + 1] === ']') {
        out += '\\]';
        i++;
      }
      continue;
    }
    if (char === '(' && rest[i + 1] === '?') {
      const group = rest.slice(i);
      if (group.startsWith('(?>')) return fail('atomicGroup', `(?> ${at}`);
      if (group.startsWith('(?(')) return fail('conditional', `(?( ${at}`);
      if (/^\(\?<[A-Za-z_]*-[A-Za-z_]+>/.test(group)) return fail('balancingGroup', `(?<…-…> ${at}`);
      if (group.startsWith('(?#')) {
        const end = rest.indexOf(')', i);
        if (end < 0) return fail('compile', `an unclosed comment ${at}`);
        i = end;
        continue;
      }
      const quoted = /^\(\?'([A-Za-z_]\w*)'/.exec(group);
      if (quoted) {
        out += `(?<${quoted[1]}>`;
        i += quoted[0].length - 1;
        continue;
      }
      if (/^\(\?[imsx-]+\)/.test(group)) return fail('inlineOption', `${/^\(\?[imsx-]+\)/.exec(group)![0]} ${at}`);
      if (/^\(\?[imsx-]+:/.test(group) && /x/.test(/^\(\?([imsx-]+):/.exec(group)![1]!)) return fail('inlineOption', `(?x: ${at}`);
    }
    if (char === '{' && !QUANTIFIER.test(rest.slice(i))) {
      out += '\\{';
      continue;
    }
    if (char === '}' && !/\{\d+(,\d*)?$/.test(out)) {
      out += '\\}';
      continue;
    }
    if (char === ']') {
      out += '\\]';
      continue;
    }
    out += char;
  }
  try {
    new RegExp(out, `${flags}u`);
  } catch (error) {
    return fail('compile', (error as Error).message);
  }
  return { ok: true, source: out, flags: `${flags}u` };
}

export type CompiledRegex = { ok: true; regex: RegExp } | { ok: false; reason: RegexUnsupported; detail: string };

const cache = new Map<string, CompiledRegex>();

/** The translated pattern, compiled; `g` added for replacing all matches. Cached by pattern. */
export function compileRegex(pattern: string, global = false): CompiledRegex {
  const key = `${global ? 'g' : ''}:${pattern}`;
  const hit = cache.get(key);
  if (hit) return hit;
  const translated = translateRegex(pattern);
  const compiled: CompiledRegex = translated.ok ? { ok: true, regex: new RegExp(translated.source, translated.flags + (global ? 'g' : '')) } : translated;
  if (cache.size > 5_000) cache.clear();
  cache.set(key, compiled);
  return compiled;
}

/** A .NET replacement string for `String.prototype.replace`: `$0` → `$&`, `${name}` → `$<name>`, `${1}` → `$1`. */
export function translateReplacement(replacement: string): string {
  return replacement.replace(/\$(\$|0(?!\d)|\{(\w+)\})/g, (whole, token: string, name: string | undefined) => {
    if (token === '$') return '$$';
    if (token === '0') return '$&';
    if (name !== undefined) return /^\d+$/.test(name) ? `$${name}` : `$<${name}>`;
    return whole;
  });
}
