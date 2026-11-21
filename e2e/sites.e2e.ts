// Site definitions on the real stack, against the fake definitions server
// and the fake Star Site (fakes/sites/server.ts), never
// indexers.prowlarr.com or a real site:
//
//   - the worker's sync fills the catalogue; Star Site is picked, tested and
//     added through the worker's engine; a season search reaches it through
//     the relay; the grab's link goes back to the engine (`siteUrl`), whose
//     download block finds the .torrent, which qBittorrent downloads from
//     the web seed, to "ready";
//   - an upstream update with a filter omnarr doesn't know is kept as a
//     pending update, and the stored definition stays in use.
import { makeFunctionReference } from 'convex/server';
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test';

import { starTorrents, type SitesRequest } from './fakes/sites/server.ts';
import { down, qbittorrentApi, rows, setUpJellyfinThroughProduct, sitesFake, up, waitFor, type Deployment } from './stack.ts';

// oxlint-disable-next-line typescript/no-explicit-any
type Any = any;
const query = (name: string, args: object = {}): Promise<Any> => d.admin.query(makeFunctionReference<'query'>(name), args);
const action = (name: string, args: object): Promise<Any> => d.admin.action(makeFunctionReference<'action'>(name), args);
const mutation = (name: string, args: object = {}): Promise<Any> => d.admin.mutation(makeFunctionReference<'mutation'>(name), args);

type Row = { _id: string } & Record<string, Any>;
type UnitRow = { unitId: string; tmdbSeason?: number; tmdbEpisode?: number; state: string };

/** Lowered from 2 s (OMNARR_TEST_LIMITS), so the spacing is visible without waiting on the production minimum. */
const PACING_MS = 500;
const MINUTE = 60_000;

let d: Deployment;
let indexerId: string;
let workId: string;

const requests = () => sitesFake<SitesRequest[]>('/_fake/requests');
const units = async (): Promise<UnitRow[]> => (await query('api/library:detail', { workId })).units;
const unit = async (episode: number) => (await units()).find((row) => row.tmdbSeason === 1 && row.tmdbEpisode === episode)!;
const definitionRow = (definitionId: string) => rows<Row>(d.env, 'siteDefinitions').find((row) => row.definitionId === definitionId);
const HASH = starTorrents()[0]!.torrent.infoHash;

beforeAll(async () => {
  d = await up({ torrents: { seedGoal: { seedTimeMs: MINUTE } }, limits: { definitionMinIntervalMs: PACING_MS } });
  await setUpJellyfinThroughProduct(d);
}, 900_000);
afterAll(() => {
  if (process.env.E2E_KEEP !== '1') return down();
});

describe('site definitions', () => {
  test('the worker syncs the package at connect: every definition listed, unsupported ones with their reason', async () => {
    const status = await waitFor('the first sync', async () => {
      const value = await query('sites/definitions:status');
      return value?.ok ? value : undefined;
    });
    expect(status).toMatchObject({ ok: true, source: 'sites:4160', supported: 1, unsupported: 2, pending: 0 });
    expect(requests().filter((r) => r.path === '/12/package.zip')).toEqual([expect.objectContaining({ userAgent: expect.stringMatching(/^omnarr\//) })]);
    const catalogue = await query('sites/definitions:list');
    expect(catalogue.map((row: Any) => [row.definitionId, row.support.ok ? 'ok' : row.support.reason])).toEqual([
      ['nyaasi', 'builtIn'],
      ['privy', 'privateInP2'],
      ['starsite', 'ok'],
    ]);
    // The file is stored as fetched, for the engine; the DTO never carries it.
    expect(definitionRow('starsite')).toMatchObject({ source: 'upstream', supported: true });
    expect(catalogue[2]).not.toHaveProperty('yaml');
  });

  test('Star Site is tested in the worker and added with kind definition and the caps its file names', async () => {
    const before = requests().length;
    const tested = await action('api/indexers:testSite', { kind: 'definition', definitionId: 'starsite', settings: { sort: 'seeders' } });
    expect(tested).toMatchObject({
      ok: true,
      kind: 'definition',
      searchModes: expect.arrayContaining([{ mode: 'tv-search', available: true, supportedParams: ['q', 'season', 'ep'] }]),
    });
    expect(requests().slice(before)).toEqual([expect.objectContaining({ path: '/star/latest', query: 'sort=seeders' })]);

    const detail = await action('api/indexers:createSite', { kind: 'definition', definitionId: 'starsite' });
    indexerId = detail.id;
    expect(detail).toMatchObject({
      name: 'Star Site',
      kind: 'definition',
      host: 'sites:4160',
      definitionName: 'Star Site',
      pacingIntervalMs: PACING_MS,
      categories: { series: [5070], movies: [] },
      site: { definitionId: 'starsite', baseUrl: 'http://sites:4160/star/', settings: {}, secretsSet: [] },
    });
    expect(rows<Row>(d.env, 'indexers').find((row) => row._id === indexerId)).toMatchObject({
      kind: 'definition',
      apiKey: '',
      apiUrl: 'http://sites:4160/star/',
    });
    // The relayed jobs are gone once their answer was read.
    expect(rows<Row>(d.env, 'jobs').filter((job) => job.class === 'indexer' && job.status === 'done')).toEqual([]);
  });

  test('a season search reaches the site through the relay, and the grab goes through the download block to ready', async () => {
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

    const searched = await waitFor('the season search', async () => {
      const log = requests()
        .slice(before)
        .filter((r) => r.path === '/star/search');
      return log.length >= 1 ? log : undefined;
    });
    expect(searched[0]!.query).toMatch(/^q=Star\+Lantern/);
    const attempt = await waitFor('the attempt to end', async () =>
      rows<Row>(d.env, 'searchAttempts').find((row) => row.workId === workId && row.groupKind === 'animeSeason' && row.state !== 'running'),
    );
    expect(attempt.indexerResults).toEqual([expect.objectContaining({ indexerId, status: 'ok', count: 1 })]);

    // The candidate's link is the details page; the submit hands it to the engine as `siteUrl`.
    const candidate = await waitFor('the candidate', async () =>
      rows<Row>(d.env, 'candidates').find((row) => row.indexerId === indexerId && row.title.includes('Star Lantern - 01')),
    );
    expect(candidate.downloadUrl).toBe('http://sites:4160/star/t/1');
    await waitFor(
      'the .torrent fetched through the download block',
      async () => (requests().some((r) => r.path === '/star/dl/1.torrent') ? true : undefined),
      180_000,
    );
    const grabbed = requests().filter((r) => r.path === '/star/t/1' || r.path === '/star/dl/1.torrent');
    expect(grabbed.map((r) => r.path)).toEqual(['/star/t/1', '/star/dl/1.torrent']);
    expect(grabbed[1]!.at - grabbed[0]!.at).toBeGreaterThanOrEqual(PACING_MS - 50);
    await waitFor('the torrent in qBittorrent', async () => qbittorrentApi<{ hash: string }[]>('torrents/info').find((info) => info.hash === HASH), 180_000);
    await waitFor('episode 1 ready', async () => ((await unit(1)).state === 'ready' ? true : undefined), 300_000, 2_000);
  });

  test("an upstream update omnarr can't run is kept pending; the stored file stays in use", async () => {
    const stored = definitionRow('starsite')!;
    sitesFake('/_fake/update?variant=broken', 'POST');
    await mutation('sites/definitions:syncNow');
    const row = await waitFor('the pending update', async () => definitionRow('starsite')?.pendingUpdate && definitionRow('starsite'));
    expect(row).toMatchObject({ sha256: stored.sha256, supported: true, pendingUpdate: { reason: 'unknownFilter', detail: 'sparkle in search.fields.title' } });
    expect(await query('sites/definitions:status')).toMatchObject({ ok: true, supported: 1, pending: 1 });
    expect((await query('sites/definitions:list')).find((r: Any) => r.definitionId === 'starsite')).toMatchObject({
      support: { ok: true },
      pendingUpdate: { reason: 'unknownFilter' },
    });
    // The indexer still runs the stored file: its test passes.
    expect(await action('api/indexers:test', { input: { indexerId } })).toMatchObject({ ok: true });
  });
});
