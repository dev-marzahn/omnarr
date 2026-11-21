import { DEFAULT_LIMITS, type JobPayload, PROTOCOL_VERSION } from '@omnarr/contracts';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';

import { api, internal } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import { capabilities, setup, storageSpace, worker, type Backend } from './setup';

let t: Backend;
let sessionId: Id<'workerSessions'>;

beforeEach(async () => {
  vi.useFakeTimers();
  t = setup();
  const response = await t.mutation(api.jobs.worker.connect, { ...worker, workerId: 'w1', capabilities });
  if (!response.accepted) throw new Error('not accepted');
  sessionId = response.sessionId;
});

afterEach(() => {
  vi.useRealTimers();
});

const cleanStaging = (path = '/data/staging/x'): JobPayload => ({ class: 'maintenance', action: 'cleanStaging', paths: [path] });

const enqueue = (key = 'cleanStaging:x', payload = cleanStaging()) => t.mutation(internal.jobs.queue.enqueue, { payload, idempotencyKey: key });

const claim = (max = 1) => t.mutation(api.jobs.queue.claim, { ...worker, sessionId, class: 'maintenance', max });

/**
 * Functions under convex-test read the real clock, not Vitest's fake one, so
 * a timestamp is checked to the second, and the past is set directly.
 */
const about = (ms: number) => expect.toSatisfy((actual: number) => Math.abs(actual - ms) < 1000);
const expireLeases = () =>
  t.run(async (ctx) => {
    for (const j of await ctx.db.query('jobs').collect()) if (j.leaseExpiresAt) await ctx.db.patch(j._id, { leaseExpiresAt: Date.now() - 1 });
  });

/** The job, with cleared optional fields present as `undefined` so `toMatchObject` can assert them. */
const job = async (jobId: Id<'jobs'>) => {
  const doc = await t.run((ctx) => ctx.db.get(jobId));
  return doc && { payload: undefined, leaseOwner: undefined, leaseExpiresAt: undefined, availableAt: undefined, ...doc };
};

describe('enqueue', () => {
  test('dedupes on the idempotency key', async () => {
    const first = await enqueue();
    const second = await enqueue();
    expect(second).toBe(first);
    expect(await t.run((ctx) => ctx.db.query('jobs').collect())).toHaveLength(1);
  });

  test('takes maxAttempts from DEFAULT_LIMITS for the class', async () => {
    const jobId = await enqueue();
    expect(await job(jobId)).toMatchObject({ class: 'maintenance', status: 'queued', attempt: 0, maxAttempts: DEFAULT_LIMITS.maxAttempts.maintenance });
  });
});

describe('queue', () => {
  test('counts claimable jobs per class', async () => {
    await enqueue('a', cleanStaging('/a'));
    await enqueue('b', cleanStaging('/b'));
    const counts = await t.query(api.jobs.queue.queue, { ...worker, classes: ['maintenance', 'import'] });
    expect(counts).toEqual([
      { class: 'maintenance', count: 2 },
      { class: 'import', count: 0 },
    ]);
  });
});

describe('claim', () => {
  test('leases up to max jobs, oldest first, and raises the lease epoch', async () => {
    const a = await enqueue('a', cleanStaging('/a'));
    await enqueue('b', cleanStaging('/b'));
    const leased = await claim(1);
    expect(leased).toEqual([{ jobId: a, class: 'maintenance', leaseEpoch: 1, payload: cleanStaging('/a') }]);
    expect(await job(a)).toMatchObject({ status: 'leased', leaseOwner: sessionId, leaseExpiresAt: about(Date.now() + DEFAULT_LIMITS.leaseMs) });
  });

  test('a leased job is not claimed again', async () => {
    await enqueue();
    expect(await claim(5)).toHaveLength(1);
    expect(await claim(5)).toHaveLength(0);
  });

  describe('priority', () => {
    const prioritized = (key: string, priority?: number) =>
      t.mutation(internal.jobs.queue.enqueue, { payload: cleanStaging(`/${key}`), idempotencyKey: key, ...(priority === undefined ? {} : { priority }) });

    test('the lowest priority first, the oldest first within a priority, and an absent priority reads as 0', async () => {
      const video = await prioritized('video', 3);
      const profileEdit = await prioritized('profileEdit', 2);
      const none = await prioritized('none');
      const zero = await prioritized('zero', 0);
      const laterProfileEdit = await prioritized('laterProfileEdit', 2);
      expect((await claim(5)).map((leased) => leased.jobId)).toEqual([none, zero, profileEdit, laterProfileEdit, video]);
    });

    test('an older priority-0 job comes before a newer job without one', async () => {
      const zero = await prioritized('zero', 0);
      const none = await prioritized('none');
      expect((await claim(2)).map((leased) => leased.jobId)).toEqual([zero, none]);
    });

    test('is stored when given above 0; 0 is stored as absent, so both sort as one priority', async () => {
      const given = await prioritized('given', 2);
      const zero = await prioritized('zero', 0);
      const none = await prioritized('none');
      expect((await job(given))!.priority).toBe(2);
      expect((await job(zero))!.priority).toBeUndefined();
      expect((await job(none))!.priority).toBeUndefined();
      expect(await t.query(api.jobs.queue.queue, { ...worker, classes: ['maintenance'] })).toEqual([{ class: 'maintenance', count: 3 }]);
      expect(await claim(3)).toHaveLength(3);
    });

    test('enqueueWith stores it too', async () => {
      const jobId = await t.run(async (ctx) => {
        const { enqueueWith } = await import('../convex/jobs/queue');
        const { jobId } = await enqueueWith(ctx, { class: 'maintenance', idempotencyKey: 'with', priority: 3 }, async () => cleanStaging('/with'));
        return jobId;
      });
      expect((await job(jobId))!.priority).toBe(3);
    });
  });

  test('a rejected session claims nothing', async () => {
    await enqueue();
    await t.mutation(api.jobs.worker.connect, { ...worker, protocolVersion: 0, workerId: 'old', capabilities });
    const rejected = await t.run(async (ctx) => (await ctx.db.query('workerSessions').collect()).find((s) => !s.accepted)!._id);
    await expect(t.mutation(api.jobs.queue.claim, { ...worker, sessionId: rejected, class: 'maintenance', max: 1 })).rejects.toThrow(/sessionNotAccepted/);
  });
});

describe('fencing', () => {
  test('a stale lease epoch is rejected', async () => {
    const jobId = await enqueue();
    await claim();
    await t.mutation(api.jobs.queue.release, { ...worker, jobId, leaseEpoch: 1 });
    await claim(); // epoch 2
    const stale = { ...worker, jobId, leaseEpoch: 1 };
    await expect(t.mutation(api.jobs.queue.progress, { ...stale, fraction: 0.5 })).rejects.toThrow(/staleLease/);
    await expect(t.mutation(api.jobs.queue.complete, { ...stale, result: { class: 'maintenance', action: 'cleanStaging', removedPaths: [] } })).rejects.toThrow(
      /staleLease/,
    );
    await expect(t.mutation(api.jobs.queue.fail, { ...stale, failureCode: 'clientUnreachable', detail: 'x' })).rejects.toThrow(/staleLease/);
    await expect(t.mutation(api.jobs.queue.release, stale)).rejects.toThrow(/staleLease/);
  });
});

describe('progress and complete', () => {
  test('progress is stored apart from the job, and removed when it completes', async () => {
    const jobId = await enqueue();
    await claim();
    await t.mutation(api.jobs.queue.progress, { ...worker, jobId, leaseEpoch: 1, fraction: 0.4, detail: 'removing' });
    expect(await t.run((ctx) => ctx.db.query('jobProgress').collect())).toMatchObject([{ jobId, fraction: 0.4, detail: 'removing' }]);

    await t.mutation(api.jobs.queue.complete, {
      ...worker,
      jobId,
      leaseEpoch: 1,
      result: { class: 'maintenance', action: 'cleanStaging', removedPaths: ['/x'] },
    });
    expect(await job(jobId)).toMatchObject({ status: 'done', payload: undefined });
    expect(await t.run((ctx) => ctx.db.query('jobProgress').collect())).toEqual([]);
  });

  test('a result for another class or action is rejected', async () => {
    const jobId = await enqueue();
    await claim();
    await expect(
      t.mutation(api.jobs.queue.complete, { ...worker, jobId, leaseEpoch: 1, result: { class: 'download.submit', clientRef: 'x' } }),
    ).rejects.toThrow(/invalidResult/);
    await expect(
      t.mutation(api.jobs.queue.complete, { ...worker, jobId, leaseEpoch: 1, result: { class: 'maintenance', action: 'testUsenetServer', outcome: 'ok' } }),
    ).rejects.toThrow(/invalidResult/);
  });
});

describe('release', () => {
  test('returns the job to the queue without counting an attempt', async () => {
    const jobId = await enqueue();
    await claim();
    await t.mutation(api.jobs.queue.release, { ...worker, jobId, leaseEpoch: 1 });
    expect(await job(jobId)).toMatchObject({ status: 'queued', attempt: 0, leaseOwner: undefined, leaseExpiresAt: undefined });
  });
});

describe('fail', () => {
  test('a retryable code backs off, counts one attempt, and wakes the job', async () => {
    const jobId = await enqueue();
    await claim();
    await t.mutation(api.jobs.queue.fail, { ...worker, jobId, leaseEpoch: 1, failureCode: 'clientUnreachable', detail: 'nzbget: /jsonrpc refused' });
    const waiting = await job(jobId);
    expect(waiting).toMatchObject({ status: 'waiting', attempt: 1, failureCode: 'clientUnreachable', lastError: 'nzbget: /jsonrpc refused' });
    expect(waiting!.availableAt).toBeGreaterThan(Date.now());

    vi.advanceTimersByTime(DEFAULT_LIMITS.backoffCapMs);
    await t.finishInProgressScheduledFunctions();
    expect(await job(jobId)).toMatchObject({ status: 'queued', availableAt: undefined });
  });

  test("the e2e's OMNARR_TEST_LIMITS lowers the backoff (backoffBaseMs)", async () => {
    vi.stubEnv('OMNARR_TEST_LIMITS', '{"backoffBaseMs":1000}');
    try {
      const jobId = await enqueue();
      await claim();
      await t.mutation(api.jobs.queue.fail, { ...worker, jobId, leaseEpoch: 1, failureCode: 'clientUnreachable', detail: 'x' });
      // The first backoff is the base, ±20 %.
      expect((await job(jobId))!.availableAt! - Date.now()).toBeLessThanOrEqual(1200);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test('past maxAttempts the job fails terminally and drops its payload', async () => {
    const jobId = await enqueue();
    for (let epoch = 1; epoch <= DEFAULT_LIMITS.maxAttempts.maintenance; epoch++) {
      await t.mutation(internal.jobs.queue.wake, { jobId });
      await claim();
      await t.mutation(api.jobs.queue.fail, { ...worker, jobId, leaseEpoch: epoch, failureCode: 'clientUnreachable', detail: 'x' });
    }
    expect(await job(jobId)).toMatchObject({ status: 'failed', attempt: DEFAULT_LIMITS.maxAttempts.maintenance, payload: undefined });
  });

  test('a bad-release code fails at once', async () => {
    const jobId = await enqueue();
    await claim();
    await t.mutation(api.jobs.queue.fail, { ...worker, jobId, leaseEpoch: 1, failureCode: 'missingArticles', detail: 'x' });
    expect(await job(jobId)).toMatchObject({ status: 'failed', failureCode: 'missingArticles', payload: undefined });
  });

  test('diskFull waits 30 minutes without counting an attempt, behind one system Issue', async () => {
    const jobId = await enqueue();
    await claim();
    await t.mutation(api.jobs.queue.fail, { ...worker, jobId, leaseEpoch: 1, failureCode: 'diskFull', detail: 'needs 4 GB, 1 GB free' });
    expect(await job(jobId)).toMatchObject({ status: 'waiting', attempt: 0, availableAt: about(Date.now() + DEFAULT_LIMITS.diskFullRetryMs) });
    const issues = await t.run((ctx) => ctx.db.query('issues').collect());
    expect(issues).toMatchObject([{ scope: 'system', failureCode: 'diskFull', state: 'open', detail: 'needs 4 GB, 1 GB free' }]);
  });

  test('stores the artifact the worker uploaded for the failure', async () => {
    const jobId = await enqueue();
    await claim();
    const artifactStorageId = await t.run((ctx) => ctx.storage.store(new Blob(['ffmpeg exited with 1'])));
    await t.mutation(api.jobs.queue.fail, { ...worker, jobId, leaseEpoch: 1, failureCode: 'missingArticles', detail: 'x', artifactStorageId });
    expect(await job(jobId)).toMatchObject({ status: 'failed', artifactStorageId });
  });

  test('cancelled ends the job as cancelled', async () => {
    const jobId = await enqueue();
    await claim();
    await t.mutation(api.jobs.queue.fail, { ...worker, jobId, leaseEpoch: 1, failureCode: 'cancelled', detail: 'cancelled by the user' });
    expect(await job(jobId)).toMatchObject({ status: 'cancelled', payload: undefined });
  });
});

describe('heartbeat and leases', () => {
  test('renews the session’s leases and returns the jobs to cancel', async () => {
    const jobId = await enqueue();
    await claim();
    await t.run((ctx) => ctx.db.patch(jobId, { cancelRequested: true }));
    await expireLeases();
    const response = await t.mutation(api.jobs.worker.heartbeat, { ...worker, sessionId, storage: storageSpace() });
    expect(response).toEqual({ cancelJobIds: [jobId], leaseExpiresAt: about(Date.now() + DEFAULT_LIMITS.leaseMs) });
    expect((await job(jobId))!.leaseExpiresAt).toBe(response.leaseExpiresAt);
  });

  test("the e2e's OMNARR_TEST_LIMITS lowers the lease (leaseMs), at the claim and at each beat", async () => {
    vi.stubEnv('OMNARR_TEST_LIMITS', '{"leaseMs":15000}');
    try {
      const jobId = await enqueue();
      await claim();
      expect((await job(jobId))!.leaseExpiresAt).toEqual(about(Date.now() + 15_000));
      const response = await t.mutation(api.jobs.worker.heartbeat, { ...worker, sessionId, storage: storageSpace() });
      expect(response.leaseExpiresAt).toEqual(about(Date.now() + 15_000));
    } finally {
      vi.unstubAllEnvs();
    }
  });
});

describe('supervise', () => {
  test('an expired lease returns the job to the queue and counts one attempt', async () => {
    const jobId = await enqueue();
    await claim();
    await expireLeases();
    await t.mutation(internal.jobs.queue.supervise, {});
    expect(await job(jobId)).toMatchObject({ status: 'queued', attempt: 1, leaseOwner: undefined });
  });

  test('an expired lease past maxAttempts fails the job with leaseExpired', async () => {
    const jobId = await enqueue();
    await t.run((ctx) => ctx.db.patch(jobId, { attempt: DEFAULT_LIMITS.maxAttempts.maintenance - 1 }));
    await claim();
    await expireLeases();
    await t.mutation(internal.jobs.queue.supervise, {});
    expect(await job(jobId)).toMatchObject({ status: 'failed', failureCode: 'leaseExpired', payload: undefined });
  });

  test('a live lease is left alone', async () => {
    const jobId = await enqueue();
    await claim();
    await t.mutation(internal.jobs.queue.supervise, {});
    expect(await job(jobId)).toMatchObject({ status: 'leased' });
  });

  test('raises workerOffline when no worker was seen for 60 s, and resolves it when one is', async () => {
    const offline = async () => (await t.run((ctx) => ctx.db.query('issues').collect())).filter((i) => i.failureCode === 'workerOffline' && i.state === 'open');
    await t.mutation(internal.jobs.queue.supervise, {});
    expect(await offline()).toHaveLength(0);

    await t.run((ctx) => ctx.db.patch(sessionId, { lastSeenAt: Date.now() - DEFAULT_LIMITS.livenessMs - 1 }));
    await t.mutation(internal.jobs.queue.supervise, {});
    expect(await offline()).toHaveLength(1);

    await t.mutation(api.jobs.worker.heartbeat, { ...worker, sessionId, storage: storageSpace() });
    await t.mutation(internal.jobs.queue.supervise, {});
    expect(await offline()).toHaveLength(0);
  });

  test('raises no workerOffline while protocolMismatch is open, so one banner shows', async () => {
    await t.run((ctx) => ctx.db.patch(sessionId, { lastSeenAt: Date.now() - DEFAULT_LIMITS.livenessMs - 1 }));
    await t.mutation(api.jobs.worker.connect, { ...worker, protocolVersion: PROTOCOL_VERSION + 1, workerId: 'old', capabilities });
    await t.mutation(internal.jobs.queue.supervise, {});
    const open = (await t.run((ctx) => ctx.db.query('issues').collect())).filter((i) => i.state === 'open').map((i) => i.failureCode);
    expect(open).toEqual(['protocolMismatch']);
  });
});

describe('enqueuePasswordPush', () => {
  test('replaces a push that no worker has picked up yet', async () => {
    const push = (newPassword: string) => t.mutation(internal.jobs.queue.enqueuePasswordPush, { userId: 'u1', username: 'admin', newPassword });
    const first = await push('one');
    const second = await push('two');
    expect(await job(first)).toMatchObject({ status: 'cancelled', payload: undefined });
    expect(await job(second)).toMatchObject({ status: 'queued', payload: { action: 'pushJellyfinPassword', newPassword: 'two' } });
  });

  test('asks a worker that already holds an earlier push to cancel it', async () => {
    const push = (newPassword: string) => t.mutation(internal.jobs.queue.enqueuePasswordPush, { userId: 'u1', username: 'admin', newPassword });
    const first = await push('one');
    await claim();
    await push('two');
    expect(await job(first)).toMatchObject({ status: 'leased', cancelRequested: true });
  });
});
