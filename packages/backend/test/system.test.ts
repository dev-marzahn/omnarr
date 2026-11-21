// `system.status`: the System page and the one worker banner, including a
// protocol mismatch.
import { DEFAULT_LIMITS, PROTOCOL_VERSION, STORAGE_AREAS, type StorageArea } from '@omnarr/contracts';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';

import { api, internal } from '../convex/_generated/api';
import { asAdmin, capabilities, seedIndexer, setup, storageSpace, worker, type Backend } from './setup';

let t: Backend;
let admin: Awaited<ReturnType<typeof asAdmin>>;

beforeEach(async () => {
  vi.useFakeTimers();
  t = setup();
  admin = await asAdmin(t);
});
afterEach(() => vi.useRealTimers());

const status = () => admin.query(api.api.system.status, {});
const connect = (protocolVersion = PROTOCOL_VERSION, workerId = 'w1') =>
  t.mutation(api.jobs.worker.connect, { ...worker, protocolVersion, workerId, capabilities });

describe('system.status', () => {
  test('before any worker connected: no worker, no banner until supervision raises offline', async () => {
    const before = await status();
    expect(before.worker).toBeUndefined();
    expect(before.banner).toBeUndefined();
    await t.mutation(internal.jobs.queue.supervise, {});
    expect((await status()).banner).toBe('workerOffline');
  });

  test('a connected worker: its version, ffmpeg, storage, and no banner', async () => {
    await connect();
    await t.mutation(internal.jobs.queue.supervise, {});
    const { worker: w, banner, storage } = await status();
    expect(banner).toBeUndefined();
    expect(w).toMatchObject({
      workerId: 'w1',
      connected: true,
      accepted: true,
      protocolVersion: PROTOCOL_VERSION,
      expectedVersion: PROTOCOL_VERSION,
      ffmpegVersion: '7.1',
    });
    expect(storage).toEqual({ areas: capabilities.storage, librarySameDevice: true, downloadsSameDevice: true, reportedAt: w!.lastSeenAt });
  });

  describe('storage', () => {
    const beat = async (devices: Partial<Record<StorageArea, string>>, freeBytes = 5e11) => {
      const response = await connect();
      if (!response.accepted) throw new Error('rejected');
      const storage = storageSpace();
      for (const area of STORAGE_AREAS) storage[area] = { freeBytes, device: devices[area] ?? '2049' };
      await t.mutation(api.jobs.worker.heartbeat, { ...worker, sessionId: response.sessionId, storage });
    };

    test("the last heartbeat's free bytes and devices, with the connect's write check", async () => {
      await beat({});
      const { storage } = await status();
      expect(storage!.areas.staging).toEqual({ freeBytes: 5e11, device: '2049', writable: true });
      expect(storage).toMatchObject({ librarySameDevice: true, downloadsSameDevice: true });
    });

    test('downloads on another filesystem: imports copy, and the library areas still share one', async () => {
      await beat({ downloads: '2050' });
      expect(await status()).toMatchObject({ storage: { librarySameDevice: true, downloadsSameDevice: false } });
    });

    test('a library root on another filesystem', async () => {
      await beat({ movies: '2051' });
      expect(await status()).toMatchObject({ storage: { librarySameDevice: false, downloadsSameDevice: true } });
    });
  });

  test('an old worker is shown as rejected, with the version expected, and the banner says mismatch', async () => {
    await connect(PROTOCOL_VERSION - 1, 'old');
    await t.mutation(internal.jobs.queue.supervise, {});
    const { worker: w, banner } = await status();
    expect(banner).toBe('protocolMismatch');
    expect(w).toMatchObject({ workerId: 'old', connected: false, accepted: false, protocolVersion: PROTOCOL_VERSION - 1, expectedVersion: PROTOCOL_VERSION });
  });

  test('a worker gone quiet for 60 s is shown disconnected, with the offline banner', async () => {
    const response = await connect();
    if (!response.accepted) throw new Error('rejected');
    await t.run((ctx) => ctx.db.patch(response.sessionId, { lastSeenAt: Date.now() - DEFAULT_LIMITS.livenessMs - 1 }));
    await t.mutation(internal.jobs.queue.supervise, {});
    const { worker: w, banner } = await status();
    expect(w!.connected).toBe(false);
    expect(banner).toBe('workerOffline');
  });

  test('job counts per class and status, and indexer health', async () => {
    await t.mutation(internal.jobs.queue.enqueue, {
      payload: { class: 'maintenance', action: 'cleanStaging', paths: ['/x'] },
      idempotencyKey: 'cleanStaging:x',
    });
    const indexerId = await seedIndexer(t);
    const { jobCounts, indexers } = await status();
    expect(jobCounts.find((row) => row.class === 'maintenance')).toEqual({ class: 'maintenance', queued: 1, waiting: 0, leased: 0 });
    expect(jobCounts.find((row) => row.class === 'import')).toEqual({ class: 'import', queued: 0, waiting: 0, leased: 0 });
    expect(indexers).toEqual([{ indexerId, name: 'indexer.fake', enabled: true, health: { status: 'unknown' } }]);
  });

  describe('client rows', () => {
    const provider = { host: 'news.example', port: 563, ssl: true, username: 'u', password: 'p', connections: 8 };

    test('before any provider is saved, NZBGet is shown disabled and not reachable', async () => {
      expect((await status()).clients).toEqual([{ clientKind: 'nzbget', enabled: false, reachable: false, config: 'pending', activeDownloads: 0 }]);
    });

    test("NZBGet's row follows the worker's reports: reachable, its version, and the config applied", async () => {
      const response = await connect();
      if (!response.accepted) throw new Error('rejected');
      await admin.mutation(api.api.downloadClients.saveUsenet, { input: provider });
      expect((await status()).clients).toEqual([{ clientKind: 'nzbget', enabled: true, reachable: false, config: 'pending', activeDownloads: 0 }]);
      await t.mutation(api.jobs.clients.report, {
        ...worker,
        sessionId: response.sessionId,
        reports: [{ kind: 'nzbget', reachable: true, clientVersion: '26.3', appliedConfigVersion: 1 }],
      });
      expect((await status()).clients).toEqual([
        { clientKind: 'nzbget', enabled: true, reachable: true, clientVersion: '26.3', config: 'applied', activeDownloads: 0 },
      ]);
    });

    test("qBittorrent's row: the seeding count and problems, the connection status and the peer port", async () => {
      const response = await connect();
      if (!response.accepted) throw new Error('rejected');
      await admin.mutation(api.api.downloadClients.saveTorrents, { input: { enabled: true, seedGoal: { ratio: 2 } } });
      await t.mutation(api.jobs.clients.report, {
        ...worker,
        sessionId: response.sessionId,
        reports: [{ kind: 'qbittorrent', reachable: true, clientVersion: 'v5.3.0', appliedConfigVersion: 1, connectionStatus: 'firewalled', peerPort: 6881 }],
      });
      expect((await status()).clients.find((row) => row.clientKind === 'qbittorrent')).toEqual({
        clientKind: 'qbittorrent',
        enabled: true,
        reachable: true,
        clientVersion: 'v5.3.0',
        config: 'applied',
        activeDownloads: 0,
        seedingCount: 0,
        seedingProblemCount: 0,
        connectionStatus: 'firewalled',
        peerPort: 6881,
      });
    });
  });

  test('refuses a caller without an admin session', async () => {
    await expect(t.query(api.api.system.status, {})).rejects.toThrow(/unauthorized/);
  });
});
