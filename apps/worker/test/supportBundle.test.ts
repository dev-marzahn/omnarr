// The support bundle: the worker reads `worker.bundleData`
// for its lease, adds its own versions and recent log lines, and uploads one
// gzipped JSON file as the job's artifact.
import { gunzipSync } from 'node:zlib';

import { PROTOCOL_VERSION, type LeasedJob, type SupportBundleData } from '@omnarr/contracts';
import { beforeEach, describe, expect, test } from 'vite-plus/test';

import { dataLayout } from '../src/fs/layout.ts';
import { maintenanceHandler } from '../src/jobs/maintenance.ts';
import { ClientRuntimeStore } from '../src/runtime/clientRuntime.ts';
import { buildSupportBundle, LogBuffer } from '../src/supportBundle.ts';
import { FakeBackend } from './fakeBackend.ts';

/** What the backend's `bundleData` answers: a slice of the DTOs, enough to see them carried through. */
const DATA = {
  builtAt: 1_000,
  backendProtocolVersion: PROTOCOL_VERSION,
  status: { indexers: [], clients: [], jobCounts: [] },
  indexers: [],
  downloadClients: {},
  issues: { needsAction: [], inProgress: [], system: [], resolved: [] },
  events: [{ at: 1, stage: 'download', kind: 'stageFailed', message: 'Repair failed.' }],
  jobs: [],
} as unknown as SupportBundleData;

let backend: FakeBackend;
let uploads: { url: string; type: string | null; body: Buffer }[];
const fetchFake = async (url: string | URL | Request, init?: RequestInit) => {
  uploads.push({
    url: url instanceof Request ? url.url : url.toString(),
    type: new Headers(init?.headers).get('Content-Type'),
    body: Buffer.from(init!.body as Uint8Array),
  });
  return new Response(JSON.stringify({ storageId: 'storage-1' }), { status: 200 });
};

beforeEach(() => {
  backend = new FakeBackend();
  backend.bundle = DATA;
  uploads = [];
});

const lease = (): LeasedJob => backend.lease({ class: 'maintenance', action: 'buildSupportBundle' }, 'bundle1');
const worker = { workerId: 'w1', protocolVersion: PROTOCOL_VERSION, version: '1.2.3' };

describe('buildSupportBundle', () => {
  test("uploads one gzipped JSON file with the backend's DTOs, the worker's versions and its recent log lines", async () => {
    const logs = new LogBuffer(3);
    for (const line of ['one', 'two', 'three', 'four']) logs.push(line);
    const storageId = await buildSupportBundle({ backend, worker, logs, fetch: fetchFake }, lease());

    expect(storageId).toBe('storage-1');
    expect(backend.calls.filter((call) => call.fn === 'bundleData').map((call) => call.args)).toEqual([{ jobId: 'bundle1', leaseEpoch: 1 }]);
    const [upload] = uploads;
    expect(upload).toMatchObject({ url: 'http://convex.invalid/upload/1', type: 'application/gzip' });
    const bundle = JSON.parse(gunzipSync(upload!.body).toString('utf8'));
    expect(bundle).toEqual({
      format: 'omnarr-support-bundle/1',
      worker: { ...worker, logs: ['two', 'three', 'four'] },
      backend: DATA,
    });
  });

  test('a stale lease reads nothing and uploads nothing', async () => {
    const job = { ...lease(), leaseEpoch: 2 };
    await expect(buildSupportBundle({ backend, worker, logs: new LogBuffer(), fetch: fetchFake }, job)).rejects.toThrow(/staleLease/);
    expect(uploads).toEqual([]);
  });

  test('a refused upload fails the job', async () => {
    const refusing = async () => new Response('no', { status: 500 });
    await expect(buildSupportBundle({ backend, worker, logs: new LogBuffer(), fetch: refusing }, lease())).rejects.toThrow(/upload/);
  });

  test('the maintenance action returns the stored file as the result', async () => {
    const handler = maintenanceHandler({
      layout: dataLayout('/tmp/none'),
      clients: {},
      runtime: new ClientRuntimeStore(),
      backend,
      probe: async () => {
        throw new Error('no probe');
      },
      bundle: { worker, logs: new LogBuffer(), fetch: fetchFake },
    });
    expect(await handler(lease(), { signal: new AbortController().signal, progress: () => {} })).toEqual({
      class: 'maintenance',
      action: 'buildSupportBundle',
      storageId: 'storage-1',
    });
  });
});
