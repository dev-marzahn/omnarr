// The support bundle: System's "Support bundle"
// queues a `buildSupportBundle` job, the worker reads `worker.bundleData` for
// its lease, and the finished archive is System's latest bundle for 14 days.
// The bundle is built from DTOs only, so no secret is in it.
import { DEFAULT_LIMITS, type LeasedJob } from '@omnarr/contracts';
import { beforeEach, describe, expect, test } from 'vite-plus/test';

import { api } from '../convex/_generated/api';
import type { FakeWorker } from './fakeWorker';
import { E1_RELEASES, pipelineHarness } from './harness';
import { INDEXER_KEY, worker, WORKER_TOKEN } from './setup';

const h = pipelineHarness();
let w: FakeWorker;

beforeEach(async () => {
  await h.indexer(E1_RELEASES);
  await h.subscribe();
  w = await h.worker();
  // A run that failed once, so the bundle has events, jobs and an Issue to show.
  await w.submitAll();
  await h.settle();
  await w.failed(await h.activeDownload(), 'missingArticles');
  await h.settle();
});

const request = () => h.admin.mutation(api.api.system.buildSupportBundle, {});
const bundleJob = async (): Promise<LeasedJob> =>
  (await w.claim('maintenance')).find((job) => job.payload.class === 'maintenance' && job.payload.action === 'buildSupportBundle')!;
const bundleData = (job: LeasedJob, leaseEpoch = job.leaseEpoch) => h.t.query(api.jobs.worker.bundleData, { ...worker, jobId: job.jobId, leaseEpoch });

describe('the support bundle', () => {
  test('"Support bundle" queues one build at a time', async () => {
    const first = await request();
    expect(await request()).toEqual(first);
    expect((await h.get(first.jobId))!.payload).toEqual({ class: 'maintenance', action: 'buildSupportBundle' });
  });

  test("the worker reads the bundle's DTOs for its lease, and nothing in them is a secret", async () => {
    await request();
    const job = await bundleJob();
    const data = await bundleData(job);

    expect(data).toMatchObject({
      builtAt: expect.any(Number),
      status: { clients: expect.any(Array) },
      indexers: [expect.objectContaining({ name: expect.any(String) })],
    });
    expect(data.events.length).toBeGreaterThan(0);
    expect(data.jobs).toContainEqual(expect.objectContaining({ class: 'download.submit', status: 'done' }));
    expect(data.jobs.every((row) => !('payload' in row))).toBe(true);
    const text = JSON.stringify(data);
    for (const secret of [INDEXER_KEY, WORKER_TOKEN, 'downloadUrl', 'apikey=']) expect(text).not.toContain(secret);

    await expect(bundleData(job, job.leaseEpoch + 1)).rejects.toThrow(/staleLease/);
  });

  test("a finished build is System's latest bundle, kept 14 days", async () => {
    await request();
    const job = await bundleJob();
    const storageId = await h.t.run((ctx) => ctx.storage.store(new Blob(['{}'])));
    await w.complete(job, { class: 'maintenance', action: 'buildSupportBundle', storageId });

    const { supportBundle } = await h.admin.query(api.api.system.status, {});
    expect(supportBundle).toEqual({
      builtAt: expect.any(Number),
      expiresAt: supportBundle!.builtAt + DEFAULT_LIMITS.artifactTtlMs,
      url: expect.stringContaining('/api/storage/'),
    });
    expect((await h.get(job.jobId))!.artifactStorageId).toBe(storageId);
  });
});
