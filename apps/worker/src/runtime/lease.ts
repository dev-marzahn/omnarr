// The lease runtime: one claim loop per job class, woken by
// the reactive queue query, with the configured concurrency per class. Every job runs
// with its own AbortController, which a cancellation, a fencing refusal or
// shutdown triggers.
import { DEFAULT_LIMITS, type FailureCode, type FailureData, type JobClass, type JobResult, type LeasedJob, type Limits } from '@omnarr/contracts';
import type { GenericId } from 'convex/values';

import { workerErrorCode, type WorkerBackend } from '../convex.ts';
import { ProgressReporter } from './progress.ts';

/**
 * Thrown by a handler to fail its job with a code. `detail` is platform-written
 * text only: a client or host and an endpoint path, never a URL or outside
 * error text.
 */
export class JobFailure extends Error {
  /** The job's uploaded log (a prepare job's `ffmpeg.log`), set by the handler before it rethrows; sent with `job.fail`. */
  public artifactStorageId?: GenericId<'_storage'>;

  public constructor(
    public readonly code: FailureCode,
    public readonly detail: string,
    /** The playback target's structured reason, for `setupJellyfin` and `publish`. */
    public readonly data?: FailureData,
    /** The error it maps, kept so the runtime can tell a write failure (`EACCES`, `EROFS`) behind it. */
    options?: { cause?: unknown },
  ) {
    super(`${code}: ${detail}`, options);
  }
}

const WRITE_REFUSED = new Set(['EACCES', 'EROFS']);

/** A file-system write refused for permissions or a read-only mount, thrown as it is or as a JobFailure's cause. */
export function isWriteFailure(error: unknown): boolean {
  for (let current = error, depth = 0; current instanceof Error && depth < 5; current = current.cause, depth++) {
    const code = (current as NodeJS.ErrnoException).code;
    if (typeof code === 'string' && WRITE_REFUSED.has(code)) return true;
  }
  return false;
}

export type JobContext = {
  signal: AbortSignal;
  /** Throttled to one write every 5 s (`progressMs`). */
  progress: (fraction: number, detail?: string) => void;
};

export type JobHandler = (job: LeasedJob, ctx: JobContext) => Promise<JobResult>;

/** The waits before each further try of a job's last call: 1 + 2 + 4 + 8 s, within the 60 s lease. */
const SETTLE_RETRY_MS = [1_000, 2_000, 4_000, 8_000];

type AbortReason = 'cancelled' | 'lostLease' | 'shutdown';

type Running = { job: LeasedJob; controller: AbortController; progress: ProgressReporter; done: Promise<void> };

export type LeaseRuntimeOptions = {
  backend: WorkerBackend;
  sessionId: GenericId<'workerSessions'>;
  handlers: Partial<Record<JobClass, JobHandler>>;
  concurrency?: Partial<Record<JobClass, number>>;
  /** `progressMs` and the default concurrency; the e2e lowers the first (`OMNARR_TEST_LIMITS`). */
  limits?: Limits;
  /** A job failed on a refused write (`EACCES`, `EROFS`): the heartbeat runs the write check again. */
  onWriteFailure?: () => void;
  /** Logs job IDs and classes, never payloads. */
  log: (message: string) => void;
};

export class LeaseRuntime {
  private readonly running = new Map<string, Running>();
  private readonly claiming = new Set<JobClass>();
  private readonly wokenDuringClaim = new Set<JobClass>();
  private readonly classes: JobClass[];
  private unwatch: (() => void) | undefined;
  private stopping = false;

  public constructor(private readonly options: LeaseRuntimeOptions) {
    this.classes = (Object.keys(options.handlers) as JobClass[]).filter((cls) => options.handlers[cls]);
  }

  public start(): void {
    if (this.classes.length === 0) return;
    this.unwatch = this.options.backend.watchQueue(this.classes, (counts) => {
      for (const { class: cls, count } of counts) if (count > 0) void this.pump(cls);
    });
  }

  /** Aborts a job the backend asked to cancel; its handler's end reports `cancelled`. */
  public cancel(jobId: string): void {
    this.running.get(jobId)?.controller.abort('cancelled' satisfies AbortReason);
  }

  /** On SIGTERM: stop claiming, abort running work, release every held job. */
  public async stop(): Promise<void> {
    this.stopping = true;
    this.unwatch?.();
    const held = [...this.running.values()];
    for (const run of held) run.controller.abort('shutdown' satisfies AbortReason);
    await Promise.all(held.map((run) => run.done));
    for (const { job } of held) {
      await this.options.backend.release({ jobId: job.jobId, leaseEpoch: job.leaseEpoch }).catch(() => {});
    }
  }

  private limit(cls: JobClass): number {
    return this.options.concurrency?.[cls] ?? (this.options.limits ?? DEFAULT_LIMITS).concurrency[cls];
  }

  private held(cls: JobClass): number {
    let n = 0;
    for (const run of this.running.values()) if (run.job.class === cls) n++;
    return n;
  }

  /**
   * Claims up to the free slots of a class. One claim per class at a time; a
   * wake-up that arrives during a claim runs another claim after it.
   */
  private async pump(cls: JobClass): Promise<void> {
    if (this.stopping) return;
    if (this.claiming.has(cls)) {
      this.wokenDuringClaim.add(cls);
      return;
    }
    const free = this.limit(cls) - this.held(cls);
    if (free <= 0) return;
    this.claiming.add(cls);
    try {
      const jobs = await this.options.backend.claim({ sessionId: this.options.sessionId, class: cls, max: free });
      for (const job of jobs) this.run(job);
    } catch (error) {
      this.options.log(`claim ${cls} failed: ${workerErrorCode(error) ?? 'error'}`);
    } finally {
      this.claiming.delete(cls);
      if (this.wokenDuringClaim.delete(cls)) void this.pump(cls);
    }
  }

  private run(job: LeasedJob): void {
    const { backend, log } = this.options;
    const lease = { jobId: job.jobId, leaseEpoch: job.leaseEpoch };
    const controller = new AbortController();
    const onRefused = (error: unknown) => {
      if (workerErrorCode(error) === 'staleLease') controller.abort('lostLease' satisfies AbortReason);
    };
    const progress = new ProgressReporter(
      (fraction, detail) => backend.progress({ ...lease, fraction, detail }).catch(onRefused),
      (this.options.limits ?? DEFAULT_LIMITS).progressMs,
    );
    const handler = this.options.handlers[job.class]!;
    log(`job ${job.jobId} (${job.class}) started`);

    const done = (async () => {
      try {
        let result: JobResult;
        try {
          result = await handler(job, { signal: controller.signal, progress: (f, d) => progress.report(f, d) });
          progress.close();
          if (controller.signal.aborted) throw controller.signal.reason;
        } catch (error) {
          progress.close();
          await this.reportFailure(job, controller.signal, error).catch(onRefused);
          return;
        }
        // The handler finished: its result is reported, never turned into a failure (CI run 44461776793).
        await this.settle(() => backend.complete({ ...lease, result }), `complete ${job.jobId}`)
          .then(() => log(`job ${job.jobId} done`))
          .catch((error: unknown) => {
            onRefused(error);
            if (workerErrorCode(error) === 'staleLease') log(`job ${job.jobId} lost its lease; dropped`);
          });
      } finally {
        this.running.delete(job.jobId);
        void this.pump(job.class);
      }
    })();
    this.running.set(job.jobId, { job, controller, progress, done });
  }

  private async reportFailure(job: LeasedJob, signal: AbortSignal, error: unknown): Promise<void> {
    const { backend, log } = this.options;
    const lease = { jobId: job.jobId, leaseEpoch: job.leaseEpoch };
    const reason = signal.aborted ? (signal.reason as AbortReason) : undefined;
    if (workerErrorCode(error) === 'staleLease' || reason === 'lostLease') {
      log(`job ${job.jobId} lost its lease; dropped`);
      return;
    }
    // stop() releases these after every handler has settled.
    if (reason === 'shutdown') return;
    if (reason === 'cancelled') {
      await this.settle(() => backend.fail({ ...lease, failureCode: 'cancelled', detail: 'Cancelled.' }), `fail ${job.jobId}`);
      log(`job ${job.jobId} cancelled`);
      return;
    }
    if (isWriteFailure(error)) this.options.onWriteFailure?.();
    if (error instanceof JobFailure) {
      await this.settle(
        () =>
          backend.fail({
            ...lease,
            failureCode: error.code,
            detail: error.detail,
            ...(error.data ? { data: error.data } : {}),
            ...(error.artifactStorageId ? { artifactStorageId: error.artifactStorageId } : {}),
          }),
        `fail ${job.jobId}`,
      );
      log(`job ${job.jobId} failed: ${error.code}`);
      return;
    }
    // Handlers map every error they expect to a JobFailure (failures.ts).
    // Anything else is a bug; its text may hold a URL, so it isn't reported.
    await this.settle(
      () => backend.fail({ ...lease, failureCode: 'pipelineError', detail: `Unexpected error in the ${job.class} handler.` }),
      `fail ${job.jobId}`,
    );
    log(`job ${job.jobId} failed: unexpected error`);
  }

  /**
   * A job's last call (`complete`, `fail`), tried again while it fails as a server error: a mutation past
   * Convex's time limit changes nothing, so the job's outcome would be lost (CI run 44461776793). A refused
   * call (a ConvexError with a code, such as staleLease) is final and thrown. After the last try the error
   * is thrown too; the lease then expires and the job is claimed again.
   */
  private async settle(call: () => Promise<void>, what: string): Promise<void> {
    for (let attempt = 0; ; attempt++) {
      try {
        return await call();
      } catch (error) {
        if (workerErrorCode(error) !== undefined || attempt >= SETTLE_RETRY_MS.length) throw error;
        this.options.log(`${what} failed, again in ${SETTLE_RETRY_MS[attempt]! / 1000} s: ${(error as Error).message.split('\n').at(-1)}`);
        await new Promise((resolve) => setTimeout(resolve, SETTLE_RETRY_MS[attempt]));
      }
    }
  }
}
