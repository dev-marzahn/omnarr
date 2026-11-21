// Dates as Cardigann definitions read them: `dateparse` and
// `timeparse` with .NET custom format strings (or Go layouts, which Prowlarr
// converts), `timeago` and `reltime`, `fuzzytime`, and FromUnknown for `date`
// fields. Month and day names are the invariant culture's (English), as
// Prowlarr parses them. A time without an offset is UTC. Every date is epoch
// milliseconds; between filters it travels as RFC 1123 text, as in Prowlarr.
//
// Ported from Prowlarr's src/NzbDrone.Core/Parser/DateTimeUtil.cs at commit
// 46c468c443ff3ebb86fc99347d3a15885d41d1e1.
// Copyright (c) Team Prowlarr and contributors. Licensed under the GNU General
// Public License v3.0 (https://www.gnu.org/licenses/gpl-3.0.html).
// Modified: ported to TypeScript for omnarr; DateTime.ParseExact is
// re-implemented for the specifiers below, and DateTimeRoutines' fuzzy parser
// is replaced by a smaller reader of the common numeric and English forms.
import { coerceDouble } from './sizes.ts';

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const DAYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
const SHORT_MONTHS = MONTHS.map((name) => name.slice(0, 3));
const SHORT_DAYS = DAYS.map((name) => name.slice(0, 3));

const cap = (name: string) => name[0]!.toUpperCase() + name.slice(1);

/** Prowlarr's Rfc1123ZPattern, `ddd, dd MMM yyyy HH':'mm':'ss z`, in UTC. */
export function formatRfc1123(ms: number): string {
  const date = new Date(ms);
  const two = (n: number) => String(n).padStart(2, '0');
  return `${cap(SHORT_DAYS[date.getUTCDay()]!)}, ${two(date.getUTCDate())} ${cap(SHORT_MONTHS[date.getUTCMonth()]!)} ${date.getUTCFullYear()} ${two(date.getUTCHours())}:${two(date.getUTCMinutes())}:${two(date.getUTCSeconds())} +0`;
}

type Token = { kind: 'literal'; text: string } | { kind: 'field'; spec: string };

/** The .NET custom format specifiers this parser knows; anything else is a literal or `dateLayout`. */
const SPECIFIERS = /^(d{1,4}|M{1,4}|y{1,5}|h{1,2}|H{1,2}|m{1,2}|s{1,2}|f{1,7}|F{1,7}|t{1,2}|z{1,3}|K|g{1,2})/;

/** A layout's tokens, or the specifier the parser can't read. */
export function tokenizeLayout(layout: string): { ok: true; tokens: Token[] } | { ok: false; detail: string } {
  const tokens: Token[] = [];
  const literal = (text: string) => {
    const last = tokens.at(-1);
    if (last?.kind === 'literal') last.text += text;
    else tokens.push({ kind: 'literal', text });
  };
  for (let i = 0; i < layout.length;) {
    const char = layout[i]!;
    if (char === "'" || char === '"') {
      const end = layout.indexOf(char, i + 1);
      if (end < 0) return { ok: false, detail: `an unclosed quote in "${layout}"` };
      literal(layout.slice(i + 1, end));
      i = end + 1;
      continue;
    }
    if (char === '\\') {
      literal(layout[i + 1] ?? '');
      i += 2;
      continue;
    }
    if (char === '%') {
      i++;
      continue;
    }
    const spec = SPECIFIERS.exec(layout.slice(i))?.[0];
    if (spec) {
      if (spec.startsWith('g') || spec === 'K' || spec.startsWith('F')) return { ok: false, detail: `the specifier "${spec}" in "${layout}"` };
      tokens.push({ kind: 'field', spec });
      i += spec.length;
      continue;
    }
    literal(char === '/' ? '/' : char === ':' ? ':' : char);
    i++;
  }
  return { ok: true, tokens };
}

/** Prowlarr's Go-layout conversion, in its order, for a layout with none of `y`, `h`, `d`. */
function fromGoLayout(layout: string): string {
  const steps: [string, string][] = [
    ['2006', 'yyyy'],
    ['06', 'yy'],
    ['January', 'MMMM'],
    ['Jan', 'MMM'],
    ['01', 'MM'],
    ['Monday', 'dddd'],
    ['Mon', 'ddd'],
    ['02', 'dd'],
    ['2', 'd'],
    ['05', 'ss'],
    ['15', 'HH'],
    ['03', 'hh'],
    ['3', 'h'],
    ['04', 'mm'],
    ['4', 'm'],
    ['5', 's'],
    ['1', 'M'],
    ['.0000', 'ffff'],
    ['.000', 'fff'],
    ['.00', 'ff'],
    ['.0', 'f'],
    ['PM', 'tt'],
    ['pm', 'tt'],
    ['Z07:00', "'Z'zzz"],
    ['Z07', "'Z'zz"],
    ['-07:00', 'zzz'],
    ['-07', 'zz'],
  ];
  return steps.reduce((format, [from, to]) => format.split(from).join(to), layout);
}

/** The layout a `dateparse` argument is parsed with: .NET's when it has `y`, `h` or `d`, else the Go conversion. */
export const dotNetLayout = (layout: string) => (/[yhd]/i.test(layout) ? layout : fromGoLayout(layout));

function readName(rest: string, names: string[]): { index: number; length: number } | undefined {
  const lower = rest.toLowerCase();
  let best: { index: number; length: number } | undefined;
  names.forEach((name, index) => {
    if (lower.startsWith(name) && (!best || name.length > best.length)) best = { index, length: name.length };
  });
  return best;
}

/**
 * DateTime.ParseExact with the invariant culture and no styles: the value
 * must fit the layout exactly. Undefined when it doesn't, or when a day name
 * contradicts the date, as .NET refuses it.
 */
export function parseLayout(value: string, layout: string): number | undefined {
  const tokenized = tokenizeLayout(dotNetLayout(layout));
  if (!tokenized.ok) return undefined;
  const text = value.trim();
  let i = 0;
  let year: number | undefined;
  let month = 1;
  let day = 1;
  let hour = 0;
  let minute = 0;
  let second = 0;
  let millis = 0;
  let pm: boolean | undefined;
  let twelveHour = false;
  let offsetMin: number | undefined;
  let weekday: number | undefined;
  const digits = (min: number, max: number) => {
    const match = new RegExp(`^\\d{${min},${max}}`).exec(text.slice(i));
    if (!match) return undefined;
    i += match[0].length;
    return Number(match[0]);
  };
  for (const token of tokenized.tokens) {
    if (token.kind === 'literal') {
      if (!text.startsWith(token.text, i)) return undefined;
      i += token.text.length;
      continue;
    }
    const { spec } = token;
    const c = spec[0]!;
    const n = spec.length;
    let read: number | undefined;
    if (c === 'd' && n >= 3) {
      const name = readName(text.slice(i), n === 3 ? SHORT_DAYS : DAYS);
      if (!name) return undefined;
      weekday = name.index;
      i += name.length;
      continue;
    }
    if (c === 'M' && n >= 3) {
      const name = readName(text.slice(i), n === 3 ? SHORT_MONTHS : MONTHS);
      if (!name) return undefined;
      month = name.index + 1;
      i += name.length;
      continue;
    }
    if (c === 't') {
      const match = /^(AM|PM|A|P)/i.exec(text.slice(i));
      if (!match) return undefined;
      pm = match[0][0]!.toUpperCase() === 'P';
      i += n === 1 ? 1 : match[0].length;
      continue;
    }
    if (c === 'z') {
      const match = (n === 3 ? /^([+-])(\d{1,2}):(\d{2})/ : /^([+-])(\d{1,2})/).exec(text.slice(i));
      if (!match) return undefined;
      offsetMin = (match[1] === '-' ? -1 : 1) * (Number(match[2]) * 60 + Number(match[3] ?? 0));
      i += match[0].length;
      continue;
    }
    if (c === 'f') {
      read = digits(n, n);
      if (read === undefined) return undefined;
      millis = Math.round((read / 10 ** n) * 1000);
      continue;
    }
    if (c === 'y') {
      read = n === 1 ? digits(1, 2) : n === 2 ? digits(2, 2) : digits(n, Math.max(n, 4));
      if (read === undefined) return undefined;
      year = n <= 2 ? (read <= 49 ? 2000 + read : 1900 + read) : read;
      continue;
    }
    read = n === 1 ? digits(1, 2) : digits(2, 2);
    if (read === undefined) return undefined;
    if (c === 'd') day = read;
    else if (c === 'M') month = read;
    else if (c === 'H') hour = read;
    else if (c === 'h') {
      hour = read;
      twelveHour = true;
    } else if (c === 'm') minute = read;
    else if (c === 's') second = read;
  }
  if (i !== text.length) return undefined;
  if (twelveHour) {
    if (hour < 1 || hour > 12) return undefined;
    hour %= 12;
  }
  if (pm) hour += hour < 12 ? 12 : 0;
  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) return undefined;
  const y = year ?? new Date().getUTCFullYear();
  const ms = Date.UTC(y, month - 1, day, hour, minute, second, millis) - (offsetMin ?? 0) * 60_000;
  const check = new Date(Date.UTC(y, month - 1, day));
  if (check.getUTCDate() !== day) return undefined;
  if (weekday !== undefined && check.getUTCDay() !== weekday) return undefined;
  return ms;
}

/** "2 hours 1 day ago" (FromTimeAgo): every number and unit summed; undefined on an unknown unit. */
export function fromTimeAgo(text: string, now: number): number | undefined {
  let str = text.toLowerCase();
  if (str.includes('now')) return now;
  str = str.replace(/,/g, '').replace(/ago/g, '').replace(/and/g, '');
  let ago = 0;
  for (const match of str.matchAll(/\s*?([\d.]+)\s*?([^\d\s.]+)\s*?/g)) {
    const value = coerceDouble(match[1]!);
    const unit = match[2]!;
    const seconds =
      unit.includes('sec') || unit === 's'
        ? 1
        : unit.includes('min') || unit === 'm'
          ? 60
          : unit.includes('hour') || unit.includes('hr') || unit === 'h'
            ? 3600
            : unit.includes('day') || unit === 'd'
              ? 86_400
              : unit.includes('week') || unit.includes('wk') || unit === 'w'
                ? 7 * 86_400
                : unit.includes('month') || unit === 'mo'
                  ? 30 * 86_400
                  : unit.includes('year') || unit === 'y'
                    ? 365 * 86_400
                    : undefined;
    if (seconds === undefined) return undefined;
    ago += value * seconds * 1000;
  }
  return Math.round(now - ago);
}

/** DateTime.Parse(time).TimeOfDay for "14:22", "2:30 pm" and "14:22:05": ms since midnight. */
function timeOfDay(text: string): number | undefined {
  const trimmed = text.trim();
  if (!trimmed) return 0;
  const match = /^(\d{1,2})(?::(\d{2}))?(?::(\d{2})(?:[.,](\d{1,7}))?)?\s*(am|pm|a\.m\.|p\.m\.)?$/i.exec(trimmed);
  if (!match || (match[2] === undefined && match[5] === undefined)) return undefined;
  let hour = Number(match[1]);
  if (match[5]) hour = (hour % 12) + (match[5][0]!.toLowerCase() === 'p' ? 12 : 0);
  const fraction = match[4] ? Math.round(Number(`0.${match[4]}`) * 1000) : 0;
  return ((hour * 60 + Number(match[2] ?? 0)) * 60 + Number(match[3] ?? 0)) * 1000 + fraction;
}

const startOfDay = (ms: number) => Math.floor(ms / 86_400_000) * 86_400_000;

/** A fuzzy date (stand-in for DateTimeRoutines, US order): the numeric and English forms sites use. */
export function fromFuzzy(text: string): number | undefined {
  const str = text.trim().replace(/\s+/g, ' ');
  const time = (rest: string | undefined) => (rest === undefined ? 0 : timeOfDay(rest.replace(/^[\sT,-]+/, '')));
  const offset = (rest: string | undefined): { rest: string | undefined; minutes: number } => {
    const match = /\s*(Z|UTC|GMT|[+-]\d{2}:?\d{2})$/i.exec(rest ?? '');
    if (!match) return { rest, minutes: 0 };
    const zone = match[1]!.toUpperCase();
    const minutes = /^[+-]/.test(zone) ? (zone[0] === '-' ? -1 : 1) * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(-2))) : 0;
    return { rest: rest!.slice(0, -match[0].length), minutes };
  };
  const build = (y: number, m: number, d: number, rest: string | undefined) => {
    const zone = offset(rest);
    const t = time(zone.rest);
    if (t === undefined || m < 1 || m > 12 || d < 1 || d > 31) return undefined;
    return Date.UTC(y < 100 ? (y <= 49 ? 2000 + y : 1900 + y) : y, m - 1, d) + t - zone.minutes * 60_000;
  };
  let match = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})(.*)$/.exec(str);
  if (match) return build(Number(match[1]), Number(match[2]), Number(match[3]), match[4]);
  match = /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})(.*)$/.exec(str);
  if (match) return build(Number(match[3]), Number(match[2]), Number(match[1]), match[4]);
  match = /^(\d{1,2})[/-](\d{1,2})[/-](\d{2,4})(.*)$/.exec(str);
  if (match) return build(Number(match[3]), Number(match[1]), Number(match[2]), match[4]);
  const monthOf = (name: string) => SHORT_MONTHS.indexOf(name.slice(0, 3).toLowerCase()) + 1;
  match = /^(?:[A-Za-z]+,? )?(\d{1,2})(?:st|nd|rd|th)? ([A-Za-z]{3,})\.?,? (\d{2,4})(.*)$/.exec(str);
  if (match && monthOf(match[2]!)) return build(Number(match[3]), monthOf(match[2]!), Number(match[1]), match[4]);
  match = /^(?:[A-Za-z]+,? )?([A-Za-z]{3,})\.? (\d{1,2})(?:st|nd|rd|th)?,? (\d{4})(.*)$/.exec(str);
  if (match && monthOf(match[1]!)) return build(Number(match[3]), monthOf(match[1]!), Number(match[2]), match[4]);
  return undefined;
}

/**
 * FromUnknown: RFC 1123 text, a Unix time, "now", "… ago", "today",
 * "yesterday", "tomorrow", "<weekday> at …", a date without its year, then
 * the fuzzy reader. Undefined when nothing reads it.
 */
export function fromUnknown(text: string, now: number): number | undefined {
  let str = text.trim();
  const rfc = /^[A-Za-z]{3}, (\d{2}) ([A-Za-z]{3}) (\d{4}) (\d{2}):(\d{2}):(\d{2}) ([+-]\d{1,2})$/.exec(str);
  if (rfc) {
    const month = SHORT_MONTHS.indexOf(rfc[2]!.toLowerCase());
    if (month >= 0) return Date.UTC(Number(rfc[3]), month, Number(rfc[1]), Number(rfc[4]), Number(rfc[5]), Number(rfc[6])) - Number(rfc[7]) * 3_600_000;
  }
  if (/^\d+$/.test(str)) return Number(str) * 1000;
  if (str.toLowerCase().includes('now')) return now;
  if (/\bago/i.test(str)) return fromTimeAgo(str, now);
  for (const [word, days] of [
    ['today', 0],
    ['yesterday', -1],
    ['tomorrow', 1],
  ] as const) {
    const match = new RegExp(`\\b${word}(?:[\\s,]+(?:at)?\\s*|[\\s,]*|$)`, 'i').exec(str);
    if (match) {
      const t = timeOfDay(str.replace(match[0], ''));
      return t === undefined ? undefined : startOfDay(now) + days * 86_400_000 + t;
    }
  }
  const weekday = /\b(monday|tuesday|wednesday|thursday|friday|saturday|sunday)\s+at\s+/i.exec(str);
  if (weekday) {
    const t = timeOfDay(str.replace(weekday[0], ''));
    if (t === undefined) return undefined;
    let day = startOfDay(now);
    const want = DAYS.indexOf(weekday[1]!.toLowerCase());
    while (new Date(day).getUTCDay() !== want) day -= 86_400_000;
    return day + t;
  }
  const year = new Date(now).getUTCFullYear();
  const missing = /^(\d{1,2}-\d{1,2})(\s|$)/.exec(str);
  if (missing) str = str.replace(missing[1]!, `${year}-${missing[1]}`);
  const missing2 = /^(\d{1,2}\s+[A-Za-z]{3})\s+(\d{1,2}:\d{1,2}.*)$/.exec(str);
  if (missing2) str = `${missing2[1]} ${year} ${missing2[2]}`;
  return fromFuzzy(str);
}
