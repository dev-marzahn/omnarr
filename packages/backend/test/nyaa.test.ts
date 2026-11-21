import { afterEach, describe, expect, test, vi } from 'vite-plus/test';

import { createNyaaAdapter, NYAA_CAPS, readFeed, readListing } from '../convex/indexers/nyaa';
import { parseSizeText } from '../convex/indexers/sizeText';
import cloudflare from './fixtures/nyaa/cloudflare.html?raw';
import ddosGuard from './fixtures/nyaa/ddos-guard.html?raw';
import feed from './fixtures/nyaa/feed.xml?raw';
import listing from './fixtures/nyaa/listing.html?raw';
import noResults from './fixtures/nyaa/no-results.html?raw';
import unrelated from './fixtures/nyaa/unrelated.html?raw';

const at = { host: 'nyaa.si', path: '/' };

/** A feed of `n` items, newest first, each with its own ID and hash: a full page at 75. */
function fullFeed(n: number): string {
  const items = Array.from({ length: n }, (_, i) => {
    const hash = (i + 1).toString(16).padStart(40, '0');
    return `<item><title>[GroupA] Harbour Lights - ${String(n - i).padStart(2, '0')} (1080p).mkv</title><link>magnet:?xt=urn:btih:${hash}</link><guid isPermaLink="true">https://nyaa.si/view/${2_000_000 - i}</guid><pubDate>Tue, 11 Nov 2025 18:40:00 -0000</pubDate><nyaa:seeders>1</nyaa:seeders><nyaa:leechers>0</nyaa:leechers><nyaa:infoHash>${hash}</nyaa:infoHash><nyaa:size>1.0 GiB</nyaa:size></item>`;
  });
  return `<rss xmlns:nyaa="https://nyaa.si/xmlns/nyaa" version="2.0"><channel><title>Nyaa</title>${items.join('')}</channel></rss>`;
}

describe('nyaa.ts: readFeed (RSS items)', () => {
  test("reads every IndexerItem field from the feed's items", () => {
    const result = readFeed(feed, at);
    expect(result.ok && result.value.items).toEqual([
      {
        guid: 'https://nyaa.si/view/1900201',
        title: '[GroupA] Harbour Lights - 1071 (1080p) [ABCD1234].mkv',
        downloadUrl:
          'magnet:?xt=urn:btih:0a1b2c3d4e5f60718293a4b5c6d7e8f901234567&dn=%5BGroupA%5D%20Harbour%20Lights%20-%201071&tr=http%3A%2F%2Ftracker.example%3A7777%2Fannounce',
        sizeBytes: 1_503_238_554,
        protocol: 'torrent',
        publishedAt: Date.UTC(2025, 10, 11, 18, 40),
        categories: [],
        ids: {},
        torrent: {
          infoHash: '0a1b2c3d4e5f60718293a4b5c6d7e8f901234567',
          magnetUrl:
            'magnet:?xt=urn:btih:0a1b2c3d4e5f60718293a4b5c6d7e8f901234567&dn=%5BGroupA%5D%20Harbour%20Lights%20-%201071&tr=http%3A%2F%2Ftracker.example%3A7777%2Fannounce',
          seeders: 120,
          peers: 128,
        },
      },
      {
        guid: 'https://nyaa.si/view/1900200',
        title: "[GroupB] Harbour Lights S2 - 02v2 (720p) [Tom & Jerry's cut]",
        downloadUrl: 'magnet:?xt=urn:btih:BBBB1111CCCC2222DDDD3333EEEE4444FFFF6666&dn=%5BGroupB%5D',
        sizeBytes: 367_525_888,
        protocol: 'torrent',
        publishedAt: Date.UTC(2025, 10, 10, 18, 40),
        categories: [],
        ids: {},
        torrent: {
          infoHash: 'bbbb1111cccc2222dddd3333eeee4444ffff6666',
          magnetUrl: 'magnet:?xt=urn:btih:BBBB1111CCCC2222DDDD3333EEEE4444FFFF6666&dn=%5BGroupB%5D',
          seeders: 45,
          peers: 45,
        },
      },
    ]);
  });

  test('drops an item without a 40-hex info hash or without a magnet link', () => {
    const result = readFeed(feed, at);
    expect(result.ok && result.value.items.map((item) => item.guid)).not.toContain('https://nyaa.si/view/1900199');
    expect(result.ok && result.value.items.map((item) => item.guid)).not.toContain('https://nyaa.si/view/1900198');
  });

  test('a feed from any host is read by its namespace; an empty feed is an empty page', () => {
    const moved = readFeed(feed.replaceAll('https://nyaa.si/', 'http://nyaa:4140/'), at);
    expect(moved.ok && moved.value.items.map((item) => item.guid)).toEqual(['http://nyaa:4140/view/1900201', 'http://nyaa:4140/view/1900200']);
    expect(readFeed('<rss xmlns:nyaa="https://nyaa.si/xmlns/nyaa" version="2.0"><channel><title>Nyaa</title></channel></rss>', at)).toEqual({
      ok: true,
      value: { items: [], offset: 0 },
    });
  });

  test("a body that isn't Nyaa's feed is unexpectedPage, naming the host and path", () => {
    const failure = { ok: false, failure: { kind: 'unexpectedPage', code: 'indexerError', host: 'nyaa.si', path: '/' } };
    expect(readFeed(unrelated, at)).toEqual(failure);
    expect(readFeed('<rss version="2.0"><channel><title>Another feed</title></channel></rss>', at)).toEqual(failure);
    expect(readFeed('not xml <<<', at)).toEqual(failure);
  });
});

describe('nyaa.ts: readListing (HTML rows)', () => {
  test("reads the default, success and danger rows' cells, and skips deleted and hidden rows and rows without a magnet", () => {
    const result = readListing(listing, 'https://nyaa.si', at);
    expect(result.ok && result.value.items).toEqual([
      {
        guid: 'https://nyaa.si/view/1900103',
        title: '[GroupA] Harbour Lights - 03 (1080p) [0A1B2C3D].mkv',
        downloadUrl:
          'magnet:?xt=urn:btih:AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555&dn=%5BGroupA%5D%20Harbour%20Lights%20-%2003&tr=http%3A%2F%2Ftracker.example%3A7777%2Fannounce',
        sizeBytes: 1_503_238_554,
        protocol: 'torrent',
        publishedAt: Date.UTC(2025, 10, 11, 18, 40),
        categories: [],
        ids: {},
        torrent: {
          infoHash: 'aaaa1111bbbb2222cccc3333dddd4444eeee5555',
          magnetUrl:
            'magnet:?xt=urn:btih:AAAA1111BBBB2222CCCC3333DDDD4444EEEE5555&dn=%5BGroupA%5D%20Harbour%20Lights%20-%2003&tr=http%3A%2F%2Ftracker.example%3A7777%2Fannounce',
          seeders: 120,
          peers: 128,
        },
      },
      {
        guid: 'https://nyaa.si/view/1900102',
        title: "[GroupB] Harbour Lights S2 - 02v2 (720p) [Tom & Jerry's cut]",
        downloadUrl: 'magnet:?xt=urn:btih:bbbb1111cccc2222dddd3333eeee4444ffff6666&dn=%5BGroupB%5D%20Harbour%20Lights',
        sizeBytes: 367_525_888,
        protocol: 'torrent',
        publishedAt: Date.UTC(2025, 10, 10, 18, 40),
        categories: [],
        ids: {},
        torrent: {
          infoHash: 'bbbb1111cccc2222dddd3333eeee4444ffff6666',
          magnetUrl: 'magnet:?xt=urn:btih:bbbb1111cccc2222dddd3333eeee4444ffff6666&dn=%5BGroupB%5D%20Harbour%20Lights',
          seeders: 45,
          peers: 45,
        },
      },
      {
        guid: 'https://nyaa.si/view/1900101',
        title: '[GroupC] Harbour Lights - 01 [Remake]',
        downloadUrl: 'magnet:?xt=urn:btih:cccc1111dddd2222eeee3333ffff4444aaaa7777&dn=%5BGroupC%5D',
        sizeBytes: 2_147_483_648,
        protocol: 'torrent',
        publishedAt: Date.UTC(2025, 10, 9, 18, 40),
        categories: [],
        ids: {},
        torrent: {
          infoHash: 'cccc1111dddd2222eeee3333ffff4444aaaa7777',
          magnetUrl: 'magnet:?xt=urn:btih:cccc1111dddd2222eeee3333ffff4444aaaa7777&dn=%5BGroupC%5D',
          seeders: 3,
          peers: 4,
        },
      },
    ]);
  });

  test('"No results found" is an empty page; a page with neither the table nor that heading is unexpectedPage', () => {
    expect(readListing(noResults, 'https://nyaa.si', at)).toEqual({ ok: true, value: { items: [], offset: 0 } });
    expect(readListing(unrelated, 'https://nyaa.si', at)).toEqual({
      ok: false,
      failure: { kind: 'unexpectedPage', code: 'indexerError', host: 'nyaa.si', path: '/' },
    });
  });
});

describe('nyaa.ts: the adapter (requests)', () => {
  afterEach(() => vi.unstubAllGlobals());

  /** `fetch` answering each request with `answer(url)`, the URLs and headers kept. */
  function serve(answer: (url: URL) => Response) {
    const seen: { url: URL; headers: Headers }[] = [];
    vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      seen.push({ url: new URL(request.url), headers: request.headers });
      return answer(new URL(request.url));
    });
    return seen;
  }
  const html = (body: string) => new Response(body, { headers: { 'content-type': 'text/html' } });
  const go = async () => 'go' as const;
  const adapter = (pace: () => Promise<'go' | 'skip'> = go) => createNyaaAdapter({ apiUrl: 'https://nyaa.si' }, { pace });
  const request = { fn: 'search' as const, q: 'Harbour Lights 03', categories: [5070], limit: 75 };

  test('offset 0 is the feed with m=1; offset 75 × (n − 1) is the listing page n, sorted by ID', async () => {
    const seen = serve((url) => (url.searchParams.get('page') === 'rss' ? new Response(feed) : html(listing)));
    await adapter().search({ ...request, offset: 0 });
    await adapter().search({ ...request, offset: 75 });
    await adapter().search({ ...request, offset: 150 });
    expect(seen.map(({ url }) => `${url.pathname}${url.search}`)).toEqual([
      '/?page=rss&q=Harbour+Lights+03&c=1_0&f=0&m=1',
      '/?q=Harbour+Lights+03&c=1_0&f=0&s=id&o=desc&p=2',
      '/?q=Harbour+Lights+03&c=1_0&f=0&s=id&o=desc&p=3',
    ]);
    expect(seen.every(({ headers }) => /^omnarr\/\S+$/.test(headers.get('user-agent') ?? ''))).toBe(true);
  });

  test('RSS is the feed without q, and its later pages the listing without q; a listing page carries its offset', async () => {
    const seen = serve((url) => (url.searchParams.get('page') === 'rss' ? new Response(fullFeed(75)) : html(listing)));
    const first = await adapter().rss({ offset: 0 });
    const second = await adapter().rss({ offset: 75 });
    expect(seen.map(({ url }) => `${url.pathname}${url.search}`)).toEqual(['/?page=rss&c=1_0&f=0&m=1', '/?c=1_0&f=0&s=id&o=desc&p=2']);
    expect(first.ok && first.value.items).toHaveLength(75);
    expect(second.ok && { offset: second.value.offset, count: second.value.items.length }).toEqual({ offset: 75, count: 3 });
  });

  test('caps are the constants, with no request', async () => {
    const seen = serve(() => new Response('', { status: 500 }));
    const caps = await adapter().caps();
    expect(seen).toHaveLength(0);
    expect(caps.ok && { ...caps.value, fetchedAt: 0 }).toEqual({ ...NYAA_CAPS, fetchedAt: 0 });
    expect(NYAA_CAPS.searchModes).toEqual([
      { mode: 'search', available: true, supportedParams: ['q'] },
      { mode: 'tv-search', available: false, supportedParams: [] },
      { mode: 'movie-search', available: false, supportedParams: [] },
    ]);
    expect(NYAA_CAPS.pageLimit).toEqual({ max: 75, default: 75 });
    expect(NYAA_CAPS.categories).toEqual([
      { id: 2000, name: 'Movies' },
      { id: 5000, name: 'TV' },
      { id: 5070, name: 'TV/Anime', parentId: 5000 },
    ]);
  });

  test('a refused pacing slot sends nothing and returns the paced skip', async () => {
    const seen = serve(() => new Response(feed));
    expect(await adapter(async () => 'skip').search({ ...request, offset: 0 })).toEqual({ ok: false, skipped: 'paced' });
    expect(await adapter(async () => 'skip').rss({ offset: 0 })).toEqual({ ok: false, skipped: 'paced' });
    expect(seen).toHaveLength(0);
  });

  test('a DDoS-Guard 503 and a Cloudflare 403 are challenged; a 200 page that is not Nyaa is unexpectedPage; 429 is rateLimited', async () => {
    const answers: Response[] = [
      new Response(ddosGuard, { status: 503, headers: { server: 'ddos-guard' } }),
      new Response(cloudflare, { status: 403 }),
      new Response('error code: 1020', { status: 403 }),
      html(unrelated),
      new Response('', { status: 429, headers: { 'retry-after': '120' } }),
      new Response('Forbidden', { status: 403 }),
    ];
    serve(() => answers.shift()!);
    const kinds = [];
    for (let i = 0; i < 6; i++) {
      const result = await adapter().rss({ offset: 0 });
      kinds.push(result.ok ? 'ok' : result.failure);
    }
    expect(kinds).toEqual([
      { kind: 'challenged', code: 'indexerRateLimited', httpStatus: 503, challenge: 'ddosGuard', host: 'nyaa.si', path: '/' },
      { kind: 'challenged', code: 'indexerRateLimited', httpStatus: 403, challenge: 'cloudflare', host: 'nyaa.si', path: '/' },
      { kind: 'challenged', code: 'indexerRateLimited', httpStatus: 403, challenge: 'cloudflare', host: 'nyaa.si', path: '/' },
      { kind: 'unexpectedPage', code: 'indexerError', host: 'nyaa.si', path: '/' },
      { kind: 'rateLimited', code: 'indexerRateLimited', httpStatus: 429, retryAfter: '120', host: 'nyaa.si', path: '/' },
      { kind: 'authRejected', code: 'indexerError', httpStatus: 403, host: 'nyaa.si', path: '/' },
    ]);
  });

  test('an unreachable host is unreachable, naming it and the path, never the query', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    expect(await adapter().search({ ...request, offset: 75 })).toEqual({
      ok: false,
      failure: { kind: 'unreachable', code: 'indexerError', host: 'nyaa.si', path: '/' },
    });
  });
});

describe('sizeText.ts: parseSizeText', () => {
  test('reads each unit as a power of 1024, with KB, MB, GB and TB as the same powers', () => {
    expect(parseSizeText('512 Bytes')).toBe(512);
    expect(parseSizeText('512 B')).toBe(512);
    expect(parseSizeText('1.5 KiB')).toBe(1536);
    expect(parseSizeText('1.5 KB')).toBe(1536);
    expect(parseSizeText('350.5 MiB')).toBe(367_525_888);
    expect(parseSizeText('2 MB')).toBe(2_097_152);
    expect(parseSizeText('1.4 GiB')).toBe(1_503_238_554);
    expect(parseSizeText('16.2 GB')).toBe(17_394_617_549);
    expect(parseSizeText('1 TiB')).toBe(1_099_511_627_776);
    expect(parseSizeText('1 TB')).toBe(1_099_511_627_776);
  });

  test('ignores case, surrounding space and thousands separators', () => {
    expect(parseSizeText('  1.4 gib ')).toBe(1_503_238_554);
    expect(parseSizeText('1,024 MiB')).toBe(1_073_741_824);
    expect(parseSizeText('1024MiB')).toBe(1_073_741_824);
  });

  test('anything else is 0, never NaN', () => {
    for (const text of ['', 'GiB', 'big', '1.4', '1.4 PiB', '-1 GiB', '1.2.3 GiB', 'NaN GiB']) expect(parseSizeText(text)).toBe(0);
  });
});
