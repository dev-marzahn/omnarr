// JSON selectors: the subset of Newtonsoft's SelectToken that
// definitions use (`$`, dotted names, `[n]`, `['name']`), and Prowlarr's
// `:has(key)`, `:not(key)` and `:contains(text)` row suffixes.
//
// The suffix rules are ported from Prowlarr's
// src/NzbDrone.Core/Indexers/Definitions/Cardigann/CardigannBase.cs
// (JsonParseRowsSelector, JsonParseFieldSelector) at commit
// 46c468c443ff3ebb86fc99347d3a15885d41d1e1.
// Copyright (c) Team Prowlarr and contributors. Licensed under the GNU General
// Public License v3.0 (https://www.gnu.org/licenses/gpl-3.0.html).
// Modified: ported to TypeScript for omnarr.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };

type Step = { key: string } | { index: number };

/** A path's steps, or undefined when it uses syntax outside the subset. */
export function parsePath(path: string): Step[] | undefined {
  const steps: Step[] = [];
  let rest = path.trim();
  if (rest.startsWith('$')) rest = rest.slice(1);
  while (rest.length) {
    let match: RegExpExecArray | null;
    if ((match = /^\.?([^.[\]:'"]+)/.exec(rest))) steps.push({ key: match[1]! });
    else if ((match = /^\[(\d+)\]/.exec(rest))) steps.push({ index: Number(match[1]) });
    else if ((match = /^\[['"]([^'"]*)['"]\]/.exec(rest))) steps.push({ key: match[1]! });
    else if ((match = /^\./.exec(rest)) && rest.length === 1) break;
    else return undefined;
    rest = rest.slice(match[0].length);
  }
  return steps;
}

/** SelectToken: the value at `path`, or undefined when a step is missing. */
export function selectToken(value: Json | undefined, path: string): Json | undefined {
  const steps = parsePath(path);
  if (!steps) return undefined;
  let current: Json | undefined = value;
  for (const step of steps) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined;
    if ('index' in step) current = Array.isArray(current) ? current[step.index] : undefined;
    else current = Array.isArray(current) ? undefined : current[step.key];
  }
  return current;
}

const SUFFIX = /:(?<filter>.+?)\((?<key>.+?)\)(?=:|$)/g;

/** JsonParseFieldSelector: the path part of `selector` when the token passes its suffixes, else undefined. */
export function fieldSelector(value: Json | undefined, selector: string): string | undefined {
  const path = selector.split(':')[0]!;
  let object: Json | undefined;
  if (!path.trim()) object = value;
  else {
    object = selectToken(value, path);
    if (object === undefined) return undefined;
  }
  for (const match of selector.matchAll(SUFFIX)) {
    const { filter, key } = match.groups as { filter: string; key: string };
    const nested = new RegExp(SUFFIX.source).test(key);
    if (filter === 'has') {
      if (nested ? fieldSelector(object, key) === undefined : selectToken(object, key) === undefined) return undefined;
    } else if (filter === 'not') {
      if (nested ? fieldSelector(object, key) !== undefined : selectToken(object, key) !== undefined) return undefined;
    } else if (filter === 'contains') {
      if (!JSON.stringify(object).includes(key)) return undefined;
    }
  }
  return path;
}

/** JsonParseRowsSelector: the array at the path, keeping the rows that pass the suffixes; undefined when it isn't an array. */
export function rowsOf(value: Json, selector: string): Json[] | undefined {
  const path = selector.split(':')[0]!;
  const rows = path.trim() ? selectToken(value, path) : value;
  if (!Array.isArray(rows)) return undefined;
  const suffix = selector.slice(path.length);
  return rows.filter((row) => fieldSelector(row, suffix) !== undefined);
}

/** A selected token as Prowlarr reads it: an array comma-joined, scalars as text, null as undefined. */
export function tokenText(value: Json | undefined): string | undefined {
  if (value === undefined || value === null) return undefined;
  if (Array.isArray(value)) return value.map((item) => (typeof item === 'object' && item !== null ? JSON.stringify(item) : String(item))).join(',');
  if (typeof value === 'object') return JSON.stringify(value);
  if (typeof value === 'boolean') return value ? 'True' : 'False';
  return String(value);
}
