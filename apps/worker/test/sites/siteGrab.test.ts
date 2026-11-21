// A grab from a definition indexer: `download.submit` with
// a `siteUrl` source runs the definition's download block through the engine,
// paced, and submits the .torrent or magnet it found as any other grab does.
import type { DownloadSubmitPayload, LeasedJob, SiteConfig, StorageSpace } from '@omnarr/contracts';
import { beforeEach, describe, expect, test } from 'vite-plus/test';

import type { SitesBackend } from '../../src/convex.ts';
import { downloadSubmitHandler } from '../../src/jobs/downloadSubmit.ts';
import { ClientRuntimeStore } from '../../src/runtime/clientRuntime.ts';
import { JobFailure } from '../../src/runtime/lease.ts';
import { FakeDownloadClient } from '../fakeDownloadClient.ts';
import { LANTERN_YML } from './fixtures.ts';

const INFO = 'd6:lengthi5e4:name5:a.mkv12:piece lengthi16384e6:pieces20:ABCDEFGHIJKLMNOPQRSTe';
const TORRENT = `d4:info${INFO}e`;
// printf '%s' "$INFO" | shasum
const HASH = 'ff8eec90e746a1d8a797c6deaab27b40c8dd87e5';

const DOWNLOAD_YML = `${LANTERN_YML}
download:
  selectors:
    - selector: a.get
      attribute: href
`;

const CONFIG: SiteConfig = {
  indexerId: 'ix1' as SiteConfig['indexerId'],
  name: 'Lantern',
  definitionId: 'lanternsite',
  sha256: 'sha-dl',
  yaml: DOWNLOAD_YML,
  baseUrl: 'https://lantern.test/',
  settings: {},
};

const plenty = { freeBytes: 1e12, device: '1' };
const storage = async (): Promise<StorageSpace> => ({ downloads: plenty, staging: plenty, originals: plenty, series: plenty, movies: plenty });
const ctx = { signal: new AbortController().signal, progress: () => {} };

const job = (url: string): LeasedJob => ({
  jobId: 'job1' as never,
  class: 'download.submit',
  leaseEpoch: 2,
  payload: {
    class: 'download.submit',
    grabId: 'grab1' as never,
    downloadId: 'dl1' as never,
    source: { kind: 'siteUrl', url, indexerId: CONFIG.indexerId },
    correlationTag: 'grab1',
    category: 'platform-series',
    indexerName: 'Lantern',
  } satisfies DownloadSubmitPayload,
});

let qbittorrent: FakeDownloadClient;
let runtime: ClientRuntimeStore;
let paced: number;
let fetched: string[];
let pages: Record<string, () => Response>;

const sites = (slot: { waitMs: number } | { skip: true } = { waitMs: 0 }): SitesBackend => ({
  reservePacing: async () => {
    paced++;
    return slot;
  },
  siteConfig: async ({ jobId, leaseEpoch, indexerId }) => (jobId === 'job1' && leaseEpoch === 2 && indexerId === CONFIG.indexerId ? CONFIG : null),
  definitionFile: async () => null,
  upsertDefinitions: async () => undefined,
  finishDefinitionSync: async () => ({ supported: 0, unsupported: 0, pending: 0 }),
});

const handler = (backend = sites()) =>
  downloadSubmitHandler({
    clients: { qbittorrent },
    runtime,
    storage,
    fetch: async () => {
      throw new Error('the release fetch is not used for a siteUrl');
    },
    sites: {
      backend,
      fetch: async (url) => {
        fetched.push(url);
        const page = pages[url];
        if (!page) return new Response('not found', { status: 404 });
        return page();
      },
    },
  });

beforeEach(() => {
  qbittorrent = new FakeDownloadClient('qbittorrent');
  runtime = new ClientRuntimeStore();
  runtime.markConfigured('qbittorrent');
  paced = 0;
  fetched = [];
  pages = {
    'https://lantern.test/torrent/7': () => new Response('<a class="get" href="/files/7.torrent">get</a>'),
    'https://lantern.test/files/7.torrent': () => new Response(TORRENT),
  };
});

describe('download.submit with a siteUrl', () => {
  test("the details page's link is fetched through the engine, paced, and its torrent submitted", async () => {
    expect(await handler()(job('https://lantern.test/torrent/7'), ctx)).toEqual({ class: 'download.submit', clientRef: HASH });
    expect(fetched).toEqual(['https://lantern.test/torrent/7', 'https://lantern.test/files/7.torrent']);
    expect(paced).toBe(2);
    expect(qbittorrent.items).toEqual([
      expect.objectContaining({ release: { kind: 'torrentFile', bytes: new TextEncoder().encode(TORRENT), infoHash: HASH } }),
    ]);
  });

  test('a details page that offers a magnet submits the magnet', async () => {
    pages['https://lantern.test/torrent/7'] = () => new Response('<a class="get" href="magnet:?xt=urn:btih:ff8eec90e746a1d8a797c6deaab27b40c8dd87e5">m</a>');
    expect(await handler()(job('https://lantern.test/torrent/7'), ctx)).toEqual({ class: 'download.submit', clientRef: HASH });
    expect(qbittorrent.items[0]!.release).toMatchObject({ kind: 'magnet' });
  });

  test('a link on a host outside the definition is refused, as a bad release', async () => {
    const error = await handler()(job('https://elsewhere.test/torrent/7'), ctx).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(JobFailure);
    expect((error as JobFailure).code).toBe('releaseFileInvalid');
    expect(fetched).toEqual([]);
  });

  test('a details page whose link points into the stack is refused', async () => {
    pages['https://lantern.test/torrent/7'] = () => new Response('<a class="get" href="http://qbittorrent:8080/api/v2/app/shutdown">x</a>');
    const error = await handler()(job('https://lantern.test/torrent/7'), ctx).catch((e: unknown) => e);
    expect((error as JobFailure).code).toBe('releaseFileInvalid');
    expect(fetched).toEqual(['https://lantern.test/torrent/7']);
  });

  test('a site that times out or is challenged may pass on retry (releaseFetchFailed); a refused slot too', async () => {
    pages['https://lantern.test/torrent/7'] = () => new Response('<title>DDOS-GUARD</title>', { status: 503 });
    expect(((await handler()(job('https://lantern.test/torrent/7'), ctx).catch((e: unknown) => e)) as JobFailure).code).toBe('releaseFetchFailed');
    expect(((await handler(sites({ skip: true }))(job('https://lantern.test/torrent/7'), ctx).catch((e: unknown) => e)) as JobFailure).code).toBe(
      'releaseFetchFailed',
    );
  });

  test('a removed indexer fails the grab as a bad release', async () => {
    const backend = { ...sites(), siteConfig: async () => null };
    expect(((await handler(backend)(job('https://lantern.test/torrent/7'), ctx).catch((e: unknown) => e)) as JobFailure).code).toBe('releaseFileInvalid');
  });
});
