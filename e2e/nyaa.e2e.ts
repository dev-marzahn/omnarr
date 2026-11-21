// Nyaa on the real stack, against the fake Nyaa (fakes/nyaa/server.ts) and
// the web seed's seed peer, never nyaa.si:
//
//   - Nyaa is added at first run's indexer step: one feed request, no URL or key;
//   - a season search fills the feed and pages into the HTML listing, each
//     request a pacing interval after the last (lowered to 1 s here);
//   - an episode published on Nyaa is grabbed from RSS, as a magnet, to "ready";
//   - a DDoS-Guard check: `challenged`, rateLimited by the fallback rule, no Issue.
import { makeFunctionReference } from 'convex/server';
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test';

import { nyaaCatalogue } from './fakes/torrent/catalogue.ts';
import { down, nyaaFake, qbittorrentApi, rows, runInternal, setUpJellyfinThroughProduct, up, waitFor, type Deployment } from './stack.ts';

// oxlint-disable-next-line typescript/no-explicit-any
type Any = any;
const query = (name: string, args: object = {}): Promise<Any> => d.admin.query(makeFunctionReference<'query'>(name), args);
const action = (name: string, args: object): Promise<Any> => d.admin.action(makeFunctionReference<'action'>(name), args);
const mutation = (name: string, args: object = {}): Promise<Any> => d.admin.mutation(makeFunctionReference<'mutation'>(name), args);

type UnitRow = { unitId: string; tmdbSeason?: number; tmdbEpisode?: number; state: string };
type Row = { _id: string } & Record<string, Any>;
type NyaaRequest = { at: number; path: string; query: string; userAgent: string };

/** Lowered from 5 s (OMNARR_TEST_LIMITS), so the spacing is visible without waiting on the production timer. */
const PACING_MS = 1_000;
const MINUTE = 60_000;

let d: Deployment;
let nyaaId: string;
let workId: string;

const requests = () => nyaaFake<NyaaRequest[]>('/_fake/requests');
const units = async (): Promise<UnitRow[]> => (await query('api/library:detail', { workId })).units;
const unit = async (episode: number) => (await units()).find((row) => row.tmdbSeason === 1 && row.tmdbEpisode === episode)!;
const nyaaRow = () => rows<Row>(d.env, 'indexers').find((row) => row._id === nyaaId)!;
const hashOf = (guid: string) => nyaaCatalogue().find((entry) => entry.guid === guid)!.torrent.infoHash;

beforeAll(async () => {
  d = await up({ torrents: { seedGoal: { seedTimeMs: MINUTE } }, limits: { nyaaIntervalMs: PACING_MS } });
  await setUpJellyfinThroughProduct(d);
}, 900_000);
afterAll(() => {
  if (process.env.E2E_KEEP !== '1') return down();
});

describe('Nyaa', () => {
  test('first run adds Nyaa from the Site list: one feed request with the omnarr User-Agent, saved with kind nyaa, Continue unlocks', async () => {
    const test = await action('api/indexers:testSite', { kind: 'nyaa' });
    expect(test).toMatchObject({ ok: true, kind: 'nyaa', categories: expect.arrayContaining([expect.objectContaining({ id: 5070 })]) });
    expect(requests()).toEqual([{ at: expect.any(Number), path: '/', query: 'page=rss&c=1_0&f=0&m=1', userAgent: expect.stringMatching(/^omnarr\//) }]);

    const detail = await action('api/indexers:createSite', { kind: 'nyaa' });
    nyaaId = detail.id;
    expect(detail).toMatchObject({ name: 'Nyaa', kind: 'nyaa', host: 'nyaa:4140', apiKeySet: false, pacingIntervalMs: PACING_MS });
    expect(nyaaRow()).toMatchObject({ kind: 'nyaa', apiUrl: 'http://nyaa:4140', apiKey: '', categories: { series: [5070], movies: [2000] } });
    // The first-run page's Continue needs one indexer.
    expect(await query('api/indexers:list')).toHaveLength(1);
    await mutation('api/setup:advance', { step: 'usenet' });
  });

  test('a season search pages from the full feed into the listing, each request a pacing interval after the last', async () => {
    const before = requests().length;
    const { library } = await query('api/library:list', { kind: 'series' });
    const anime = (await query('api/releaseProfiles:list')).find((profile: { shippedKey?: string }) => profile.shippedKey === 'anime-1080p');
    ({ workId } = await action('api/library:subscribe', {
      tmdbId: '900002',
      kind: 'series',
      libraryId: library.libraryId,
      releaseProfileId: anime.id,
      seasons: [1],
    }));

    // The RSS cron may fetch the feed (no `q`) in between: only the search's requests count here.
    const sent = await waitFor('the season search', async () => {
      const log = requests()
        .slice(before)
        .filter((r) => r.query.includes('q=Star+Lantern'));
      return log.length >= 2 ? log : undefined;
    });
    expect(sent.map((r) => r.query)).toEqual(['page=rss&q=Star+Lantern&c=1_0&f=0&m=1', 'q=Star+Lantern&c=1_0&f=0&s=id&o=desc&p=2']);
    expect(sent[1]!.at - sent[0]!.at).toBeGreaterThanOrEqual(PACING_MS - 50);

    const attempt = await waitFor('the attempt to end', async () =>
      rows<Row>(d.env, 'searchAttempts').find((row) => row.workId === workId && row.groupKind === 'animeSeason' && row.state !== 'running'),
    );
    expect(attempt.indexerResults).toEqual([{ indexerId: nyaaId, status: 'ok', count: 81, pages: 2 }]);
    // Episode 1 is the one release of the Work; the look-alikes don't match it.
    await waitFor('episode 1 grabbed', async () => ((await unit(1)).state !== 'wanted' ? true : undefined));
    // createSite's test and the two pages, at least (RSS fetches count too).
    expect(nyaaRow().usage.reduce((sum: number, hour: { requests: number }) => sum + hour.requests, 0)).toBeGreaterThanOrEqual(3);
  });

  test('an episode published on Nyaa is grabbed from RSS as a magnet, with its info hash and peers, and becomes ready', async () => {
    // The first fetch only sets the high-water mark; the cron may have run it already.
    runInternal(d, 'pipeline/rssAction:fetch', { indexerId: nyaaId });
    nyaaFake('/_fake/publish', 'POST');
    runInternal(d, 'pipeline/rssAction:fetch', { indexerId: nyaaId });

    const rss = await waitFor('the RSS attempt', async () =>
      rows<Row>(d.env, 'searchAttempts').find((row) => row.workId === workId && row.trigger === 'rss' && row.state !== 'running'),
    );
    expect(rss.state).toBe('picked');
    const candidate = rows<Row>(d.env, 'candidates').find((row) => row.searchAttemptId === rss._id)!;
    expect(candidate).toMatchObject({ protocol: 'torrent', torrent: { infoHash: hashOf('sl-n-03'), seeders: 30, peers: 31 } });
    expect(candidate.downloadUrl).toMatch(/^magnet:\?xt=urn:btih:/);

    await waitFor(
      'the magnet in qBittorrent',
      async () => qbittorrentApi<{ hash: string }[]>('torrents/info').find((info) => info.hash === hashOf('sl-n-03')),
      180_000,
    );
    await waitFor('episode 3 ready', async () => ((await unit(3)).state === 'ready' ? true : undefined), 300_000, 2_000);
  });

  test('a DDoS-Guard check is `challenged`: rate limited by the fallback backoff, the failure named, no Issue', async () => {
    nyaaFake('/_fake/failure?kind=ddosGuard', 'POST');
    const before = Date.now();
    runInternal(d, 'pipeline/search:start', { unitIds: [(await unit(4)).unitId], trigger: 'backfill' });
    const attempt = await waitFor('the backfill attempt', async () =>
      rows<Row>(d.env, 'searchAttempts').find((row) => row.workId === workId && row.trigger === 'backfill' && row.state !== 'running'),
    );
    expect(attempt).toMatchObject({ state: 'failed', indexerResults: [{ indexerId: nyaaId, status: 'rateLimited', failureCode: 'indexerRateLimited' }] });
    const nyaa = nyaaRow();
    expect(nyaa).toMatchObject({
      rateLimitReason: 'fallback',
      consecutiveRateLimits: 1,
      health: { status: 'rateLimited', detail: { kind: 'challenged', httpStatus: 503, challenge: 'ddosGuard' } },
    });
    expect(nyaa.rateLimitedUntil).toBeGreaterThanOrEqual(before + 60 * MINUTE - 5_000);
    expect(rows<Row>(d.env, 'issues').filter((issue) => JSON.stringify(issue).includes('indexer'))).toEqual([]);
    const [row] = await query('api/indexers:list');
    expect(row).toMatchObject({ kind: 'nyaa', health: { status: 'rateLimited' }, rateLimitReason: 'fallback' });
  });
});
