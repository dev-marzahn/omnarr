// The download reconciler and the startup reconciliation, against a fake
// backend and a fake client: config
// convergence, only changes reported, the two-pass missing rule, stalls,
// staging emptied and orphans reported.
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_LIMITS, type DesiredClientConfig, type Limits } from '@omnarr/contracts';
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';

import type { GluetunReader } from '../src/clients/gluetun.ts';
import { dataLayout, type DataLayout } from '../src/fs/layout.ts';
import { ClientRuntimeStore } from '../src/runtime/clientRuntime.ts';
import { JobFailure } from '../src/runtime/lease.ts';
import { Reconciler } from '../src/runtime/reconcile.ts';
import { VpnMonitor } from '../src/runtime/vpnMonitor.ts';
import { FakeBackend } from './fakeBackend.ts';
import { FakeDownloadClient } from './fakeDownloadClient.ts';

let backend: FakeBackend;
let client: FakeDownloadClient;
let runtime: ClientRuntimeStore;
let root: string;
let layout: DataLayout;
let now: number;

const server = { host: 'news.example', port: 563, ssl: true, username: 'u', password: 'p', connections: 8, level: 0 };
const nzbgetRow = (overrides: Partial<DesiredClientConfig> = {}): DesiredClientConfig => ({
  kind: 'nzbget',
  clientId: 'c1' as never,
  enabled: true,
  configVersion: 1,
  nzbget: { server },
  ...overrides,
});

beforeEach(async () => {
  backend = new FakeBackend();
  backend.desired = [nzbgetRow()];
  client = new FakeDownloadClient();
  runtime = new ClientRuntimeStore();
  root = await mkdtemp(join(tmpdir(), 'omnarr-reconcile-'));
  layout = dataLayout(root);
  now = 1_000_000;
});
afterEach(() => rm(root, { recursive: true, force: true }));

const reconciler = (clients: ConstructorParameters<typeof Reconciler>[0]['clients'] = { nzbget: client }) =>
  new Reconciler({ backend, sessionId: 'session1' as never, clients, layout, runtime, now: () => now, log: () => {} });

/** A Download the backend has as active, and its item in the client. */
function tracked(grabId = 'grab1') {
  const clientRef = client.add(grabId);
  backend.active.push({ downloadId: `dl-${grabId}` as never, clientKind: 'nzbget', clientRef, correlationTag: grabId, clientStage: 'queued', state: 'active' });
  return clientRef;
}

describe('monthly limits on the client poll', () => {
  const limited = { ...server, host: 'bonus.example', level: 2, id: 'bonus', limit: { monthlyLimitGb: 1, resetDay: 1 } };

  test('each pass checks the limits once the config is applied and reports the usage, only when it changed', async () => {
    backend.desired = [nzbgetRow({ nzbget: { server, backupServers: [limited] } })];
    client.usage = [{ backupId: 'bonus', usedBytes: 2e9, limitReached: true }];
    const r = reconciler();
    await r.pass();
    expect(client.limitChecks).toEqual([{ server, backupServers: [limited] }]);
    expect(backend.clientReports[0]).toEqual([
      {
        kind: 'nzbget',
        reachable: true,
        clientVersion: '26.3',
        appliedConfigVersion: 1,
        usenetUsage: [{ backupId: 'bonus', usedBytes: 2e9, limitReached: true }],
      },
    ]);
    backend.desired = [nzbgetRow({ nzbget: { server, backupServers: [limited] }, appliedConfigVersion: 1 })];
    await r.pass();
    expect(client.limitChecks).toHaveLength(2);
    expect(backend.clientReports).toHaveLength(1);
  });

  test("a failed apply skips the check: NZBGet's ServerIDs may not match the saved servers yet", async () => {
    backend.desired = [nzbgetRow({ nzbget: { server, backupServers: [limited] } })];
    client.applyConfig = async () => {
      throw new JobFailure('pipelineError', 'NZBGet refused saveconfig.');
    };
    await reconciler().pass();
    expect(client.limitChecks).toEqual([]);
  });
});

describe('config convergence', () => {
  test("the first pass of a session applies each enabled client's config, before anything is compared, and reports the version", async () => {
    await reconciler().pass();
    expect(client.applied).toEqual([nzbgetRow()]);
    expect(client.calls[0]).toBe('applyConfig');
    expect(runtime.configured('nzbget')).toBe(true);
    expect(backend.clientReports).toEqual([[{ kind: 'nzbget', reachable: true, clientVersion: '26.3', appliedConfigVersion: 1 }]]);
  });

  test("a restarted worker applies again, though the row says it's applied: changes made inside the client are overwritten", async () => {
    backend.desired = [nzbgetRow({ appliedConfigVersion: 1 })];
    await reconciler().pass();
    expect(client.applied).toHaveLength(1);
  });

  test('later passes apply only after a save raised configVersion', async () => {
    const r = reconciler();
    await r.pass();
    await r.pass();
    expect(client.applied).toHaveLength(1);
    backend.desired[0]!.configVersion = 2;
    await r.pass();
    expect(client.applied).toHaveLength(2);
    expect(backend.clientReports.at(-1)).toEqual([{ kind: 'nzbget', reachable: true, clientVersion: '26.3', appliedConfigVersion: 2 }]);
  });

  test('a failed apply reports applyFailure and is retried on the next pass; the client is not configured until then', async () => {
    client.unreachable = true;
    const r = reconciler();
    await r.pass();
    expect(runtime.configured('nzbget')).toBe(false);
    expect(backend.clientReports).toEqual([[{ kind: 'nzbget', reachable: false, applyFailure: 'clientUnreachable' }]]);
    client.unreachable = false;
    await r.pass();
    expect(runtime.configured('nzbget')).toBe(true);
    expect(backend.clientReports.at(-1)).toEqual([{ kind: 'nzbget', reachable: true, clientVersion: '26.3', appliedConfigVersion: 1 }]);
  });

  test("an apply the client refuses reports the adapter's code", async () => {
    client.applyConfig = async () => {
      throw new JobFailure('pipelineError', 'NZBGet refused saveconfig.');
    };
    await reconciler().pass();
    expect(backend.clientReports).toEqual([[{ kind: 'nzbget', reachable: true, applyFailure: 'pipelineError' }]]);
  });

  test('a disabled row, or no row, is not applied and leaves the client unconfigured', async () => {
    backend.desired = [nzbgetRow({ enabled: false })];
    await reconciler().pass();
    backend.desired = [];
    await reconciler().pass();
    expect(client.applied).toEqual([]);
    expect(runtime.configured('nzbget')).toBe(false);
  });

  test('the latest desired config lands in the runtime store', async () => {
    await reconciler().pass();
    expect(runtime.desired('nzbget')).toEqual(nzbgetRow());
  });

  test('a new session starts unconfigured, so its first pass applies again', async () => {
    await reconciler().pass();
    await reconciler().pass();
    expect(client.applied).toHaveLength(2);
  });

  test('the apply runs under the client lock', async () => {
    let release!: () => void;
    const held = runtime.withClientLock('nzbget', () => new Promise<void>((resolve) => (release = resolve)));
    const passing = reconciler().pass();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(client.applied).toEqual([]);
    release();
    await Promise.all([held, passing]);
    expect(client.applied).toHaveLength(1);
  });
});

describe('client status reports', () => {
  test('an unchanged status is reported once', async () => {
    const r = reconciler();
    await r.pass();
    await r.pass();
    await r.pass();
    expect(backend.clientReports).toHaveLength(1);
  });

  test('a client that stops answering is reported unreachable, and reachable again when it answers', async () => {
    const r = reconciler();
    await r.pass();
    client.unreachable = true;
    await r.pass();
    client.unreachable = false;
    await r.pass();
    expect(backend.clientReports.slice(1)).toEqual([[{ kind: 'nzbget', reachable: false }], [{ kind: 'nzbget', reachable: true, clientVersion: '26.3' }]]);
  });
});

describe('a pass over the watched Downloads', () => {
  test('reports nothing while nothing changed', async () => {
    tracked();
    await reconciler().pass();
    expect(backend.reports).toEqual([]);
  });

  test('reports a new client stage once', async () => {
    const ref = tracked();
    client.set(ref, { stage: 'downloading', status: { stage: 'DOWNLOADING', progress: 0.2, raw: {} } });
    const r = reconciler();
    await r.pass();
    client.set(ref, { status: { stage: 'DOWNLOADING', progress: 0.6, raw: {} } });
    await r.pass();
    expect(backend.reports).toEqual([[{ downloadId: 'dl-grab1', clientStage: 'downloading', clientStatus: { stage: 'DOWNLOADING', progress: 0.2, raw: {} } }]]);
  });

  test('reports completion with where the content is', async () => {
    const ref = tracked();
    client.set(ref, {
      stage: 'completed',
      contentPath: '/data/downloads/usenet/completed/platform-series/x',
      status: { stage: 'SUCCESS/ALL', progress: 1, raw: {} },
    });
    await reconciler().pass();
    expect(backend.reports).toEqual([
      [
        {
          downloadId: 'dl-grab1',
          outcome: 'completed',
          contentPath: '/data/downloads/usenet/completed/platform-series/x',
          clientStatus: { stage: 'SUCCESS/ALL', progress: 1, raw: {} },
        },
      ],
    ]);
  });

  test("reports a failure with the code the adapter mapped the client's status to", async () => {
    const ref = tracked();
    client.set(ref, { stage: 'failed', failureCode: 'unknownClientFailure', status: { stage: 'FAILURE/SCRIPT', progress: 1, raw: {} } });
    await reconciler().pass();
    expect(backend.reports[0]).toEqual([
      { downloadId: 'dl-grab1', outcome: 'failed', failureCode: 'unknownClientFailure', clientStatus: { stage: 'FAILURE/SCRIPT', progress: 1, raw: {} } },
    ]);
  });

  test('an item someone deleted in the client is reported removed', async () => {
    const ref = tracked();
    client.set(ref, { stage: 'removed', status: { stage: 'DELETED/MANUAL', progress: 1, raw: {} } });
    await reconciler().pass();
    expect(backend.reports[0]).toEqual([{ downloadId: 'dl-grab1', outcome: 'removed', clientStatus: { stage: 'DELETED/MANUAL', progress: 1, raw: {} } }]);
  });

  test('a torrent without progress for 6 hours is reported stalled; a Usenet download is left to its client', async () => {
    const torrents = new FakeDownloadClient('qbittorrent');
    const clientRef = torrents.add('grabT', { stage: 'downloading', downloadedBytes: 300, status: { stage: 'stalledDL', progress: 0.3, raw: {} } });
    backend.active.push({
      downloadId: 'dl-grabT' as never,
      clientKind: 'qbittorrent',
      clientRef,
      correlationTag: 'grabT',
      clientStage: 'downloading',
      state: 'active',
    });
    const usenetRef = tracked();
    client.set(usenetRef, { stage: 'downloading', status: { stage: 'DOWNLOADING', progress: 0.3, raw: {} } });
    const r = reconciler({ nzbget: client, qbittorrent: torrents });
    await r.pass();
    now += 6 * 3_600_000 - 1;
    await r.pass();
    expect(backend.reports.flat().filter((entry) => entry.outcome)).toEqual([]);
    now += 1;
    await r.pass();
    expect(backend.reports.flat().filter((entry) => entry.outcome)).toEqual([
      expect.objectContaining({ downloadId: 'dl-grabT', outcome: 'stalled', failureCode: 'torrentStalled' }),
    ]);
  });

  test('an unreachable client is skipped this pass and no Download is reported', async () => {
    tracked();
    client.unreachable = true;
    await expect(reconciler().pass()).resolves.toBeUndefined();
    expect(backend.reports).toEqual([]);
  });
});

describe('an active item missing from the client', () => {
  const missing = () => backend.reports.flat().filter((entry) => entry.outcome);

  test('fails with unknownClientFailure after two passes in a row, never as a cancel', async () => {
    const ref = tracked();
    client.items = client.items.filter((item) => item.clientRef !== ref);
    const r = reconciler();
    await r.pass();
    expect(missing()).toEqual([]);
    await r.pass();
    expect(missing()).toEqual([
      { downloadId: 'dl-grab1', outcome: 'failed', failureCode: 'unknownClientFailure', clientStatus: { stage: 'missing', progress: 0, raw: {} } },
    ]);
  });

  test('an item that shows again between the passes starts the count over', async () => {
    const ref = tracked();
    const item = client.items[0]!;
    const r = reconciler();
    client.items = [];
    await r.pass();
    client.items = [item];
    await r.pass();
    client.items = [];
    await r.pass();
    expect(missing()).toEqual([]);
    void ref;
  });

  test("a pass that can't list the client doesn't count", async () => {
    tracked();
    client.items = [];
    const r = reconciler();
    await r.pass();
    client.unreachable = true;
    await r.pass();
    client.unreachable = false;
    expect(missing()).toEqual([]);
    await r.pass();
    expect(missing()).toHaveLength(1);
  });

  test('a Download not submitted yet (no client reference) is not missing', async () => {
    backend.active.push({ downloadId: 'dl-new' as never, clientKind: 'nzbget', correlationTag: 'grab-new', clientStage: 'queued', state: 'active' });
    const r = reconciler();
    await r.pass();
    await r.pass();
    expect(missing()).toEqual([]);
  });
});

describe('torrents', () => {
  const HOUR = 3_600_000;
  const GOAL = { ratio: 2, seedTimeMs: 14 * 24 * HOUR };
  let torrents: FakeDownloadClient;
  const qbittorrentRow = (overrides: Partial<DesiredClientConfig> = {}): DesiredClientConfig => ({
    kind: 'qbittorrent',
    clientId: 'c2' as never,
    enabled: true,
    configVersion: 1,
    qbittorrent: { seedGoal: GOAL },
    ...overrides,
  });
  const r = () => reconciler({ nzbget: client, qbittorrent: torrents });
  /** The same with the e2e's lowered limits (OMNARR_TEST_LIMITS). */
  const withLimits = (lowered: Partial<Limits>) =>
    new Reconciler({
      backend,
      sessionId: 'session1' as never,
      clients: { nzbget: client, qbittorrent: torrents },
      layout,
      runtime,
      now: () => now,
      limits: { ...DEFAULT_LIMITS, ...lowered },
      log: () => {},
    });
  const outcomes = () => backend.reports.flat().filter((entry) => entry.outcome);

  /** A torrent the backend watches: `active` while it downloads, `completed` while it seeds. */
  function torrent(state: 'active' | 'completed', patch: Parameters<FakeDownloadClient['add']>[1] = {}) {
    const clientRef = torrents.add('grabT', { stage: 'downloading', downloadedBytes: 100, status: { stage: 'downloading', progress: 0.1, raw: {} }, ...patch });
    backend.active.push({
      downloadId: 'dl-grabT' as never,
      clientKind: 'qbittorrent',
      clientRef,
      correlationTag: 'grabT',
      clientStage: 'downloading',
      state,
      seedGoal: GOAL,
    });
    return clientRef;
  }

  beforeEach(() => {
    torrents = new FakeDownloadClient('qbittorrent');
    backend.desired = [nzbgetRow(), qbittorrentRow()];
  });

  test('qBittorrent without a row is still configured, with torrents on and the default goal', async () => {
    backend.desired = [nzbgetRow()];
    await r().pass();
    expect(torrents.applied).toEqual([
      expect.objectContaining({ kind: 'qbittorrent', enabled: true, qbittorrent: { seedGoal: { ratio: 2, seedTimeMs: 1_209_600_000 } } }),
    ]);
    expect(runtime.configured('qbittorrent')).toBe(true);
  });

  test('a disabled qBittorrent row is not configured', async () => {
    backend.desired = [nzbgetRow(), qbittorrentRow({ enabled: false })];
    await r().pass();
    expect(torrents.applied).toEqual([]);
  });

  test("qBittorrent's report carries its connection status and the peer port", async () => {
    torrents.status = async () => ({ reachable: true, version: 'v5.3.0', connectionStatus: 'firewalled' });
    await new Reconciler({
      backend,
      sessionId: 'session1' as never,
      clients: { qbittorrent: torrents },
      layout,
      runtime,
      peerPort: 6881,
      now: () => now,
      log: () => {},
    }).pass();
    expect(backend.clientReports[0]).toEqual([
      expect.objectContaining({ kind: 'qbittorrent', reachable: true, connectionStatus: 'firewalled', peerPort: 6881 }),
    ]);
  });

  test('a torrent qBittorrent is still moving at progress 1 reports no change, not completion', async () => {
    torrent('active', { stage: 'queued', unchanged: true, status: { stage: 'moving', progress: 1, raw: {} } });
    await r().pass();
    expect(backend.reports).toEqual([]);
  });

  test('a completed torrent is reported with its private flag', async () => {
    const ref = torrent('active');
    torrents.set(ref, {
      stage: 'completed',
      isPrivate: true,
      contentPath: '/data/downloads/torrents/platform-series/x',
      status: { stage: 'stalledUP', progress: 1, raw: {} },
    });
    await r().pass();
    expect(outcomes()).toEqual([expect.objectContaining({ outcome: 'completed', private: true, contentPath: '/data/downloads/torrents/platform-series/x' })]);
  });

  describe('the stall clock counts downloaded bytes', () => {
    test('a torrent whose progress fraction moves but whose bytes do not, for 6 h, stalls', async () => {
      const ref = torrent('active');
      const pass = r();
      await pass.pass();
      now += 6 * HOUR;
      torrents.set(ref, { status: { stage: 'downloading', progress: 0.5, raw: {} } });
      await pass.pass();
      expect(outcomes()).toEqual([expect.objectContaining({ outcome: 'stalled', failureCode: 'torrentStalled' })]);
    });

    test("the e2e's lowered torrentStallMs: a minute without a byte stalls", async () => {
      torrent('active');
      const pass = withLimits({ torrentStallMs: 60_000 });
      await pass.pass();
      now += 60_000 - 1;
      await pass.pass();
      expect(outcomes()).toEqual([]);
      now += 1;
      await pass.pass();
      expect(outcomes()).toEqual([expect.objectContaining({ outcome: 'stalled', failureCode: 'torrentStalled' })]);
    });

    test('a byte of progress restarts the clock', async () => {
      const ref = torrent('active');
      const pass = r();
      await pass.pass();
      now += 5 * HOUR;
      torrents.set(ref, { downloadedBytes: 101 });
      await pass.pass();
      now += 5 * HOUR;
      await pass.pass();
      expect(outcomes()).toEqual([]);
      now += HOUR;
      await pass.pass();
      expect(outcomes()).toHaveLength(1);
    });

    test('metaDL with no bytes counts towards a stall', async () => {
      torrent('active', { downloadedBytes: 0, status: { stage: 'metaDL', progress: 0, raw: {} } });
      const pass = r();
      await pass.pass();
      now += 6 * HOUR;
      await pass.pass();
      expect(outcomes()).toHaveLength(1);
    });

    test('the clock pauses while qBittorrent cannot be reached, and resumes where it stopped', async () => {
      torrent('active');
      const pass = r();
      await pass.pass();
      now += 4 * HOUR;
      await pass.pass(); // 4 h counted
      torrents.unreachable = true;
      now += 10 * HOUR;
      await pass.pass();
      now += 10 * HOUR;
      await pass.pass();
      torrents.unreachable = false;
      now += HOUR;
      await pass.pass(); // the hours across the outage don't count
      expect(outcomes()).toEqual([]);
      now += 2 * HOUR;
      await pass.pass(); // 6 h counted
      expect(outcomes()).toHaveLength(1);
    });

    test('checking or allocating never counts', async () => {
      torrent('active', { stage: 'queued', checking: true, status: { stage: 'checkingDL', progress: 0.1, raw: {} } });
      const pass = r();
      await pass.pass();
      now += 7 * HOUR;
      await pass.pass();
      expect(outcomes()).toEqual([]);
    });
  });

  describe('watched completed torrents', () => {
    const seeding = { stage: 'completed' as const, status: { stage: 'stalledUP', progress: 1, raw: {} } };

    test('1. stopped with its goal met: seedingDone with the final ratio and seed time, on every pass until it leaves', async () => {
      const ref = torrent('completed', {
        ...seeding,
        stopped: true,
        ratio: 3.1,
        seedingTimeMs: GOAL.seedTimeMs,
        status: { stage: 'stoppedUP', progress: 1, raw: {} },
      });
      const pass = r();
      await pass.pass();
      await pass.pass();
      expect(outcomes()).toEqual([
        {
          downloadId: 'dl-grabT',
          outcome: 'seedingDone',
          seedRatio: 3.1,
          seedTimeMs: GOAL.seedTimeMs,
          clientStatus: { stage: 'stoppedUP', progress: 1, raw: {} },
        },
        expect.objectContaining({ outcome: 'seedingDone' }),
      ]);
      void ref;
    });

    test('1. the ratio alone can meet the goal', async () => {
      torrent('completed', { ...seeding, stopped: true, ratio: 2, seedingTimeMs: HOUR });
      await r().pass();
      expect(outcomes()).toEqual([expect.objectContaining({ outcome: 'seedingDone', seedRatio: 2 })]);
    });

    test('a stopped torrent whose goal is not met is left alone', async () => {
      torrent('completed', { ...seeding, stopped: true, ratio: 0.5, seedingTimeMs: HOUR });
      await r().pass();
      expect(outcomes()).toEqual([]);
    });

    test('2. seeding or checking reports no outcome, and never stalls', async () => {
      const ref = torrent('completed', { ...seeding, ratio: 0.1, seedingTimeMs: HOUR });
      const pass = r();
      await pass.pass();
      now += 10 * HOUR;
      torrents.set(ref, { checking: true, status: { stage: 'checkingUP', progress: 1, raw: {} } });
      await pass.pass();
      expect(outcomes()).toEqual([]);
    });

    describe('seeding progress', () => {
      const progress = () => backend.reports.flat().filter((entry) => !entry.outcome);

      test('a seeding torrent reports its ratio, seed time and uploaded bytes on its client status, without an outcome', async () => {
        torrent('completed', { ...seeding, ratio: 0.8, seedingTimeMs: 3 * 24 * HOUR, uploadedBytes: 1_200_000_000 });
        await r().pass();
        expect(backend.reports.flat()).toEqual([
          {
            downloadId: 'dl-grabT',
            clientStatus: { stage: 'stalledUP', progress: 1, raw: {}, ratio: 0.8, seedTimeMs: 3 * 24 * HOUR, uploadedBytes: 1_200_000_000 },
          },
        ]);
      });

      test('it is sent again only once the ratio moved by 0.01 or the seed time by 1 % of the goal', async () => {
        const ref = torrent('completed', { ...seeding, ratio: 0.8, seedingTimeMs: 0, uploadedBytes: 1000 });
        const pass = r();
        await pass.pass();
        // 1 % of 14 days is 3.36 hours: 3 hours is no change, nor is a ratio change below 0.01 or more bytes alone.
        torrents.set(ref, { ratio: 0.804, seedingTimeMs: 3 * HOUR, uploadedBytes: 2000 });
        await pass.pass();
        expect(progress()).toHaveLength(1);
        torrents.set(ref, { ratio: 0.81 });
        await pass.pass();
        torrents.set(ref, { seedingTimeMs: 4 * HOUR });
        await pass.pass();
        expect(progress().map((entry) => [entry.clientStatus.ratio, entry.clientStatus.seedTimeMs])).toEqual([
          [0.8, 0],
          [0.81, 3 * HOUR],
          [0.81, 4 * HOUR],
        ]);
      });

      test("the e2e's one-minute goal reports on every pass the seed time grew", async () => {
        const ref = torrent('completed', { ...seeding, ratio: 0, seedingTimeMs: 10_000 });
        backend.active[0]!.seedGoal = { seedTimeMs: 60_000 };
        const pass = r();
        await pass.pass();
        torrents.set(ref, { seedingTimeMs: 15_000 });
        await pass.pass();
        expect(progress()).toHaveLength(2);
      });

      test('an active torrent reports no seeding stats', async () => {
        torrent('active', { ratio: 0.1, seedingTimeMs: 0, uploadedBytes: 10 });
        await r().pass();
        expect(backend.reports.flat().every((entry) => entry.clientStatus.ratio === undefined)).toBe(true);
      });
    });

    test('3. missing files is a seeding problem on the client report; after an hour, seedingLost', async () => {
      const ref = torrent('completed', {
        stage: 'failed',
        problem: 'missingFiles',
        failureCode: 'unknownClientFailure',
        status: { stage: 'missingFiles', progress: 1, raw: {} },
      });
      const pass = r();
      await pass.pass();
      expect(backend.clientReports.at(-1)!.find((report) => report.kind === 'qbittorrent')).toMatchObject({
        seedingProblems: [{ downloadId: 'dl-grabT', state: 'missingFiles', since: now }],
      });
      expect(outcomes()).toEqual([]);
      now += HOUR - 1;
      await pass.pass();
      expect(outcomes()).toEqual([]);
      now += 1;
      await pass.pass();
      expect(outcomes()).toEqual([expect.objectContaining({ outcome: 'seedingLost', clientStatus: { stage: 'missingFiles', progress: 1, raw: {} } })]);
      void ref;
    });

    test('3. a problem that clears is dropped from the report', async () => {
      const ref = torrent('completed', { stage: 'failed', problem: 'error', status: { stage: 'error', progress: 1, raw: {} } });
      const pass = r();
      await pass.pass();
      torrents.set(ref, { ...seeding, problem: undefined });
      await pass.pass();
      expect(backend.clientReports.at(-1)).toEqual([expect.objectContaining({ kind: 'qbittorrent' })]);
      expect(backend.clientReports.at(-1)![0]!.seedingProblems).toBeUndefined();
    });

    test('4. missing from the client in two passes in a row: seedingLost', async () => {
      const ref = torrent('completed', seeding);
      torrents.items = torrents.items.filter((item) => item.clientRef !== ref);
      const pass = r();
      await pass.pass();
      expect(outcomes()).toEqual([]);
      await pass.pass();
      expect(outcomes()).toEqual([expect.objectContaining({ downloadId: 'dl-grabT', outcome: 'seedingLost' })]);
    });
  });

  // qBittorrent applies a seed time limit only when it refreshes the torrent, which a tracker announce does;
  // a seeder with no working tracker can sit past its goal.
  describe('the goal nudge (goalGraceMs)', () => {
    const GRACE = 10 * 60_000;
    /** A seeder that completed `ago` ms before now, with no tracker to refresh it (its seed time froze). */
    const seeder = (ago: number) =>
      torrent('completed', { stage: 'completed', completedAt: now - ago, seedingTimeMs: 44_000, status: { stage: 'stalledUP', progress: 1, raw: {} } });

    test('still seeding its goal plus the grace after completing: qBittorrent is made to refresh it, once per pass', async () => {
      const ref = seeder(GOAL.seedTimeMs + GRACE);
      const pass = r();
      await pass.pass();
      expect(torrents.refreshed).toEqual([ref]);
      await pass.pass();
      expect(torrents.refreshed).toHaveLength(2);
      expect(outcomes()).toEqual([]);
    });

    test('inside the grace: no call, the next announce stops it', async () => {
      seeder(GOAL.seedTimeMs + GRACE - 1);
      await r().pass();
      expect(torrents.refreshed).toEqual([]);
    });

    test('a ratio-only goal is never nudged: uploading refreshes the torrent anyway', async () => {
      seeder(365 * 24 * HOUR);
      backend.active[0]!.seedGoal = { ratio: 2 };
      await r().pass();
      expect(torrents.refreshed).toEqual([]);
    });

    test('a stopped torrent, or one whose completion time is unknown, is not nudged', async () => {
      const ref = seeder(GOAL.seedTimeMs + GRACE);
      torrents.set(ref, { completedAt: undefined });
      await r().pass();
      torrents.set(ref, { completedAt: now - GOAL.seedTimeMs - GRACE, stopped: true, ratio: 0, seedingTimeMs: 0 });
      await r().pass();
      expect(torrents.refreshed).toEqual([]);
    });

    test("the e2e's lowered goalGraceMs: the nudge comes that long past the goal", async () => {
      const ref = seeder(GOAL.seedTimeMs + 5000);
      await withLimits({ goalGraceMs: 5000 }).pass();
      expect(torrents.refreshed).toEqual([ref]);
    });

    test('a failed nudge is left for the next pass, and the pass goes on', async () => {
      seeder(GOAL.seedTimeMs + GRACE);
      torrents.refreshTorrent = async () => {
        throw new JobFailure('clientUnreachable', 'qBittorrent did not answer.');
      };
      await expect(r().pass()).resolves.toBeUndefined();
    });
  });

  describe('the VPN', () => {
    const WG_CONF = '[Interface]\nPrivateKey = k\n[Peer]\nEndpoint = 10.0.0.1:51820\n';
    const VPN = { kind: 'wireguardFile' as const, wireguardConf: WG_CONF, savedAt: 1 };
    let vpnDir: string;
    let gluetun: { status: string; healthy: boolean; port: number };
    const reader: GluetunReader = {
      timeoutMs: 5000,
      vpnStatus: async () => gluetun.status,
      healthy: async () => gluetun.healthy,
      publicIp: async () => '203.0.113.7',
      forwardedPort: async () => gluetun.port,
    };

    beforeEach(async () => {
      vpnDir = join(root, 'vpn');
      await mkdir(vpnDir);
      gluetun = { status: 'running', healthy: true, port: 0 };
      backend.desired = [nzbgetRow(), qbittorrentRow({ qbittorrent: { seedGoal: GOAL, vpn: VPN } })];
    });

    /** A reconciler in the direct layout, or in the VPN layout with the scripted gluetun. */
    const withVpn = (layout_: 'direct' | 'vpn' = 'direct') =>
      new Reconciler({
        backend,
        sessionId: 'session1' as never,
        clients: { nzbget: client, qbittorrent: torrents },
        layout,
        runtime,
        peerPort: 6881,
        vpn: new VpnMonitor({ ...(layout_ === 'vpn' ? { gluetun: reader } : {}), peerPort: 6881, setListenPort: async () => {}, now: () => now }),
        vpnDir,
        now: () => now,
        log: () => {},
      });
    const vpnReports = () => backend.clientReports.flat().filter((report) => report.kind === 'qbittorrent' && report.vpn);

    test('a chosen VPN in the direct layout writes the vpn/ files, reports notActive, and gates torrents', async () => {
      await withVpn().pass();
      expect((await readdir(vpnDir)).sort()).toEqual(['gluetun.env', 'wg0.conf']);
      expect(vpnReports().map((report) => report.vpn!.state)).toEqual(['notActive']);
      expect(runtime.vpnGated()).toBe(true);
    });

    test('"No VPN" in the base layout deletes the files; in the VPN layout they stay, so gluetun keeps working', async () => {
      await withVpn().pass();
      backend.desired = [nzbgetRow(), qbittorrentRow({ configVersion: 2 })];
      const inVpnLayout = withVpn('vpn');
      await inVpnLayout.pass();
      expect((await readdir(vpnDir)).sort()).toEqual(['gluetun.env', 'wg0.conf']);
      expect(vpnReports().at(-1)!.vpn).toMatchObject({ state: 'up', layoutWithoutChoice: true });
      runtime.newSession();
      await withVpn('direct').pass();
      expect(await readdir(vpnDir)).toEqual([]);
      expect(vpnReports().at(-1)!.vpn!.state).toBe('off');
      expect(runtime.vpnGated()).toBe(false);
    });

    test('the VPN state is reported only when it changes, not on every check', async () => {
      const r_ = withVpn('vpn');
      await r_.pass();
      now += 30_000;
      await r_.pass();
      expect(vpnReports()).toHaveLength(1);
      gluetun.healthy = false;
      now += 30_000;
      await r_.pass();
      expect(vpnReports().map((report) => report.vpn!.state)).toEqual(['up', 'connecting']);
    });

    test('the stall clock pauses while the VPN gate holds, and resumes where it stopped', async () => {
      torrent('active');
      const r_ = withVpn('vpn');
      await r_.pass();
      now += 4 * HOUR;
      await r_.pass(); // 4 h counted
      gluetun.healthy = false;
      for (let i = 0; i < 4; i++) {
        now += 3 * HOUR;
        await r_.pass();
      }
      gluetun.healthy = true;
      now += HOUR;
      await r_.pass(); // still down: the tunnel must hold for the stable window
      now += 2 * 60_000;
      await r_.pass(); // up; the outage didn't count
      expect(outcomes()).toEqual([]);
      now += 2 * HOUR;
      await r_.pass(); // 6 h counted
      expect(outcomes()).toHaveLength(1);
    });

    test('a download that completes while the gate holds is still reported', async () => {
      const ref = torrent('active');
      gluetun.healthy = false;
      torrents.set(ref, {
        stage: 'completed',
        contentPath: '/data/downloads/torrents/platform-series/x',
        status: { stage: 'stalledUP', progress: 1, raw: {} },
      });
      await withVpn('vpn').pass();
      expect(outcomes()).toEqual([expect.objectContaining({ outcome: 'completed' })]);
    });

    test('the peer port in the VPN layout is the forwarded port, and none without one', async () => {
      const r_ = withVpn('vpn');
      await r_.pass();
      expect(vpnReports().at(-1)).not.toHaveProperty('peerPort');
      gluetun.port = 38852;
      now += 30_000;
      await r_.pass();
      expect(vpnReports().at(-1)).toMatchObject({ peerPort: 38852, vpn: { port: { kind: 'forwarded', port: 38852 } } });
      gluetun.healthy = false;
      now += 30_000;
      await r_.pass();
      expect(vpnReports().at(-1)).not.toHaveProperty('peerPort');
    });

    test('the peer port in the direct layout is the published one, VPN chosen or not', async () => {
      await withVpn().pass();
      expect(vpnReports().at(-1)).toMatchObject({ peerPort: 6881, vpn: { state: 'notActive' } });
    });

    test('without the monitor (no qBittorrent), nothing VPN-related happens', async () => {
      await reconciler().pass();
      expect(await readdir(vpnDir)).toEqual([]);
      expect(runtime.vpnGated()).toBe(false);
    });
  });
});

// Between passes, every 5 s while a Download is active, one batch of the changed percents, bytes and rates.
describe('the progress-only poll', () => {
  const downloading = (clientRef: string, doneBytes: number, extra: object = {}) => {
    const item = client.items.find((entry) => entry.clientRef === clientRef)!;
    item.stage = 'downloading';
    item.status = { stage: 'DOWNLOADING', progress: doneBytes / 1_000_000_000, doneBytes, totalBytes: 1_000_000_000, raw: {}, ...extra };
  };

  test('with no active Download it lists no client and sends nothing', async () => {
    const r = reconciler();
    await r.pass();
    client.calls = [];
    await r.progressTick();
    expect(client.calls).not.toContain('list');
    expect(backend.progressReports).toEqual([]);
  });

  test("sends the active Downloads' client status, and NZBGet's rate from the change since the previous poll", async () => {
    const ref = tracked();
    const r = reconciler();
    await r.pass();
    downloading(ref, 100_000_000);
    await r.progressTick();
    expect(backend.progressReports).toEqual([
      [{ downloadId: 'dl-grab1', clientStatus: { stage: 'DOWNLOADING', progress: 0.1, doneBytes: 100_000_000, totalBytes: 1_000_000_000, raw: {} } }],
    ]);
    now += 5_000;
    downloading(ref, 150_000_000);
    await r.progressTick();
    expect(backend.progressReports.at(-1)).toEqual([
      {
        downloadId: 'dl-grab1',
        clientStatus: { stage: 'DOWNLOADING', progress: 0.15, doneBytes: 150_000_000, totalBytes: 1_000_000_000, bytesPerSec: 10_000_000, raw: {} },
      },
    ]);
  });

  test('sends nothing when no value changed', async () => {
    const ref = tracked();
    const r = reconciler();
    await r.pass();
    downloading(ref, 100_000_000, { bytesPerSec: 2_000_000 });
    await r.progressTick();
    now += 5_000;
    await r.progressTick();
    expect(backend.progressReports).toHaveLength(1);
  });

  test("a client's own rate is kept; every changed Download goes in one batch", async () => {
    const a = tracked('grab1');
    const b = tracked('grab2');
    const r = reconciler();
    await r.pass();
    downloading(a, 100_000_000, { bytesPerSec: 3_000_000 });
    downloading(b, 200_000_000, { bytesPerSec: 4_000_000 });
    await r.progressTick();
    expect(backend.progressReports).toHaveLength(1);
    expect(backend.progressReports[0]!.map((entry) => [entry.downloadId, entry.clientStatus.bytesPerSec])).toEqual([
      ['dl-grab1', 3_000_000],
      ['dl-grab2', 4_000_000],
    ]);
  });

  test("leaves stages and outcomes to the pass: a finished item isn't sent", async () => {
    const ref = tracked();
    const r = reconciler();
    await r.pass();
    const item = client.items.find((entry) => entry.clientRef === ref)!;
    item.stage = 'completed';
    item.status = { stage: 'SUCCESS/ALL', progress: 1, raw: {} };
    await r.progressTick();
    expect(backend.progressReports).toEqual([]);
    expect(backend.reports).toEqual([]);
  });
});

describe('the startup reconciliation', () => {
  test('empties staging, since this worker holds no job yet', async () => {
    await mkdir(join(layout.staging, 'job1'), { recursive: true });
    await writeFile(join(layout.staging, 'job1', 'part.mkv'), 'x');
    await reconciler().startup();
    expect(await readdir(layout.staging)).toEqual([]);
  });

  test("keeps staging/held/, an upgrade's files waiting for preparation", async () => {
    await mkdir(join(layout.staging, 'held', 'job2'), { recursive: true });
    await writeFile(join(layout.staging, 'held', 'job2', '1.mkv'), 'x');
    await mkdir(join(layout.staging, 'job1'), { recursive: true });
    await reconciler().startup();
    expect(await readdir(layout.staging)).toEqual(['held']);
    expect(await readdir(join(layout.staging, 'held', 'job2'))).toEqual(['1.mkv']);
  });

  test('applies the client config first, so it happens before any claim', async () => {
    tracked();
    await reconciler().startup();
    expect(client.calls[0]).toBe('applyConfig');
    expect(runtime.configured('nzbget')).toBe(true);
  });

  test('reports client items that match no watched Download, and never removes them', async () => {
    tracked('grab1');
    client.add('grab-finished', { name: 'Finished.Release' });
    await reconciler().startup();
    expect(backend.orphanReports).toEqual([[{ clientKind: 'nzbget', clientRef: '2', correlationTag: 'grab-finished', name: 'Finished.Release' }]]);
    expect(client.items).toHaveLength(2);
  });
});
