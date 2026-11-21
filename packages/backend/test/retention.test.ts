// The TTL and retention crons: candidates expire after 30 days unless their
// attempt led to a Grab, and the jobs and workflow records of Grabs finished
// more than 30 days ago go, and job artifacts are deleted after 14 days.
import { DEFAULT_LIMITS } from '@omnarr/contracts';
import { beforeEach, describe, expect, test, vi } from 'vite-plus/test';

import { api, internal } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import { workflow } from '../convex/pipeline/workflow';
import { FITTING_PROBE, type FakeWorker } from './fakeWorker';
import { E1, pipelineHarness, release } from './harness';
import { worker } from './setup';

const h = pipelineHarness();
let w: FakeWorker;

/** Not in the profile: season 2's attempt ends noAcceptable, so its candidate expires. */
const HDTV = release('s2e1-hdtv', 'Harbour.Lights.S02E01.720p.HDTV.x264-GRPC');

beforeEach(async () => {
  await h.indexer([E1, HDTV]);
  await h.subscribe([1, 2]);
  w = await h.worker();
});

const ageEverything = (ms: number) =>
  h.t.run(async (ctx) => {
    for (const row of await ctx.db.query('candidates').collect()) if (row.expiresAt !== undefined) await ctx.db.patch(row._id, { expiresAt: Date.now() - 1 });
    for (const row of await ctx.db.query('events').collect()) await ctx.db.patch(row._id, { at: row.at - ms });
  });

describe('candidate TTL (hourly)', () => {
  test('deletes expired candidates, and keeps those of an attempt that led to a Grab', async () => {
    const before = await h.all('candidates');
    const picked = before.filter((row) => row.expiresAt === undefined);
    expect(picked.length).toBeGreaterThan(0);
    expect(before.length).toBeGreaterThan(picked.length);

    await ageEverything(0);
    await h.t.mutation(internal.pipeline.retention.expireCandidates, {});
    expect((await h.all('candidates')).map((row) => row._id).sort()).toEqual(picked.map((row) => row._id).sort());
  });
});

describe('artifact TTL (hourly)', () => {
  /** A failed job with an ffmpeg log the worker uploaded for it, as `fail` records it. */
  async function failedWithArtifact(key: string) {
    await h.t.mutation(internal.jobs.queue.enqueue, { payload: { class: 'maintenance', action: 'cleanStaging', paths: [`/${key}`] }, idempotencyKey: key });
    const [job] = await w.claim('maintenance', 1);
    const artifactStorageId = await h.t.run((ctx) => ctx.storage.store(new Blob([`ffmpeg log ${key}`])));
    await h.t.mutation(api.jobs.queue.fail, {
      ...worker,
      jobId: job!.jobId,
      leaseEpoch: job!.leaseEpoch,
      failureCode: 'missingArticles',
      detail: 'x',
      artifactStorageId,
    });
    return { jobId: job!.jobId, artifactStorageId };
  }
  const stored = (id: Id<'_storage'>) => h.t.run(async (ctx) => (await ctx.storage.get(id)) !== null);

  test('deletes artifacts older than 14 days and clears them from their jobs, and keeps younger ones', async () => {
    const old = await failedWithArtifact('old');
    vi.setSystemTime(Date.now() + DEFAULT_LIMITS.artifactTtlMs - 60 * 60_000);
    const young = await failedWithArtifact('young');
    vi.setSystemTime(Date.now() + 2 * 60 * 60_000);

    await h.t.mutation(internal.jobs.artifacts.expire, {});
    expect(await stored(old.artifactStorageId)).toBe(false);
    expect((await h.get(old.jobId))!.artifactStorageId).toBeUndefined();
    expect(await stored(young.artifactStorageId)).toBe(true);
    expect((await h.get(young.jobId))!.artifactStorageId).toBe(young.artifactStorageId);
  });

  test("keeps a TMDB image, which is stored too but isn't an artifact", async () => {
    const workId = (await h.all('works'))[0]!._id;
    const storageId = await h.t.run((ctx) => ctx.storage.store(new Blob(['<svg/>'])));
    await h.t.run((ctx) => ctx.db.insert('images', { workId, path: '/poster.jpg', size: 'w342', storageId, fetchedAt: Date.now() }));
    vi.setSystemTime(Date.now() + DEFAULT_LIMITS.artifactTtlMs + 60 * 60_000);

    await h.t.mutation(internal.jobs.artifacts.expire, {});
    expect(await stored(storageId)).toBe(true);
  });
});

describe('job and run retention (daily)', () => {
  async function finishRun() {
    await w.submitAll();
    await h.settle();
    await w.completed(await h.activeDownload());
    await h.settle();
    // A file that fits: no `prepare` job, which runs outside the run, is left queued.
    await w.importAll({ probe: FITTING_PROBE });
    await h.settle();
    await w.publishAll();
    await h.settle();
    for (const job of await w.claim('maintenance')) await w.complete(job, { class: 'maintenance', action: 'removeDownload', removed: true });
  }

  test('deletes the jobs and the workflow records of a Grab finished more than 30 days ago', async () => {
    await finishRun();
    const [grab] = await h.all('grabs');
    const status = () => h.t.run((ctx) => workflow.status(ctx, grab!.workflowId!));
    expect((await status()).type).toBe('completed');
    await ageEverything(DEFAULT_LIMITS.jobRetentionMs + 60_000);
    await h.t.mutation(internal.pipeline.retention.cleanUpRuns, {});
    await h.settle();

    expect(await h.all('jobs')).toEqual([]);
    await expect(status()).rejects.toThrow();
    // The Grab itself, its events and its decision records stay: the timeline reads them.
    expect(await h.all('grabs')).toHaveLength(1);
  });

  test('keeps a Grab finished less than 30 days ago', async () => {
    await finishRun();
    await ageEverything(DEFAULT_LIMITS.jobRetentionMs - 86_400_000);
    await h.t.mutation(internal.pipeline.retention.cleanUpRuns, {});
    expect((await h.all('jobs')).length).toBeGreaterThan(0);
  });
});

describe('relay job retention (daily)', () => {
  const relayJobs = async () => (await h.all('jobs')).filter((job) => job.class === 'indexer');

  test('deletes the indexer jobs an action left behind, cancels a leased one, and keeps those under an hour old', async () => {
    const indexerId = (await h.all('indexers'))[0]!._id;
    const enqueue = () => h.t.mutation(internal.indexers.relay.enqueue, { payload: { class: 'indexer', action: 'rss', indexerId } });
    // The action died after the worker answered, while the worker ran it, and before any worker claimed it.
    const answered = await enqueue();
    const [first] = await w.claim('indexer', 1);
    await w.complete(first!, { class: 'indexer', outcome: { ok: true, value: { items: [], offset: 0 } } });
    const running = await enqueue();
    const [second] = await w.claim('indexer', 1);
    const unclaimed = await enqueue();
    vi.setSystemTime(Date.now() + DEFAULT_LIMITS.relayJobAbandonedMs + 60_000);
    // A live relay's job, still being polled.
    const live = await enqueue();

    await h.t.mutation(internal.pipeline.retention.cleanUpRelayJobs, {});
    expect((await relayJobs()).map((job) => job._id).sort()).toEqual([running, live].sort());
    expect((await h.get(running))!.cancelRequested).toBe(true);
    expect((await h.get(answered)) ?? null).toBeNull();
    expect((await h.get(unclaimed)) ?? null).toBeNull();

    // The worker ends the cancelled job; the next run deletes it.
    await w.complete(second!, { class: 'indexer', outcome: { ok: true, value: { items: [], offset: 0 } } });
    await h.t.mutation(internal.pipeline.retention.cleanUpRelayJobs, {});
    expect((await relayJobs()).map((job) => job._id)).toEqual([live]);
  });

  test("removes failed, cancelled (the relay timeout's leftover) and waiting ones, and keeps another class's jobs past the cutoff", async () => {
    const indexerId = (await h.all('indexers'))[0]!._id;
    const relayJob = async (status: 'failed' | 'cancelled' | 'waiting') => {
      const jobId = await h.t.mutation(internal.indexers.relay.enqueue, { payload: { class: 'indexer', action: 'rss', indexerId } });
      await h.t.run((ctx) => ctx.db.patch(jobId, { status }));
      return jobId;
    };
    await relayJob('failed');
    await relayJob('cancelled');
    await relayJob('waiting');
    await h.t.mutation(internal.jobs.queue.enqueue, {
      payload: { class: 'maintenance', action: 'cleanStaging', paths: ['/old'] },
      idempotencyKey: 'old-maintenance',
    });
    const others = (await h.all('jobs')).filter((job) => job.class !== 'indexer').map((job) => job._id);
    expect(others.length).toBeGreaterThan(0);
    vi.setSystemTime(Date.now() + DEFAULT_LIMITS.relayJobAbandonedMs + 60_000);

    await h.t.mutation(internal.pipeline.retention.cleanUpRelayJobs, {});
    expect(await relayJobs()).toEqual([]);
    expect((await h.all('jobs')).map((job) => job._id).sort()).toEqual(others.sort());
  });

  test('runs as the daily retention chain’s last step', async () => {
    const indexerId = (await h.all('indexers'))[0]!._id;
    await h.t.mutation(internal.indexers.relay.enqueue, { payload: { class: 'indexer', action: 'rss', indexerId } });
    vi.setSystemTime(Date.now() + DEFAULT_LIMITS.relayJobAbandonedMs + 60_000);
    await h.t.mutation(internal.pipeline.retention.cleanUpRuns, {});
    await h.settle();
    expect(await relayJobs()).toEqual([]);
  });
});
