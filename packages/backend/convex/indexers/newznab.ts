// The Newznab adapter and type detection.
// Torznab (torznab.ts) shares feed.ts and this request shape; feed.ts reads its attributes.
import type { DownloadProtocol, IndexerCaps, IndexerKind, IndexerPage, IndexerRequest, IndexerResult } from '@omnarr/contracts';

import type { AdapterIndexer, IndexerAdapter } from './adapter';
import { parseCaps } from './caps';
import { parseFeed } from './feed';
import { indexerFetch, SEARCH_TIMEOUT_MS, whereOf } from './http';

/**
 * Newznab or Torznab, read from a results page. feed.ts drops the
 * namespace prefixes, so this reads the raw XML. An empty result falls back
 * to the namespace the feed declares; undefined when nothing decides it.
 */
export function detectKind(xml: string): IndexerKind | undefined {
  if (/<torznab:attr\b/i.test(xml) || /type\s*=\s*["']application\/x-bittorrent["']/i.test(xml)) return 'torznab';
  if (/<newznab:attr\b/i.test(xml) || /type\s*=\s*["']application\/x-nzb["']/i.test(xml)) return 'newznab';
  if (/<item\b/i.test(xml)) return undefined;
  const torznab = /xmlns:torznab\s*=/i.test(xml);
  const newznab = /xmlns:newznab\s*=/i.test(xml);
  if (torznab !== newznab) return torznab ? 'torznab' : 'newznab';
  return undefined;
}

/** The query parameters one request plan step sends. */
export function requestParams(request: IndexerRequest): Record<string, string> {
  const params: Record<string, string> = { t: request.fn, extended: '1', limit: String(request.limit), offset: String(request.offset) };
  if (request.categories.length > 0) params.cat = request.categories.join(',');
  if (request.q !== undefined) params.q = request.q;
  if (request.season !== undefined) params.season = request.season;
  if (request.ep !== undefined) params.ep = request.ep;
  for (const [name, value] of Object.entries(request.ids ?? {})) if (value !== undefined) params[name] = value;
  return params;
}

/** RSS reads one page at the caps' maximum, else its default, else 100. */
export const pageSizeOf = (caps?: Pick<IndexerCaps, 'pageLimit'>) => caps?.pageLimit.max ?? caps?.pageLimit.default ?? 100;

/**
 * The adapter both kinds share: one request shape, one feed parser. The
 * protocol decides what an item carries (Torznab's `torrent`).
 */
export function createFeedAdapter(indexer: AdapterIndexer, protocol: DownloadProtocol, options: { timeoutMs?: number } = {}): IndexerAdapter {
  const timeoutMs = options.timeoutMs ?? SEARCH_TIMEOUT_MS;
  const source = { ...whereOf(indexer.apiUrl), protocol };
  const page = async (params: Record<string, string>): Promise<IndexerResult<IndexerPage>> => {
    const response = await indexerFetch(indexer, params, timeoutMs);
    if (!response.ok) return { ok: false, failure: response.failure };
    // A page whose `apilimits` are at their maximum is still a valid page: the
    // caller records it and holds the next request.
    return parseFeed(response.body, source);
  };
  return {
    caps: async () => {
      const response = await indexerFetch(indexer, { t: 'caps' }, timeoutMs);
      return response.ok ? parseCaps(response.body, source, Date.now()) : { ok: false, failure: response.failure };
    },
    search: (request) => page(requestParams(request)),
    rss: ({ offset }) =>
      page(requestParams({ fn: 'search', categories: [...indexer.categories.series, ...indexer.categories.movies], limit: pageSizeOf(indexer.caps), offset })),
  };
}

export const createNewznabAdapter = (indexer: AdapterIndexer, options: { timeoutMs?: number } = {}): IndexerAdapter =>
  createFeedAdapter(indexer, 'usenet', options);
