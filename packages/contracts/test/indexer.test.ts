import { describe, expect, test } from 'vite-plus/test';

import { IndexerHealth } from '../src/dto/system.ts';
import { indexerFailureCode } from '../src/failures.ts';
import {
  IndexerCreateSiteInput,
  IndexerTestSiteInput,
  IndexerKind,
  IndexerSkip,
  protocolOf,
  ApiLimits,
  IndexerCall,
  IndexerCaps,
  IndexerCreateInput,
  IndexerDetail,
  IndexerFailure,
  IndexerItem,
  IndexerPage,
  IndexerPatch,
  IndexerRequest,
  IndexerRow,
  IndexerTestInput,
  IndexerTestResult,
  IndexerUsageHour,
  RateLimitReason,
} from '../src/indexer.ts';
import { capsFromMeta, newznabCategoryId } from '../src/sites.ts';

const item = {
  guid: 'a1b2c3',
  title: 'The.Long.Harbor.S01E02.1080p.WEB-DL.DDP5.1.H.264-GRPA',
  downloadUrl: 'https://indexer.example/getnzb/a1b2c3.nzb?apikey=planted-key',
  sizeBytes: 1_500_000_000,
  protocol: 'usenet',
  publishedAt: 1_763_000_000_000,
  categories: [5000, 5040],
  ids: { tvdbid: '7700001', imdbid: '9900001' },
};

describe('the adapter shapes', () => {
  test('a Newznab item and page parse', () => {
    expect(IndexerItem.parse(item)).toEqual(item);
    const page = { items: [item], total: 250, offset: 100, apiLimits: { apiCurrent: 12, apiMax: 100 } };
    expect(IndexerPage.parse(page)).toEqual(page);
  });

  test('an item without numbers or IDs still parses', () => {
    expect(IndexerItem.safeParse({ ...item, ids: {}, categories: [] }).success).toBe(true);
  });

  test('a protocol other than usenet or torrent is refused', () => {
    expect(IndexerItem.safeParse({ ...item, protocol: 'ftp' }).success).toBe(false);
  });

  test('ApiLimits carries the oldest-request time and the next free slot as optional times', () => {
    expect(ApiLimits.parse({ apiCurrent: 100, apiMax: 100, apiOldestTime: 1, apiNextAvailable: 2 })).toEqual({
      apiCurrent: 100,
      apiMax: 100,
      apiOldestTime: 1,
      apiNextAvailable: 2,
    });
  });

  test('an IndexerFailure names the host and path and maps its kind to a failure code', () => {
    const failure = { kind: 'rateLimited', code: 'indexerRateLimited', errorCode: 500, host: 'indexer.example', path: '/api' };
    expect(IndexerFailure.parse(failure)).toEqual(failure);
    expect(IndexerFailure.safeParse({ ...failure, code: 'diskFull' }).success).toBe(false);
  });

  test('a torrent item carries its Torznab fields', () => {
    const torrent = { ...item, protocol: 'torrent', torrent: { infoHash: 'abc', magnetUrl: 'magnet:?xt=urn:btih:abc', seeders: 4, peers: 9 } };
    expect(IndexerItem.parse(torrent)).toEqual(torrent);
  });

  test('a request names its function, IDs, categories and page', () => {
    const request = { fn: 'tvsearch', season: '1', ep: '2', ids: { tvdbid: '7700001' }, categories: [5000], limit: 100, offset: 0 };
    expect(IndexerRequest.parse(request)).toEqual(request);
    expect(IndexerRequest.safeParse({ ...request, fn: 'tv-search' }).success).toBe(false);
  });

  test('caps hold the search modes with their parameters, the page limits and the categories', () => {
    const caps = {
      searchModes: [
        { mode: 'search', available: true, supportedParams: ['q'] },
        { mode: 'tv-search', available: true, supportedParams: ['q', 'tvdbid', 'season', 'ep'] },
      ],
      pageLimit: { max: 100, default: 50 },
      categories: [
        { id: 5000, name: 'TV' },
        { id: 5040, name: 'TV/HD', parentId: 5000 },
      ],
      fetchedAt: 1,
    };
    expect(IndexerCaps.parse(caps)).toEqual(caps);
  });

  test('an IndexerCall records one request for usage and health', () => {
    expect(IndexerCall.safeParse({ at: 1, ok: true, latencyMs: 120, kind: 'search', count: 40 }).success).toBe(true);
    expect(
      IndexerCall.safeParse({ at: 1, ok: false, latencyMs: 30000, kind: 'rss', failure: { kind: 'timeout', code: 'indexerTimeout', host: 'h', path: '/api' } })
        .success,
    ).toBe(true);
  });

  test('IndexerTestInput takes a new URL and key, or a stored indexer with either replaced', () => {
    expect(IndexerTestInput.safeParse({ url: 'https://indexer.example', apiKey: 'k' }).success).toBe(true);
    expect(IndexerTestInput.safeParse({ indexerId: 'abc' }).success).toBe(true);
    expect(IndexerTestInput.safeParse({ url: 'https://indexer.example' }).success).toBe(false);
  });

  test('an IndexerFailure has no field for a URL', () => {
    expect(IndexerFailure.safeParse({ kind: 'timeout', code: 'indexerTimeout', host: 'h', path: '/api', url: 'https://h/api?apikey=k' }).success).toBe(false);
  });
});

describe('the indexer DTOs', () => {
  const health = { status: 'ok', checkedAt: 1, latencyMs: 300, lastSearch: { at: 1, status: 'ok', count: 12 }, lastRss: { at: 2, newItems: 5, matched: 1 } };
  const row = {
    id: 'idx1',
    name: 'Example',
    kind: 'newznab',
    host: 'indexer.example',
    enabled: true,
    priority: 25,
    health,
    rateLimitedUntil: 10,
    rateLimitReason: 'fallback',
    apiUse24h: 40,
    errors24h: 1,
    effectiveRssIntervalMinutes: 58,
  };
  const detail = {
    ...row,
    apiUrl: 'https://indexer.example/api',
    caps: { searchModes: [{ mode: 'search', available: true, supportedParams: ['q'] }], categories: [{ id: 5000, name: 'TV' }], pageLimit: { max: 100 } },
    categories: { series: [5000], movies: [2000] },
    apiLimit: { max: 100, source: 'apilimits' },
    apiKeySet: true,
    rssIntervalMinutes: 15,
  };
  const testResult = {
    ok: false,
    searchModes: [],
    categories: [],
    latencyMs: 10000,
    failure: { kind: 'authRejected', errorCode: 100, host: 'indexer.example', path: '/api' },
  };
  const create = { name: 'Example', url: 'https://indexer.example', apiKey: 'k', priority: 10 };

  test('accept their fields', () => {
    expect(IndexerRow.safeParse(row).success).toBe(true);
    expect(IndexerDetail.safeParse(detail).success).toBe(true);
    expect(IndexerTestResult.safeParse(testResult).success).toBe(true);
    expect(IndexerCreateInput.safeParse(create).success).toBe(true);
    expect(IndexerPatch.safeParse({ priority: 3 }).success).toBe(true);
  });

  test.each(['apiKey', 'downloadUrl', 'magnetUrl'])('reject a %s key (.strict())', (key) => {
    for (const [schema, value] of [
      [IndexerRow, row],
      [IndexerDetail, detail],
      [IndexerTestResult, testResult],
    ] as const) {
      expect(schema.safeParse({ ...value, [key]: 'secret' }).success).toBe(false);
    }
  });

  test('IndexerHealth carries the failure detail and the last search and RSS fetch', () => {
    expect(IndexerHealth.parse({ ...health, detail: { kind: 'rateLimited', httpStatus: 429 } })).toMatchObject({ detail: { kind: 'rateLimited' } });
  });

  test('usage hours and the rate-limit reasons', () => {
    expect(IndexerUsageHour.safeParse({ hourStart: 0, requests: 3, errors: 0 }).success).toBe(true);
    expect(RateLimitReason.options).toEqual(['retryAfter', 'apilimits', 'ownCount', 'fallback']);
  });
});

describe('site indexers', () => {
  test('Nyaa is a kind, and every kind but Newznab is a torrent indexer', () => {
    expect(IndexerKind.options).toEqual(['newznab', 'torznab', 'nyaa', 'definition']);
    expect(protocolOf('newznab')).toBe('usenet');
    expect(protocolOf('torznab')).toBe('torrent');
    expect(protocolOf('nyaa')).toBe('torrent');
    expect(protocolOf('definition')).toBe('torrent');
  });

  test('a worker that ran no request is an indexer error', () => {
    expect(indexerFailureCode('workerUnavailable')).toBe('indexerError');
  });

  test("a definition's caps are built from its modes and category names", () => {
    const caps = capsFromMeta({ modes: { search: ['q'], 'tv-search': ['q', 'season', 'ep'], 'music-search': ['q'] }, categories: [2000, 5070] }, 7);
    expect(caps).toEqual({
      searchModes: [
        { mode: 'search', available: true, supportedParams: ['q'] },
        { mode: 'tv-search', available: true, supportedParams: ['q', 'season', 'ep'] },
        { mode: 'movie-search', available: false, supportedParams: [] },
      ],
      pageLimit: {},
      categories: [
        { id: 2000, name: 'Movies' },
        { id: 5000, name: 'TV' },
        { id: 5070, name: 'TV/Anime', parentId: 5000 },
      ],
      fetchedAt: 7,
    });
    expect(newznabCategoryId('tv/anime')).toBe(5070);
    expect(newznabCategoryId('Made/Up')).toBeUndefined();
  });

  test('a challenge is a rate limit and an unexpected page an error', () => {
    expect(indexerFailureCode('challenged')).toBe('indexerRateLimited');
    expect(indexerFailureCode('unexpectedPage')).toBe('indexerError');
  });

  test('a paced indexer is a skip', () => {
    expect(IndexerSkip.options).toContain('paced');
  });

  test('a site is created by its kind alone', () => {
    expect(IndexerCreateSiteInput.parse({ kind: 'nyaa' })).toEqual({ kind: 'nyaa' });
    expect(IndexerCreateSiteInput.parse({ kind: 'nyaa', name: 'Anime' })).toEqual({ kind: 'nyaa', name: 'Anime' });
    expect(IndexerCreateSiteInput.safeParse({ kind: 'torznab' }).success).toBe(false);
    expect(IndexerCreateSiteInput.safeParse({ kind: 'nyaa', url: 'https://nyaa.example' }).success).toBe(false);
    const site = { kind: 'definition', definitionId: 'lanternsite', baseUrl: 'https://lantern.test/', settings: { sort: 'added', freeleech: true } };
    expect(IndexerCreateSiteInput.parse(site)).toEqual(site);
    expect(IndexerTestSiteInput.parse(site)).toEqual(site);
  });
});
