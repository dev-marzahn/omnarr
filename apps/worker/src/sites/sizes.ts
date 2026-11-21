// Numbers and sizes as Cardigann definitions read them.
//
// Ported from Prowlarr's src/NzbDrone.Core/Parser/ParseUtil.cs at commit
// 46c468c443ff3ebb86fc99347d3a15885d41d1e1.
// Copyright (c) Team Prowlarr and contributors. Licensed under the GNU General
// Public License v3.0 (https://www.gnu.org/licenses/gpl-3.0.html).
// Modified: ported to TypeScript for omnarr.

/** ParseUtil's NormalizeNumber: digits, `.` and `,` kept; a decimal comma read as a point. */
function normalize(text: string, isInt: boolean): string {
  let value = Array.from(text)
    .filter((char) => /[\p{Nd}.,]/u.test(char))
    .join('')
    .trim();
  value = value.replace(/\p{Nd}/gu, (digit) => String(Number.parseInt(digit, 10) || digitValue(digit)));
  if (isInt) {
    if (value.includes(',') && value.includes('.')) return value;
    return value.length === 0 ? '0' : value.replace(/\./g, ',');
  }
  value = value.length === 0 ? '0' : value.replace(/,/g, '.');
  if ((value.match(/\./g) ?? []).length > 1) {
    const last = value.lastIndexOf('.');
    value = value.slice(0, last).replace(/\./g, '') + value.slice(last);
  }
  return value;
}

/** A non-ASCII decimal digit's value. */
function digitValue(digit: string): number {
  const code = digit.codePointAt(0)!;
  for (let zero = code; zero > code - 10; zero--) {
    if (!/\p{Nd}/u.test(String.fromCodePoint(zero - 1))) return code - zero;
  }
  return 0;
}

/** A double, with `,` as a decimal point; anything unreadable is 0. */
export function coerceDouble(text: string): number {
  const value = Number(normalize(text, false));
  return Number.isFinite(value) ? value : 0;
}

/** An integer, with `,` and `.` as thousands separators; anything unreadable is 0. */
export function coerceInt(text: string): number {
  const normalized = normalize(text, true);
  // Both separators: `,` groups, `.` is the decimal point (invariant culture).
  const value = normalized.includes('.') ? Math.trunc(Number(normalized.replace(/,/g, ''))) : Number(normalized.replace(/,/g, ''));
  return Number.isFinite(value) ? value : 0;
}

/** The first run of ASCII digits in `text` (ParseUtil's GetLongFromString), or undefined. */
export function longFromString(text: string | undefined): number | undefined {
  const digits = /[0-9]+/.exec(text ?? '')?.[0];
  return digits === undefined ? undefined : Number(digits);
}

/** GetBytes: the letters name the unit (KB, MB, GB, TB, with or without `i`, powers of 1024), the rest is the number. */
export function parseBytes(text: string): number {
  const unit = Array.from(text)
    .filter((char) => /\p{L}/u.test(char))
    .join('')
    .replace(/i/g, '')
    .toLowerCase();
  const value = coerceDouble(text);
  const power = unit.includes('kb') ? 1 : unit.includes('mb') ? 2 : unit.includes('gb') ? 3 : unit.includes('tb') ? 4 : 0;
  return Math.trunc(value * 1024 ** power);
}
