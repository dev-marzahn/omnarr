import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test';

import { nyaaCatalogue, TRACKER_URL } from '../torrent/catalogue.ts';
import { createNyaaFake, e2eNyaaItems } from './server.ts';

const { listed, held } = e2eNyaaItems();
let base: string;
const fake = createNyaaFake({ origin: 'http://nyaa:4140', listed, held });
beforeAll(async () => {
  await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => fake.server.close(() => resolve())));

const get = async (path: string) => {
  const res = await fetch(`${base}${path}`, { headers: { 'user-agent': 'omnarr/test' } });
  return { status: res.status, headers: res.headers, body: await res.text() };
};
const feedTitles = (body: string) => [...body.matchAll(/<item>\s*<title>([^<]*)<\/title>/g)].map((m) => m[1]);
const rows = (body: string) => body.match(/<tr class="default">/g)?.length ?? 0;

describe('the Nyaa fake', () => {
  test("the feed: the newest 75 matches of q, newest ID first, in nyaa's namespace, magnets naming the web seed's tracker", async () => {
    const feed = await get('/?page=rss&q=Star+Lantern&c=1_0&f=0&m=1');
    expect(feed.status).toBe(200);
    expect(feed.body).toContain('xmlns:nyaa="http://nyaa:4140/xmlns/nyaa"');
    const titles = feedTitles(feed.body);
    expect(titles).toHaveLength(75);
    expect(titles[0]).toBe('[SubsPlease] Star Lantern - 01 (1080p) [5E1A0001].mkv');
    const hash = nyaaCatalogue()[0]!.torrent.infoHash;
    expect(feed.body).toContain(`<nyaa:infoHash>${hash}</nyaa:infoHash>`);
    expect(feed.body).toContain(`magnet:?xt=urn:btih:${hash}`);
    expect(feed.body).toContain(encodeURIComponent(TRACKER_URL));
    expect(feed.body).toContain('<guid isPermaLink="true">http://nyaa:4140/view/2001</guid>');
  });

  test('the listing\'s page 2 continues the feed; a page past the end is "No results found"', async () => {
    expect(rows((await get('/?q=Star+Lantern&c=1_0&f=0&s=id&o=desc&p=2')).body)).toBe(6);
    expect((await get('/?q=Star+Lantern&c=1_0&f=0&s=id&o=desc&p=3')).body).toContain('<h3>No results found</h3>');
  });

  test('a query word matches the start of a title word: 01 finds episode 01, not 1071', async () => {
    expect(feedTitles((await get('/?page=rss&q=Star+Lantern+01&c=1_0&f=0&m=1')).body)).toEqual([
      '[SubsPlease] Star Lantern - 01 (1080p) [5E1A0001].mkv',
      '[Fill] Starfall Lanterns - 01 (1080p) [F0000072].mkv',
      '[Fill] Starfall Lanterns - 01 (1080p) [F0000048].mkv',
      '[Fill] Starfall Lanterns - 01 (1080p) [F0000024].mkv',
      '[Fill] Starfall Lanterns - 01 (1080p) [F0000000].mkv',
    ]);
  });

  test('publish lists the held episode, published now; the failure switch answers DDoS-Guard, a broken page, then normally again', async () => {
    expect(feedTitles((await get('/?page=rss&c=1_0&f=0&m=1')).body)).not.toContain('[SubsPlease] Star Lantern - 03 (1080p) [5E1A0003].mkv');
    await fetch(`${base}/_fake/publish`, { method: 'POST' });
    const feed = await get('/?page=rss&c=1_0&f=0&m=1');
    expect(feedTitles(feed.body)[0]).toBe('[SubsPlease] Star Lantern - 03 (1080p) [5E1A0003].mkv');

    await fetch(`${base}/_fake/failure?kind=ddosGuard`, { method: 'POST' });
    const challenged = await get('/?page=rss&c=1_0&f=0&m=1');
    expect({ status: challenged.status, server: challenged.headers.get('server') }).toEqual({ status: 503, server: 'ddos-guard' });
    await fetch(`${base}/_fake/failure?kind=brokenPage`, { method: 'POST' });
    expect((await get('/?page=rss')).body).not.toContain('xmlns:nyaa');
    await fetch(`${base}/_fake/failure?kind=none`, { method: 'POST' });
    expect((await get('/?page=rss')).status).toBe(200);
  });

  test('the request log has each request with its query, time and User-Agent, and no control route', async () => {
    const log = (await (await fetch(`${base}/_fake/requests`)).json()) as { at: number; path: string; query: string; userAgent: string }[];
    expect(log[0]).toEqual({ at: expect.any(Number), path: '/', query: 'page=rss&q=Star+Lantern&c=1_0&f=0&m=1', userAgent: 'omnarr/test' });
    expect(log.some((entry) => entry.path.startsWith('/_fake'))).toBe(false);
  });
});
