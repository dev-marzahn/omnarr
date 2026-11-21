import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test';

import { torrentCatalogue, vpnCatalogue } from '../torrent/catalogue.ts';
import { COMMITTED_CATALOGUE, loadCatalogue, readMedia } from '../usenet/catalogue.ts';
import { createRelease } from '../usenet/release.ts';
import { e2eItems, ITEMS } from './fixtures.ts';
import { createNewznabFake, torrentItems } from './server.ts';

const fake = createNewznabFake({ apiKey: 'k', pageMax: 3 });
let base: string;
beforeAll(async () => {
  await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}/api`;
});
afterAll(() => new Promise<void>((resolve) => fake.server.close(() => resolve())));

const get = async (query: string) => {
  const res = await fetch(`${base}?${query}`);
  return { status: res.status, type: res.headers.get('content-type'), body: await res.text() };
};
const titles = (body: string) => [...body.matchAll(/<title>([^<]*)<\/title>/g)].map((m) => m[1]).filter((t) => t !== 'Newznab fake');

describe('the Newznab fake', () => {
  test('answers a wrong key with error code 100 and HTTP 200, as Newznab does', async () => {
    expect(await get('t=search&apikey=wrong')).toMatchObject({ status: 200, body: expect.stringContaining('<error code="100"') });
  });

  test('serves t=search as an RSS page, newest first, with newznab:response', async () => {
    const page = await get('t=search&apikey=k&cat=5000');
    expect(page.status).toBe(200);
    expect(page.type).toMatch(/xml/);
    expect(page.body).toContain('<newznab:response offset="0" total="4"/>');
    expect(titles(page.body)).toHaveLength(3);
  });

  test('filters by category, counting a child category under its parent', async () => {
    const movies = await get('t=search&apikey=k&cat=2000&limit=3');
    expect(titles(movies.body)).toEqual(['Quiet.Orchard.2024.1080p.WEB-DL.DDP5.1.H.264-GRPB', 'Paper Lantern Road 2019 720p BluRay x264-GRPC']);
  });

  test('pages with offset, and caps limit at pageMax', async () => {
    const second = await get('t=search&apikey=k&cat=5000&limit=100&offset=3');
    expect(second.body).toContain('<newznab:response offset="3" total="4"/>');
    expect(titles(second.body)).toHaveLength(1);
  });

  test('puts the key into download URLs, as real indexers do', async () => {
    expect((await get('t=search&apikey=k&cat=5000')).body).toMatch(/<enclosure url="[^"]*apikey=k"/);
  });

  test('records every request it receives, refused ones included', async () => {
    const before = fake.requests.length;
    await get('t=search&apikey=k');
    await get('t=search&apikey=wrong');
    expect(fake.requests.length).toBe(before + 2);
    expect(fake.requests.at(-2)?.get('t')).toBe('search');
  });

  test('serves caps: limits, the search modes with supportedParams, and the categories', async () => {
    const caps = await get('t=caps&apikey=k');
    expect(caps.body).toContain('<limits max="3" default="3"/>');
    expect(caps.body).toContain('<tv-search available="yes" supportedParams="q,tvdbid,imdbid,season,ep"/>');
    expect(caps.body).toContain('<movie-search available="yes" supportedParams="q,imdbid,tmdbid"/>');
    expect(caps.body).toMatch(/<category id="5000" name="TV">[\s\S]*<subcat id="5070" name="Anime"\/>/);
  });

  test('t=tvsearch filters by ID, season and episode', async () => {
    expect(titles((await get('t=tvsearch&apikey=k&tvdbid=7700001&season=1&ep=2')).body)).toEqual(['The.Long.Harbor.S01E02.1080p.WEB-DL.DDP5.1.H.264-GRPA']);
    expect(titles((await get('t=tvsearch&apikey=k&tvdbid=7700001&season=1')).body)).toHaveLength(3);
    expect(titles((await get('t=tvsearch&apikey=k&tvdbid=1&season=1')).body)).toEqual([]);
  });

  test('t=movie filters by IMDb ID without its tt prefix', async () => {
    expect(titles((await get('t=movie&apikey=k&imdbid=9900101')).body)).toEqual(['Quiet.Orchard.2024.1080p.WEB-DL.DDP5.1.H.264-GRPB']);
  });
});

describe('the Newznab fake, serving NZBs', () => {
  const release = createRelease({ guid: 'rel-1', title: 'Show.S01E01.1080p.WEB-DL-GRP', fileName: 'Show.S01E01.1080p.WEB-DL-GRP.mkv' }, new Uint8Array(9000), {
    partSize: 4000,
  });
  const nzbs = createNewznabFake({
    apiKey: 'k',
    items: [{ guid: 'rel-1', title: release.entry.title, categories: [5000], sizeBytes: 9000, publishedAt: '2026-11-01T00:00:00Z', release }, ...ITEMS],
  });
  let origin: string;
  beforeAll(async () => {
    await new Promise<void>((resolve) => nzbs.server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(nzbs.server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => nzbs.server.close(() => resolve())));

  test('serves the NZB a result links to, naming the articles the NNTP fake serves', async () => {
    const search = await (await fetch(`${origin}/api?t=search&apikey=k&q=show`)).text();
    const link = /<link>([^<]+)<\/link>/.exec(search)![1]!.replace(/&amp;/g, '&');
    const res = await fetch(link);
    expect([res.status, res.headers.get('content-type')]).toEqual([200, 'application/x-nzb']);
    const nzb = await res.text();
    expect(nzb).toContain('<meta type="title">Show.S01E01.1080p.WEB-DL-GRP</meta>');
    expect([...nzb.matchAll(/<segment [^>]*>([^<]+)<\/segment>/g)].map((m) => m[1])).toEqual([
      'rel-1.p1of3@omnarr.fake',
      'rel-1.p2of3@omnarr.fake',
      'rel-1.p3of3@omnarr.fake',
    ]);
  });

  test('refuses a wrong key with error 100, and answers 404 for a guid without an NZB', async () => {
    expect(await (await fetch(`${origin}/getnzb/rel-1.nzb?apikey=wrong`)).text()).toContain('<error code="100"');
    expect((await fetch(`${origin}/getnzb/nope.nzb?apikey=k`)).status).toBe(404);
    expect((await fetch(`${origin}/getnzb/${ITEMS[0]!.guid}.nzb?apikey=k`)).status).toBe(404);
  });

  test('with the download limit reached, /getnzb answers error 501 and searches still work', async () => {
    nzbs.setFailure({ kind: 'grabLimit501' });
    expect(await (await fetch(`${origin}/getnzb/rel-1.nzb?apikey=k`)).text()).toContain('<error code="501"');
    expect((await fetch(`${origin}/api?t=search&apikey=k`)).status).toBe(200);
    expect(await (await fetch(`${origin}/api?t=search&apikey=k`)).text()).not.toContain('<error');
    nzbs.setFailure(undefined);
  });

  test('refuses NZBs while rate-limited, as it refuses searches', async () => {
    nzbs.setFailure({ kind: 'limit500' });
    expect(await (await fetch(`${origin}/getnzb/rel-1.nzb?apikey=k`)).text()).toContain('<error code="500"');
    nzbs.setFailure(undefined);
  });
});

describe('the Newznab fake, serving the e2e catalogue', () => {
  // The committed releases: the fakes' tests run without the generated S02E01 file.
  const e2e = createNewznabFake({ apiKey: 'k', items: e2eItems(loadCatalogue(COMMITTED_CATALOGUE)) });
  let origin: string;
  beforeAll(async () => {
    await new Promise<void>((resolve) => e2e.server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(e2e.server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => e2e.server.close(() => resolve())));

  test("lists a season's releases as HD series releases of the Harbour Lights tvdb ID, newest first, sized as their files", async () => {
    const body = await (await fetch(`${origin}/api?t=tvsearch&apikey=k&tvdbid=7700001&season=1&cat=5040`)).text();
    expect(titles(body)).toEqual([
      // Listed under every query, and the newest.
      '[Kaze] Harbour Lights - 03 (1080p) [B1C2D3E4]',
      'Harbour.Lights.S01E02.1080p.WEB-DL.AAC2.0.H.264-GRPB',
      'Harbour.Lights.S01E02.1080p.WEB-DL.AAC2.0.H.264-GRPF',
      'Harbour.Lights.S01E01.1080p.WEB-DL.DDP5.1.H.264-GRPB',
    ]);
    expect(body).toContain(`<newznab:attr name="size" value="${readMedia('sample.mkv').length}"/>`);
    expect(body).toContain(`<newznab:attr name="size" value="${readMedia('webdl.mkv').length}"/>`);
    expect(body).toContain('<newznab:attr name="category" value="5000"/>');
  });

  test('lists the release of unclear numbering under every query in its categories, as an indexer that ignores the numbers does', async () => {
    for (const query of ['t=tvsearch&tvdbid=7700001&season=1&ep=3', 't=tvsearch&q=Harbour%20Lights&season=2&ep=9', 't=search&q=Unrelated'])
      expect(titles(await (await fetch(`${origin}/api?${query}&apikey=k&cat=5040`)).text())).toContain('[Kaze] Harbour Lights - 03 (1080p) [B1C2D3E4]');
    expect(titles(await (await fetch(`${origin}/api?t=search&apikey=k&cat=2000`)).text())).toEqual([]);
  });

  test('serves each release NZB by its guid', async () => {
    const nzb = await (await fetch(`${origin}/getnzb/hl-s01e02-bad.nzb?apikey=k`)).text();
    expect(nzb).toContain('>hl-s01e02-bad.p1of5@omnarr.fake</segment>');
  });
});

describe('the Newznab fake, switched to fail', () => {
  const failing = createNewznabFake({ apiKey: 'k' });
  let url: string;
  beforeAll(async () => {
    await new Promise<void>((resolve) => failing.server.listen(0, '127.0.0.1', resolve));
    url = `http://127.0.0.1:${(failing.server.address() as AddressInfo).port}/api?t=search&apikey=k`;
  });
  afterAll(() => new Promise<void>((resolve) => failing.server.close(() => resolve())));

  test('rate-limits with error 500, with HTTP 429 with and without Retry-After, and with apilimits at their maximum', async () => {
    failing.setFailure({ kind: 'limit500' });
    expect(await (await fetch(url)).text()).toContain('<error code="500" description="Request limit reached"/>');
    failing.setFailure({ kind: 'http429', retryAfter: '120' });
    const limited = await fetch(url);
    expect([limited.status, limited.headers.get('retry-after')]).toEqual([429, '120']);
    failing.setFailure({ kind: 'http429' });
    expect((await fetch(url)).headers.get('retry-after')).toBeNull();
    failing.setFailure({ kind: 'apilimitsAtMax' });
    expect(await (await fetch(url)).text()).toMatch(/<newznab:apilimits apicurrent="100" apimax="100"/);
  });

  test('answers with a body that is no API, and with nothing until the caller gives up', async () => {
    failing.setFailure({ kind: 'notAnApi' });
    expect(await (await fetch(url)).text()).toContain('<html>');
    failing.setFailure({ kind: 'timeout' });
    await expect(fetch(url, { signal: AbortSignal.timeout(100) })).rejects.toThrow();
    failing.setFailure(undefined);
    expect((await fetch(url)).status).toBe(200);
  });
});

describe('the torrents e2e catalogue (NEWZNAB_CATALOGUE=torrents)', () => {
  const catalogue = torrentCatalogue();
  const items = torrentItems(catalogue);

  test('lists every entry as a Harbour Lights series release with its seeders and info hash', () => {
    expect(items.map((item) => [item.guid, item.title, item.torrent?.seeders, item.torrent?.infoHash])).toEqual(
      catalogue.map((entry) => [entry.guid, entry.title, entry.seeders, entry.torrent.infoHash]),
    );
    expect(items.every((item) => item.ids?.tvdbid === '7700001' && item.categories.includes(5040))).toBe(true);
  });

  test("a magnet entry has no .torrent file, and its magnet names the web seed's tracker", () => {
    const magnet = items.find((item) => item.guid === 'hl-t-s01e02')!;
    expect(magnet.torrent).toMatchObject({ magnetParams: 'tr=http%3A%2F%2Fwebseed%3A4130%2Fannounce' });
    expect(magnet.torrent!.file).toBeUndefined();
    expect(items.find((item) => item.guid === 'hl-t-s01e01')!.torrent!.file).toEqual(catalogue[0]!.torrent.bytes);
  });
});

describe('the vpn e2e catalogue (NEWZNAB_CATALOGUE=vpn)', () => {
  const catalogue = vpnCatalogue('10.213.2.210:4130');
  const items = torrentItems(catalogue);

  test('S01E01 and the trickling S01E04, as .torrent files whose web seed and tracker are the address behind the tunnel', () => {
    expect(items.map((item) => item.guid)).toEqual(['hl-t-s01e01', 'hl-t-s01e04-slow']);
    const text = Buffer.from(items[0]!.torrent!.file!).toString('latin1');
    expect(text).toContain('http://10.213.2.210:4130/files/');
    expect(text).toContain('http://10.213.2.210:4130/announce');
    expect(text).not.toContain('webseed:4130');
  });

  test('the info hashes are the torrents scenario’s: the web seed and the tracker are outside the info dict', () => {
    const direct = torrentCatalogue();
    expect(catalogue.map((entry) => entry.torrent.infoHash)).toEqual(
      ['hl-t-s01e01', 'hl-t-s01e04-slow'].map((guid) => direct.find((entry) => entry.guid === guid)!.torrent.infoHash),
    );
  });
});

describe('the Newznab fake in Torznab mode', () => {
  const file = new TextEncoder().encode('d4:infod6:lengthi1e4:name1:aee');
  const torznab = createNewznabFake({
    apiKey: 'k',
    kind: 'torznab',
    items: [
      {
        guid: 'tor-1',
        title: 'Show.S01E01.1080p.WEB-DL-GRP',
        categories: [5000, 5040],
        sizeBytes: 9000,
        publishedAt: '2026-11-02T00:00:00Z',
        ids: { tvdbid: '7700001' },
        torrent: { infoHash: 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a', seeders: 4, peers: 6, minimumRatio: 1, minimumSeedTimeSec: 259_200, file },
      },
      {
        guid: 'tor-2',
        title: 'Show.S01E02.1080p.WEB-DL-GRP',
        categories: [5000, 5040],
        sizeBytes: 9000,
        publishedAt: '2026-11-01T00:00:00Z',
        torrent: { infoHash: '0123456789abcdef0123456789abcdef01234567', seeders: 0, magnetParams: 'x.pe=seeder%3A6881' },
      },
    ],
  });
  let origin: string;
  beforeAll(async () => {
    await new Promise<void>((resolve) => torznab.server.listen(0, '127.0.0.1', resolve));
    origin = `http://127.0.0.1:${(torznab.server.address() as AddressInfo).port}`;
  });
  afterAll(() => new Promise<void>((resolve) => torznab.server.close(() => resolve())));
  const search = async () => (await fetch(`${origin}/api?t=search&apikey=k`)).text();

  test('answers in the torznab namespace, with torrent enclosures and torznab:attr seeders, peers, infohash and the minimums', async () => {
    const body = await search();
    expect(body).toContain('xmlns:torznab="http://torznab.com/schemas/2015/feed"');
    expect(body).toContain('<torznab:response offset="0" total="2"/>');
    expect(body).not.toContain('newznab:');
    expect(body).toMatch(/<enclosure url="[^"]*\/dl\/tor-1\.torrent\?apikey=k" length="9000" type="application\/x-bittorrent"\/>/);
    for (const [name, value] of [
      ['seeders', '4'],
      ['peers', '6'],
      ['infohash', 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a'],
      ['minimumratio', '1'],
      ['minimumseedtime', '259200'],
      ['tvdbid', '7700001'],
    ])
      expect(body).toContain(`<torznab:attr name="${name}" value="${value}"/>`);
    expect(body).toContain(
      '<torznab:attr name="magneturl" value="magnet:?xt=urn:btih:c12fe1c06bba254a9dc9f519b335aa7c1367a88a&amp;dn=Show.S01E01.1080p.WEB-DL-GRP"/>',
    );
  });

  test('an item without a .torrent file links only its magnet, with its extra parameters', async () => {
    const body = await search();
    expect(body).toContain(
      '<link>magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&amp;dn=Show.S01E02.1080p.WEB-DL-GRP&amp;x.pe=seeder%3A6881</link>',
    );
    expect(body).toContain('<torznab:attr name="seeders" value="0"/>');
  });

  test('serves the .torrent file with the key, as application/x-bittorrent; 404 for an item without one', async () => {
    const res = await fetch(`${origin}/dl/tor-1.torrent?apikey=k`);
    expect([res.status, res.headers.get('content-type')]).toEqual([200, 'application/x-bittorrent']);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(file);
    expect(await (await fetch(`${origin}/dl/tor-1.torrent?apikey=wrong`)).text()).toContain('<error code="100"');
    expect((await fetch(`${origin}/dl/tor-2.torrent?apikey=k`)).status).toBe(404);
  });

  test('the grab limit refuses .torrent downloads too', async () => {
    torznab.setFailure({ kind: 'grabLimit501' });
    expect(await (await fetch(`${origin}/dl/tor-1.torrent?apikey=k`)).text()).toContain('<error code="501"');
    torznab.setFailure(undefined);
  });
});
