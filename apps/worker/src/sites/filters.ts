// Cardigann filters: every filter of Prowlarr's ApplyFilters, with
// `hexdump` and `strdump` (debug output) doing nothing. A filter name outside
// FILTERS makes the definition unsupported at load (check.ts); here it is
// skipped, as Prowlarr skips it.
//
// Ported from Prowlarr's
// src/NzbDrone.Core/Indexers/Definitions/Cardigann/CardigannBase.cs
// (ApplyFilters) at commit 46c468c443ff3ebb86fc99347d3a15885d41d1e1.
// Copyright (c) Team Prowlarr and contributors. Licensed under the GNU General
// Public License v3.0 (https://www.gnu.org/licenses/gpl-3.0.html).
// Modified: ported to TypeScript for omnarr; regexes are translated from .NET
// (regex.ts).
import { formatRfc1123, fromTimeAgo, fromUnknown, parseLayout } from './dates.ts';
import { yamlText } from './definition.ts';
import { urlDecode, urlEncode } from './encoding.ts';
import { type Json, selectToken } from './jsonPath.ts';
import { compileRegex, translateReplacement } from './regex.ts';
import { applyTemplate, type Variables } from './template.ts';

export type Filter = { name: string; args?: unknown };

export type FilterContext = { variables: Variables; encoding: string | undefined; now: number };

export const FILTERS = new Set([
  'querystring',
  'timeparse',
  'dateparse',
  'regexp',
  're_replace',
  'split',
  'replace',
  'trim',
  'prepend',
  'append',
  'tolower',
  'toupper',
  'base64decode',
  'base64encode',
  'urldecode',
  'urlencode',
  'htmldecode',
  'htmlencode',
  'timeago',
  'reltime',
  'fuzzytime',
  'validfilename',
  'diacritics',
  'jsonjoinarray',
  'hexdump',
  'strdump',
  'validate',
]);

/** `(string)filter.Args`: YAML scalars read as text. */
export const argText = (args: unknown): string | undefined =>
  args === undefined || args === null ? undefined : Array.isArray(args) ? argText(args[0]) : yamlText(args);
export const argAt = (args: unknown, index: number): string => {
  const value = Array.isArray(args) ? args[index] : index === 0 ? args : undefined;
  return value === undefined || value === null ? '' : String(value);
};

function regex(pattern: string, global = false): RegExp {
  const compiled = compileRegex(pattern, global);
  if (!compiled.ok) throw new Error(`regex ${compiled.reason}: ${compiled.detail}`);
  return compiled.regex;
}

const HTML_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
  nbsp: ' ',
  laquo: '«',
  raquo: '»',
  copy: '©',
  reg: '®',
  hellip: '…',
  ndash: '–',
  mdash: '—',
};

/** WebUtility.HtmlDecode for numeric references and the common named entities. */
export function htmlDecode(text: string): string {
  return text.replace(/&(#\d+|#x[0-9a-fA-F]+|[A-Za-z]+);/g, (whole, body: string) => {
    if (body.startsWith('#x') || body.startsWith('#X')) return String.fromCodePoint(Number.parseInt(body.slice(2), 16));
    if (body.startsWith('#')) return String.fromCodePoint(Number(body.slice(1)));
    return HTML_ENTITIES[body] ?? whole;
  });
}

/** WebUtility.HtmlEncode: `<>&"'` as entities, U+00A0–U+00FF as numeric references. */
export function htmlEncode(text: string): string {
  const named: Record<string, string> = { '<': '&lt;', '>': '&gt;', '&': '&amp;', '"': '&quot;', "'": '&#39;' };
  return Array.from(text, (char) => named[char] ?? (char.charCodeAt(0) >= 160 && char.charCodeAt(0) < 256 ? `&#${char.charCodeAt(0)};` : char)).join('');
}

const base64UrlDecode = (text: string) =>
  new TextDecoder().decode(
    Uint8Array.from(
      atob(
        text
          .replace(/-/g, '+')
          .replace(/_/g, '/')
          .padEnd(Math.ceil(text.length / 4) * 4, '='),
      ),
      (c) => c.charCodeAt(0),
    ),
  );
const base64UrlEncode = (text: string) =>
  btoa(String.fromCharCode(...new TextEncoder().encode(text)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

const VALIDATE_DELIMITERS = /[, /)(.;[\]"|:]+/;

export function applyFilters(data: string, filters: Filter[] | undefined, context: FilterContext): string {
  if (!filters) return data;
  let value = data;
  for (const filter of filters) {
    switch (filter.name) {
      case 'querystring': {
        const query = value.split('?', 2)[1];
        if (query === undefined) throw new Error('querystring: no query in the value');
        const params = new URLSearchParams(query.split('#')[0]);
        value = params.get(argText(filter.args) ?? '') ?? '';
        break;
      }
      case 'timeparse':
      case 'dateparse': {
        const parsed = parseLayout(value, argText(filter.args) ?? '');
        if (parsed !== undefined) value = formatRfc1123(parsed);
        break;
      }
      case 'regexp':
        value = regex(argText(filter.args) ?? '').exec(value)?.[1] ?? '';
        break;
      case 're_replace':
        value = value.replace(regex(argAt(filter.args, 0), true), translateReplacement(applyTemplate(argAt(filter.args, 1), context.variables)));
        break;
      case 'split': {
        const separator = argAt(filter.args, 0)[0] ?? '';
        const parts = value.split(separator);
        let position = Number.parseInt(argAt(filter.args, 1), 10);
        if (position < 0) position += parts.length;
        const part = parts[position];
        if (part === undefined) throw new Error('split: index out of range');
        value = part;
        break;
      }
      case 'replace':
        value = value.split(argAt(filter.args, 0)).join(applyTemplate(argAt(filter.args, 1), context.variables));
        break;
      case 'trim': {
        const cutset = argText(filter.args);
        if (cutset) {
          const char = cutset[0]!;
          while (value.startsWith(char)) value = value.slice(1);
          while (value.endsWith(char)) value = value.slice(0, -1);
        } else value = value.trim();
        break;
      }
      case 'prepend':
        value = applyTemplate(argText(filter.args) ?? '', context.variables) + value;
        break;
      case 'append':
        value += applyTemplate(argText(filter.args) ?? '', context.variables);
        break;
      case 'tolower':
        value = value.toLowerCase();
        break;
      case 'toupper':
        value = value.toUpperCase();
        break;
      case 'base64decode':
        value = base64UrlDecode(value);
        break;
      case 'base64encode':
        value = base64UrlEncode(value);
        break;
      case 'urldecode':
        value = urlDecode(value, context.encoding);
        break;
      case 'urlencode':
        value = urlEncode(value, context.encoding);
        break;
      case 'htmldecode':
        value = htmlDecode(value);
        break;
      case 'htmlencode':
        value = htmlEncode(value);
        break;
      case 'timeago':
      case 'reltime': {
        const parsed = fromTimeAgo(value, context.now);
        if (parsed === undefined) throw new Error('timeago: unknown unit');
        value = formatRfc1123(parsed);
        break;
      }
      case 'fuzzytime': {
        const parsed = fromUnknown(value, context.now);
        if (parsed === undefined) throw new Error('fuzzytime: unreadable date');
        value = formatRfc1123(parsed);
        break;
      }
      case 'validfilename':
        // Path.GetInvalidFileNameChars on Linux, where Prowlarr's image runs.
        value = value.replace(/[/\0]/g, '_');
        break;
      case 'diacritics':
        if (argText(filter.args) !== 'replace') throw new Error('unsupported diacritics filter argument');
        value = value
          .normalize('NFD')
          .replace(/\p{Mn}/gu, '')
          .normalize('NFC');
        break;
      case 'jsonjoinarray': {
        const parsed = JSON.parse(value) as Json;
        const selected = selectToken(parsed, argAt(filter.args, 0));
        const list = Array.isArray(selected) ? selected : [];
        value = list.map((item) => (typeof item === 'object' && item !== null ? JSON.stringify(item) : String(item))).join(argAt(filter.args, 1));
        break;
      }
      case 'validate': {
        const allowed = [
          ...new Set(
            (argText(filter.args) ?? '')
              .toLowerCase()
              .split(VALIDATE_DELIMITERS)
              .map((t) => t.trim())
              .filter(Boolean),
          ),
        ];
        const present = new Set(
          value
            .toLowerCase()
            .split(VALIDATE_DELIMITERS)
            .map((t) => t.trim())
            .filter(Boolean),
        );
        value = allowed.filter((token) => present.has(token)).join(', ');
        break;
      }
      case 'hexdump':
      case 'strdump':
      default:
        break;
    }
  }
  return value;
}
