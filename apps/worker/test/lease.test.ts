import { DEFAULT_LIMITS, type JobPayload, type JobResult } from '@omnarr/contracts';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';

import { JobFailure, LeaseRuntime, type JobHandler } from '../src/runtime/lease.ts';
import { FakeBackend } from './fakeBackend.ts';

const cleanStaging: JobPayload = { class: 'maintenance', action: 'cleanStaging', paths: ['/data/staging/a'] };
const done: JobResult = { class: 'maintenance', action: 'cleanStaging', removedPaths: [] };

/** A handler that runs until the test resolves it or its signal aborts. */
function controllable() {
  const runs: { resolve: () => void; signal: AbortSignal }[] = [];
  const handler: JobHandler = (_job, { signal }) =>
    new Promise((resolve, reject) => {
      runs.push({ resolve: () => resolve(done), signal });
      signal.addEventListener('abort', () => reject(signal.reason));
    });
  return { runs, handler };
}

const settle = () => vi.advanceTimersByTimeAsync(0);

let backend: FakeBackend;
beforeEach(() => {
  vi.useFakeTimers();
  backend = new FakeBackend();
});
afterEach(() => {
  vi.useRealTimers();
});

const runtime = (handler: JobHandler, concurrency = 2) =>
  new LeaseRuntime({ backend, sessionId: 'session1' as never, handlers: { maintenance: handler }, concurrency: { maintenance: concurrency }, log: () => {} });

// CI run 44461776793: a publish job's `complete` timed out on a loaded backend, and the worker failed the
// finished job as pipelineError, which failed its Grab. A timed-out mutation changes nothing, so it is tried again.
describe('LeaseRuntime, a backend call that fails as a server error', () => {
  test('complete is tried again, and the finished job is never failed', async () => {
    backend.transientFailures.complete = 2;
    const rt = runtime(async () => done);
    rt.start();
    const jobId = backend.add(cleanStaging);
    await settle();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(backend.calls.map((c) => c.fn).filter((fn) => fn.startsWith('complete') || fn.startsWith('fail'))).toEqual([
      'complete:serverError',
      'complete:serverError',
      'complete',
    ]);
    expect(backend.calls.find((c) => c.fn === 'complete')?.args).toMatchObject({ jobId, result: done });
  });

  test("a handler's failure is reported again too, with its own code", async () => {
    backend.transientFailures.fail = 1;
    const rt = runtime(async () => {
      throw new JobFailure('transcodeFailed', 'Output check failed.');
    });
    rt.start();
    backend.add(cleanStaging);
    await settle();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(backend.calls.filter((c) => c.fn.startsWith('fail')).map((c) => [c.fn, (c.args as { failureCode: string }).failureCode])).toEqual([
      ['fail:serverError', 'transcodeFailed'],
      ['fail', 'transcodeFailed'],
    ]);
  });

  test('a refused call (staleLease) is final: no retry, and no failure reported', async () => {
    const { runs, handler } = controllable();
    const rt = runtime(handler);
    rt.start();
    const jobId = backend.add(cleanStaging);
    await settle();
    backend.expireLease(jobId);
    runs[0]!.resolve();
    await settle();
    await vi.advanceTimersByTimeAsync(10_000);
    expect(backend.calls.filter((c) => c.fn.startsWith('complete') || c.fn.startsWith('fail'))).toEqual([]);
  });
});

describe('LeaseRuntime', () => {
  test('claims a queued job when the queue says so, and completes it with the handler’s result', async () => {
    const rt = runtime(async () => done);
    rt.start();
    const jobId = backend.add(cleanStaging);
    await settle();
    expect(backend.calls.find((c) => c.fn === 'complete')?.args).toMatchObject({ jobId, leaseEpoch: 1, result: done });
  });

  test('holds at most `concurrency` jobs of a class', async () => {
    const { runs, handler } = controllable();
    runtime(handler, 2).start();
    backend.add(cleanStaging);
    backend.add(cleanStaging);
    backend.add(cleanStaging);
    await settle();
    expect(runs).toHaveLength(2);
    runs[0]!.resolve();
    await settle();
    expect(runs).toHaveLength(3);
  });

  test('claims only classes it has a handler for', async () => {
    runtime(async () => done).start();
    backend.add({
      class: 'publish',
      publicationIds: [],
      workFolderPath: '/data/library/series/A',
      items: [],
      library: { libraryId: 'l1' as never, root: '/data/library/series', kind: 'series' },
    });
    await settle();
    expect(backend.count('claim')).toBe(0);
  });

  test("a JobFailure's structured reason goes with it to job.fail", async () => {
    runtime(async () => {
      throw new JobFailure('jellyfinSetupNeeded', 'refused', { reason: 'credentialsNeeded', step: 'apiKey' });
    }).start();
    const jobId = backend.add(cleanStaging);
    await settle();
    expect(backend.calls.find((c) => c.fn === 'fail')?.args).toMatchObject({
      jobId,
      failureCode: 'jellyfinSetupNeeded',
      data: { reason: 'credentialsNeeded', step: 'apiKey' },
    });
  });

  test("a JobFailure's uploaded log goes with it to job.fail as artifactStorageId", async () => {
    runtime(async () => {
      const failure = new JobFailure('transcodeFailed', 'ffmpeg exited with code 1.');
      failure.artifactStorageId = 'storage1' as never;
      throw failure;
    }).start();
    const jobId = backend.add(cleanStaging);
    await settle();
    expect(backend.calls.find((c) => c.fn === 'fail')?.args).toEqual({
      jobId,
      leaseEpoch: 1,
      failureCode: 'transcodeFailed',
      detail: 'ffmpeg exited with code 1.',
      artifactStorageId: 'storage1',
    });
  });

  test('a handler’s JobFailure fails the job with its code', async () => {
    runtime(async () => {
      throw new JobFailure('clientUnreachable', 'nzbget: /jsonrpc refused');
    }).start();
    const jobId = backend.add(cleanStaging);
    await settle();
    expect(backend.calls.find((c) => c.fn === 'fail')?.args).toMatchObject({ jobId, failureCode: 'clientUnreachable', detail: 'nzbget: /jsonrpc refused' });
  });

  test('a cancellation aborts the handler and reports cancelled', async () => {
    const { runs, handler } = controllable();
    const rt = runtime(handler);
    rt.start();
    const jobId = backend.add(cleanStaging);
    await settle();
    rt.cancel(jobId);
    await settle();
    expect(runs[0]!.signal.aborted).toBe(true);
    expect(backend.calls.find((c) => c.fn === 'fail')?.args).toMatchObject({ jobId, failureCode: 'cancelled' });
  });

  test('a lost lease (fencing) drops the job without failing it', async () => {
    const { runs, handler } = controllable();
    runtime(handler).start();
    const jobId = backend.add(cleanStaging);
    await settle();
    backend.expireLease(jobId);
    runs[0]!.resolve();
    await settle();
    expect(backend.count('complete') + backend.count('fail')).toBe(0);
  });

  test("progress is written at most every 5 s; the e2e's lowered progressMs every second", async () => {
    for (const [limits, writes] of [
      [undefined, 1],
      [{ ...DEFAULT_LIMITS, progressMs: 1000 }, 2],
    ] as const) {
      backend = new FakeBackend();
      const { runs, handler } = controllable();
      const rt = new LeaseRuntime({
        backend,
        sessionId: 'session1' as never,
        handlers: { maintenance: (job, ctx) => (ctx.progress(0.1), setTimeout(() => ctx.progress(0.2), 1000), handler(job, ctx)) },
        ...(limits ? { limits } : {}),
        log: () => {},
      });
      rt.start();
      backend.add(cleanStaging);
      await vi.advanceTimersByTimeAsync(2000);
      expect(backend.count('progress')).toBe(writes);
      runs[0]!.resolve();
      await settle();
    }
  });

  test('a progress call refused by fencing aborts the handler', async () => {
    let signal: AbortSignal | undefined;
    const rt = runtime((_job, ctx) => {
      signal = ctx.signal;
      return new Promise((_resolve, reject) => {
        ctx.signal.addEventListener('abort', () => reject(ctx.signal.reason));
        // The supervision cron took the lease; this worker shouldn't claim it again here.
        backend.expireLease(jobId);
        void rt.stop();
        ctx.progress(0.5);
      });
    });
    rt.start();
    const jobId = backend.add(cleanStaging);
    await settle();
    expect(signal?.aborted).toBe(true);
    expect(backend.count('fail')).toBe(0);
  });

  test('stop aborts running work and releases every held job', async () => {
    const { runs, handler } = controllable();
    const rt = runtime(handler);
    rt.start();
    const a = backend.add(cleanStaging);
    const b = backend.add(cleanStaging);
    await settle();
    await rt.stop();
    expect(runs.every((r) => r.signal.aborted)).toBe(true);
    expect(backend.calls.filter((c) => c.fn === 'release').map((c) => (c.args as { jobId: string }).jobId)).toEqual([a, b]);
    expect(backend.count('fail') + backend.count('complete')).toBe(0);
  });
});
