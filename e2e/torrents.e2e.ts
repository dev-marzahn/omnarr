// Torrents on the real stack, in the direct layout: qBittorrent 5.3.0-2
// from the stock image, configured by the reconciler, downloading from the
// web-seed fake through the Torznab fake.
//
//   S01E01  a .torrent submit: the web seed downloads it, it is imported and
//           published, seeds to its one-minute goal, and then the torrent and
//           its folder are removed while the library file stays;
//   S01E02  a magnet submit: the metadata and pieces come from the seed peer;
//   S01E03  the best release's web seed never answers: torrentStalled, the
//           release blocklisted, and next-best downloads the second one;
//   S01E04  a trickling web seed: the cancel removes the incomplete torrent;
//   secrets the passkey in the Torznab links reaches no output.
import { makeFunctionReference } from 'convex/server';
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test';

import { torrentCatalogue } from './fakes/torrent/catalogue.ts';
import { dataPathExists, down, logs, NEWZNAB_KEY, qbittorrentApi, rows, setUpJellyfinThroughProduct, up, waitFor, type Deployment } from './stack.ts';

// oxlint-disable-next-line typescript/no-explicit-any
type Any = any;
/** Every public function output the run read, for the planted-secrets check. */
const outputs: string[] = [];
const seen = <T>(value: T): T => {
  outputs.push(JSON.stringify(value) ?? '');
  return value;
};
const query = (name: string, args: object = {}): Promise<Any> => d.admin.query(makeFunctionReference<'query'>(name), args).then(seen);
const action = (name: string, args: object): Promise<Any> => d.admin.action(makeFunctionReference<'action'>(name), args).then(seen);
const mutation = (name: string, args: object): Promise<Any> => d.admin.mutation(makeFunctionReference<'mutation'>(name), args).then(seen);

type UnitRow = { unitId: string; tmdbSeason?: number; tmdbEpisode?: number; state: string };
type TorrentInfo = {
  hash: string;
  name: string;
  state: string;
  progress: number;
  tags: string;
  category: string;
  content_path: string;
  max_seeding_time: number;
};
type Row = { _id: string } & Record<string, Any>;

const MINUTE = 60_000;
const catalogue = torrentCatalogue();
const hashOf = (guid: string) => catalogue.find((entry) => entry.guid === guid)!.torrent.infoHash;

let d: Deployment;
let workId: string;

const units = async (): Promise<UnitRow[]> => (await query('api/library:detail', { workId })).units;
const unit = async (episode: number) => (await units()).find((row) => row.tmdbSeason === 1 && row.tmdbEpisode === episode)!;
const torrents = (): TorrentInfo[] => qbittorrentApi<TorrentInfo[]>('torrents/info');
const torrent = (guid: string) => torrents().find((info) => info.hash === hashOf(guid));
/** The Grab whose candidate is this release, and its Download. */
function grabOf(guid: string): { grab: Row; download?: Row } | undefined {
  const candidates = rows<Row>(d.env, 'candidates').filter((row) => String(row.guid).endsWith(`/details/${guid}`));
  const grab = rows<Row>(d.env, 'grabs').find((row) => candidates.some((candidate) => candidate._id === row.candidateId));
  if (!grab) return undefined;
  return { grab, download: rows<Row>(d.env, 'downloads').find((row) => row.grabId === grab._id) };
}

beforeAll(async () => {
  d = await up({ torrents: { seedGoal: { seedTimeMs: MINUTE } }, torrentStallMs: MINUTE });
  await setUpJellyfinThroughProduct(d);
}, 900_000);
afterAll(() => {
  if (process.env.E2E_KEEP !== '1') return down();
});

describe('torrents in the direct layout', () => {
  test('setup: the reconciler configures qBittorrent from the stock image; a Torznab indexer; a subscription to season 1', async () => {
    const qbittorrent = await waitFor('qBittorrent applied', async () => {
      const row = (await query('api/system:status')).clients.find((client: { clientKind: string }) => client.clientKind === 'qbittorrent');
      return row?.config === 'applied' && row.reachable ? row : undefined;
    });
    expect(qbittorrent).toMatchObject({ enabled: true, clientVersion: expect.stringMatching(/^v?5\.3\.0/), peerPort: 6881 });
    const preferences = qbittorrentApi<Record<string, unknown>>('app/preferences');
    expect(preferences).toMatchObject({
      save_path: '/data/downloads/torrents',
      auto_tmm_enabled: true,
      queueing_enabled: false,
      max_ratio_act: 0,
      listen_port: 6881,
    });
    expect(Object.keys(qbittorrentApi<Record<string, unknown>>('torrents/categories')).sort()).toEqual(['platform-movies', 'platform-series']);

    await action('api/indexers:create', { name: 'Torznab', url: 'http://torznab:4122/api', apiKey: NEWZNAB_KEY, priority: 10 });
    // Detected from the search answer.
    expect(rows<Row>(d.env, 'indexers')).toEqual([expect.objectContaining({ name: 'Torznab', kind: 'torznab' })]);
    const { library } = await query('api/library:list', { kind: 'series' });
    ({ workId } = await action('api/library:subscribe', {
      tmdbId: '900001',
      kind: 'series',
      libraryId: library.libraryId,
      releaseProfileId: library.defaultReleaseProfileId,
      seasons: [1],
    }));
  });

  test('a .torrent submit and a magnet submit reach qBittorrent tagged with their Grabs, with the goal as per-torrent limits', async () => {
    const e1 = await waitFor('S01E01 in qBittorrent', async () => torrent('hl-t-s01e01'), 180_000);
    const e2 = await waitFor('S01E02 in qBittorrent', async () => torrent('hl-t-s01e02'), 180_000);
    for (const [info, guid] of [
      [e1, 'hl-t-s01e01'],
      [e2, 'hl-t-s01e02'],
    ] as const) {
      expect(info.category).toBe('platform-series');
      expect(info.tags).toBe(`omnarr-${grabOf(guid)!.grab._id}`);
      expect(info.max_seeding_time).toBe(1);
    }
    // S01E01's candidate links its .torrent, S01E02's only a magnet (the job payloads are cleared once the jobs end).
    const linkOf = (guid: string) => rows<Row>(d.env, 'candidates').find((row) => String(row.guid).endsWith(`/details/${guid}`))!.downloadUrl as string;
    expect([linkOf('hl-t-s01e01').startsWith('http://torznab:4122/dl/'), linkOf('hl-t-s01e02').startsWith('magnet:')]).toEqual([true, true]);
  });

  test('a cancel removes an incomplete torrent (the trickling S01E04)', async () => {
    const info = await waitFor('S01E04 in qBittorrent', async () => torrent('hl-t-s01e04-slow'), 180_000);
    expect(info.progress).toBeLessThan(1);
    await mutation('api/units:cancelGrab', { grabId: grabOf('hl-t-s01e04-slow')!.grab._id });
    await waitFor('S01E04 gone from qBittorrent', async () => (torrent('hl-t-s01e04-slow') === undefined ? true : undefined), 120_000, 1_000);
    const e4 = grabOf('hl-t-s01e04-slow')!;
    expect(e4.grab.state).toBe('cancelled');
    await waitFor('S01E04 removed', async () => (grabOf('hl-t-s01e04-slow')!.download!.state === 'removed' ? true : undefined), 60_000, 1_000);
  });

  // The one-minute goal leaves a minute or more of seeding, and the pass runs every 2 s.
  test('a done torrent shows its seeding progress on the item and the Torrents card until the goal', async () => {
    const unitId = (await unit(1)).unitId;
    const seeding = await waitFor(
      'S01E01 seeding progress',
      async () => {
        const reading = (await query('api/units:timeline', { unitId }))?.seeding;
        return reading?.seedTimeMs !== undefined ? reading : undefined;
      },
      600_000,
      1_000,
    );
    expect(seeding).toMatchObject({ goal: { seedTimeMs: MINUTE }, ratio: expect.any(Number), uploadedBytes: expect.any(Number) });
    expect(seeding.fraction).toBeGreaterThanOrEqual(0);
    expect(seeding.fraction).toBeLessThanOrEqual(1);
    const torrents = (await query('api/downloadClients:get')).torrents;
    expect(torrents.seeding.count).toBeGreaterThanOrEqual(1);
  });

  // Published without preparation: `notInTargetFormat` is the playable state before it, as in pipeline.e2e.ts.
  const published = async (episode: number) => ['notInTargetFormat', 'ready'].includes((await unit(episode)).state);

  test('both download (web seed, seed peer), import and publish; the Downloads stay completed while they seed', async () => {
    await waitFor('S01E01 and S01E02 published', async () => ((await published(1)) && (await published(2)) ? true : undefined), 600_000, 1_000);
    const e1 = grabOf('hl-t-s01e01')!;
    expect(e1.grab.state).toBe('done');
    expect(e1.download!.contentPath).toMatch(/^\/data\/downloads\/torrents\/platform-series\//);
    expect(grabOf('hl-t-s01e02')!.grab.state).toBe('done');
  });

  test('the one-minute goal is met: torrent and folder removed, the library file kept', async () => {
    const e1 = grabOf('hl-t-s01e01')!;
    const folder = e1.download!.contentPath as string;
    const libraryFiles = rows<Row>(d.env, 'files').map((file) => file.path as string);
    expect(libraryFiles.length).toBeGreaterThan(0);
    // qBittorrent applies the limit at the next tracker announce, at most 5 minutes apart (fixtures README), or when the
    // worker nudges it, goalGraceMs past the goal (10 minutes in production, 5 s in E2E_LIMITS).
    await waitFor('S01E01 removed after its goal', async () => (grabOf('hl-t-s01e01')!.download!.state === 'removed' ? true : undefined), 600_000, 1_000);
    expect(torrent('hl-t-s01e01')).toBeUndefined();
    expect(dataPathExists(folder)).toBe(false);
    for (const path of libraryFiles) expect(dataPathExists(path)).toBe(true);
    expect(await published(1)).toBe(true);
    const events = rows<Row>(d.env, 'events')
      .filter((event) => event.grabId === e1.grab._id)
      .map((event) => event.message as string);
    // At least the goal: qBittorrent stops it at the next announce after it.
    expect(events.some((message) => /^Seeding goal met: ratio [\d.]+, \d+ minutes?$/.test(message))).toBe(true);
    // Seeding finished: the item no longer shows it seeding.
    expect((await query('api/units:timeline', { unitId: (await unit(1)).unitId }))?.seeding).toBeUndefined();
  });

  test('a stalled web seed ends as torrentStalled: the release is blocklisted and next-best downloads the other one', async () => {
    await waitFor('the stalled S01E03 failed', async () => (grabOf('hl-t-s01e03-stall')?.grab.state === 'failed' ? true : undefined), 600_000, 1_000);
    expect(grabOf('hl-t-s01e03-stall')!.grab.failureCode).toBe('torrentStalled');
    expect(rows<Row>(d.env, 'blocklist').map((row) => row.releaseKey)).toContain(hashOf('hl-t-s01e03-stall'));
    await waitFor('the stalled torrent removed', async () => (torrent('hl-t-s01e03-stall') === undefined ? true : undefined), 120_000, 1_000);
    await waitFor('S01E03 published from next-best', async () => ((await published(3)) ? true : undefined), 600_000, 1_000);
    expect(grabOf('hl-t-s01e03')!.grab.state).toBe('done');
  });

  test('no indexer key reaches qBittorrent', () => {
    expect(JSON.stringify(torrents())).not.toContain(NEWZNAB_KEY);
    expect(logs('qbittorrent')).not.toContain(NEWZNAB_KEY);
  });

  test("the passkey in the Torznab .torrent links isn't in the worker or backend output, or any public function output the run read", () => {
    // The Torznab fake puts its key into every .torrent link, as a private tracker's passkey (candidates.downloadUrl).
    const links = rows<Row>(d.env, 'candidates').map((row) => String(row.downloadUrl));
    expect(links.some((link) => link.includes(`apikey=${NEWZNAB_KEY}`))).toBe(true);
    const places: [string, string][] = [
      ["the worker's output", logs('worker')],
      ["the backend's output", logs('backend')],
      ['the public function outputs', outputs.join('\n')],
    ];
    expect(outputs.length).toBeGreaterThan(0);
    const found = places.flatMap(([place, body]) => (body.includes(NEWZNAB_KEY) || body.includes('magnet:?') ? [place] : []));
    expect(found).toEqual([]);
  });
});
