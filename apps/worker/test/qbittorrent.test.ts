// The qBittorrent adapter against an in-process fake
// WebUI API v2 that answers as qbittorrent-nox 5.3.0-2 did
// (test/fixtures/qbittorrent/README.md).
import { readFileSync } from 'node:fs';

import type { DesiredClientConfig } from '@omnarr/contracts';
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';

import { qbittorrentClient, type QbittorrentClient } from '../src/clients/qbittorrent.ts';
import { JobFailure } from '../src/runtime/lease.ts';
import { startFakeQbittorrent, type FakeQbittorrent, type FakeTorrent } from './fakes/qbittorrent.ts';

const CREDENTIALS = { username: 'omnarr', password: 'pl4nted-qbt-s3cret' };
const HASH = 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a';
const TORRENT_BYTES = new TextEncoder().encode('d4:infod6:lengthi5e4:name5:a.mkv12:piece lengthi16384e6:pieces20:ABCDEFGHIJKLMNOPQRSTee');
const GOAL = { seedTimeMs: 14 * 86_400_000 };
const GiB = 1024 ** 3;
const signal = new AbortController().signal;

let fake: FakeQbittorrent;
let client: QbittorrentClient;
let now: number;
let free: number;

beforeEach(async () => {
  fake = await startFakeQbittorrent(CREDENTIALS);
  now = 1_000_000;
  free = 100 * GiB;
  client = qbittorrentClient({ url: fake.url, ...CREDENTIALS, listenPort: 6881, freeBytes: async () => free, addPollMs: 5, now: () => now });
});
afterEach(() => fake.close());

const calls = (path: string) => fake.calls.filter((call) => call.path === path);
/** A recorded `torrents/info` answer (fixtures/qbittorrent/), in the fake's platform categories. */
const recording = (file: string): FakeTorrent[] =>
  (JSON.parse(readFileSync(new URL(`./fixtures/qbittorrent/${file}`, import.meta.url), 'utf8')) as FakeTorrent[]).map((torrent) => ({
    ...torrent,
    category: torrent.category.startsWith('platform-') ? torrent.category : 'platform-series',
  }));

/** A torrent as qBittorrent lists it. */
function listed(patch: Partial<FakeTorrent> = {}): FakeTorrent {
  const torrent: FakeTorrent = {
    hash: HASH,
    name: 'Harbour.Lights.S01E01.mkv',
    state: 'downloading',
    progress: 0.4,
    downloaded: 4000,
    ratio: 0,
    seeding_time: 0,
    category: 'platform-series',
    tags: 'omnarr-grab1',
    save_path: '/data/downloads/torrents/platform-series',
    content_path: '/data/downloads/torrents/platform-series/Harbour.Lights.S01E01',
    root_path: '/data/downloads/torrents/platform-series/Harbour.Lights.S01E01',
    private: false,
    ratio_limit: -1,
    seeding_time_limit: 20160,
    inactive_seeding_time_limit: -1,
    ...patch,
  };
  fake.torrents.push(torrent);
  return torrent;
}

describe('submit', () => {
  test('a .torrent file is added with its category, tag, per-torrent limits and not stopped; the clientRef is its info hash', async () => {
    fake.knowTorrent(TORRENT_BYTES, HASH);
    const result = await client.submit(
      { kind: 'torrentFile', bytes: TORRENT_BYTES, infoHash: HASH },
      { correlationTag: 'grab1', category: 'platform-series', seedGoal: GOAL },
      signal,
    );
    expect(result).toEqual({ clientRef: HASH });
    const [add] = calls('torrents/add');
    expect(add!.files).toEqual(['torrents']);
    expect(add!.form).toMatchObject({
      category: 'platform-series',
      tags: 'omnarr-grab1',
      ratioLimit: '-1',
      seedingTimeLimit: '20160',
      inactiveSeedingTimeLimit: '-1',
      stopped: 'false',
    });
  });

  test('a magnet is added by its URI', async () => {
    const uri = `magnet:?xt=urn:btih:${HASH}&dn=x`;
    await client.submit({ kind: 'magnet', uri, infoHash: HASH }, { correlationTag: 'grab1', category: 'platform-movies', seedGoal: { ratio: 2 } }, signal);
    expect(calls('torrents/add')[0]!.form).toMatchObject({ urls: uri, category: 'platform-movies', ratioLimit: '2', seedingTimeLimit: '-1' });
  });

  test('the seed time limit is in whole minutes, rounded up', async () => {
    await client.submit(
      { kind: 'magnet', uri: `magnet:?xt=urn:btih:${HASH}`, infoHash: HASH },
      { correlationTag: 'g', category: 'platform-series', seedGoal: { seedTimeMs: 90_001 } },
      signal,
    );
    expect(calls('torrents/add')[0]!.form.seedingTimeLimit).toBe('2');
  });

  test('a hash already in qBittorrent (still seeding) only gets this Grab’s tag; its limits stay as they are', async () => {
    listed({ state: 'stalledUP', progress: 1, tags: 'omnarr-grab0' });
    const result = await client.submit(
      { kind: 'magnet', uri: `magnet:?xt=urn:btih:${HASH}`, infoHash: HASH },
      { correlationTag: 'grab1', category: 'platform-series', seedGoal: GOAL },
      signal,
    );
    expect(result).toEqual({ clientRef: HASH });
    expect(calls('torrents/add')).toEqual([]);
    expect(calls('torrents/addTags')[0]!.form).toMatchObject({ hashes: HASH, tags: 'omnarr-grab1' });
    expect(fake.torrents[0]!.tags).toBe('omnarr-grab0, omnarr-grab1');
  });

  test('an add that meets the same hash (409, another Grab added it meanwhile) adds the tag instead', async () => {
    fake.knowTorrent(TORRENT_BYTES, HASH);
    listed({ tags: 'omnarr-grab0' });
    // The adapter's look-up misses it, as one made just before the other Grab's add would.
    fake.hiddenOnce.add(HASH);
    const result = await client.submit(
      { kind: 'torrentFile', bytes: TORRENT_BYTES, infoHash: HASH },
      { correlationTag: 'grab1', category: 'platform-series' },
      signal,
    );
    expect(result).toEqual({ clientRef: HASH });
    expect(fake.torrents[0]!.tags).toBe('omnarr-grab0, omnarr-grab1');
  });

  test('waits until the torrent is listed', async () => {
    fake.listDelayMs = 50;
    await client.submit({ kind: 'magnet', uri: `magnet:?xt=urn:btih:${HASH}`, infoHash: HASH }, { correlationTag: 'g', category: 'platform-series' }, signal);
    expect(fake.torrents.map((t) => t.hash)).toEqual([HASH]);
  });

  test('a torrent not listed in time fails as clientUnreachable, so the retry finds it by tag', async () => {
    fake.listDelayMs = 60_000;
    const quick = qbittorrentClient({ url: fake.url, ...CREDENTIALS, listenPort: 6881, freeBytes: async () => free, addPollMs: 5, addWaitMs: 30 });
    const error = await quick
      .submit({ kind: 'magnet', uri: `magnet:?xt=urn:btih:${HASH}`, infoHash: HASH }, { correlationTag: 'g', category: 'platform-series' }, signal)
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobFailure);
    expect((error as JobFailure).code).toBe('clientUnreachable');
  });

  test('a file qBittorrent refuses is releaseFileInvalid', async () => {
    const error = await client
      .submit({ kind: 'torrentFile', bytes: new Uint8Array([1, 2]), infoHash: HASH }, { correlationTag: 'g', category: 'platform-series' }, signal)
      .catch((e: unknown) => e);
    expect((error as JobFailure).code).toBe('releaseFileInvalid');
  });
});

describe('the session', () => {
  test('logs in once, and again after a 403', async () => {
    await client.findByTag('grab1', signal);
    await client.findByTag('grab1', signal);
    expect(calls('auth/login')).toHaveLength(1);
    fake.expireSessions();
    await client.findByTag('grab1', signal);
    expect(calls('auth/login')).toHaveLength(2);
  });

  test('a rejected login is clientUnreachable, naming qBittorrent but no password', async () => {
    const wrong = qbittorrentClient({ url: fake.url, username: 'omnarr', password: 'wrong', listenPort: 6881, freeBytes: async () => free });
    const error = (await wrong.findByTag('grab1', signal).catch((e: unknown) => e)) as JobFailure;
    expect([error.code, error.detail]).toEqual(['clientUnreachable', 'qBittorrent rejected the control username or password (POST /api/v2/auth/login).']);
  });

  test('no answer is clientUnreachable', async () => {
    await fake.close();
    const error = (await client.status(signal).catch((e: unknown) => e)) as { reachable: boolean };
    expect(error).toEqual({ reachable: false });
  });
});

describe('findByTag and list', () => {
  test('findByTag reads torrents/info?tag=omnarr-<grabId>', async () => {
    listed();
    expect(await client.findByTag('grab1', signal)).toMatchObject({ clientRef: HASH, correlationTags: ['grab1'] });
    expect(calls('torrents/info').at(-1)!.form).toMatchObject({ tag: 'omnarr-grab1' });
    expect(await client.findByTag('other', signal)).toBeNull();
  });

  test('list covers both categories, strips the omnarr- prefix, and leaves other tags out', async () => {
    listed({ tags: 'omnarr-grab1, omnarr-grab2, mine' });
    listed({ hash: 'ab'.repeat(20), category: 'platform-movies', tags: 'omnarr-grab3' });
    listed({ hash: 'cd'.repeat(20), category: 'someone-elses', tags: '' });
    const items = await client.list(signal);
    expect(items.map((item) => [item.clientRef, item.correlationTags])).toEqual([
      [HASH, ['grab1', 'grab2']],
      ['ab'.repeat(20), ['grab3']],
    ]);
  });

  // Size, bytes done and rate from torrents/info.
  test("a downloading torrent's status has its size, bytes done and rate", async () => {
    listed({ state: 'downloading', progress: 0.25, total_size: 1_600_000_000, completed: 400_000_000, dlspeed: 12_600_000 });
    expect((await client.list(signal))[0]!.status).toMatchObject({ doneBytes: 400_000_000, totalBytes: 1_600_000_000, bytesPerSec: 12_600_000 });
  });

  test('a downloading torrent: its stage, byte count and raw state', async () => {
    listed({ state: 'stalledDL', downloaded: 1234, progress: 0.25 });
    expect((await client.list(signal))[0]).toMatchObject({
      stage: 'downloading',
      downloadedBytes: 1234,
      status: { stage: 'stalledDL', progress: 0.25, raw: { state: 'stalledDL' } },
    });
  });

  test('a completed torrent: completed, with its content folder, private flag, ratio and seed time', async () => {
    listed({ state: 'stoppedUP', progress: 1, private: true, ratio: 3.1, seeding_time: 1_209_600 });
    expect((await client.list(signal))[0]).toMatchObject({
      stage: 'completed',
      contentPath: '/data/downloads/torrents/platform-series/Harbour.Lights.S01E01',
      isPrivate: true,
      stopped: true,
      ratio: 3.1,
      seedingTimeMs: 1_209_600_000,
    });
  });

  test("a single-file torrent's content path is its folder: under the Subfolder layout, qBittorrent's root_path", async () => {
    const [recorded] = recording('torrents-info-stoppedUP.json');
    fake.torrents.push(recorded!);
    expect(recorded!.content_path).toMatch(/\.mkv$/);
    expect((await client.list(signal))[0]!.contentPath).toBe('/data/downloads/torrents/platform-movies/Example.Movie.2013.1080p.WEB-DL-FIXTURE');
  });

  test('a folder whose name looks like a file name is still the folder', async () => {
    listed({
      state: 'uploading',
      progress: 1,
      content_path: '/data/downloads/torrents/platform-series/Show.S01.x264',
      root_path: '/data/downloads/torrents/platform-series/Show.S01.x264',
    });
    expect((await client.list(signal))[0]!.contentPath).toBe('/data/downloads/torrents/platform-series/Show.S01.x264');
  });

  // Recorded from 5.3.0-2: each entry's state, as the list maps it.
  test.each([
    ['torrents-info-metaDL.json', { stage: 'downloading', downloadedBytes: 0 }],
    ['torrents-info-stalledDL.json', { stage: 'downloading' }],
    ['torrents-info-queuedDL.json', { stage: 'queued' }],
    ['torrents-info-checkingDL.json', { stage: 'queued', checking: true }],
    ['torrents-info-stalledUP-private.json', { stage: 'completed', isPrivate: true }],
    ['torrents-info-stoppedUP.json', { stage: 'completed', stopped: true, ratio: 0, seedingTimeMs: 308_000 }],
    // Seeding progress: the ratio, seed time and uploaded bytes.
    ['torrents-info-uploading.json', { stage: 'completed', ratio: 0.0625, seedingTimeMs: 30_000, uploadedBytes: 262_144 }],
    ['torrents-info-missingFiles.json', { stage: 'failed', failureCode: 'unknownClientFailure', problem: 'missingFiles' }],
    ['torrents-info-error.json', { stage: 'failed', problem: 'error' }],
  ])('%s', async (file, expected) => {
    fake.torrents.push(...recording(file));
    const [item] = await client.list(signal);
    expect(item).toMatchObject(expected);
  });

  test('a torrent without metadata yet has no private flag (qBittorrent reports null)', async () => {
    fake.torrents.push(...recording('torrents-info-metaDL.json'));
    expect((await client.list(signal))[0]).not.toHaveProperty('isPrivate');
  });

  test('an errored torrent is diskFull below 1 GiB free, from the worker’s own reading', async () => {
    listed({ state: 'error' });
    free = GiB / 2;
    expect((await client.list(signal))[0]).toMatchObject({ stage: 'failed', failureCode: 'diskFull', problem: 'error' });
  });

  test('a not-working tracker’s message and host reach the status of an incomplete torrent, never its URL; read at most every 5 minutes', async () => {
    listed({
      trackers: [
        { url: '** [DHT] **', status: 0, msg: '' },
        { url: 'https://tracker.example/announce?passkey=planted-passkey', status: 4, msg: 'unregistered torrent' },
      ],
    });
    const first = (await client.list(signal))[0]!;
    expect(first.status.message).toBe('unregistered torrent');
    expect(first.status.raw).toMatchObject({ trackerHost: 'tracker.example' });
    expect(JSON.stringify(first)).not.toContain('planted-passkey');
    await client.list(signal);
    expect(calls('torrents/trackers')).toHaveLength(1);
    now += 5 * 60_000;
    expect((await client.list(signal))[0]!.status.message).toBe('unregistered torrent');
    expect(calls('torrents/trackers')).toHaveLength(2);
  });

  test('a seeding torrent’s trackers are not read', async () => {
    listed({ state: 'stalledUP', progress: 1, trackers: [{ url: 'http://t/a', status: 4, msg: 'x' }] });
    await client.list(signal);
    expect(calls('torrents/trackers')).toEqual([]);
  });
});

describe('the goal nudge', () => {
  test("list gives a completed torrent's completion time, which doesn't go stale; an incomplete one has none", async () => {
    fake.torrents.push(...recording('torrents-info-stalledUP.json'), ...recording('torrents-info-metaDL.json'));
    const [done, meta] = await client.list(signal);
    expect(done!.completedAt).toBe(1_794_996_229_000);
    expect(meta).not.toHaveProperty('completedAt');
  });

  // On 5.3.0 only a real change to the torrent refreshes it: re-sending the same share limits, a
  // reannounce, or re-adding a tag it has don't.
  test('refreshTorrent adds and removes a tag outside the omnarr- prefix, leaving the tags as they were', async () => {
    listed({ state: 'stalledUP', progress: 1, tags: 'omnarr-grab1' });
    await client.refreshTorrent(HASH, signal);
    expect(calls('torrents/addTags')[0]!.form).toEqual({ hashes: HASH, tags: 'goal-check' });
    expect(calls('torrents/removeTags')[0]!.form).toEqual({ hashes: HASH, tags: 'goal-check' });
    expect(fake.torrents[0]!.tags).toBe('omnarr-grab1');
  });
});

describe('remove', () => {
  test('removes this Grab’s tag; the torrent goes, with its files, once no omnarr- tag is left', async () => {
    listed({ tags: 'omnarr-grab1, omnarr-grab2' });
    expect(await client.remove(HASH, 'grab1', true, signal)).toEqual({ removed: false });
    expect(fake.torrents[0]!.tags).toBe('omnarr-grab2');
    expect(fake.deleted).toEqual([]);
    expect(await client.remove(HASH, 'grab2', true, signal)).toEqual({ removed: true });
    expect(fake.deleted).toEqual([{ hash: HASH, deleteFiles: true }]);
  });

  test('seedingLost removes the torrent without its files', async () => {
    listed();
    await client.remove(HASH, 'grab1', false, signal);
    expect(fake.deleted).toEqual([{ hash: HASH, deleteFiles: false }]);
  });

  test('a torrent that is gone already counts as removed', async () => {
    expect(await client.remove(HASH, 'grab1', true, signal)).toEqual({ removed: true });
  });
});

describe('applyConfig', () => {
  const desired: DesiredClientConfig = { kind: 'qbittorrent', clientId: 'c2' as never, enabled: true, configVersion: 1, qbittorrent: { seedGoal: GOAL } };

  test('sends only the owned preferences that differ, and creates both categories', async () => {
    const result = await client.applyConfig(desired, signal);
    expect(result).toEqual({ applied: true, changed: true, clientVersion: 'v5.3.0' });
    const sent = JSON.parse(calls('app/setPreferences')[0]!.form.json!);
    expect(sent).toEqual({
      save_path: '/data/downloads/torrents',
      auto_tmm_enabled: true,
      torrent_content_layout: 'Subfolder',
      upnp: false,
      queueing_enabled: false,
    });
    expect(fake.categories).toEqual({
      'platform-series': { name: 'platform-series', savePath: '/data/downloads/torrents/platform-series' },
      'platform-movies': { name: 'platform-movies', savePath: '/data/downloads/torrents/platform-movies' },
    });
  });

  test('an apply that finds nothing different writes nothing', async () => {
    await client.applyConfig(desired, signal);
    fake.calls.length = 0;
    expect(await client.applyConfig(desired, signal)).toEqual({ applied: true, changed: false, clientVersion: 'v5.3.0' });
    expect(calls('app/setPreferences')).toEqual([]);
    expect(calls('torrents/createCategory')).toEqual([]);
    expect(calls('torrents/editCategory')).toEqual([]);
  });

  test('a category with another save path is edited', async () => {
    fake.categories['platform-series'] = { name: 'platform-series', savePath: '/elsewhere' };
    await client.applyConfig(desired, signal);
    expect(calls('torrents/editCategory')[0]!.form).toMatchObject({ category: 'platform-series', savePath: '/data/downloads/torrents/platform-series' });
  });

  test('the listen port is the published peer port', async () => {
    fake.preferences.listen_port = 12345;
    await client.applyConfig(desired, signal);
    expect(JSON.parse(calls('app/setPreferences')[0]!.form.json!)).toMatchObject({ listen_port: 6881 });
  });

  test('a chosen VPN binds qBittorrent to tun0, so it moves no traffic outside the tunnel; No VPN unbinds it', async () => {
    const vpn = { kind: 'wireguardFile' as const, wireguardConf: 'x', savedAt: 1 };
    await client.applyConfig({ ...desired, qbittorrent: { seedGoal: GOAL, vpn } }, signal);
    expect(fake.preferences.current_network_interface).toBe('tun0');
    await client.applyConfig(desired, signal);
    expect(fake.preferences.current_network_interface).toBe('');
  });

  test('under the VPN, the listen port is the one the VPN monitor last set', async () => {
    let port = 40123;
    const vpnClient = qbittorrentClient({ url: fake.url, ...CREDENTIALS, listenPort: () => port, freeBytes: async () => free, addPollMs: 5 });
    await vpnClient.applyConfig(desired, signal);
    expect(fake.preferences.listen_port).toBe(40123);
    port = 51000;
    await vpnClient.applyConfig(desired, signal);
    expect(fake.preferences.listen_port).toBe(51000);
  });

  test('an unreachable qBittorrent fails the apply with clientUnreachable', async () => {
    fake.httpStatus = 502;
    const error = (await client.applyConfig(desired, signal).catch((e: unknown) => e)) as JobFailure;
    expect(error.code).toBe('clientUnreachable');
  });
});

describe('status', () => {
  test('reads the version and transfer/info’s connection status', async () => {
    fake.connectionStatus = 'firewalled';
    expect(await client.status(signal)).toEqual({ reachable: true, version: 'v5.3.0', connectionStatus: 'firewalled' });
  });
});
