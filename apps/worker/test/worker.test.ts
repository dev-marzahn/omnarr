import { type Capabilities, DEFAULT_LIMITS, PROTOCOL_VERSION, type StorageSpace } from '@omnarr/contracts';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';

import { startWorker, type Worker } from '../src/worker.ts';
import { FakeBackend } from './fakeBackend.ts';
import { IMPORT_PAYLOAD } from './payloads.ts';

const area = { freeBytes: 1, device: '42' };
const SPACE: StorageSpace = { downloads: area, staging: area, originals: area, series: area, movies: area };
const writable = { ...area, writable: true };
const capabilities: Capabilities = {
  ffmpegVersion: '7.1',
  encoders: [],
  storage: { downloads: writable, staging: writable, originals: writable, series: writable, movies: writable },
};

let backend: FakeBackend;
let worker: Worker | undefined;
beforeEach(() => {
  vi.useFakeTimers();
  backend = new FakeBackend();
});
afterEach(async () => {
  await worker?.stop();
  vi.useRealTimers();
});

const start = () => {
  worker = startWorker({
    backend,
    workerId: 'w1',
    capabilities: async () => capabilities,
    storage: async () => SPACE,
    handlers: {
      maintenance: async () => ({ class: 'maintenance', action: 'cleanStaging', removedPaths: [] }),
    },
    log: () => {},
  });
  return worker;
};

describe("Jellyfin's connection", () => {
  const startWithJellyfin = (onConnection: (value: unknown) => void) => {
    worker = startWorker({
      backend,
      workerId: 'w1',
      capabilities: async () => capabilities,
      storage: async () => SPACE,
      handlers: { maintenance: async () => ({ class: 'maintenance', action: 'cleanStaging', removedPaths: [] }) },
      jellyfin: { onConnection },
      log: () => {},
    });
  };

  test('each session subscribes, and claims nothing before the first value arrives', async () => {
    backend.jellyfinConnectionHeld = true;
    const values: unknown[] = [];
    backend.add({ class: 'maintenance', action: 'cleanStaging', paths: [] });
    startWithJellyfin((value) => values.push(value));
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.count('watchJellyfinConnection')).toBe(1);
    expect(backend.count('claim')).toBe(0);

    backend.pushJellyfinConnection({ state: 'ready', apiKey: 'k', adminUserId: 'u', libraries: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(values).toEqual([{ state: 'ready', apiKey: 'k', adminUserId: 'u', libraries: [] }]);
    expect(backend.count('claim')).toBeGreaterThan(0);
    expect(backend.count('complete')).toBe(1);
  });

  test('with Jellyfin not set up (connection null), download and import jobs are still claimed and run', async () => {
    backend.jellyfinConnection = null;
    const ran: string[] = [];
    worker = startWorker({
      backend,
      workerId: 'w1',
      capabilities: async () => capabilities,
      storage: async () => SPACE,
      handlers: {
        'download.submit': async () => (ran.push('download.submit'), { class: 'download.submit', clientRef: 'nzb-1' }),
        import: async () => (ran.push('import'), { class: 'import', files: [] }),
      },
      jellyfin: { onConnection: () => {} },
      log: () => {},
    });
    backend.add({
      class: 'download.submit',
      grabId: 'g' as never,
      downloadId: 'd' as never,
      source: { kind: 'nzbUrl', url: 'http://indexer.invalid/1.nzb' },
      correlationTag: 'g',
      category: 'platform-series',
      indexerName: 'Main',
    });
    backend.add(IMPORT_PAYLOAD);
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.count('watchJellyfinConnection')).toBe(1);
    expect(ran.sort()).toEqual(['download.submit', 'import']);
    expect(backend.count('complete')).toBe(2);
  });

  test('the subscription stops with the session', async () => {
    startWithJellyfin(() => {});
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.jellyfinWatchers).toBe(1);
    await worker!.stop();
    worker = undefined;
    expect(backend.jellyfinWatchers).toBe(0);
  });
});

describe('the play poller', () => {
  const READY = { state: 'ready' as const, apiKey: 'k', adminUserId: 'u', libraries: [] };
  const PLAY = { deviceId: 'd', deviceName: 'Chrome', client: 'Jellyfin Web', itemRef: 'item', method: 'directPlay' as const, reasons: [], rawReasons: [] };
  let observed: number;

  const startWithPoller = () => {
    observed = 0;
    worker = startWorker({
      backend,
      workerId: 'w1',
      capabilities: async () => capabilities,
      storage: async () => SPACE,
      handlers: {},
      jellyfin: {
        onConnection: () => {},
        target: {
          observe: async () => {
            observed++;
            return [PLAY];
          },
        },
      },
      log: () => {},
    });
  };

  test("starts with the session and reads the session's connection", async () => {
    backend.jellyfinConnection = { state: 'settingUp', libraries: [] };
    startWithPoller();
    await vi.advanceTimersByTimeAsync(DEFAULT_LIMITS.playbackPollMs);
    expect(observed).toBe(0);

    backend.pushJellyfinConnection(READY);
    await vi.advanceTimersByTimeAsync(DEFAULT_LIMITS.playbackPollMs);
    expect(observed).toBe(1);
    expect(backend.playReports).toEqual([{ sessionId: 'session1', plays: [PLAY] }]);
  });

  test("the e2e's lowered playbackPollMs: a poll every 2 s", async () => {
    backend.jellyfinConnection = READY;
    observed = 0;
    worker = startWorker({
      backend,
      workerId: 'w1',
      capabilities: async () => capabilities,
      storage: async () => SPACE,
      handlers: {},
      jellyfin: { onConnection: () => {}, target: { observe: async () => (observed++, [PLAY]) } },
      limits: { ...DEFAULT_LIMITS, playbackPollMs: 2000 },
      log: () => {},
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(observed).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(observed).toBe(2);
  });

  test('stops with the session, and a new session starts its own and sends its first set again', async () => {
    backend.jellyfinConnection = READY;
    backend.connectResponses = [
      { accepted: true, sessionId: 'session1' as never },
      { accepted: true, sessionId: 'session2' as never },
    ];
    startWithPoller();
    await vi.advanceTimersByTimeAsync(DEFAULT_LIMITS.playbackPollMs);
    expect(backend.playReports.map((report) => report.sessionId)).toEqual(['session1']);

    // The backend refuses the session: the worker connects again at once.
    backend.heartbeatError = 'sessionNotAccepted';
    await vi.advanceTimersByTimeAsync(DEFAULT_LIMITS.heartbeatMs);
    backend.heartbeatError = undefined;
    expect(backend.count('connect')).toBe(2);
    await vi.advanceTimersByTimeAsync(DEFAULT_LIMITS.playbackPollMs);
    expect(backend.playReports.map((report) => report.sessionId)).toEqual(['session1', 'session2']);

    const before = observed;
    await worker!.stop();
    worker = undefined;
    await vi.advanceTimersByTimeAsync(DEFAULT_LIMITS.playbackPollMs * 3);
    expect(observed).toBe(before);
  });

  test("a stop before the connection's first value stops the poller and the subscription too", async () => {
    backend.jellyfinConnectionHeld = true;
    startWithPoller();
    await vi.advanceTimersByTimeAsync(0);
    await worker!.stop();
    worker = undefined;
    backend.pushJellyfinConnection(READY);
    await vi.advanceTimersByTimeAsync(DEFAULT_LIMITS.playbackPollMs * 3);
    expect(observed).toBe(0);
    expect(backend.jellyfinWatchers).toBe(0);
  });
});

describe('the handshake', () => {
  test('a rejected worker retries every 60 s without exiting, and claims nothing until accepted', async () => {
    backend.connectResponses = [
      { accepted: false, expectedVersion: PROTOCOL_VERSION + 1 },
      { accepted: false, expectedVersion: PROTOCOL_VERSION + 1 },
    ];
    backend.add({ class: 'maintenance', action: 'cleanStaging', paths: [] });
    start();
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.count('connect')).toBe(1);
    expect(backend.count('claim')).toBe(0);

    await vi.advanceTimersByTimeAsync(DEFAULT_LIMITS.handshakeRetryMs);
    expect(backend.count('connect')).toBe(2);
    expect(backend.count('claim')).toBe(0);

    await vi.advanceTimersByTimeAsync(DEFAULT_LIMITS.handshakeRetryMs);
    expect(backend.count('connect')).toBe(3);
    expect(backend.count('complete')).toBe(1);
  });

  test("the e2e's lowered handshakeRetryMs: a rejected worker retries every 2 s", async () => {
    backend.connectResponses = [{ accepted: false, expectedVersion: PROTOCOL_VERSION + 1 }];
    worker = startWorker({
      backend,
      workerId: 'w1',
      capabilities: async () => capabilities,
      storage: async () => SPACE,
      handlers: {},
      limits: { ...DEFAULT_LIMITS, handshakeRetryMs: 2000 },
      log: () => {},
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.count('connect')).toBe(1);
    await vi.advanceTimersByTimeAsync(2000);
    expect(backend.count('connect')).toBe(2);
  });

  test('a backend upgraded under a connected worker sends it back to the handshake', async () => {
    start();
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.count('connect')).toBe(1);

    // The new backend refuses the old session's calls, and the old version at connect.
    backend.heartbeatError = 'protocolMismatch';
    backend.connectResponses = [{ accepted: false, expectedVersion: PROTOCOL_VERSION + 1 }];
    await vi.advanceTimersByTimeAsync(DEFAULT_LIMITS.heartbeatMs);
    expect(backend.count('connect')).toBe(2);

    // It keeps retrying, and no longer beats on the dead session.
    const beats = backend.count('heartbeat');
    await vi.advanceTimersByTimeAsync(DEFAULT_LIMITS.handshakeRetryMs);
    expect(backend.count('connect')).toBe(3);
    expect(backend.count('heartbeat')).toBe(beats);
  });

  test('connects with its id and capabilities', async () => {
    start();
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.calls[0]).toEqual({ fn: 'connect', args: { workerId: 'w1', capabilities } });
  });
});

describe('the heartbeat', () => {
  test("beats every 20 s with each area's free bytes and device", async () => {
    start();
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.count('heartbeat')).toBe(0);
    await vi.advanceTimersByTimeAsync(DEFAULT_LIMITS.heartbeatMs * 3);
    expect(backend.count('heartbeat')).toBe(3);
    expect(backend.calls.find((c) => c.fn === 'heartbeat')?.args).toEqual({ sessionId: 'session1', storage: SPACE });
  });

  test.each(['EACCES', 'EROFS'])('after a job fails with %s, the next beat runs the write check again and sends it once', async (code) => {
    const checks: string[] = [];
    const READ_ONLY = { downloads: true, staging: true, originals: true, series: false, movies: true };
    worker = startWorker({
      backend,
      workerId: 'w1',
      capabilities: async () => capabilities,
      storage: async () => SPACE,
      writeCheck: async () => (checks.push('check'), READ_ONLY),
      handlers: {
        maintenance: async () => {
          throw Object.assign(new Error('write refused'), { code });
        },
      },
      log: () => {},
    });
    backend.add({ class: 'maintenance', action: 'cleanStaging', paths: [] });
    await vi.advanceTimersByTimeAsync(0);
    expect(backend.calls.find((c) => c.fn === 'fail')?.args).toMatchObject({ failureCode: 'pipelineError' });
    await vi.advanceTimersByTimeAsync(DEFAULT_LIMITS.heartbeatMs * 2);
    const beats = backend.calls.filter((c) => c.fn === 'heartbeat').map((c) => c.args);
    expect(beats).toEqual([
      { sessionId: 'session1', storage: SPACE, writable: READ_ONLY },
      { sessionId: 'session1', storage: SPACE },
    ]);
    expect(checks).toEqual(['check']);
  });

  test('a job failure for another reason runs no write check', async () => {
    const checks: string[] = [];
    worker = startWorker({
      backend,
      workerId: 'w1',
      capabilities: async () => capabilities,
      storage: async () => SPACE,
      writeCheck: async () => (checks.push('check'), { downloads: true, staging: true, originals: true, series: true, movies: true }),
      handlers: {
        maintenance: async () => {
          throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        },
      },
      log: () => {},
    });
    backend.add({ class: 'maintenance', action: 'cleanStaging', paths: [] });
    await vi.advanceTimersByTimeAsync(DEFAULT_LIMITS.heartbeatMs);
    expect(checks).toEqual([]);
    expect(backend.calls.find((c) => c.fn === 'heartbeat')?.args).toEqual({ sessionId: 'session1', storage: SPACE });
  });

  test('aborts the jobs it returns, which report cancelled', async () => {
    worker = startWorker({
      backend,
      workerId: 'w1',
      capabilities: async () => capabilities,
      storage: async () => SPACE,
      handlers: { maintenance: (_job, { signal }) => new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(signal.reason))) },
      log: () => {},
    });
    const jobId = backend.add({ class: 'maintenance', action: 'cleanStaging', paths: [] });
    await vi.advanceTimersByTimeAsync(0);
    backend.cancel.add(jobId);
    await vi.advanceTimersByTimeAsync(DEFAULT_LIMITS.heartbeatMs);
    expect(backend.calls.find((c) => c.fn === 'fail')?.args).toMatchObject({ jobId, failureCode: 'cancelled' });
  });
});

describe('the download reconciler', () => {
  const withReconciler = (passes: string[]) => {
    worker = startWorker({
      backend,
      workerId: 'w1',
      capabilities: async () => capabilities,
      storage: async () => SPACE,
      handlers: { maintenance: async () => ({ class: 'maintenance', action: 'cleanStaging', removedPaths: [] }) },
      reconciler: () => ({
        startup: async () => void passes.push(`startup, claims so far: ${backend.count('claim')}`),
        pass: async () => void passes.push('pass'),
      }),
      log: () => {},
    });
  };

  test('runs the startup reconciliation before the first claim, then a pass every 30 s', async () => {
    const passes: string[] = [];
    backend.add({ class: 'maintenance', action: 'cleanStaging', paths: [] });
    withReconciler(passes);
    await vi.advanceTimersByTimeAsync(0);
    expect(passes).toEqual(['startup, claims so far: 0']);
    expect(backend.count('complete')).toBe(1);
    await vi.advanceTimersByTimeAsync(DEFAULT_LIMITS.reconcilerPollMs * 2);
    expect(passes).toEqual(['startup, claims so far: 0', 'pass', 'pass']);
  });

  test("the e2e's lowered reconcilerPollMs and progressPollMs: a pass every 2 s, a progress tick every second", async () => {
    const passes: string[] = [];
    worker = startWorker({
      backend,
      workerId: 'w1',
      capabilities: async () => capabilities,
      storage: async () => SPACE,
      handlers: {},
      reconciler: () => ({ startup: async () => {}, pass: async () => void passes.push('pass'), progressTick: async () => void passes.push('tick') }),
      limits: { ...DEFAULT_LIMITS, reconcilerPollMs: 2000, progressPollMs: 1000 },
      log: () => {},
    });
    await vi.advanceTimersByTimeAsync(2000);
    expect(passes).toEqual(['tick', 'pass', 'tick']);
  });
});

test("the e2e's lowered heartbeatMs: a beat every 3 s", async () => {
  worker = startWorker({
    backend,
    workerId: 'w1',
    capabilities: async () => capabilities,
    storage: async () => SPACE,
    handlers: {},
    limits: { ...DEFAULT_LIMITS, heartbeatMs: 3000 },
    log: () => {},
  });
  await vi.advanceTimersByTimeAsync(6000);
  expect(backend.count('heartbeat')).toBe(2);
});

test('stop stops the heartbeat', async () => {
  const w = start();
  await vi.advanceTimersByTimeAsync(0);
  await w.stop();
  worker = undefined;
  await vi.advanceTimersByTimeAsync(DEFAULT_LIMITS.heartbeatMs * 3);
  expect(backend.count('heartbeat')).toBe(0);
});
