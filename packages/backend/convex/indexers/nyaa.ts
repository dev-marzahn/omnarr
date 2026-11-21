// The Nyaa adapter. Searches and RSS read Nyaa's RSS feed
// (`/?page=rss`, magnets with `m=1`); offsets past the feed's 75 read the
// HTML listing with the same `q`, `c` and `f`, sorted by ID as the feed is.
// Caps are constants. Every request takes a pacing slot first and sends
// the omnarr User-Agent. The base URL is the indexer's `apiUrl`, which
// createSite sets from `nyaaBaseUrl()`: `https://nyaa.si`, or `NYAA_URL` in
// the e2e stack.
import { indexerFailureCode, normalizeInfoHash } from '@omnarr/contracts';
import type { IndexerCaps, IndexerCategories, IndexerItem, IndexerOutcome, IndexerPage, IndexerRequest, IndexerResult } from '@omnarr/contracts';
import { selectAll, selectOne } from 'css-select';
import { XMLParser } from 'fast-xml-parser';
import { DomUtils, parseDocument } from 'htmlparser2';

import { userAgent } from '../lib/userAgent';
import type { IndexerAdapter } from './adapter';
import { SEARCH_TIMEOUT_MS, siteFetch } from './http';
import { parseSizeText } from './sizeText';

/** Mirrors aren't offered. */
export const NYAA_BASE_URL = 'https://nyaa.si';
export const nyaaBaseUrl = () => process.env.NYAA_URL || NYAA_BASE_URL;

/** The feed's cap (nyaa's `DEFAULT_PER_PAGE`), which the listing's pages share. */
export const NYAA_PAGE_SIZE = 75;

/** Title search only; anime series and movies under the standard category ids, both sent as Nyaa's `c=1_0`. */
export const NYAA_CAPS: IndexerCaps = {
  searchModes: [
    { mode: 'search', available: true, supportedParams: ['q'] },
    { mode: 'tv-search', available: false, supportedParams: [] },
    { mode: 'movie-search', available: false, supportedParams: [] },
  ],
  pageLimit: { max: NYAA_PAGE_SIZE, default: NYAA_PAGE_SIZE },
  categories: [
    { id: 2000, name: 'Movies' },
    { id: 5000, name: 'TV' },
    { id: 5070, name: 'TV/Anime', parentId: 5000 },
  ],
  fetchedAt: 0,
};

export const NYAA_CATEGORIES: IndexerCategories = { series: [5070], movies: [2000] };

/** The caps built now: the 24-hour caps refresh rebuilds them without a request. */
export const nyaaCaps = (now: number): IndexerCaps => ({ ...NYAA_CAPS, fetchedAt: now });

type Where = { host: string; path: string };

const unexpected = (at: Where): IndexerOutcome<never> => ({
  ok: false,
  failure: { kind: 'unexpectedPage', code: indexerFailureCode('unexpectedPage'), host: at.host, path: at.path },
});

type Node = Record<string, unknown>;

// feed.ts's settings, plus `htmlEntities`: Nyaa's templates escape `'` and `"` as `&#39;` and `&#34;`.
const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  parseAttributeValue: false,
  removeNSPrefix: true,
  htmlEntities: true,
  isArray: (name) => name === 'item',
});

const isNode = (value: unknown): value is Node => typeof value === 'object' && value !== null && !Array.isArray(value);

function text(value: unknown): string | undefined {
  if (typeof value === 'string') return value.trim();
  if (isNode(value) && typeof value['#text'] === 'string') return value['#text'].trim();
  return undefined;
}

const count = (value: string | undefined) => (value !== undefined && /^\s*\d+\s*$/.test(value) ? Number(value) : undefined);

/** An item as both readers build it; undefined without a title, a page link, a magnet or an info hash. */
function itemOf(fields: {
  guid?: string;
  title?: string;
  magnet?: string;
  infoHash?: string;
  size?: string;
  publishedAt: number;
  seeders?: string;
  leechers?: string;
}): IndexerItem | undefined {
  const infoHash = fields.infoHash === undefined ? undefined : normalizeInfoHash(fields.infoHash.trim());
  if (!fields.guid || !fields.title || !fields.magnet?.startsWith('magnet:') || !infoHash) return undefined;
  const seeders = count(fields.seeders);
  const leechers = count(fields.leechers);
  return {
    guid: fields.guid,
    title: fields.title,
    downloadUrl: fields.magnet,
    sizeBytes: parseSizeText(fields.size ?? ''),
    protocol: 'torrent',
    publishedAt: Number.isNaN(fields.publishedAt) ? 0 : fields.publishedAt,
    // Nyaa's categories don't say series or movie: RSS parses as a series, then as a movie.
    categories: [],
    ids: {},
    torrent: {
      infoHash,
      magnetUrl: fields.magnet,
      ...(seeders === undefined ? {} : { seeders }),
      ...(seeders === undefined || leechers === undefined ? {} : { peers: seeders + leechers }),
    },
  };
}

/** Nyaa's RSS feed, recognized by its `nyaa` namespace on any host. Anything else is `unexpectedPage`. */
export function readFeed(body: string, at: Where): IndexerOutcome<IndexerPage> {
  if (!/xmlns:nyaa\s*=\s*["'][^"']*\/xmlns\/nyaa["']/.test(body)) return unexpected(at);
  let doc: Node;
  try {
    doc = parser.parse(body) as Node;
  } catch {
    return unexpected(at);
  }
  const channel = isNode(doc.rss) ? doc.rss.channel : undefined;
  if (!isNode(channel)) return unexpected(at);
  const raw = Array.isArray(channel.item) ? channel.item : [];
  const items = raw.flatMap((entry) => {
    const item = isNode(entry) ? entry : {};
    const built = itemOf({
      guid: text(item.guid),
      title: text(item.title),
      magnet: text(item.link),
      infoHash: text(item.infoHash),
      size: text(item.size),
      publishedAt: Date.parse(text(item.pubDate) ?? ''),
      seeders: text(item.seeders),
      leechers: text(item.leechers),
    });
    return built ? [built] : [];
  });
  return { ok: true, value: { items, offset: 0 } };
}

type Document = ReturnType<typeof parseDocument>;
type Element = ReturnType<typeof DomUtils.getElementsByTagName>[number];
/** css-select's results, typed as elements: its generics can't infer them from a document. */
const all = (query: string, root: Document | Element | Element[]) => selectAll(query, root) as Element[];
const one = (query: string, root: Document | Element | Element[]) => selectOne(query, root) as Element | null;

/** The row classes the listing shows for live uploads; `deleted` and `warning` (hidden) rows are skipped. */
const LIVE_ROWS = new Set(['default', 'success', 'danger']);

/**
 * The listing's `table.torrent-list` rows (nyaa's `search_results.html`),
 * cells by position. The heading "No results found" is an empty page; a page
 * with neither is `unexpectedPage`.
 */
export function readListing(body: string, baseUrl: string, at: Where, offset = 0): IndexerOutcome<IndexerPage> {
  const doc = parseDocument(body);
  const table = one('table.torrent-list', doc);
  if (!table) {
    const empty = all('h3', doc).some((heading) => DomUtils.textContent(heading).trim() === 'No results found');
    return empty ? { ok: true, value: { items: [], offset } } : unexpected(at);
  }
  const items = all('tbody > tr', table).flatMap((row) => {
    if (!LIVE_ROWS.has((row.attribs.class ?? '').trim())) return [];
    const cells = all(':scope > td', row);
    const cell = (n: number) => cells[n - 1];
    const name = all('a', cell(2) ?? [])
      .filter((a) => !(a.attribs.class ?? '').split(/\s+/).includes('comments'))
      .at(-1);
    const magnet = one('a[href^="magnet:"]', cell(3) ?? [])?.attribs.href;
    const href = name?.attribs.href;
    const built = itemOf({
      guid: href ? new URL(href, baseUrl).href : undefined,
      title: name?.attribs.title?.trim(),
      magnet,
      infoHash: magnet === undefined ? undefined : /[?&]xt=urn:btih:([0-9a-z]+)/i.exec(magnet)?.[1],
      size: cell(4) && DomUtils.textContent(cell(4)!),
      publishedAt: Number(cell(5)?.attribs['data-timestamp'] ?? NaN) * 1000,
      seeders: cell(6) && DomUtils.textContent(cell(6)!),
      leechers: cell(7) && DomUtils.textContent(cell(7)!),
    });
    return built ? [built] : [];
  });
  return { ok: true, value: { items, offset } };
}

/** The URL for one page: the feed at offset 0, the listing's page `offset / 75 + 1` after it. */
export function nyaaUrl(baseUrl: string, q: string | undefined, offset: number): URL {
  const url = new URL('/', baseUrl);
  const set = (name: string, value: string) => url.searchParams.set(name, value);
  if (offset === 0) set('page', 'rss');
  if (q) set('q', q);
  set('c', '1_0');
  set('f', '0');
  if (offset === 0) set('m', '1');
  else {
    set('s', 'id');
    set('o', 'desc');
    set('p', String(Math.floor(offset / NYAA_PAGE_SIZE) + 1));
  }
  return url;
}

/** `pace` takes the indexer's pacing slot and resolves when the request may go, or with `skip`. */
export type NyaaOptions = { pace: () => Promise<'go' | 'skip'>; timeoutMs?: number };

export function createNyaaAdapter(indexer: { apiUrl: string }, options: NyaaOptions): IndexerAdapter {
  const timeoutMs = options.timeoutMs ?? SEARCH_TIMEOUT_MS;
  const page = async (q: string | undefined, offset: number): Promise<IndexerResult<IndexerPage>> => {
    if ((await options.pace()) === 'skip') return { ok: false, skipped: 'paced' };
    const url = nyaaUrl(indexer.apiUrl, q, offset);
    const response = await siteFetch(url, { timeoutMs, headers: { 'User-Agent': userAgent() } });
    if (!response.ok) return { ok: false, failure: response.failure };
    const at = { host: url.host, path: url.pathname };
    return offset === 0 ? readFeed(response.body, at) : readListing(response.body, indexer.apiUrl, at, offset);
  };
  return {
    caps: async () => ({ ok: true, value: nyaaCaps(Date.now()) }),
    search: (request: IndexerRequest) => page(request.q, request.offset),
    rss: ({ offset }) => page(undefined, offset),
  };
}
