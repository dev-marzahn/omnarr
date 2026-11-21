// The engine through its entry points: a hand-written definition,
// its requests (captured by an injected fetch) and pages, the IndexerItems,
// the failures, pacing, and the download block.
import { describe, expect, test } from 'vite-plus/test';

import { loadDefinition } from '../../src/sites/definition.ts';
import { download, type EngineDeps, rss, search, test as testIndexer } from '../../src/sites/engine.ts';
import { JSONSITE_BODY, JSONSITE_YML, LANTERN_EMPTY, LANTERN_PAGE, LANTERN_YML, variant } from './fixtures.ts';

const NOW = Date.UTC(2026, 10, 20, 12);

type Call = { url: string; init: RequestInit };

function fakeSite(routes: (url: string, init: RequestInit) => Response | undefined) {
  const calls: Call[] = [];
  let paced = 0;
  const deps: EngineDeps = {
    fetch: async (url, init) => {
      calls.push({ url, init });
      const response = routes(url, init);
      if (!response) throw new Error(`unexpected fetch of ${url}`);
      return response;
    },
    pace: async () => {
      paced++;
      return 'go';
    },
    now: () => NOW,
  };
  return { deps, calls, paced: () => paced };
}

const load = (yml: string) => {
  const loaded = loadDefinition(yml);
  if (!loaded.ok) throw new Error(loaded.detail);
  return loaded.definition;
};

let counter = 0;
/** A fresh indexer per test, so cookie jars don't leak between tests. */
const indexer = (settings = {}, baseUrl = 'https://lantern.test/') => ({ indexerId: `ix${++counter}`, baseUrl, settings });

const html = (body: string, init: ResponseInit = {}) => new Response(body, { status: 200, headers: { 'content-type': 'text/html' }, ...init });

describe('search', () => {
  test('builds the request from the IndexerRequest, the settings and the keyword filters, and maps the rows', async () => {
    const site = fakeSite(() => html(LANTERN_PAGE));
    const result = await search(
      indexer({ sort: 'seeders', freeleech: true }),
      load(LANTERN_YML),
      { fn: 'tvsearch', q: 'Star Lantern', season: '1', ep: '2', categories: [5070], limit: 100, offset: 0 },
      site.deps,
    );
    expect(site.calls.map((call) => call.url)).toEqual(['https://lantern.test/search/Star%20Lantern%201x02?cat=1&order=seeders&free=1']);
    expect(site.paced()).toBe(1);
    expect((site.calls[0]!.init.headers as Record<string, string>)['user-agent']).toMatch(/^omnarr\//);
    expect(result.ok).toBe(true);
    const items = result.ok ? result.value.items : [];
    expect(items).toEqual([
      {
        guid: 'https://lantern.test/torrent/101',
        title: '[Grp] Star Lantern - 02 (1080p)',
        downloadUrl: 'magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&dn=x',
        sizeBytes: 1_610_612_736,
        protocol: 'torrent',
        publishedAt: Date.UTC(2025, 2, 4, 5, 6),
        categories: [5070, 5000],
        ids: {},
        torrent: {
          infoHash: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          magnetUrl: 'magnet:?xt=urn:btih:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA&dn=x',
          seeders: 12,
          peers: 15,
          downloadVolumeFactor: 1,
        },
      },
      {
        guid: 'https://lantern.test/torrent/102',
        title: 'Lantern Movie 2024 1080p',
        downloadUrl: 'https://lantern.test/get/102.torrent',
        sizeBytes: 4_509_715_660,
        protocol: 'torrent',
        publishedAt: Date.UTC(2025, 2, 5, 6, 7),
        categories: [2000],
        ids: {},
        torrent: { seeders: 1024, peers: 1024, downloadVolumeFactor: 0 },
      },
    ]);
  });

  test('a keyword search with no rows is an empty page; RSS with no rows is unexpectedPage', async () => {
    const site = fakeSite(() => html(LANTERN_EMPTY));
    const definition = load(LANTERN_YML);
    expect(await search(indexer(), definition, { fn: 'search', q: 'nothing', categories: [], limit: 100, offset: 0 }, site.deps)).toEqual({
      ok: true,
      value: { items: [], offset: 0 },
    });
    expect(await rss(indexer(), definition, site.deps)).toMatchObject({
      ok: false,
      failure: { kind: 'unexpectedPage', host: 'lantern.test', path: '/latest' },
    });
  });

  test('RSS sends the keywordless path and the default category', async () => {
    const site = fakeSite(() => html(LANTERN_PAGE));
    const result = await rss(indexer(), load(LANTERN_YML), site.deps);
    expect(site.calls[0]!.url).toBe('https://lantern.test/latest?cat=3&order=added');
    expect(result.ok && result.value.items).toHaveLength(2);
  });

  test('a legacy base URL runs against the first link, and is reported once', async () => {
    const site = fakeSite(() => html(LANTERN_PAGE));
    const legacy: string[] = [];
    const deps = { ...site.deps, onLegacyLink: (_id: string, from: string, to: string) => legacy.push(`${from} -> ${to}`) };
    const ix = indexer({}, 'https://old.lantern.test/');
    await rss(ix, load(LANTERN_YML), deps);
    await rss(ix, load(LANTERN_YML), deps);
    expect(site.calls.map((call) => new URL(call.url).host)).toEqual(['lantern.test', 'lantern.test']);
    expect(legacy).toEqual(['https://old.lantern.test/ -> https://lantern.test/']);
  });

  test.each([
    ['a DDoS-Guard check', new Response('<title>DDOS-GUARD</title>', { status: 503 }), { kind: 'challenged', challenge: 'ddosGuard', httpStatus: 503 }],
    ['a Cloudflare server', new Response('x', { status: 403, headers: { server: 'cloudflare' } }), { kind: 'challenged', challenge: 'cloudflare' }],
    ['HTTP 429', new Response('x', { status: 429, headers: { 'retry-after': '120' } }), { kind: 'rateLimited', retryAfter: '120' }],
    [
      'a redirect',
      new Response(null, { status: 302, headers: { location: 'https://elsewhere.test/' } }),
      { kind: 'httpError', httpStatus: 302, redirectHost: 'elsewhere.test' },
    ],
    ['HTTP 500', new Response('x', { status: 500 }), { kind: 'httpError', httpStatus: 500 }],
  ])('%s is a failure naming the host and path only', async (_name, response, failure) => {
    const site = fakeSite(() => response);
    const result = await search(indexer(), load(LANTERN_YML), { fn: 'search', q: 'x', categories: [], limit: 100, offset: 0 }, site.deps);
    expect(result).toMatchObject({ ok: false, failure: { ...failure, host: 'lantern.test', path: '/search/x' } });
  });

  test('a refused pacing slot sends nothing', async () => {
    const site = fakeSite(() => html(LANTERN_PAGE));
    const result = await rss(indexer(), load(LANTERN_YML), { ...site.deps, pace: async () => 'skip' });
    expect(result).toEqual({ ok: false, skipped: 'paced' });
    expect(site.calls).toHaveLength(0);
  });

  test('duplicate GET URLs of several paths are sent once, and POST paths send a form', async () => {
    const yml = variant(
      LANTERN_YML,
      '  paths:\n    - path: "{{ if .Keywords }}search/{{ .Keywords }}{{ else }}latest{{ end }}"',
      '  paths:\n    - path: latest\n    - path: latest\n    - path: find\n      method: post',
    );
    const site = fakeSite(() => html(LANTERN_PAGE));
    await rss(indexer(), load(yml), site.deps);
    expect(site.calls.map((call) => `${call.init.method} ${call.url}`)).toEqual([
      'GET https://lantern.test/latest?cat=3&order=added',
      'POST https://lantern.test/find',
    ]);
    expect(site.calls[1]!.init.body).toBe('cat=3&order=added');
  });

  test('a windows-1251 site gets its query in that encoding and its page decoded from it', async () => {
    const yml = variant(LANTERN_YML, 'encoding: UTF-8', 'encoding: windows-1251');
    const page = LANTERN_PAGE.replace('[Grp] Star Lantern - 02 (1080p)', 'Звёздный фонарь - 02');
    const bytes = Uint8Array.from(
      Array.from(page, (char) =>
        char.charCodeAt(0) < 128
          ? char.charCodeAt(0)
          : (new Map(
              Array.from('Звёздный фонарь', (c, i) => [c, [0xc7, 0xe2, 0xb8, 0xe7, 0xe4, 0xed, 0xfb, 0xe9, 0x20, 0xf4, 0xee, 0xed, 0xe0, 0xf0, 0xfc][i]!]),
            ).get(char) ?? 0x3f),
      ),
    );
    const site = fakeSite(() => new Response(bytes, { status: 200 }));
    const result = await search(indexer(), load(yml), { fn: 'search', q: 'фонарь', categories: [], limit: 100, offset: 0 }, site.deps);
    expect(site.calls[0]!.url).toContain('/search/%D1%84%D0%BE%D0%BD%D0%B0%D1%80%D1%8C?');
    expect(result.ok && result.value.items[0]!.title).toBe('Звёздный фонарь - 02');
  });

  test('andmatch keeps the releases that name the search terms', async () => {
    const yml = variant(
      LANTERN_YML,
      '    selector: table.results > tbody > tr:has(a.title)',
      '    selector: table.results > tbody > tr:has(a.title)\n    filters:\n      - name: andmatch',
    );
    const site = fakeSite(() => html(LANTERN_PAGE));
    const result = await search(indexer(), load(yml), { fn: 'search', q: 'Lantern Movie', categories: [], limit: 100, offset: 0 }, site.deps);
    expect(result.ok && result.value.items.map((item) => item.title)).toEqual(['Lantern Movie 2024 1080p']);
  });
});

describe('a JSON site', () => {
  test('rows with multiple, parent fields, |append and an info hash become magnets', async () => {
    const site = fakeSite(() => new Response(JSONSITE_BODY, { status: 200 }));
    const result = await search(
      { indexerId: 'json1', baseUrl: 'https://api.json.test/', settings: {} },
      load(JSONSITE_YML),
      { fn: 'movie', q: 'Lantern Movie', ids: { imdbid: '0123456' }, categories: [2000], limit: 100, offset: 0 },
      site.deps,
    );
    expect(site.calls[0]!.url).toBe('https://api.json.test/api/list.json?query=Lantern+Movie&imdb=tt0123456');
    const items = result.ok ? result.value.items : [];
    expect(items.map((item) => [item.title, item.downloadUrl, item.sizeBytes, item.torrent?.seeders, item.torrent?.peers, item.publishedAt, item.ids])).toEqual(
      [
        [
          'Lantern Movie 1080p',
          'magnet:?xt=urn:btih:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb&dn=Lantern%20Movie%201080p',
          2_147_483_648,
          5,
          7,
          1_741_064_767_000,
          { imdbid: '0123456' },
        ],
        [
          'Lantern Movie 720p',
          'magnet:?xt=urn:btih:cccccccccccccccccccccccccccccccccccccccc&dn=Lantern%20Movie%20720p',
          1_073_741_824,
          3,
          4,
          1_741_064_767_000,
          { imdbid: '0123456' },
        ],
      ],
    );
    // Both torrents share the movie's page, so each guid adds its hash.
    expect(items.map((item) => item.guid)).toEqual([
      'https://api.json.test/movie/7#bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      'https://api.json.test/movie/7#cccccccccccccccccccccccccccccccccccccccc',
    ]);
    expect(items[0]!.categories).toEqual([2000]);
  });

  test("the noResultsMessage marks an empty answer; a body that isn't JSON is unexpectedPage", async () => {
    const empty = fakeSite(() => new Response('{"data":{"count":0}}', { status: 200 }));
    expect(
      await search(
        { indexerId: 'json2', baseUrl: 'https://api.json.test/', settings: {} },
        load(JSONSITE_YML),
        { fn: 'search', q: 'x', categories: [], limit: 100, offset: 0 },
        empty.deps,
      ),
    ).toEqual({
      ok: true,
      value: { items: [], offset: 0 },
    });
    const broken = fakeSite(() => new Response('<html>oops</html>', { status: 200 }));
    expect(
      await search(
        { indexerId: 'json3', baseUrl: 'https://api.json.test/', settings: {} },
        load(JSONSITE_YML),
        { fn: 'search', q: 'x', categories: [], limit: 100, offset: 0 },
        broken.deps,
      ),
    ).toMatchObject({
      ok: false,
      failure: { kind: 'unexpectedPage', host: 'api.json.test', path: '/api/list.json' },
    });
  });
});

describe('test', () => {
  test('passes when the RSS search finds rows, with the caps built from the definition', async () => {
    const site = fakeSite(() => html(LANTERN_PAGE));
    expect(await testIndexer(indexer(), load(LANTERN_YML), site.deps)).toMatchObject({
      ok: true,
      kind: 'definition',
      searchModes: [
        { mode: 'search', available: true, supportedParams: ['q'] },
        { mode: 'tv-search', available: true, supportedParams: ['q', 'season', 'ep'] },
        { mode: 'movie-search', available: true, supportedParams: ['q', 'imdbid'] },
      ],
    });
  });
});

const DOWNLOAD_YML = `${LANTERN_YML}
download:
  selectors:
    - selector: a.missing
      attribute: href
    - selector: a[href$=".torrent"]
      attribute: href
`;

const TORRENT = new Uint8Array([0x64, 0x34, 0x3a, 0x69, 0x6e, 0x66, 0x6f, 0x64, 0x65, 0x65]);

describe('download', () => {
  test('the details page gives the .torrent, which is tested and returned', async () => {
    const site = fakeSite((url) => {
      if (url === 'https://lantern.test/torrent/101') return html('<a href="/files/101.torrent">get</a>');
      if (url === 'https://lantern.test/files/101.torrent') return new Response(TORRENT, { status: 200 });
      return undefined;
    });
    const result = await download(indexer(), load(DOWNLOAD_YML), 'https://lantern.test/torrent/101', site.deps);
    expect(result).toEqual({ ok: true, value: { kind: 'torrent', bytes: TORRENT } });
    expect(site.calls.map((call) => call.url)).toEqual([
      'https://lantern.test/torrent/101',
      'https://lantern.test/torrent/101',
      'https://lantern.test/files/101.torrent',
    ]);
    expect(site.paced()).toBe(3);
  });

  test('an infohash block makes a magnet', async () => {
    const yml = `${LANTERN_YML}\ndownload:\n  infohash:\n    hash:\n      selector: span.hash\n    title:\n      selector: h1\n`;
    const site = fakeSite(() => html('<h1>Star Lantern 02</h1><span class="hash">DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD</span>'));
    expect(await download(indexer(), load(yml), 'https://lantern.test/torrent/9', site.deps)).toEqual({
      ok: true,
      value: { kind: 'magnet', uri: 'magnet:?xt=urn:btih:DDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDDD&dn=Star%20Lantern%2002' },
    });
  });

  test("a URL on a host outside the definition's links is refused without a request", async () => {
    const site = fakeSite(() => html(''));
    const result = await download(indexer(), load(DOWNLOAD_YML), 'https://evil.test/torrent/1', site.deps);
    expect(result.ok).toBe(false);
    expect(site.calls).toHaveLength(0);
  });

  test('without a download block the URL is the .torrent; a body that is not one is unexpectedPage', async () => {
    const good = fakeSite(() => new Response(TORRENT, { status: 200 }));
    expect(await download(indexer(), load(LANTERN_YML), 'https://lantern.test/get/101.torrent', good.deps)).toEqual({
      ok: true,
      value: { kind: 'torrent', bytes: TORRENT },
    });
    const bad = fakeSite(() => html('<html>login</html>'));
    expect(await download(indexer(), load(LANTERN_YML), 'https://lantern.test/get/101.torrent', bad.deps)).toMatchObject({
      ok: false,
      failure: { kind: 'unexpectedPage' },
    });
  });
});
