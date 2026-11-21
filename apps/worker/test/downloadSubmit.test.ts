// The `download.submit` handler: its steps in order (the
// configured check, find by tag, free space, the worker's own fetch, the
// submit under the client's lock), against a fake client and an injected fetch.
import type { DownloadSubmitPayload, LeasedJob, StorageSpace } from '@omnarr/contracts';
import { beforeEach, describe, expect, test } from 'vite-plus/test';

import { downloadSubmitHandler } from '../src/jobs/downloadSubmit.ts';
import type { ReleaseFetch } from '../src/release/fetch.ts';
import { ClientRuntimeStore } from '../src/runtime/clientRuntime.ts';
import { JobFailure } from '../src/runtime/lease.ts';
import { FakeDownloadClient } from './fakeDownloadClient.ts';

const URL_ = 'http://newznab:4120/getnzb/x.nzb?apikey=planted-key';
const NZB =
  '<?xml version="1.0"?><nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"><file subject="a"><segments><segment number="1">a@b</segment></segments></file></nzb>';

const payload: DownloadSubmitPayload = {
  class: 'download.submit',
  grabId: 'grab1' as never,
  downloadId: 'dl1' as never,
  source: { kind: 'nzbUrl', url: URL_ },
  correlationTag: 'grab1',
  category: 'platform-series',
  sizeBytes: 1_000,
  releaseTitle: 'Harbour.Lights.S01E02.1080p.WEB-DL.H.264-GRP',
  indexerName: 'Main',
};
const job = (leaseEpoch = 1, overrides: Partial<DownloadSubmitPayload> = {}): LeasedJob => ({
  jobId: 'job1' as never,
  class: 'download.submit',
  leaseEpoch,
  payload: { ...payload, ...overrides },
});
const ctx = { signal: new AbortController().signal, progress: () => {} };
/** The downloads area has `downloads` free bytes; the others have plenty. */
const space =
  (downloads: number): (() => Promise<StorageSpace>) =>
  async () => {
    const plenty = { freeBytes: 1e12, device: '1' };
    return { downloads: { freeBytes: downloads, device: '2' }, staging: plenty, originals: plenty, series: plenty, movies: plenty };
  };

let client: FakeDownloadClient;
let runtime: ClientRuntimeStore;
let fetched: string[];
let answer: () => Response;
const fetch: ReleaseFetch = async (url) => {
  fetched.push(url);
  return answer();
};

beforeEach(() => {
  client = new FakeDownloadClient();
  runtime = new ClientRuntimeStore();
  runtime.markConfigured('nzbget');
  fetched = [];
  answer = () => new Response(NZB);
});

const handler = (free = 1e12) => downloadSubmitHandler({ clients: { nzbget: client }, runtime, storage: space(free), fetch });

async function failure(promise: Promise<unknown>) {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(JobFailure);
  return error as JobFailure;
}

describe('download.submit', () => {
  test("fetches the candidate's NZB itself and uploads it, named after the release, tagged with the Grab", async () => {
    expect(await handler()(job(), ctx)).toEqual({ class: 'download.submit', clientRef: '1' });
    expect(fetched).toEqual([URL_]);
    expect(client.items).toEqual([
      expect.objectContaining({
        correlationTags: ['grab1'],
        category: 'platform-series',
        release: { kind: 'nzb', name: payload.releaseTitle, bytes: new TextEncoder().encode(NZB) },
      }),
    ]);
  });

  test('a job queued before releaseTitle names the NZB after the Grab', async () => {
    const { releaseTitle: _, ...withoutTitle } = payload;
    await handler()({ ...job(), payload: withoutTitle }, ctx);
    expect(client.items[0]!.release).toMatchObject({ kind: 'nzb', name: 'grab1' });
  });

  test('1. a client the reconciler has not configured in this session fails as clientUnreachable, before anything else', async () => {
    runtime.newSession();
    const error = await failure(handler()(job(), ctx));
    expect(error).toMatchObject({ code: 'clientUnreachable', detail: "NZBGet isn't configured yet in this worker session." });
    expect(client.calls).toEqual([]);
    expect(fetched).toEqual([]);
  });

  test('2. a re-claimed job finds the tagged item and neither fetches nor submits again', async () => {
    await handler()(job(1), ctx);
    expect(await handler()(job(2), ctx)).toEqual({ class: 'download.submit', clientRef: '1' });
    expect(fetched).toHaveLength(1);
    expect(client.calls.filter((call) => call === 'submit')).toHaveLength(1);
  });

  test('4. without room under downloads/, it fails as diskFull with needed and free bytes, and fetches nothing', async () => {
    const error = await failure(handler(500)(job(), ctx));
    expect(error.code).toBe('diskFull');
    expect(error.detail).toMatch(/1000 bytes.*500 bytes free/);
    expect(fetched).toEqual([]);
    expect(client.calls).not.toContain('submit');
  });

  test("5. the indexer's download limit fails as releaseFetchFailed, and nothing reaches NZBGet", async () => {
    answer = () => new Response('<?xml version="1.0"?><error code="501" description="Download limit reached"/>');
    const error = await failure(handler()(job(), ctx));
    expect(error).toMatchObject({ code: 'releaseFetchFailed', detail: 'Main: the download limit is reached (GET /getnzb/x.nzb).' });
    expect(client.calls).not.toContain('submit');
  });

  test('5. a dead link fails as releaseFileInvalid', async () => {
    answer = () => new Response('gone', { status: 404 });
    expect((await failure(handler()(job(), ctx))).code).toBe('releaseFileInvalid');
  });

  test('6. the submit waits for an apply that holds the client lock', async () => {
    const events: string[] = [];
    let release!: () => void;
    const applying = runtime.withClientLock('nzbget', async () => {
      events.push('apply start');
      await new Promise<void>((resolve) => (release = resolve));
      events.push('apply end');
    });
    const submitting = handler()(job(), ctx).then(() => events.push('submitted'));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(events).toEqual(['apply start']);
    release();
    await Promise.all([applying, submitting]);
    expect(events).toEqual(['apply start', 'apply end', 'submitted']);
  });
});

describe('download.submit for a torrent', () => {
  const TORRENT_URL = 'http://tracker.test/dl/42.torrent?passkey=planted-passkey';
  const INFO = 'd6:lengthi5e4:name5:a.mkv12:piece lengthi16384e6:pieces20:ABCDEFGHIJKLMNOPQRSTe';
  const TORRENT = `d4:info${INFO}e`;
  // printf '%s' "$INFO" | shasum
  const HASH = 'ff8eec90e746a1d8a797c6deaab27b40c8dd87e5';
  const MAGNET = 'magnet:?xt=urn:btih:ABCDEFGHIJKLMNOPQRSTUVWXYZ234567&dn=Harbour.Lights.S01E02';
  const goal = { seedTimeMs: 14 * 86_400_000 };
  let qbittorrent: FakeDownloadClient;
  const torrentJob = (source: DownloadSubmitPayload['source']) => job(1, { source, seedGoal: goal, indexerName: 'Tracker' });
  const torrentHandler = () => downloadSubmitHandler({ clients: { nzbget: client, qbittorrent }, runtime, storage: space(1e12), fetch });

  beforeEach(() => {
    qbittorrent = new FakeDownloadClient('qbittorrent');
    runtime.markConfigured('qbittorrent');
    answer = () => new Response(TORRENT);
  });

  test('a .torrent link is fetched by the worker and its file submitted with its info hash and the goal', async () => {
    expect(await torrentHandler()(torrentJob({ kind: 'torrentUrl', url: TORRENT_URL }), ctx)).toEqual({ class: 'download.submit', clientRef: HASH });
    expect(fetched).toEqual([TORRENT_URL]);
    expect(qbittorrent.items).toEqual([
      expect.objectContaining({
        clientRef: HASH,
        correlationTags: ['grab1'],
        category: 'platform-series',
        seedGoal: goal,
        release: { kind: 'torrentFile', bytes: new TextEncoder().encode(TORRENT), infoHash: HASH },
      }),
    ]);
    expect(client.items).toEqual([]);
  });

  test('a magnet is submitted as it is, with its normalized hash, and nothing is fetched', async () => {
    expect(await torrentHandler()(torrentJob({ kind: 'magnet', uri: MAGNET }), ctx)).toEqual({
      class: 'download.submit',
      clientRef: '00443214c74254b635cf84653a56d7c675be77df',
    });
    expect(fetched).toEqual([]);
    expect(qbittorrent.items[0]!.release).toEqual({ kind: 'magnet', uri: MAGNET, infoHash: '00443214c74254b635cf84653a56d7c675be77df' });
  });

  test('a .torrent link that redirects to a magnet submits the magnet', async () => {
    answer = () => new Response(null, { status: 302, headers: { location: MAGNET } });
    await torrentHandler()(torrentJob({ kind: 'torrentUrl', url: TORRENT_URL }), ctx);
    expect(qbittorrent.items[0]!.release).toMatchObject({ kind: 'magnet', uri: MAGNET });
  });

  test('a magnet without a hash fails as releaseFileInvalid, and nothing reaches qBittorrent', async () => {
    const error = await failure(torrentHandler()(torrentJob({ kind: 'magnet', uri: 'magnet:?dn=nothing' }), ctx));
    expect(error.code).toBe('releaseFileInvalid');
    expect(error.detail).toBe('The magnet from Tracker has no info hash.');
    expect(qbittorrent.calls).not.toContain('submit');
  });

  test('a body that is not a torrent fails as releaseFileInvalid', async () => {
    answer = () => new Response('<html>log in</html>');
    expect((await failure(torrentHandler()(torrentJob({ kind: 'torrentUrl', url: TORRENT_URL }), ctx))).code).toBe('releaseFileInvalid');
  });

  test('qBittorrent not configured this session fails as clientUnreachable, naming it', async () => {
    runtime.newSession();
    const error = await failure(torrentHandler()(torrentJob({ kind: 'magnet', uri: MAGNET }), ctx));
    expect([error.code, error.detail]).toEqual(['clientUnreachable', "qBittorrent isn't configured yet in this worker session."]);
  });

  describe('the VPN gate (step 3)', () => {
    test.each(['notActive', 'connecting', 'down'] as const)(
      'while the VPN is %s, a torrent waits with vpnDown: nothing is fetched or submitted',
      async (state) => {
        runtime.setVpnState(state);
        const error = await failure(torrentHandler()(torrentJob({ kind: 'torrentUrl', url: TORRENT_URL }), ctx));
        expect(error.code).toBe('vpnDown');
        expect(error.detail).toBe(
          state === 'notActive' ? 'A VPN is chosen, but the VPN layout isn’t in use yet.' : 'The VPN isn’t up: qBittorrent moves no traffic until it is.',
        );
        expect(fetched).toEqual([]);
        expect(qbittorrent.calls).not.toContain('submit');
      },
    );

    test.each(['up', 'off'] as const)('%s lets it through', async (state) => {
      runtime.setVpnState(state);
      expect(await torrentHandler()(torrentJob({ kind: 'magnet', uri: MAGNET }), ctx)).toMatchObject({ clientRef: expect.any(String) });
    });

    test('a torrent an earlier attempt submitted is found by its tag before the gate', async () => {
      await torrentHandler()(torrentJob({ kind: 'magnet', uri: MAGNET }), ctx);
      runtime.setVpnState('down');
      expect(await torrentHandler()(torrentJob({ kind: 'magnet', uri: MAGNET }), ctx)).toMatchObject({ clientRef: expect.any(String) });
    });

    test('under the VPN layout, an unreachable qBittorrent’s failure names the command that recreates gluetun and qBittorrent', async () => {
      runtime.setVpnState('up');
      qbittorrent.unreachable = true;
      const error = await failure(torrentHandler()(torrentJob({ kind: 'magnet', uri: MAGNET }), ctx));
      expect(error.code).toBe('clientUnreachable');
      expect(error.detail).toMatch(/If qBittorrent lost the VPN container’s network, run docker compose up -d --force-recreate gluetun qbittorrent\.$/);
    });

    test('in the direct layout it doesn’t', async () => {
      qbittorrent.unreachable = true;
      const error = (await torrentHandler()(torrentJob({ kind: 'magnet', uri: MAGNET }), ctx).catch((e: unknown) => e)) as Error & { detail?: string };
      expect(error.detail ?? error.message).not.toContain('force-recreate');
    });

    test('Usenet never waits for the VPN', async () => {
      runtime.setVpnState('down');
      answer = () => new Response(NZB);
      expect(await handler()(job(), ctx)).toEqual({ class: 'download.submit', clientRef: '1' });
    });
  });
});
