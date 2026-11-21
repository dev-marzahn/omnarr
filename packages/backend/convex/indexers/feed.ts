import { indexerFailureCode, normalizeInfoHash } from '@omnarr/contracts';
import type {
  ApiLimits,
  CandidateTorrent,
  DownloadProtocol,
  IndexerFailure,
  IndexerFailureKind,
  IndexerIds,
  IndexerItem,
  IndexerPage,
  IndexerOutcome,
} from '@omnarr/contracts';
// Newznab and Torznab response parsing: results pages,
// `newznab:attr`/`torznab:attr`, `newznab:response`, `apilimits` in both
// spellings, and a 200 body that is an `<error>` element.
//
// scripts/collect-titles.ts runs this file under Node's type stripping, so it
// imports only fast-xml-parser and contract types, uses explicit `.ts`
// relative imports, and only erasable TypeScript syntax.
import { XMLParser } from 'fast-xml-parser';

/** Where the response came from: for `IndexerFailure`, and the protocol every item gets. */
export type FeedSource = { host: string; path: string; protocol: DownloadProtocol };

type Node = Record<string, unknown>;

/** HTML 4's Latin-1 names, U+00A0 to U+00FF in order. */
const LATIN_1 =
  'nbsp iexcl cent pound curren yen brvbar sect uml copy ordf laquo not shy reg macr deg plusmn sup2 sup3 acute micro para middot cedil sup1 ordm raquo frac14 frac12 frac34 iquest ' +
  'Agrave Aacute Acirc Atilde Auml Aring AElig Ccedil Egrave Eacute Ecirc Euml Igrave Iacute Icirc Iuml ETH Ntilde Ograve Oacute Ocirc Otilde Ouml times Oslash Ugrave Uacute Ucirc Uuml Yacute THORN szlig ' +
  'agrave aacute acirc atilde auml aring aelig ccedil egrave eacute ecirc euml igrave iacute icirc iuml eth ntilde ograve oacute ocirc otilde ouml divide oslash ugrave uacute ucirc uuml yacute thorn yuml';

/** HTML 4's special characters (ligatures, quotes, dashes, spaces) and a few common symbols. */
const SPECIAL: Record<string, number> = {
  OElig: 0x152,
  oelig: 0x153,
  Scaron: 0x160,
  scaron: 0x161,
  Yuml: 0x178,
  fnof: 0x192,
  circ: 0x2c6,
  tilde: 0x2dc,
  ensp: 0x2002,
  emsp: 0x2003,
  thinsp: 0x2009,
  zwnj: 0x200c,
  zwj: 0x200d,
  lrm: 0x200e,
  rlm: 0x200f,
  ndash: 0x2013,
  mdash: 0x2014,
  lsquo: 0x2018,
  rsquo: 0x2019,
  sbquo: 0x201a,
  ldquo: 0x201c,
  rdquo: 0x201d,
  bdquo: 0x201e,
  dagger: 0x2020,
  Dagger: 0x2021,
  bull: 0x2022,
  hellip: 0x2026,
  permil: 0x2030,
  prime: 0x2032,
  Prime: 0x2033,
  lsaquo: 0x2039,
  rsaquo: 0x203a,
  oline: 0x203e,
  frasl: 0x2044,
  euro: 0x20ac,
  trade: 0x2122,
  larr: 0x2190,
  rarr: 0x2192,
};

/** XML's five, then HTML 4's names. */
const NAMED: Record<string, string> = Object.fromEntries([
  ['amp', '&'],
  ['lt', '<'],
  ['gt', '>'],
  ['quot', '"'],
  ['apos', "'"],
  ...LATIN_1.split(' ').map((name, i) => [name, String.fromCodePoint(0xa0 + i)]),
  ...Object.entries(SPECIAL).map(([name, code]) => [name, String.fromCodePoint(code)]),
]);

const scalar = (code: number) => code > 0 && code <= 0x10ffff && (code < 0xd800 || code > 0xdfff);

/**
 * Decodes a feed's text or attribute in one pass: decimal and hex
 * references (`&#39;`, `&#x27;`) and the names above, so `&amp;amp;` reads
 * `&amp;`. An unknown name or an invalid code point stays as written.
 */
function decodeEntities(value: string): string {
  return value.replace(/&(?:#(\d{1,7})|#[xX]([0-9a-fA-F]{1,6})|([A-Za-z][A-Za-z0-9]{1,31}));/g, (whole, dec?: string, hex?: string, name?: string) => {
    if (name !== undefined) return Object.hasOwn(NAMED, name) ? NAMED[name]! : whole;
    const code = dec !== undefined ? Number(dec) : parseInt(hex!, 16);
    return scalar(code) ? String.fromCodePoint(code) : whole;
  });
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  // Keep `category`, `guid` and every attribute as strings (brief, Minor 3).
  parseTagValue: false,
  parseAttributeValue: false,
  // `newznab:attr` and `torznab:attr` read alike.
  removeNSPrefix: true,
  // The parser decodes only XML's five; decodeEntities does all of them, once.
  processEntities: false,
  tagValueProcessor: (_name, value) => decodeEntities(value),
  attributeValueProcessor: (_name, value) => decodeEntities(value),
  isArray: (name) => name === 'item' || name === 'attr' || name === 'category',
});

const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null && !Array.isArray(value);
const asNode = (value: unknown): Node => (isNode(value) ? value : {});
const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined ? [] : [value]);

/** A text element's text, whether or not it has attributes. */
function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim();
  if (isNode(value) && typeof value['#text'] === 'string') return value['#text'].trim();
  return undefined;
}

function attr(node: unknown, name: string): string | undefined {
  const value = asNode(node)[`@_${name}`];
  return typeof value === 'string' ? value : undefined;
}

/** A whole, non-negative number, else undefined. */
function count(value: string | undefined): number | undefined {
  if (value === undefined || !/^\s*\d+\s*$/.test(value)) return undefined;
  return Number(value);
}

/** The values of every `<newznab:attr name=…>` of an item, by name. */
function attrsOf(item: Node): Map<string, string[]> {
  const attrs = new Map<string, string[]>();
  for (const entry of asArray(item.attr)) {
    const name = attr(entry, 'name')?.toLowerCase();
    const value = attr(entry, 'value');
    if (name === undefined || value === undefined) continue;
    attrs.set(name, [...(attrs.get(name) ?? []), value]);
  }
  return attrs;
}

function idsOf(attrs: Map<string, string[]>): IndexerIds {
  const ids: IndexerIds = {};
  const tvdb = attrs.get('tvdbid')?.[0];
  const tmdb = attrs.get('tmdbid')?.[0];
  // Torznab spells it `imdb`; Newznab indexers send `imdb` or `imdbid`, with or without "tt".
  const imdb = (attrs.get('imdbid') ?? attrs.get('imdb'))?.[0]?.replace(/^tt/i, '');
  if (tvdb && tvdb !== '0') ids.tvdbid = tvdb;
  if (tmdb && tmdb !== '0') ids.tmdbid = tmdb;
  if (imdb && !/^0*$/.test(imdb)) ids.imdbid = imdb;
  return ids;
}

/** Only these are fetched later (`download.submit`), so a forged feed can't point at a local file. */
const ALLOWED_SCHEMES = new Set(['http:', 'https:', 'magnet:']);

function hasAllowedScheme(url: string): boolean {
  try {
    return ALLOWED_SCHEMES.has(new URL(url).protocol);
  } catch {
    return false;
  }
}

/** A finite, non-negative decimal, else undefined. */
function decimal(value: string | undefined): number | undefined {
  if (value === undefined || !/^\s*\d+(\.\d+)?\s*$/.test(value)) return undefined;
  return Number(value);
}

/** The hash a magnet names: its `btih`, else its `btmh`. */
function magnetHash(magnet: string | undefined): string | undefined {
  const topic = magnet === undefined ? undefined : /[?&]xt=urn:bt(?:ih|mh):([0-9a-z]+)/i.exec(magnet)?.[1];
  return topic === undefined ? undefined : normalizeInfoHash(topic);
}

/**
 * The Torznab attributes. The info hash is normalized, from `infohash`,
 * else from the magnet. A magnet
 * that is the item's own link is its magnet too.
 */
function torrentOf(attrs: Map<string, string[]>, downloadUrl: string): CandidateTorrent {
  const first = (name: string) => attrs.get(name)?.[0];
  const magnetUrl = first('magneturl') ?? (downloadUrl.startsWith('magnet:') ? downloadUrl : undefined);
  const fields: CandidateTorrent = {
    infoHash: normalizeInfoHash(first('infohash')?.trim() ?? '') ?? magnetHash(magnetUrl),
    magnetUrl,
    seeders: count(first('seeders')),
    peers: count(first('peers')),
    minimumRatio: decimal(first('minimumratio')),
    minimumSeedTimeSec: count(first('minimumseedtime')),
    downloadVolumeFactor: decimal(first('downloadvolumefactor')),
  };
  return Object.fromEntries(Object.entries(fields).filter(([, value]) => value !== undefined));
}

function itemOf(raw: unknown, protocol: DownloadProtocol): IndexerItem | undefined {
  const item = asNode(raw);
  const title = text(item.title);
  const guid = text(item.guid);
  const enclosure = asNode(item.enclosure);
  const downloadUrl = attr(enclosure, 'url') ?? text(item.link);
  if (!title || !guid || !downloadUrl || !hasAllowedScheme(downloadUrl)) return undefined;
  const attrs = attrsOf(item);
  const fromAttrs = (attrs.get('category') ?? []).map((value) => count(value)).filter((id) => id !== undefined);
  const fromElements = asArray(item.category)
    .map((value) => count(text(value)))
    .filter((id) => id !== undefined);
  const publishedAt = Date.parse(text(item.pubDate) ?? '');
  return {
    guid,
    title,
    downloadUrl,
    sizeBytes: count(attr(enclosure, 'length')) ?? count(attrs.get('size')?.[0]) ?? count(text(item.size)) ?? 0,
    protocol,
    publishedAt: Number.isNaN(publishedAt) ? 0 : publishedAt,
    categories: fromAttrs.length > 0 ? fromAttrs : fromElements,
    ids: idsOf(attrs),
    ...(protocol === 'torrent' ? { torrent: torrentOf(attrs, downloadUrl) } : {}),
  };
}

/**
 * Classifies an `<error code description>` body. The description is
 * read only to detect "limit reached", then dropped.
 */
function errorKind(code: number | undefined, description: string): IndexerFailureKind {
  if (code === 500 || /limit reached/i.test(description)) return 'rateLimited';
  if (code === 100 || code === 101 || code === 102) return 'authRejected';
  if (code === 910) return 'apiDisabled';
  return 'indexerError';
}

function failureOf(kind: IndexerFailureKind, source: FeedSource, extra: Partial<IndexerFailure> = {}): IndexerOutcome<never> {
  return { ok: false, failure: { kind, code: indexerFailureCode(kind), ...extra, host: source.host, path: source.path } };
}

/** An attribute by name, ignoring case: `apimax` and `apiMax` are the same attribute. */
function attrAnyCase(node: unknown, name: string): string | undefined {
  const wanted = `@_${name}`.toLowerCase();
  const entry = Object.entries(asNode(node)).find(([key]) => key.toLowerCase() === wanted);
  return typeof entry?.[1] === 'string' ? entry[1] : undefined;
}

function time(value: string | undefined): number | undefined {
  const ms = Date.parse(value ?? '');
  return Number.isNaN(ms) ? undefined : ms;
}

/** Both spellings of `apilimits`, when the element is there and names a maximum. */
function apiLimitsOf(node: unknown): ApiLimits | undefined {
  if (!isNode(node)) return undefined;
  const apiMax = count(attrAnyCase(node, 'apimax'));
  if (apiMax === undefined) return undefined;
  const limits: ApiLimits = { apiCurrent: count(attrAnyCase(node, 'apicurrent')) ?? 0, apiMax };
  const oldest = time(attrAnyCase(node, 'apioldesttime'));
  const next = time(attrAnyCase(node, 'apinextavailable'));
  if (oldest !== undefined) limits.apiOldestTime = oldest;
  if (next !== undefined) limits.apiNextAvailable = next;
  return limits;
}

function parseXml(xml: string): Node | undefined {
  try {
    return asNode(parser.parse(xml));
  } catch {
    return undefined;
  }
}

/** Parses one results page, or the `<error>` body an indexer sends with HTTP 200. */
export function parseFeed(xml: string, source: FeedSource): IndexerOutcome<IndexerPage> {
  const doc = parseXml(xml);
  if (doc && isNode(doc.error)) {
    const errorCode = count(attr(doc.error, 'code'));
    const apiLimits = apiLimitsOf(doc.error.apilimits);
    const atMax = apiLimits !== undefined && apiLimits.apiCurrent >= apiLimits.apiMax;
    const kind = atMax ? 'rateLimited' : errorKind(errorCode, attr(doc.error, 'description') ?? '');
    return failureOf(kind, source, { ...(errorCode === undefined ? {} : { errorCode }), ...(apiLimits ? { apiLimits } : {}) });
  }
  const channel = doc && isNode(doc.rss) ? doc.rss.channel : undefined;
  if (!isNode(channel)) return failureOf('notAnIndexerApi', source);
  const response = channel.response;
  const items = asArray(channel.item)
    .map((raw) => itemOf(raw, source.protocol))
    .filter((item) => item !== undefined);
  const page: IndexerPage = { items, offset: count(attr(response, 'offset')) ?? 0 };
  const total = count(attr(response, 'total'));
  if (total !== undefined) page.total = total;
  const apiLimits = apiLimitsOf(channel.apilimits);
  if (apiLimits) page.apiLimits = apiLimits;
  return { ok: true, value: page };
}
