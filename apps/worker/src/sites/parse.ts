// A search response's rows and fields, as IndexerItems: HTML and
// XML rows with cheerio, JSON rows with jsonPath.ts, the field rules of
// Prowlarr's ParseFields, `after`, `dateheaders`, `count`, `multiple`,
// `missingAttributeEqualsNoResults`, the `andmatch` row filter, and the
// mapping to IndexerItem. A JSON body that doesn't parse, or rows the selector can't find,
// is `unexpectedPage`.
//
// Ported from Prowlarr's
// src/NzbDrone.Core/Indexers/Definitions/Cardigann/CardigannParser.cs,
// CardigannBase.cs (HandleSelector, HandleJsonSelector) and IndexerBase.cs
// (FilterReleasesByQuery) at commit 46c468c443ff3ebb86fc99347d3a15885d41d1e1.
// Copyright (c) Team Prowlarr and contributors. Licensed under the GNU General
// Public License v3.0 (https://www.gnu.org/licenses/gpl-3.0.html).
// Modified: ported to TypeScript for omnarr, with a mapping to omnarr's IndexerItem.
import { type IndexerItem, normalizeInfoHash } from '@omnarr/contracts';
import type { Cheerio } from 'cheerio';
import type { AnyNode, Element } from 'domhandler';

import { categoryMappings, newznabFor, parentOf } from './categories.ts';
import { formatRfc1123, fromUnknown } from './dates.ts';
import { type Definition, type SearchPath, type SelectorBlock, yamlText } from './definition.ts';
import { applyFilters } from './filters.ts';
import { fieldSelector, type Json, rowsOf, selectToken, tokenText } from './jsonPath.ts';
import { compileRegex } from './regex.ts';
import { resolve } from './request.ts';
import { type Dom, parseDom, querySelector, selectAt } from './selectors.ts';
import { coerceDouble, coerceInt, longFromString, parseBytes } from './sizes.ts';
import { applyTemplate, type Variables } from './template.ts';

/** Fields that are optional whatever the file says (CardigannBase.OptionalFields). */
const OPTIONAL_FIELDS = new Set([
  'imdb',
  'imdbid',
  'tmdbid',
  'rageid',
  'tvdbid',
  'tvmazeid',
  'traktid',
  'doubanid',
  'poster',
  'banner',
  'description',
  'genre',
]);

/** A release as the fields build it (Prowlarr's TorrentInfo, the parts omnarr reads). */
export type Release = {
  title?: string;
  description?: string;
  downloadUrl?: string;
  magnetUrl?: string;
  infoHash?: string;
  details?: string;
  categories?: number[];
  size?: number;
  seeders?: number;
  peers?: number;
  publishedAt?: number;
  imdbid?: number;
  tmdbid?: number;
  tvdbid?: number;
  minimumRatio?: number;
  minimumSeedTime?: number;
  downloadVolumeFactor?: number;
};

export type ParseContext = { definition: Definition; path: SearchPath; requestUrl: string; variables: Variables; now: number };

export type Parsed = { ok: true; releases: Release[] } | { ok: false; detail: string };

class FieldMissing extends Error {}

const SCALE_MAX = 5_000_000;

/** ParseFields: one field's value into the release; returns what `.Result.<name>` holds. */
function parseField(value: string, name: string, modifiers: string[], release: Release, context: ParseContext): string | null {
  const { definition, requestUrl, now } = context;
  switch (name) {
    case 'download':
      if (!value) {
        release.downloadUrl = undefined;
        return null;
      }
      if (value.startsWith('magnet:')) {
        release.magnetUrl = value;
        return value;
      }
      release.downloadUrl = resolve(value, requestUrl);
      return release.downloadUrl;
    case 'magnet':
      release.magnetUrl = value;
      return value;
    case 'infohash':
      release.infoHash = value;
      return value;
    case 'details':
      release.details = resolve(value, requestUrl);
      return release.details;
    case 'comments':
      return resolve(value, requestUrl);
    case 'title':
      release.title = modifiers.includes('append') ? (release.title ?? '') + value : value;
      return release.title;
    case 'description':
      release.description = modifiers.includes('append') ? (release.description ?? '') + value : value;
      return release.description;
    case 'category':
    case 'categorydesc': {
      const mappings = categoryMappings(definition);
      const ids = value
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean)
        .flatMap((part) =>
          name === 'category'
            ? newznabFor(definition, part)
            : mappings
                .filter((mapping) => mapping.desc === part && mapping.newznab !== undefined)
                .flatMap((mapping) => [mapping.newznab!, parentOf(mapping.newznab!)]),
        );
      if (ids.length)
        release.categories = !release.categories || modifiers.includes('noappend') ? [...new Set(ids)] : [...new Set([...release.categories, ...ids])];
      return release.categories?.length ? release.categories.join(',') : value;
    }
    case 'size':
      release.size = parseBytes(value);
      return String(release.size);
    case 'leechers': {
      let leechers = coerceInt(value);
      if (leechers >= SCALE_MAX) leechers = 0;
      release.peers = (release.peers ?? 0) + leechers;
      return String(leechers);
    }
    case 'seeders': {
      let seeders = coerceInt(value);
      if (seeders >= SCALE_MAX) seeders = 0;
      release.seeders = seeders;
      release.peers = (release.peers ?? 0) + seeders;
      return String(seeders);
    }
    case 'date': {
      const date = fromUnknown(value, now);
      if (date === undefined) throw new Error(`unreadable date`);
      release.publishedAt = date;
      return formatRfc1123(date);
    }
    case 'downloadvolumefactor':
      release.downloadVolumeFactor = coerceDouble(value);
      return String(release.downloadVolumeFactor);
    case 'uploadvolumefactor':
      return String(coerceDouble(value));
    case 'minimumratio':
      release.minimumRatio = coerceDouble(value);
      return String(release.minimumRatio);
    case 'minimumseedtime':
      release.minimumSeedTime = coerceInt(value);
      return String(release.minimumSeedTime);
    case 'files':
    case 'grabs':
    case 'year':
      return String(coerceInt(value));
    case 'imdb':
    case 'imdbid':
      release.imdbid = longFromString(value) ?? 0;
      return String(release.imdbid);
    case 'tmdbid':
      release.tmdbid = longFromString(value) ?? 0;
      return String(release.tmdbid);
    case 'tvdbid':
      release.tvdbid = longFromString(value) ?? 0;
      return String(release.tvdbid);
    case 'rageid':
    case 'tvmazeid':
    case 'traktid':
    case 'doubanid':
      return String(longFromString(value) ?? 0);
    default:
      return value;
  }
}

const text = (value: unknown) => (value === undefined || value === null ? undefined : yamlText(value));

/** HandleSelector for HTML and XML: the block's value at `row`, or null when an optional part is missing. */
function htmlValue(block: SelectorBlock, dom: Dom, row: Cheerio<AnyNode>, context: ParseContext, required: boolean): string | null {
  const filterContext = { variables: context.variables, encoding: context.definition.encoding, now: context.now };
  if (block.text !== undefined && block.text !== null) return applyFilters(applyTemplate(text(block.text), context.variables), block.filters, filterContext);
  let selection: Cheerio<AnyNode> | undefined = row;
  if (block.selector !== undefined) {
    selection = selectAt(dom, row, applyTemplate(block.selector, context.variables));
    if (!selection) {
      if (required) throw new FieldMissing(`selector ${block.selector}`);
      return null;
    }
  }
  if (block.remove) selection.find(block.remove).remove();
  let value: string | undefined;
  if (block.case) {
    for (const [selector, result] of Object.entries(block.case)) {
      if (matches(selection, selector) || querySelector(dom, selection, selector)) {
        value = applyTemplate(text(result), context.variables);
        break;
      }
    }
    if (value === undefined) {
      if (required) throw new FieldMissing('case');
      return null;
    }
  } else if (block.attribute !== undefined) {
    const attribute = (selection as Cheerio<Element>).attr(block.attribute);
    if (attribute === undefined) {
      if (required) throw new FieldMissing(`attribute ${block.attribute}`);
      return null;
    }
    value = attribute;
  } else value = selection.text();
  return applyFilters(value.trim(), block.filters, filterContext);
}

const matches = (selection: Cheerio<AnyNode>, selector: string) => {
  try {
    return selection.is(selector);
  } catch {
    return false;
  }
};

/** HandleJsonSelector: the block's value in `parent`. */
function jsonValue(block: SelectorBlock, parent: Json | undefined, context: ParseContext, required: boolean): string | null {
  const filterContext = { variables: context.variables, encoding: context.definition.encoding, now: context.now };
  if (block.text !== undefined && block.text !== null) return applyFilters(applyTemplate(text(block.text), context.variables), block.filters, filterContext);
  let value: string | undefined;
  if (block.selector !== undefined) {
    const selector = applyTemplate(block.selector.replace(/^\.+/, ''), context.variables);
    const path = fieldSelector(parent, selector);
    const selection = path === undefined ? undefined : path === '' ? parent : selectToken(parent, path);
    if (selection === undefined) {
      if (required) throw new FieldMissing(`selector ${block.selector}`);
      return null;
    }
    value = tokenText(selection);
  }
  if (block.case) {
    let matched = false;
    for (const [key, result] of Object.entries(block.case)) {
      if ((value !== undefined && value === key) || key === '*') {
        value = applyTemplate(text(result), context.variables);
        matched = true;
        break;
      }
    }
    if (!matched) {
      if (required) throw new FieldMissing('case');
      return null;
    }
  }
  return value === undefined ? null : applyFilters(value.trim(), block.filters, filterContext);
}

/** One row's fields, in order; returns the release, or throws (JSON) when a required field fails. */
function parseRow(context: ParseContext, read: (block: SelectorBlock, required: boolean) => string | null, strict: boolean): Release {
  const release: Release = {};
  const { variables } = context;
  for (const [key, block] of context.definition.search.fields) {
    const [name, ...modifiers] = key.split('|') as [string, ...string[]];
    const variable = `.Result.${name}`;
    const optional = OPTIONAL_FIELDS.has(key) || modifiers.includes('optional') || block?.optional === true;
    try {
      let value = read(block ?? {}, !optional);
      if (optional && !value?.trim()) {
        const fallback = applyTemplate(text(block?.default), variables);
        if (!fallback.trim()) {
          variables[variable] = null;
          continue;
        }
        value = fallback;
      }
      variables[variable] = parseField(value ?? '', name, modifiers, release, context);
    } catch (error) {
      if (!(variable in variables) || optional) variables[variable] = null;
      if (optional) continue;
      if (strict) throw error;
    }
  }
  return release;
}

/** The `dateheaders` rule: the nearest earlier row (or its parent's earlier sibling) the selector matches. */
function dateHeader(dom: Dom, row: Cheerio<Element>, context: ParseContext): number | undefined {
  const block = context.definition.search.rows.dateheaders!;
  let previous = row.prev();
  if (!previous.length) previous = row.parent().prev();
  while (previous.length) {
    try {
      const value = htmlValue(block, dom, previous, context, true);
      if (value !== null) return fromUnknown(value, context.now);
    } catch {
      // not a header: keep looking
    }
    const current = previous;
    previous = current.prev();
    if (!previous.length) previous = current.parent().prev();
  }
  if (block.optional) return undefined;
  throw new Error('no date header row');
}

/** ParseResponse: the releases of one response body, before the andmatch filter and the item mapping. */
export function parseResponse(body: string, context: ParseContext): Parsed {
  const { definition, path } = context;
  const { search } = definition;
  const rowsBlock = search.rows;
  const filterContext = { variables: context.variables, encoding: definition.encoding, now: context.now };
  if (path.response?.type === 'json') {
    const message = path.response.noResultsMessage;
    if (message !== undefined && message !== null && ((String(message).trim() && body.includes(String(message))) || (!String(message).trim() && !body.trim())))
      return { ok: true, releases: [] };
    let parsed: Json;
    try {
      parsed = JSON.parse(body) as Json;
    } catch {
      return { ok: false, detail: 'the body is not JSON' };
    }
    if (rowsBlock.count) {
      try {
        const count = jsonValue(rowsBlock.count, parsed, context, true);
        if (count !== null && /^-?\d+$/.test(count.trim()) && Number(count) < 1) return { ok: true, releases: [] };
      } catch {
        // Prowlarr logs a count it can't read and goes on.
      }
    }
    const rows = rowsOf(parsed, applyTemplate(rowsBlock.selector ?? '', context.variables));
    if (!rows) return rowsBlock.missingAttributeEqualsNoResults ? { ok: true, releases: [] } : { ok: false, detail: 'the rows selector found nothing' };
    const releases: Release[] = [];
    try {
      for (const row of rows) {
        let selected: Json | undefined = row;
        if (rowsBlock.attribute !== undefined) {
          selected = selectToken(row, rowsBlock.attribute);
          if (selected === undefined && rowsBlock.missingAttributeEqualsNoResults) continue;
        }
        const items = rowsBlock.multiple
          ? Array.isArray(selected)
            ? selected
            : selected && typeof selected === 'object'
              ? Object.values(selected)
              : []
          : [selected];
        for (const item of items) {
          releases.push(
            parseRow(context, (block, required) => jsonValue(block, block.selector?.startsWith('..') ? row : (item ?? undefined), context, required), true),
          );
        }
      }
    } catch (error) {
      return { ok: false, detail: `a row's field failed: ${(error as Error).message}` };
    }
    return { ok: true, releases };
  }

  const xml = path.response?.type === 'xml';
  const source = search.preprocessingfilters ? applyFilters(body, search.preprocessingfilters, filterContext) : body;
  const dom = parseDom(source, xml);
  let rows: Cheerio<Element>[];
  try {
    rows = dom
      .$(applyTemplate(rowsBlock.selector ?? '', context.variables))
      .toArray()
      .map((element) => dom.$(element) as Cheerio<Element>);
  } catch (error) {
    return { ok: false, detail: `the rows selector: ${(error as Error).message}` };
  }
  const after = Number(rowsBlock.after ?? 0);
  if (after > 0) {
    for (let i = 0; i < rows.length; i++) {
      for (let j = 0; j < after; j++) {
        const merge = rows[i + j + 1];
        if (merge) rows[i]!.append(merge.contents());
      }
      rows.splice(i + 1, after);
    }
  }
  const releases: Release[] = [];
  for (const row of rows) {
    try {
      const release = parseRow(context, (block, required) => htmlValue(block, dom, row, context, required), false);
      if (release.publishedAt === undefined && rowsBlock.dateheaders) {
        const date = dateHeader(dom, row, context);
        if (date !== undefined) release.publishedAt = date;
      }
      releases.push(release);
    } catch {
      // Prowlarr logs a row that fails and goes on with the next.
    }
  }
  return { ok: true, releases };
}

/** Terms shorter than 2 characters and these words don't count (FilterReleasesByQuery). */
const COMMON_WORDS = new Set(['and', 'the', 'an', 'of']);

/** The `andmatch` rows filter: a keyword search keeps releases whose title or description has its terms. */
export function andMatch(releases: Release[], searchTerm: string | undefined, idSearch: boolean): Release[] {
  if (searchTerm === undefined || idSearch) return releases;
  const split = compileRegex('[^\\w]+', true);
  const terms = searchTerm.split(split.ok ? split.regex : /\W+/).filter((term) => term.trim() && term.length > 1 && !COMMON_WORDS.has(term.toLowerCase()));
  return releases.filter((release) => {
    const haystacks = [release.title, release.description].filter((value): value is string => !!value?.trim()).map((value) => value.toLowerCase());
    const matched = terms.filter((term) => haystacks.some((value) => value.includes(term.toLowerCase())));
    return terms.length > 1 ? matched.length > 1 : matched.length > 0;
  });
}

const magnetHash = (magnet: string) => /xt=urn:btih:([^&]+)/i.exec(magnet)?.[1];

/**
 * The mapping of a release to an IndexerItem. A release without a title or
 * a download URL is dropped. A public site's magnet is preferred.
 */
export function toItem(release: Release, options: { isPrivate: boolean; now: number }): IndexerItem | undefined {
  const title = release.title?.trim();
  let { magnetUrl } = release;
  let infoHash = release.infoHash ? normalizeInfoHash(release.infoHash.trim()) : undefined;
  if (!magnetUrl && infoHash && !options.isPrivate) magnetUrl = `magnet:?xt=urn:btih:${infoHash}&dn=${encodeURIComponent(title ?? '')}`;
  if (magnetUrl && !infoHash) {
    const hash = magnetHash(magnetUrl);
    infoHash = hash ? normalizeInfoHash(decodeURIComponent(hash)) : undefined;
  }
  const downloadUrl = (!options.isPrivate && magnetUrl) || release.downloadUrl || magnetUrl;
  if (!title || !downloadUrl) return undefined;
  const seeders = release.seeders;
  return {
    guid: release.details ?? release.downloadUrl ?? magnetUrl ?? downloadUrl,
    title,
    downloadUrl,
    sizeBytes: release.size ?? 0,
    protocol: 'torrent',
    publishedAt: release.publishedAt ?? options.now,
    categories: release.categories ?? [],
    ids: {
      ...(release.imdbid ? { imdbid: String(release.imdbid).padStart(7, '0') } : {}),
      ...(release.tvdbid ? { tvdbid: String(release.tvdbid) } : {}),
      ...(release.tmdbid ? { tmdbid: String(release.tmdbid) } : {}),
    },
    torrent: {
      ...(infoHash ? { infoHash } : {}),
      ...(magnetUrl ? { magnetUrl } : {}),
      ...(seeders !== undefined ? { seeders } : {}),
      ...(release.peers !== undefined ? { peers: release.peers } : {}),
      ...(release.minimumRatio !== undefined ? { minimumRatio: release.minimumRatio } : {}),
      ...(release.minimumSeedTime !== undefined ? { minimumSeedTimeSec: release.minimumSeedTime } : {}),
      ...(release.downloadVolumeFactor !== undefined ? { downloadVolumeFactor: release.downloadVolumeFactor } : {}),
    },
  };
}
