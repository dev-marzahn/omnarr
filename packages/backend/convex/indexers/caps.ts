// Caps: the search modes with their parameters, the page
// limit and the categories; the default category lists; and the API URL a
// pasted URL stands for.
import type { IndexerCaps, IndexerCategory, IndexerOutcome, SearchMode } from '@omnarr/contracts';
import { XMLParser } from 'fast-xml-parser';

import { parseFeed } from './feed';

type Node = Record<string, unknown>;

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  removeNSPrefix: true,
  isArray: (name) => name === 'category' || name === 'subcat',
});

const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null && !Array.isArray(value);
const attr = (node: unknown, name: string) => (isNode(node) && typeof node[`@_${name}`] === 'string' ? (node[`@_${name}`] as string) : undefined);
const whole = (value: string | undefined) => (value !== undefined && /^\s*\d+\s*$/.test(value) ? Number(value) : undefined);

/** Torznab revision 1.1's defaults, for caps that omit `supportedParams`. */
const DEFAULT_PARAMS: Record<SearchMode, string[]> = {
  search: ['q'],
  'tv-search': ['q', 'rid', 'season', 'ep'],
  'movie-search': ['q', 'imdbid'],
};

const MODES: SearchMode[] = ['search', 'tv-search', 'movie-search'];

/** Parses a `t=caps` answer; an `<error>` body keeps its classification. */
export function parseCaps(xml: string, source: { host: string; path: string }, now: number): IndexerOutcome<IndexerCaps> {
  let doc: Node;
  try {
    doc = parser.parse(xml) as Node;
  } catch {
    doc = {};
  }
  if (isNode(doc.error)) {
    const failure = parseFeed(xml, { ...source, protocol: 'usenet' });
    if (!failure.ok) return failure;
  }
  const caps = doc.caps;
  if (!isNode(caps)) return { ok: false, failure: { kind: 'notAnIndexerApi', code: 'indexerError', host: source.host, path: source.path } };

  const searching = isNode(caps.searching) ? caps.searching : {};
  const searchModes = MODES.map((mode) => {
    const element = searching[mode];
    const listed = attr(element, 'supportedParams');
    const available = attr(element, 'available') === 'yes';
    if (listed === undefined) return { mode, available, supportedParams: DEFAULT_PARAMS[mode], defaulted: true };
    return {
      mode,
      available,
      supportedParams: listed
        .split(',')
        .map((param) => param.trim())
        .filter(Boolean),
    };
  });

  const pageLimit: IndexerCaps['pageLimit'] = {};
  const max = whole(attr(caps.limits, 'max'));
  const fallback = whole(attr(caps.limits, 'default'));
  if (max !== undefined) pageLimit.max = max;
  if (fallback !== undefined) pageLimit.default = fallback;

  const categories: IndexerCategory[] = [];
  const list = isNode(caps.categories) && Array.isArray(caps.categories.category) ? caps.categories.category : [];
  for (const category of list) {
    const id = whole(attr(category, 'id'));
    if (id === undefined) continue;
    categories.push({ id, name: attr(category, 'name') ?? '' });
    const subcats = isNode(category) && Array.isArray(category.subcat) ? category.subcat : [];
    for (const sub of subcats) {
      const subId = whole(attr(sub, 'id'));
      if (subId !== undefined) categories.push({ id: subId, name: attr(sub, 'name') ?? '', parentId: id });
    }
  }
  return { ok: true, value: { searchModes, pageLimit, categories, fetchedAt: now } };
}

/** The `apilimits` element caps may carry, read like a results page's. */
export function capsApiLimits(xml: string) {
  const match = /<(?:\w+:)?apilimits\b[^>]*\/?>/i.exec(xml);
  if (!match) return undefined;
  const page = parseFeed(`<rss><channel>${match[0]}</channel></rss>`, { host: '', path: '', protocol: 'usenet' });
  return page.ok ? page.value.apiLimits : undefined;
}

/** Series: 5000 and its children (5xxx), plus site categories (≥ 100000) under 5000. Movies: the same for 2000. */
export function defaultCategories(caps: Pick<IndexerCaps, 'categories'>): { series: number[]; movies: number[] } {
  const under = (root: number) =>
    caps.categories.filter((c) => (c.id >= root && c.id < root + 1000) || (c.id >= 100_000 && c.parentId === root)).map((c) => c.id);
  return { series: under(5000), movies: under(2000) };
}

/**
 * The API endpoint without parameters: a pasted URL whose path doesn't end
 * in `/api` gets it appended (Jackett and Prowlarr URLs already end in it).
 * Undefined for anything but http and https.
 */
export function normalizeApiUrl(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  const path = parsed.pathname.replace(/\/+$/, '');
  return `${parsed.origin}${path.endsWith('/api') ? path : `${path}/api`}`;
}
