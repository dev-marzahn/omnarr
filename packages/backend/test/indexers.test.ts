import { createNewznabHandler, type NewznabHandler } from '@omnarr/e2e/fakes/newznab';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';

import type { Id } from '../convex/_generated/dataModel';
import { type AdapterIndexer, createAdapter as createAdapterFor } from '../convex/indexers/adapter';
import { defaultCategories, normalizeApiUrl, parseCaps } from '../convex/indexers/caps';
import { testConnection } from '../convex/indexers/connection';
import { parseFeed } from '../convex/indexers/feed.ts';
import { detectKind } from '../convex/indexers/newznab';
import apiLimitsCamel from './fixtures/newznab/apilimits-camel.xml?raw';
import apiLimitsLower from './fixtures/newznab/apilimits-lower.xml?raw';
import badScheme from './fixtures/newznab/bad-scheme.xml?raw';
import capsDefaults from './fixtures/newznab/caps-defaults.xml?raw';
import capsFull from './fixtures/newznab/caps-full.xml?raw';
import empty from './fixtures/newznab/empty.xml?raw';
import error100 from './fixtures/newznab/error-100.xml?raw';
import error500 from './fixtures/newznab/error-500.xml?raw';
import error910 from './fixtures/newznab/error-910.xml?raw';
import pageLast from './fixtures/newznab/page-last.xml?raw';
import torznabMagnet from './fixtures/torznab/magnet.xml?raw';
import torznabPage from './fixtures/torznab/page.xml?raw';
import { useFetchFakes } from './setup';

const at = { host: 'indexer.example', path: '/api', protocol: 'usenet' } as const;

/** The Newznab and Torznab adapters take no pacing slot, so they get no action context. */
const createAdapter = (indexer: Omit<AdapterIndexer, 'id'>, options?: { timeoutMs?: number }) =>
  createAdapterFor(
    { id: 'unpaced' as Id<'indexers'>, ...indexer },
    { runMutation: () => Promise.reject(new Error('not paced')), runQuery: () => Promise.reject(new Error('not relayed')) },
    options,
  );

describe('feed.ts: Newznab results', () => {
  test('reads each item, the response offset and total', () => {
    const result = parseFeed(pageLast, at);
    expect(result).toEqual({
      ok: true,
      value: {
        offset: 100,
        total: 102,
        items: [
          {
            guid: 'https://indexer.example/details/0a1b2c3d',
            title: 'The.Long.Harbor.S01E02.1080p.WEB-DL.DDP5.1.H.264-GRPA',
            downloadUrl: 'https://indexer.example/getnzb/0a1b2c3d.nzb&i=1&r=planted-newznab-key',
            sizeBytes: 1_500_000_000,
            protocol: 'usenet',
            publishedAt: Date.UTC(2026, 10, 10, 18, 30),
            categories: [5000, 5040],
            ids: { tvdbid: '7700001', imdbid: '9900001' },
          },
          {
            guid: '5e6f7a8b',
            title: 'Quiet Orchard 2024 2160p WEB-DL DDP5.1 HDR10 H.265-GRPB',
            downloadUrl: 'https://indexer.example/getnzb/5e6f7a8b.nzb&i=1&r=planted-newznab-key',
            sizeBytes: 8_000_000_000,
            protocol: 'usenet',
            publishedAt: Date.UTC(2026, 10, 9, 7, 5),
            categories: [2045],
            ids: { imdbid: '9900101', tmdbid: '900101' },
          },
        ],
      },
    });
  });

  test('decodes numeric (decimal and hex) and named entities in titles and fields', () => {
    const item = (title: string, guid: string) =>
      `<item><title>${title}</title><guid>${guid}</guid><enclosure url="https://indexer.example/getnzb/${guid}.nzb" length="1"/></item>`;
    const xml = `<?xml version="1.0"?><rss><channel>${[
      item('Kino&#39;s Journey S01E01 1080p', 'apostrophe'),
      item('Kino&#x27;s Journey &#X2014; S01E02 &amp; More', 'hex'),
      item('Tom &quot;and&quot; Jerry&apos;s &lt;Show&gt; &eacute;t&eacute; &nbsp;S01E03', 'named'),
      item('Caf&eacute; &amp;amp; S01E04', 'once'),
      item('Unknown &bogus; S01E05', 'unknown&#39;guid'),
    ].join('')}</channel></rss>`;
    const result = parseFeed(xml, at);
    if (!result.ok) throw new Error('expected a page');
    expect(result.value.items.map((i) => [i.guid, i.title])).toEqual([
      ['apostrophe', "Kino's Journey S01E01 1080p"],
      ['hex', "Kino's Journey — S01E02 & More"],
      ['named', 'Tom "and" Jerry\'s <Show> été  S01E03'],
      ['once', 'Café &amp; S01E04'],
      ["unknown'guid", 'Unknown &bogus; S01E05'],
    ]);
  });

  test('drops items whose download URL is not http, https or magnet, and reads a missing or non-numeric size as 0', () => {
    const result = parseFeed(badScheme, at);
    if (!result.ok) throw new Error('expected a page');
    expect(result.value.items.map((item) => [item.guid, item.sizeBytes])).toEqual([
      ['plain-http', 0],
      ['magnet', 0],
    ]);
  });
});

describe('feed.ts: Torznab results', () => {
  const tracker = { host: 'tracker.example', path: '/api', protocol: 'torrent' } as const;

  test('reads the torznab:attr fields into the item’s torrent, the info hash normalized, and imdb as the spec spells it', () => {
    const result = parseFeed(torznabPage, tracker);
    expect(result).toEqual({
      ok: true,
      value: {
        offset: 0,
        items: [
          {
            guid: 'https://tracker.example/details/42',
            title: 'The.Long.Harbor.S01E03.1080p.WEB-DL.DDP5.1.H.264-GRPA',
            downloadUrl: 'https://tracker.example/dl/42?passkey=planted-torznab-passkey',
            sizeBytes: 1_500_000_000,
            protocol: 'torrent',
            publishedAt: Date.UTC(2026, 10, 10, 18, 30),
            categories: [5040],
            ids: { tvdbid: '7700001' },
            torrent: {
              infoHash: 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a',
              magnetUrl:
                'magnet:?xt=urn:btih:C12FE1C06BBA254A9DC9F519B335AA7C1367A88A&dn=The.Long.Harbor&tr=https%3A%2F%2Ftracker.example%2Fannounce%3Fpasskey%3Dplanted-torznab-passkey',
              seeders: 12,
              peers: 15,
              minimumRatio: 1,
              minimumSeedTimeSec: 259_200,
              downloadVolumeFactor: 0,
            },
          },
          {
            guid: 'https://tracker.example/details/43',
            title: 'Quiet.Orchard.2024.1080p.WEB-DL.DDP5.1.H.264-GRPB',
            downloadUrl: 'https://tracker.example/dl/43?passkey=planted-torznab-passkey',
            sizeBytes: 6_000_000_000,
            protocol: 'torrent',
            publishedAt: Date.UTC(2026, 10, 9, 7, 5),
            categories: [2040],
            ids: { imdbid: '9900101' },
            // No infohash attribute: the hash comes from the magnet's base32 btih.
            torrent: {
              infoHash: '00443214c74254b635cf84653a56d7c675be77df',
              magnetUrl: 'magnet:?xt=urn:btih:ABCDEFGHIJKLMNOPQRSTUVWXYZ234567&dn=Quiet.Orchard',
              seeders: 0,
            },
          },
        ],
      },
    });
  });

  test('an item that links only a magnet keeps it as its download URL and its magnet, with the hash from btih or btmh', () => {
    const result = parseFeed(torznabMagnet, tracker);
    if (!result.ok) throw new Error('expected a page');
    expect(result.value.items.map((item) => [item.guid, item.sizeBytes, item.downloadUrl.slice(0, 20), item.torrent])).toEqual([
      [
        'public-44',
        1_400_000_000,
        'magnet:?xt=urn:btih:',
        {
          infoHash: '0123456789abcdef0123456789abcdef01234567',
          magnetUrl: result.value.items[0]!.downloadUrl,
          seeders: 3,
          peers: 4,
        },
      ],
      ['public-45', 1_400_000_000, 'magnet:?xt=urn:btmh:', { infoHash: 'ab'.repeat(20), magnetUrl: result.value.items[1]!.downloadUrl, seeders: 5 }],
    ]);
  });

  test('a Newznab page gets no torrent field', () => {
    const result = parseFeed(pageLast, at);
    expect(result.ok && result.value.items.every((item) => item.torrent === undefined)).toBe(true);
  });
});

describe('feed.ts: empty results, API limits and bodies that are no feed', () => {
  test('an empty result is a page with no items', () => {
    expect(parseFeed(empty, at)).toEqual({ ok: true, value: { items: [], offset: 0, total: 0 } });
  });

  test('reads the lowercase apilimits spelling', () => {
    const result = parseFeed(apiLimitsLower, at);
    expect(result.ok && result.value.apiLimits).toEqual({ apiCurrent: 42, apiMax: 100, apiOldestTime: Date.UTC(2026, 10, 17, 6, 15) });
  });

  test('reads the camelCase apilimits spelling', () => {
    const result = parseFeed(apiLimitsCamel, at);
    expect(result.ok && result.value.apiLimits).toEqual({ apiCurrent: 100, apiMax: 100, apiNextAvailable: Date.UTC(2026, 10, 17, 14, 5) });
  });

  test('an error body keeps its apilimits, and a non-limit code at the maximum is a rate limit', () => {
    const xml = '<error code="203" description="Function not available"><newznab:apilimits apicurrent="100" apimax="100"/></error>';
    expect(parseFeed(xml, at)).toEqual({
      ok: false,
      failure: {
        kind: 'rateLimited',
        code: 'indexerRateLimited',
        errorCode: 203,
        apiLimits: { apiCurrent: 100, apiMax: 100 },
        host: 'indexer.example',
        path: '/api',
      },
    });
  });

  test.each([
    ['HTML', '<!doctype html><html><body>Login</body></html>'],
    ['JSON', '{"error":"nope"}'],
    ['an empty body', ''],
    ['an RSS document without a channel', '<rss version="2.0"></rss>'],
  ])('%s is notAnIndexerApi', (_name, body) => {
    expect(parseFeed(body, at)).toEqual({ ok: false, failure: { kind: 'notAnIndexerApi', code: 'indexerError', host: 'indexer.example', path: '/api' } });
  });
});

describe('feed.ts: a 200 body that is an <error> element', () => {
  const error = (code: string, description: string) => `<?xml version="1.0"?><error code="${code}" description="${description}"/>`;

  test.each([
    ['code 100', error100, 'authRejected', 'indexerError', 100],
    ['code 101', error('101', 'Account suspended'), 'authRejected', 'indexerError', 101],
    ['code 102', error('102', 'Insufficient privileges'), 'authRejected', 'indexerError', 102],
    ['code 500', error500, 'rateLimited', 'indexerRateLimited', 500],
    ['"limit reached" under another code', error('429', 'Daily Request Limit Reached'), 'rateLimited', 'indexerRateLimited', 429],
    ['code 910', error910, 'apiDisabled', 'indexerError', 910],
    ['another code', error('201', 'Incorrect parameter'), 'indexerError', 'indexerError', 201],
  ])('%s → %s', (_name, xml, kind, code, errorCode) => {
    expect(parseFeed(xml, at)).toEqual({ ok: false, failure: { kind, code, errorCode, host: 'indexer.example', path: '/api' } });
  });

  test("the indexer's description text never reaches the failure", () => {
    expect(JSON.stringify(parseFeed(error500, at))).not.toMatch(/Request limit/i);
  });
});

const NOW = Date.UTC(2026, 10, 17, 12);

describe('caps.ts', () => {
  test('reads the search modes with their supportedParams, the page limit and the categories with their parents', () => {
    const result = parseCaps(capsFull, at, NOW);
    if (!result.ok) throw new Error('expected caps');
    expect(result.value.searchModes).toEqual([
      { mode: 'search', available: true, supportedParams: ['q'] },
      { mode: 'tv-search', available: true, supportedParams: ['q', 'rid', 'tvdbid', 'tmdbid', 'season', 'ep'] },
      { mode: 'movie-search', available: true, supportedParams: ['q', 'imdbid'] },
    ]);
    expect(result.value.pageLimit).toEqual({ max: 100, default: 50 });
    expect(result.value.fetchedAt).toBe(NOW);
    expect(result.value.categories).toContainEqual({ id: 100040, name: 'TV HEVC', parentId: 5000 });
    expect(result.value.categories).toContainEqual({ id: 5000, name: 'TV' });
  });

  test('without supportedParams the Torznab 1.1 defaults apply, marked as defaults; a missing mode is unavailable', () => {
    const result = parseCaps(capsDefaults, at, NOW);
    if (!result.ok) throw new Error('expected caps');
    expect(result.value.searchModes).toEqual([
      { mode: 'search', available: true, supportedParams: ['q'], defaulted: true },
      { mode: 'tv-search', available: true, supportedParams: ['q', 'rid', 'season', 'ep'], defaulted: true },
      { mode: 'movie-search', available: false, supportedParams: ['q', 'imdbid'], defaulted: true },
    ]);
    expect(result.value.pageLimit).toEqual({});
  });

  test('a body that is no caps is notAnIndexerApi; an error body keeps its kind', () => {
    expect(parseCaps('<html></html>', at, NOW)).toMatchObject({ ok: false, failure: { kind: 'notAnIndexerApi' } });
    expect(parseCaps(error100, at, NOW)).toMatchObject({ ok: false, failure: { kind: 'authRejected', errorCode: 100 } });
  });

  test('default categories: 5000 and its children plus site categories under 5000; 2000 and its children', () => {
    const result = parseCaps(capsFull, at, NOW);
    if (!result.ok) throw new Error('expected caps');
    expect(defaultCategories(result.value)).toEqual({ series: [5000, 5040, 5070, 100040], movies: [2000, 2040, 2045] });
  });

  test.each([
    ['https://indexer.example', 'https://indexer.example/api'],
    ['https://indexer.example/', 'https://indexer.example/api'],
    ['https://indexer.example/api/', 'https://indexer.example/api'],
    ['https://indexer.example/api?apikey=secret&t=caps', 'https://indexer.example/api'],
    ['http://jackett:9117/api/v2.0/indexers/x/results/torznab/api', 'http://jackett:9117/api/v2.0/indexers/x/results/torznab/api'],
    ['https://indexer.example/newznab', 'https://indexer.example/newznab/api'],
  ])('normalizes %s to %s', (url, apiUrl) => {
    expect(normalizeApiUrl(url)).toBe(apiUrl);
  });

  test('a URL that is not http or https is refused', () => {
    expect(normalizeApiUrl('ftp://indexer.example')).toBeUndefined();
    expect(normalizeApiUrl('not a url')).toBeUndefined();
  });
});

describe('detectKind', () => {
  test('a Newznab result is newznab, a Torznab one torznab', () => {
    expect(detectKind(pageLast)).toBe('newznab');
    expect(detectKind(torznabPage)).toBe('torznab');
  });

  test('an empty result falls back to the namespace declared on the feed', () => {
    expect(detectKind(empty)).toBe('newznab');
    expect(detectKind('<rss xmlns:torznab="http://torznab.com/schemas/2015/feed"><channel></channel></rss>')).toBe('torznab');
  });

  test('nothing decides it: undefined', () => {
    expect(detectKind('<rss version="2.0"><channel><title>x</title></channel></rss>')).toBeUndefined();
  });
});

describe('the Newznab adapter against the fake', () => {
  const KEY = 'planted-indexer-key-7f3a';
  let fake: NewznabHandler;
  beforeEach(() => {
    fake = createNewznabHandler({ apiKey: KEY, pageMax: 2 });
    useFetchFakes({ indexers: { 'indexer.fake': fake.handle } });
  });
  afterEach(() => vi.unstubAllGlobals());

  const indexer = { apiUrl: 'https://indexer.fake/api', apiKey: KEY, kind: 'newznab' as const, categories: { series: [5000], movies: [2000] } };
  const request = { fn: 'tvsearch' as const, ids: { tvdbid: '7700001' }, season: '1', categories: [5000], limit: 2, offset: 0 };

  test('sends a request with its parameters and the key, and reads the page', async () => {
    const result = await createAdapter(indexer).search(request);
    if (!result.ok) throw new Error('expected a page');
    expect(result.value.items.map((item) => item.title)).toEqual([
      'The.Long.Harbor.S01.1080p.WEB-DL.DDP5.1.H.264-GRPA',
      'The.Long.Harbor.S01E02.1080p.WEB-DL.DDP5.1.H.264-GRPA',
    ]);
    expect(Object.fromEntries(fake.requests[0]!)).toMatchObject({
      t: 'tvsearch',
      tvdbid: '7700001',
      season: '1',
      cat: '5000',
      limit: '2',
      offset: '0',
      apikey: KEY,
    });
  });

  test('caps parses through the adapter', async () => {
    const result = await createAdapter(indexer).caps();
    expect(result.ok && result.value.pageLimit).toEqual({ max: 2, default: 2 });
  });

  test('rss asks t=search with both category lists and no query', async () => {
    await createAdapter({ ...indexer, caps: { pageLimit: { max: 2 } } }).rss({ offset: 0 });
    expect(Object.fromEntries(fake.requests[0]!)).toMatchObject({ t: 'search', cat: '5000,2000', limit: '2', offset: '0' });
    expect(fake.requests[0]!.has('q')).toBe(false);
  });

  const failures: [string, (f: NewznabHandler) => void, Record<string, unknown>][] = [
    ['wrong key (code 100)', (f) => f.setFailure({ kind: 'wrongKey' }), { kind: 'authRejected', code: 'indexerError', errorCode: 100 }],
    ['code 500', (f) => f.setFailure({ kind: 'limit500' }), { kind: 'rateLimited', code: 'indexerRateLimited', errorCode: 500 }],
    ['HTTP 429 with Retry-After', (f) => f.setFailure({ kind: 'http429', retryAfter: '120' }), { kind: 'rateLimited', httpStatus: 429, retryAfter: '120' }],
    ['HTTP 429 without Retry-After', (f) => f.setFailure({ kind: 'http429' }), { kind: 'rateLimited', httpStatus: 429 }],
    ['a body that is no API', (f) => f.setFailure({ kind: 'notAnApi' }), { kind: 'notAnIndexerApi', code: 'indexerError' }],
  ];

  test('a page whose apilimits are at their maximum is still a page, with its items and the limits (decision 2026-11-17)', async () => {
    fake.setFailure({ kind: 'apilimitsAtMax' });
    const result = await createAdapter(indexer).search(request);
    if (!result.ok) throw new Error('expected a page');
    expect(result.value.items).toHaveLength(2);
    expect(result.value.apiLimits).toEqual({ apiCurrent: 100, apiMax: 100 });
  });

  test.each(failures)('%s', async (_name, arrange, expected) => {
    arrange(fake);
    const result = await createAdapter(indexer).search(request);
    expect(result).toMatchObject({ ok: false, failure: { ...expected, host: 'indexer.fake', path: '/api' } });
    expect(JSON.stringify(result)).not.toContain(KEY);
  });

  test('no answer in time is a timeout', async () => {
    fake.setFailure({ kind: 'timeout' });
    const result = await createAdapter(indexer, { timeoutMs: 50 }).search(request);
    expect(result).toEqual({ ok: false, failure: { kind: 'timeout', code: 'indexerTimeout', host: 'indexer.fake', path: '/api' } });
  });

  test('a host that refuses the connection is unreachable', async () => {
    const result = await createAdapter({ ...indexer, apiUrl: 'https://gone.fake/api' }).search(request);
    expect(result).toEqual({ ok: false, failure: { kind: 'unreachable', code: 'indexerError', host: 'gone.fake', path: '/api' } });
  });

  test('HTTP 401 and 403 reject the key; another status is httpError', async () => {
    for (const [status, kind] of [
      [401, 'authRejected'],
      [403, 'authRejected'],
      [502, 'httpError'],
    ] as const) {
      useFetchFakes({ indexers: { 'indexer.fake': async () => new Response('nope', { status }) } });
      const result = await createAdapter(indexer).search(request);
      expect(result).toEqual({ ok: false, failure: { kind, code: 'indexerError', httpStatus: status, host: 'indexer.fake', path: '/api' } });
    }
  });

  test('code 910 is apiDisabled', async () => {
    useFetchFakes({ indexers: { 'indexer.fake': async () => new Response(error910) } });
    expect(await createAdapter(indexer).search(request)).toMatchObject({ ok: false, failure: { kind: 'apiDisabled', errorCode: 910 } });
  });
});

describe('the Torznab adapter against the fake in Torznab mode', () => {
  const KEY = 'planted-torznab-key-51c2';
  const items = [
    {
      guid: 'tor-1',
      title: 'The.Long.Harbor.S01E03.1080p.WEB-DL.DDP5.1.H.264-GRPA',
      categories: [5000, 5040],
      sizeBytes: 1_500_000_000,
      publishedAt: '2026-11-10T18:30:00Z',
      ids: { tvdbid: '7700001' },
      torrent: { infoHash: 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a', seeders: 9, peers: 11, minimumSeedTimeSec: 259_200, file: new Uint8Array([1]) },
    },
  ];
  beforeEach(() => {
    useFetchFakes({ indexers: { 'tracker.fake': createNewznabHandler({ apiKey: KEY, kind: 'torznab', items }).handle } });
  });
  afterEach(() => vi.unstubAllGlobals());

  const indexer = { apiUrl: 'https://tracker.fake/api', apiKey: KEY, kind: 'torznab' as const, categories: { series: [5000], movies: [2000] } };

  test('a search returns torrent items with their seeders, info hash, magnet and minimums', async () => {
    const result = await createAdapter(indexer).search({ fn: 'tvsearch', ids: { tvdbid: '7700001' }, season: '1', categories: [5000], limit: 100, offset: 0 });
    if (!result.ok) throw new Error('expected a page');
    expect(result.value.items).toEqual([
      expect.objectContaining({
        guid: 'https://tracker.fake/details/tor-1',
        protocol: 'torrent',
        downloadUrl: `https://tracker.fake/dl/tor-1.torrent?apikey=${KEY}`,
        torrent: {
          infoHash: 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a',
          magnetUrl: 'magnet:?xt=urn:btih:c12fe1c06bba254a9dc9f519b335aa7c1367a88a&dn=The.Long.Harbor.S01E03.1080p.WEB-DL.DDP5.1.H.264-GRPA',
          seeders: 9,
          peers: 11,
          minimumSeedTimeSec: 259_200,
        },
      }),
    ]);
  });

  test('the connection test detects Torznab', async () => {
    const test = await testConnection(indexer);
    expect(test.result).toMatchObject({ ok: true, kind: 'torznab' });
  });
});

describe('testConnection', () => {
  const KEY = 'planted-indexer-key-7f3a';
  let fake: NewznabHandler;
  beforeEach(() => {
    fake = createNewznabHandler({ apiKey: KEY, pageMax: 50, apiLimits: { current: 10, max: 100 } });
    useFetchFakes({ indexers: { 'indexer.fake': fake.handle } });
  });
  afterEach(() => vi.unstubAllGlobals());

  test('reads caps, sends one search with limit=1, detects Newznab and reports the API limit, in two requests', async () => {
    const { result, calls, caps } = await testConnection({ apiUrl: 'https://indexer.fake/api', apiKey: KEY });
    expect(result).toMatchObject({ ok: true, kind: 'newznab', apiLimit: { max: 100, source: 'apilimits' } });
    expect(result.searchModes.find((m) => m.mode === 'tv-search')).toMatchObject({ available: true });
    expect(result.categories.map((c) => c.id)).toContain(5070);
    expect(caps?.pageLimit).toEqual({ max: 50, default: 50 });
    expect(fake.requests.map((q) => [q.get('t'), q.get('limit')])).toEqual([
      ['caps', null],
      ['search', '1'],
    ]);
    expect(calls).toMatchObject([
      { kind: 'test', ok: true },
      { kind: 'test', ok: true },
    ]);
  });

  test('a rejected key names the host and endpoint path, never the URL or key', async () => {
    const { result, calls } = await testConnection({ apiUrl: 'https://indexer.fake/api', apiKey: 'wrong' });
    expect(result).toMatchObject({ ok: false, failure: { kind: 'authRejected', errorCode: 100, host: 'indexer.fake', path: '/api' } });
    expect(calls).toHaveLength(1);
    expect(JSON.stringify(result)).not.toMatch(/apikey|wrong/);
  });

  test('an unreachable host and a page that is no API each get their own kind', async () => {
    expect((await testConnection({ apiUrl: 'https://gone.fake/api', apiKey: KEY })).result.failure).toMatchObject({ kind: 'unreachable', host: 'gone.fake' });
    fake.setFailure({ kind: 'notAnApi' });
    expect((await testConnection({ apiUrl: 'https://indexer.fake/api', apiKey: KEY })).result.failure).toMatchObject({ kind: 'notAnIndexerApi' });
  });
});
