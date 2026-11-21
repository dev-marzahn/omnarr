import { type Capabilities, PROTOCOL_VERSION, STORAGE_AREAS, type StorageArea, type StorageSpace } from '@omnarr/contracts';
import { beforeEach, describe, expect, test } from 'vite-plus/test';

import { api, internal } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import { asAdmin, capabilities, setup, storageSpace, worker, type Backend } from './setup';

let t: Backend;
beforeEach(() => {
  t = setup();
});

/** A write check's result after a job failed with `EACCES` or `EROFS`: every area writable but these. */
const writableExcept = (...areas: StorageArea[]) =>
  Object.fromEntries(STORAGE_AREAS.map((area) => [area, !areas.includes(area)])) as Record<StorageArea, boolean>;

const openIssues = (code: string) =>
  t.run(async (ctx) => (await ctx.db.query('issues').collect()).filter((issue) => issue.state === 'open' && issue.failureCode === code));

describe('worker.connect', () => {
  test('accepts a worker with the backend protocol version', async () => {
    const response = await t.mutation(api.jobs.worker.connect, { ...worker, workerId: 'w1', capabilities });
    expect(response.accepted).toBe(true);
  });

  test('rejects a mismatched version with the expected one, and claims nothing', async () => {
    const response = await t.mutation(api.jobs.worker.connect, { ...worker, protocolVersion: PROTOCOL_VERSION + 1, workerId: 'w1', capabilities });
    expect(response).toEqual({ accepted: false, expectedVersion: PROTOCOL_VERSION });
    expect(await openIssues('protocolMismatch')).toHaveLength(1);
  });

  test('only the first rejection writes a session row', async () => {
    const old = { ...worker, protocolVersion: PROTOCOL_VERSION - 1, workerId: 'w1', capabilities };
    await t.mutation(api.jobs.worker.connect, old);
    await t.mutation(api.jobs.worker.connect, old);
    await t.mutation(api.jobs.worker.connect, old);
    const sessions = await t.run((ctx) => ctx.db.query('workerSessions').collect());
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({ accepted: false, rejectReason: 'protocolMismatch' });
    expect(await openIssues('protocolMismatch')).toHaveLength(1);
  });

  test('a matching worker resolves the protocolMismatch Issue', async () => {
    await t.mutation(api.jobs.worker.connect, { ...worker, protocolVersion: 0, workerId: 'w1', capabilities });
    await t.mutation(api.jobs.worker.connect, { ...worker, workerId: 'w1', capabilities });
    expect(await openIssues('protocolMismatch')).toHaveLength(0);
  });

  test('a reconnect starts a new session, so the old leases expire', async () => {
    const first = await t.mutation(api.jobs.worker.connect, { ...worker, workerId: 'w1', capabilities });
    const second = await t.mutation(api.jobs.worker.connect, { ...worker, workerId: 'w1', capabilities });
    expect(first.accepted && second.accepted && first.sessionId !== second.sessionId).toBe(true);
  });

  test("another release's worker is rejected with the expected version whatever its capabilities, and none are stored", async () => {
    const response = await t.mutation(api.jobs.worker.connect, {
      ...worker,
      protocolVersion: PROTOCOL_VERSION - 1,
      workerId: 'w1',
      capabilities: { ffmpeg: 'some old shape' },
    });
    expect(response).toEqual({ accepted: false, expectedVersion: PROTOCOL_VERSION });
    const [session] = await t.run((ctx) => ctx.db.query('workerSessions').collect());
    expect(session).not.toHaveProperty('capabilities');
  });

  test('a matching version with invalid capabilities fails with invalidCapabilities', async () => {
    await expect(t.mutation(api.jobs.worker.connect, { ...worker, workerId: 'w1', capabilities: { ffmpeg: 'bad' } })).rejects.toThrow(/invalidCapabilities/);
  });

  test('system.status reads ffmpeg from the newest accepted session, not a newer rejected one', async () => {
    await t.mutation(api.jobs.worker.connect, { ...worker, workerId: 'w1', capabilities });
    await t.mutation(api.jobs.worker.connect, { ...worker, protocolVersion: 0, workerId: 'w2', capabilities: {} });
    const status = await (await asAdmin(t)).query(api.api.system.status, {});
    expect(status.worker).toMatchObject({ workerId: 'w2', accepted: false, ffmpegVersion: '7.1', encoders: ['libx264', 'aac'] });
  });

  test('rejects a wrong worker token', async () => {
    await expect(t.mutation(api.jobs.worker.connect, { ...worker, workerToken: 'nope', workerId: 'w1', capabilities })).rejects.toThrow(/unauthorized/);
  });
});

describe('worker.heartbeat', () => {
  const connect = async () => {
    const response = await t.mutation(api.jobs.worker.connect, { ...worker, workerId: 'w1', capabilities });
    if (!response.accepted) throw new Error('not accepted');
    return response.sessionId;
  };

  test('updates lastSeenAt and each area’s free bytes and device, keeping the write check of connect', async () => {
    const sessionId = await connect();
    const space = storageSpace();
    await t.mutation(api.jobs.worker.heartbeat, { ...worker, sessionId, storage: { ...space, staging: { freeBytes: 6, device: '2049' } } });
    const session = await t.run((ctx) => ctx.db.get(sessionId));
    expect(session?.capabilities?.storage).toEqual({ ...capabilities.storage, staging: { freeBytes: 6, device: '2049', writable: true } });
  });

  test('stores the write check a heartbeat carries', async () => {
    const sessionId = await connect();
    await t.mutation(api.jobs.worker.heartbeat, { ...worker, sessionId, storage: storageSpace(), writable: writableExcept('movies') });
    const session = await t.run((ctx) => ctx.db.get(sessionId));
    expect(session?.capabilities?.storage.movies).toEqual({ freeBytes: 1e12, device: '2049', writable: false });
    expect(session?.capabilities?.storage.series.writable).toBe(true);
  });

  test('refuses a session that was rejected', async () => {
    await t.mutation(api.jobs.worker.connect, { ...worker, protocolVersion: 0, workerId: 'w1', capabilities });
    const [rejected] = await t.run((ctx) => ctx.db.query('workerSessions').collect());
    await expect(t.mutation(api.jobs.worker.heartbeat, { ...worker, sessionId: rejected!._id, storage: storageSpace() })).rejects.toThrow(/sessionNotAccepted/);
  });

  test('refuses a call with another protocol version', async () => {
    const sessionId = await connect();
    await expect(
      t.mutation(api.jobs.worker.heartbeat, { ...worker, protocolVersion: PROTOCOL_VERSION + 1, sessionId, storage: storageSpace() }),
    ).rejects.toThrow(/protocolMismatch/);
  });
});

describe('storageUnavailable', () => {
  const FIX = 'Put the library, staging and originals on the /data volume, and check the owner set in the compose file.';
  const storageIssues = () => openIssues('storageUnavailable');
  const connectWith = async (storage: Capabilities['storage']) => {
    const response = await t.mutation(api.jobs.worker.connect, { ...worker, workerId: 'w1', capabilities: { ...capabilities, storage } });
    if (!response.accepted) throw new Error('not accepted');
    return response.sessionId;
  };
  const beat = (sessionId: Id<'workerSessions'>, storage: StorageSpace, writable?: Record<StorageArea, boolean>) =>
    t.mutation(api.jobs.worker.heartbeat, { ...worker, sessionId, storage, ...(writable ? { writable } : {}) });
  const onDevice = (device: string, ...areas: StorageArea[]) => {
    const space = storageSpace();
    for (const area of areas) space[area] = { ...space[area], device };
    return space;
  };

  test('a connect whose write check finds areas not writable raises it, naming the areas', async () => {
    const { series, movies } = capabilities.storage;
    await connectWith({ ...capabilities.storage, series: { ...series, writable: false }, movies: { ...movies, writable: false } });
    expect(await storageIssues()).toMatchObject([{ scope: 'system', class: 'system', fixActions: [], detail: `Not writable: series and movies. ${FIX}` }]);
  });

  test('a heartbeat that finds the library on another device raises it, and one that finds one device again resolves it', async () => {
    const sessionId = await connectWith(capabilities.storage);
    expect(await storageIssues()).toEqual([]);

    await beat(sessionId, onDevice('2050', 'series'));
    expect(await storageIssues()).toMatchObject([
      { detail: `On different filesystems: staging, originals and movies (device 2049); series (device 2050). ${FIX}` },
    ]);

    await beat(sessionId, storageSpace());
    expect(await storageIssues()).toEqual([]);
  });

  test('downloads on another device is not an Issue: imports copy instead', async () => {
    const sessionId = await connectWith(capabilities.storage);
    await beat(sessionId, onDevice('2050', 'downloads'));
    expect(await storageIssues()).toEqual([]);
  });

  test('an area not writable stays raised until a write check finds it writable', async () => {
    const sessionId = await connectWith(capabilities.storage);
    await beat(sessionId, storageSpace(), writableExcept('originals'));
    expect(await storageIssues()).toMatchObject([{ detail: `Not writable: originals. ${FIX}` }]);

    await beat(sessionId, storageSpace());
    expect(await storageIssues()).toHaveLength(1);

    await beat(sessionId, storageSpace(), writableExcept());
    expect(await storageIssues()).toEqual([]);
  });

  test('a later connect whose check passes resolves it', async () => {
    const { staging } = capabilities.storage;
    await connectWith({ ...capabilities.storage, staging: { ...staging, writable: false } });
    await connectWith(capabilities.storage);
    expect(await storageIssues()).toEqual([]);
  });
});

describe('worker.artifactUploadUrl', () => {
  test('gives the holder of a lease an upload URL, and refuses a stale lease', async () => {
    const response = await t.mutation(api.jobs.worker.connect, { ...worker, workerId: 'w1', capabilities });
    if (!response.accepted) throw new Error('rejected');
    await t.mutation(internal.jobs.queue.enqueue, { payload: { class: 'maintenance', action: 'buildSupportBundle' }, idempotencyKey: 'buildSupportBundle:1' });
    const [job] = await t.mutation(api.jobs.queue.claim, { ...worker, sessionId: response.sessionId, class: 'maintenance', max: 1 });
    expect(await t.mutation(api.jobs.worker.artifactUploadUrl, { ...worker, jobId: job!.jobId, leaseEpoch: job!.leaseEpoch })).toEqual({
      uploadUrl: expect.stringMatching(/^https?:/),
    });
    await expect(t.mutation(api.jobs.worker.artifactUploadUrl, { ...worker, jobId: job!.jobId, leaseEpoch: job!.leaseEpoch + 1 })).rejects.toThrow(
      /staleLease/,
    );
  });
});
