// The job table: enqueue (with the entity row a job serves), the reactive
// queue the worker subscribes to, leased claims with epoch fencing,
// backoff, the per-class results (results.ts) and supervision.
import { sendEvent, vWorkflowId } from '@dev-marzahn/convex-workflow-migrations';
import {
  Ack,
  backoff,
  ClaimRequest,
  ClaimResponse,
  CompleteRequest,
  DEFAULT_LIMITS,
  FailRequest,
  type FailureCode,
  type FailureData,
  type JobClass,
  jobEventName,
  JobPayload,
  type JobEventValue,
  type LeasedJob,
  ProgressRequest,
  PROTOCOL_VERSION,
  QUEUE_COUNT_CAP,
  QueueCounts,
  QueueRequest,
  ReleaseRequest,
  retryPolicy,
} from '@omnarr/contracts';
import { zodToConvex } from 'convex-helpers/server/zod4';
import { type ObjectType, v } from 'convex/values';

import { components, internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { internalMutation, type MutationCtx, type QueryCtx } from '../_generated/server';
import { applySetupFailure, blockFromPublish, isSetupJob, serverRow, stepOfProgress } from '../jellyfin/setup';
import { workerError, workerMutation, workerQuery } from '../lib/functions';
import { raiseIssue, resolveSystemIssue } from '../lib/issues';
import { limits } from '../lib/limits';
import { endPauses } from '../pipeline/grabs';
import { isPasswordPush, pushesOf, pushKeyPrefix, releaseHeldPush } from './passwordPushes';
import { applyEnd, applyResult } from './results';
import { acceptedSession } from './worker';

const enqueueArgs = {
  payload: zodToConvex(JobPayload),
  /** `${grabId}:${class}` for run jobs, `${renditionId}:prepare`, `${action}:${subjectId}` for maintenance. */
  idempotencyKey: v.string(),
  grabId: v.optional(v.id('grabs')),
  renditionId: v.optional(v.id('renditions')),
  /** Set when a run awaits the job's event. */
  workflowId: v.optional(vWorkflowId),
  /** Claim order within the class, lowest first; only prepare jobs set it. */
  priority: v.optional(v.number()),
};
export type Enqueue = ObjectType<typeof enqueueArgs>;

/**
 * An absent `priority` reads as 0. Convex sorts a missing field before
 * every number, so a stored 0 would sort after every job without one; 0 is
 * therefore stored as absent, and within one priority the index's creation
 * order keeps the oldest first. Priorities are never negative.
 */
const storedPriority = (priority: number | undefined) => ({ priority: priority || undefined });

/**
 * Inserts a job, or returns the one that already has this idempotency key.
 * `status` is `queued` unless the caller holds the job (`waiting` with no
 * `availableAt`, the password-push hold).
 */
export async function enqueueJob(ctx: MutationCtx, job: Enqueue, status: 'queued' | 'waiting' = 'queued'): Promise<Id<'jobs'>> {
  const existing = await ctx.db
    .query('jobs')
    .withIndex('by_idempotency_key', (q) => q.eq('idempotencyKey', job.idempotencyKey))
    .first();
  if (existing) return existing._id;
  const cls = job.payload.class;
  return await ctx.db.insert('jobs', {
    ...job,
    ...storedPriority(job.priority),
    class: cls,
    status,
    attempt: 0,
    maxAttempts: DEFAULT_LIMITS.maxAttempts[cls],
    leaseEpoch: 0,
    protocolVersion: PROTOCOL_VERSION,
    cancelRequested: false,
  });
}

/**
 * Inserts a job together with the entity row it serves: the row
 * needs the job's ID and the payload the row's, so the job is inserted
 * first, `build` inserts the row, and the payload is patched on, in one
 * mutation. An existing job with the key is returned as it is.
 */
export async function enqueueWith(
  ctx: MutationCtx,
  job: Omit<Enqueue, 'payload'> & { class: JobPayload['class'] },
  build: (jobId: Id<'jobs'>) => Promise<JobPayload>,
): Promise<{ jobId: Id<'jobs'>; created: boolean }> {
  const existing = await ctx.db
    .query('jobs')
    .withIndex('by_idempotency_key', (q) => q.eq('idempotencyKey', job.idempotencyKey))
    .first();
  if (existing) return { jobId: existing._id, created: false };
  const { class: cls, ...fields } = job;
  const jobId = await ctx.db.insert('jobs', {
    ...fields,
    ...storedPriority(fields.priority),
    class: cls,
    status: 'queued',
    attempt: 0,
    maxAttempts: DEFAULT_LIMITS.maxAttempts[cls],
    leaseEpoch: 0,
    protocolVersion: PROTOCOL_VERSION,
    cancelRequested: false,
  });
  await ctx.db.patch(jobId, { payload: await build(jobId) });
  return { jobId, created: true };
}

export const enqueue = internalMutation({
  args: enqueueArgs,
  returns: v.id('jobs'),
  handler: (ctx, args) => enqueueJob(ctx, args),
});

/**
 * A password change pushed to Jellyfin. Each change is
 * its own job: the subject of the idempotency key is the change, numbered per
 * user. Earlier pushes no worker has picked up are cancelled; a leased one is
 * asked to cancel. While one is leased, the new push is held (`waiting`, no
 * `availableAt`) until it ends, so an older password never lands after a
 * newer one.
 */
export async function enqueuePasswordPushJob(
  ctx: MutationCtx,
  { userId, username, newPassword }: { userId: string; username: string; newPassword: string },
): Promise<Id<'jobs'>> {
  const earlier = await pushesOf(ctx, userId);
  let leased = false;
  for (const job of earlier) {
    if (job.status === 'queued' || job.status === 'waiting') await finishJob(ctx, job, 'cancelled');
    else if (job.status === 'leased') {
      leased = true;
      await ctx.db.patch(job._id, { cancelRequested: true });
    }
  }
  return await enqueueJob(
    ctx,
    { payload: { class: 'maintenance', action: 'pushJellyfinPassword', username, newPassword }, idempotencyKey: `${pushKeyPrefix(userId)}${earlier.length}` },
    leased ? 'waiting' : 'queued',
  );
}

export const enqueuePasswordPush = internalMutation({
  args: { userId: v.string(), username: v.string(), newPassword: v.string() },
  returns: v.id('jobs'),
  handler: (ctx, args) => enqueuePasswordPushJob(ctx, args),
});

/** Each class's queued jobs, counted up to the cap through the index: never more than the cap per class is read (queryCost.test.ts). */
export const queueCounts = (ctx: QueryCtx, classes: JobClass[]) =>
  Promise.all(
    classes.map(async (cls) => {
      const queued = await ctx.db
        .query('jobs')
        .withIndex('by_status_class_priority', (q) => q.eq('status', 'queued').eq('class', cls))
        .take(QUEUE_COUNT_CAP);
      return { class: cls, count: queued.length };
    }),
  );

export const queue = workerQuery({
  args: QueueRequest.shape,
  returns: QueueCounts,
  handler: (ctx, { classes }) => queueCounts(ctx, classes),
});

export const claim = workerMutation({
  args: ClaimRequest.shape,
  returns: ClaimResponse,
  handler: async (ctx, { sessionId, class: cls, max }) => {
    await acceptedSession(ctx, sessionId);
    // Lowest priority first, oldest first within one.
    const queued = await ctx.db
      .query('jobs')
      .withIndex('by_status_class_priority', (q) => q.eq('status', 'queued').eq('class', cls))
      .take(max);
    const leaseExpiresAt = Date.now() + limits().leaseMs;
    const leased: LeasedJob[] = [];
    for (const job of queued) {
      // A queued job always has its payload; it's cleared only when the job ends.
      if (!job.payload) continue;
      if (await staleRename(ctx, job.payload)) {
        await finishJob(ctx, job, 'cancelled');
        continue;
      }
      const leaseEpoch = job.leaseEpoch + 1;
      await ctx.db.patch(job._id, { status: 'leased', leaseOwner: sessionId, leaseEpoch, leaseExpiresAt });
      leased.push({ jobId: job._id, class: job.class, leaseEpoch, payload: job.payload });
    }
    return leased;
  },
});

/**
 * A `renameLibraryFile` whose file was replaced or deleted since it was
 * queued: the row is gone, or no longer at the rename's `from`
 * (moved to originals/, restored, renamed). It is dropped at the claim, so
 * no worker renames another file that now sits at `from`.
 */
async function staleRename(ctx: QueryCtx, payload: JobPayload): Promise<boolean> {
  if (payload.class !== 'maintenance' || payload.action !== 'renameLibraryFile') return false;
  const file = await ctx.db.get(payload.fileId);
  return file?.path !== payload.from;
}

/** The job a fenced call names, if it still holds that lease. */
export async function fenced(ctx: MutationCtx, jobId: Id<'jobs'>, leaseEpoch: number): Promise<Doc<'jobs'>> {
  const job = await ctx.db.get(jobId);
  if (!job || job.status !== 'leased' || job.leaseEpoch !== leaseEpoch) throw workerError('staleLease');
  return job;
}

const noLease = { leaseOwner: undefined, leaseExpiresAt: undefined } as const;

async function deleteProgress(ctx: MutationCtx, jobId: Id<'jobs'>): Promise<void> {
  const rows = await ctx.db
    .query('jobProgress')
    .withIndex('by_job', (q) => q.eq('jobId', jobId))
    .collect();
  for (const row of rows) await ctx.db.delete(row._id);
}

/**
 * Ends a job: clears its payload and progress, and sends its event to the
 * run that awaits it. Each job's event is sent once, here.
 */
async function finishJob(
  ctx: MutationCtx,
  job: Doc<'jobs'>,
  outcome: JobEventValue['outcome'],
  failure?: { code: FailureCode; lastError: string; data?: FailureData },
): Promise<void> {
  if (outcome !== 'done') await applyEnd(ctx, job, outcome, failure?.code, failure?.lastError);
  // A terminal setup failure blocks publishing, at the step the job last reported if it sent none.
  if (outcome === 'failed' && failure && isSetupJob(job)) {
    const progress = await ctx.db
      .query('jobProgress')
      .withIndex('by_job', (q) => q.eq('jobId', job._id))
      .first();
    await applySetupFailure(ctx, job, failure.code, failure.data, stepOfProgress(progress?.detail));
  }
  await ctx.db.patch(job._id, {
    status: outcome,
    payload: undefined,
    ...noLease,
    failureCode: failure?.code,
    lastError: failure?.lastError,
    availableAt: undefined,
  });
  await deleteProgress(ctx, job._id);
  // A leased push's end releases the user's held push; a push that can't land raises its Issue.
  await releaseHeldPush(ctx, job);
  if (outcome === 'failed' && isPasswordPush(job)) await raiseIssue(ctx, { code: 'jellyfinPasswordNotPushed', jobId: job._id, detail: failure?.lastError });
  if (job.workflowId) {
    const value: JobEventValue = { outcome, jobId: job._id, failureCode: failure?.code };
    await sendEvent(ctx, components.workflow, { workflowId: job.workflowId, name: jobEventName(job._id), value });
  }
}

/**
 * Cancels a job: one no worker holds ends now, with its event; a
 * leased one is asked to stop at the worker's next heartbeat, or by
 * supervision when its lease expires. Returns whether the job was still live.
 */
export async function cancelJob(ctx: MutationCtx, jobId: Id<'jobs'>): Promise<boolean> {
  const job = await ctx.db.get(jobId);
  if (!job) return false;
  if (job.status === 'queued' || job.status === 'waiting') await finishJob(ctx, job, 'cancelled');
  else if (job.status === 'leased') await ctx.db.patch(jobId, { cancelRequested: true });
  else return false;
  return true;
}

/** Puts a job back to `waiting` until `availableAt`, when `wake` queues it again. */
async function wait(ctx: MutationCtx, job: Doc<'jobs'>, patch: { availableAt: number; attempt: number; failureCode: FailureCode; lastError: string }) {
  await ctx.db.patch(job._id, { status: 'waiting', ...noLease, ...patch });
  // A query doesn't re-run as time passes, so the wake has to be scheduled.
  await ctx.scheduler.runAt(patch.availableAt, internal.jobs.queue.wake, { jobId: job._id });
}

export const progress = workerMutation({
  args: ProgressRequest.shape,
  returns: Ack,
  handler: async (ctx, { jobId, leaseEpoch, fraction, detail }) => {
    await fenced(ctx, jobId, leaseEpoch);
    const row = await ctx.db
      .query('jobProgress')
      .withIndex('by_job', (q) => q.eq('jobId', jobId))
      .first();
    const update = { fraction, detail, updatedAt: Date.now() };
    if (row) await ctx.db.patch(row._id, update);
    else await ctx.db.insert('jobProgress', { jobId, ...update });
    return null;
  },
});

export const complete = workerMutation({
  args: CompleteRequest.shape,
  returns: Ack,
  handler: async (ctx, { jobId, leaseEpoch, result }) => {
    const job = await fenced(ctx, jobId, leaseEpoch);
    const action = job.payload?.class === 'maintenance' ? job.payload.action : undefined;
    if (result.class !== job.class || (result.class === 'maintenance' && result.action !== action)) {
      throw workerError('invalidResult', { expected: action ? `${job.class}/${action}` : job.class });
    }
    await applyResult(ctx, job, result);
    // These jobs check free space first, so their success is the pass that found space.
    if (job.class === 'download.submit' || job.class === 'prepare') await resolveSystemIssue(ctx, 'diskFull');
    await finishJob(ctx, job, 'done');
    return null;
  },
});

const RUN_JOB_CLASSES = new Set<Doc<'jobs'>['class']>(['download.submit', 'import', 'publish']);

/** A failed attempt, as the `fail` hooks see it; `data` only for the jobs that send it. */
type Failure = { job: Doc<'jobs'>; code: FailureCode; detail: string; data?: FailureData };

/**
 * A run job that fails with a retryable code (any policy but
 * `terminal`) while its Grab has `cancelRequested` isn't retried: it ends
 * `cancelled` with its event, and `onRunComplete` ends the Grab cancelled.
 * A terminal code takes its usual path, which ends the run the same way.
 * Only run jobs: the clean-up a cancel enqueues (its `removeDownload`)
 * carries the Grab too, and must be retried.
 */
async function cancelledGrab(ctx: MutationCtx, { job, code }: Failure): Promise<boolean> {
  // With the job's class: a publish's `jellyfinSetupWait` is retryable, so a cancelled Grab's publish doesn't wait.
  if (retryPolicy(code, job.class) === 'terminal' || !job.grabId || !job.workflowId || !RUN_JOB_CLASSES.has(job.class)) return false;
  const grab = await ctx.db.get(job.grabId);
  const cancelledOrDeleted = grab === null || grab.cancelRequested;
  if (!cancelledOrDeleted) return false;
  await finishJob(ctx, job, 'cancelled');
  return true;
}

/**
 * The hooks `fail` runs in order before the retry policy; the first that
 * handles the failure ends it. The cancelled-Grab check is first,
 * before the Jellyfin ones.
 */
/** A superseded password push that fails with a retryable code ends `cancelled`, so it is never retried. */
async function supersededPush(ctx: MutationCtx, { job, code }: Failure): Promise<boolean> {
  if (retryPolicy(code, job.class) === 'terminal' || !job.cancelRequested || !isPasswordPush(job)) return false;
  await finishJob(ctx, job, 'cancelled');
  return true;
}

/**
 * A publish waits for Jellyfin's setup, counting no attempt; a successful setup wakes it.
 * Failed without a reason while setup is already done, it ran on the worker's connection from before
 * setup, which the setup's wake came too early for: it tries again after the backoff, still counting none.
 */
async function setupWait(ctx: MutationCtx, { job, code, detail, data }: Failure): Promise<boolean> {
  if (retryPolicy(code, job.class) !== 'jellyfinSetupWait') return false;
  const staleConnection = !data && (await serverRow(ctx))?.state === 'ready';
  const waitMs = staleConnection ? limits().backoffBaseMs : DEFAULT_LIMITS.jellyfinSetupRetryMs;
  await wait(ctx, job, { availableAt: Date.now() + waitMs, attempt: job.attempt, failureCode: code, lastError: detail });
  if (data) await blockFromPublish(ctx, data);
  return true;
}

// The Jellyfin terminal ends (applySetupFailure, jellyfinPasswordNotPushed) run in finishJob, for a terminal fail and an expired lease alike.
const FAIL_HOOKS: ((ctx: MutationCtx, failure: Failure) => Promise<boolean>)[] = [cancelledGrab, supersededPush, setupWait];

export const fail = workerMutation({
  args: FailRequest.shape,
  returns: Ack,
  handler: async (ctx, { jobId, leaseEpoch, failureCode, detail, data: sent, artifactStorageId }) => {
    const leased = await fenced(ctx, jobId, leaseEpoch);
    // The attempt's artifact, such as a failed prepare's ffmpeg log, on the job the hooks and applyEnd see; ttl.artifacts deletes it after 14 days.
    if (artifactStorageId) await ctx.db.patch(jobId, { artifactStorageId });
    const job = artifactStorageId ? { ...leased, artifactStorageId } : leased;
    // The Jellyfin reason is read only for the jobs that send it.
    const data = job.class === 'publish' || isSetupJob(job) ? sent : undefined;
    if (failureCode === 'cancelled') {
      await finishJob(ctx, job, 'cancelled');
      return null;
    }
    for (const hook of FAIL_HOOKS) if (await hook(ctx, { job, code: failureCode, detail, ...(data ? { data } : {}) })) return null;
    const now = Date.now();
    const current = limits();
    const policy = retryPolicy(failureCode, job.class);
    if (policy === 'diskWait') {
      // Disk space is checked again in 30 minutes; the wait counts no attempt.
      await wait(ctx, job, { availableAt: now + DEFAULT_LIMITS.diskFullRetryMs, attempt: job.attempt, failureCode, lastError: detail });
      await raiseIssue(ctx, { code: 'diskFull', jobId, detail });
      return null;
    }
    if (policy === 'vpnWait') {
      // A torrent submit waits for the VPN without counting an attempt; `vpnDown` is raised by
      // downloadClients.report, and the transition to `up` wakes it sooner.
      await wait(ctx, job, { availableAt: now + current.vpnWaitRetryMs, attempt: job.attempt, failureCode, lastError: detail });
      return null;
    }
    const attempt = job.attempt + 1;
    if (policy === 'backoff' && attempt < job.maxAttempts) {
      await wait(ctx, job, { availableAt: now + backoff(attempt, Math.random, current), attempt, failureCode, lastError: detail });
      return null;
    }
    await ctx.db.patch(jobId, { attempt: policy === 'backoff' ? attempt : job.attempt });
    await finishJob(ctx, job, 'failed', { code: failureCode, lastError: detail, ...(data ? { data } : {}) });
    return null;
  },
});

export const release = workerMutation({
  args: ReleaseRequest.shape,
  returns: Ack,
  handler: async (ctx, { jobId, leaseEpoch }) => {
    await fenced(ctx, jobId, leaseEpoch);
    await ctx.db.patch(jobId, { status: 'queued', ...noLease });
    return null;
  },
});

export const wake = internalMutation({
  args: { jobId: v.id('jobs') },
  returns: v.null(),
  handler: async (ctx, { jobId }) => {
    const job = await ctx.db.get(jobId);
    if (job?.status === 'waiting') await ctx.db.patch(jobId, { status: 'queued', availableAt: undefined });
    return null;
  },
});

const SUPERVISE_PAGE = 100;

/**
 * Run by the supervision cron every 30 s (crons.ts): returns jobs whose
 * lease expired to the queue, counting one attempt (or cancels them when a
 * cancel was asked), checks that a worker was seen in the last 60 s, and
 * ends the pauses that are over.
 */
export const supervise = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    const expired = await ctx.db
      .query('jobs')
      .withIndex('by_lease_expiry', (q) => q.eq('status', 'leased').lt('leaseExpiresAt', now))
      .take(SUPERVISE_PAGE);
    for (const job of expired) {
      const attempt = job.attempt + 1;
      if (job.cancelRequested) {
        // The worker never heard of the cancel: it ends here instead of going back to the queue.
        await finishJob(ctx, job, 'cancelled');
      } else if (attempt >= job.maxAttempts) {
        await ctx.db.patch(job._id, { attempt });
        await finishJob(ctx, job, 'failed', { code: 'leaseExpired', lastError: 'The worker stopped renewing its lease.' });
      } else {
        await ctx.db.patch(job._id, { status: 'queued', attempt, ...noLease });
      }
    }
    if (expired.length === SUPERVISE_PAGE) await ctx.scheduler.runAfter(0, internal.jobs.queue.supervise, {});

    const live = await ctx.db
      .query('workerSessions')
      .withIndex('by_last_seen', (q) => q.gt('lastSeenAt', now - DEFAULT_LIMITS.livenessMs))
      .filter((q) => q.eq(q.field('accepted'), true))
      .first();
    const mismatch = await ctx.db
      .query('issues')
      .withIndex('by_state_scope', (q) => q.eq('state', 'open').eq('scope', 'system'))
      .filter((q) => q.eq(q.field('failureCode'), 'protocolMismatch'))
      .first();
    if (live) {
      await resolveSystemIssue(ctx, 'workerOffline');
    } else if (!mismatch) {
      // While the version mismatch is open, it is the one banner.
      await raiseIssue(ctx, { code: 'workerOffline', detail: 'No worker has been seen for 60 seconds.' });
    }
    await endPauses(ctx);
    return null;
  },
});
