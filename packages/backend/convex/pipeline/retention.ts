// What the platform stops keeping: expired candidates (hourly), and the
// jobs and workflow records of Grabs finished more than 30 days ago, then
// play reports older than 90 days (daily), then the relay's `indexer` jobs
// an action left behind (daily). All delete in pages. The Grab, its events
// and its kept candidates stay: the timeline reads them. Artifacts (ffmpeg
// logs, support bundles) get their TTL with their producers.
import { DEFAULT_LIMITS } from '@omnarr/contracts';
import { v } from 'convex/values';

import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import { internalMutation, type MutationCtx } from '../_generated/server';
import { cancelJob } from '../jobs/queue';
import { runPublishJobs } from './steps';
import { workflow } from './workflow';

const PAGE = 200;

/** Candidates past `expiresAt`. Those of an attempt that led to a Grab have none. */
export const expireCandidates = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const now = Date.now();
    // An absent `expiresAt` sorts first in the index, so the range starts above it.
    const expired = await ctx.db
      .query('candidates')
      .withIndex('by_expires_at', (q) => q.gt('expiresAt', 0).lt('expiresAt', now))
      .take(PAGE);
    for (const row of expired) await ctx.db.delete(row._id);
    if (expired.length === PAGE) await ctx.scheduler.runAfter(0, internal.pipeline.retention.expireCandidates, {});
    return null;
  },
});

/** When a Grab's run ended: its last event. */
async function endedAt(ctx: MutationCtx, grab: Doc<'grabs'>): Promise<number> {
  const last = await ctx.db
    .query('events')
    .withIndex('by_grab_at', (q) => q.eq('grabId', grab._id))
    .order('desc')
    .first();
  return last?.at ?? grab._creationTime;
}

export const ended = (job: Doc<'jobs'> | null): job is Doc<'jobs'> =>
  job !== null && (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled');

/** Deletes the job with its progress, whatever its status. */
export async function deleteJobRow(ctx: MutationCtx, job: Doc<'jobs'>): Promise<void> {
  for (const row of await ctx.db
    .query('jobProgress')
    .withIndex('by_job', (q) => q.eq('jobId', job._id))
    .collect())
    await ctx.db.delete(row._id);
  await ctx.db.delete(job._id);
}

/** Deletes the job with its progress if it has ended, and says whether it is gone (also when there was none). */
export async function deleteEndedJob(ctx: MutationCtx, job: Doc<'jobs'> | null): Promise<boolean> {
  if (job === null) return true;
  if (!ended(job)) return false;
  await deleteJobRow(ctx, job);
  return true;
}

/** The jobs with this key (a key names one job). */
export const jobsByKey = (ctx: MutationCtx, idempotencyKey: string) =>
  ctx.db
    .query('jobs')
    .withIndex('by_idempotency_key', (q) => q.eq('idempotencyKey', idempotencyKey))
    .collect();

async function deleteJob(ctx: MutationCtx, idempotencyKey: string): Promise<void> {
  for (const job of await jobsByKey(ctx, idempotencyKey)) await deleteEndedJob(ctx, job);
}

/** The run's publish job is keyed by its Publications, so it is found through them. */
async function deletePublishJobs(ctx: MutationCtx, grab: Doc<'grabs'>): Promise<void> {
  for (const job of await runPublishJobs(ctx, grab._id)) await deleteEndedJob(ctx, job);
}

/**
 * A finished Grab's jobs (its run jobs and the maintenance it enqueued) and
 * its workflow records go after 30 days. `workflowId` is cleared with them,
 * so the next run of this cron skips the Grab.
 */
export const cleanUpRuns = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const cutoff = Date.now() - DEFAULT_LIMITS.jobRetentionMs;
    let cleaned = 0;
    for (const state of ['done', 'failed', 'cancelled'] as const) {
      const grabs = await ctx.db
        .query('grabs')
        .withIndex('by_state', (q) => q.eq('state', state))
        .filter((q) => q.neq(q.field('workflowId'), undefined))
        .take(PAGE);
      for (const grab of grabs) {
        if ((await endedAt(ctx, grab)) > cutoff) continue;
        for (const cls of ['download.submit', 'import']) await deleteJob(ctx, `${grab._id}:${cls}`);
        await deletePublishJobs(ctx, grab);
        await deleteJob(ctx, `cleanStaging:${grab._id}`);
        for (const download of await ctx.db
          .query('downloads')
          .withIndex('by_grab', (q) => q.eq('grabId', grab._id))
          .collect())
          await deleteJob(ctx, `removeDownload:${download._id}`);
        await workflow.cleanup(ctx, grab.workflowId!);
        await ctx.db.patch(grab._id, { workflowId: undefined });
        cleaned++;
      }
    }
    if (cleaned === PAGE) await ctx.scheduler.runAfter(0, internal.pipeline.retention.cleanUpRuns, {});
    // The daily run's last page goes on to the play reports.
    else await ctx.scheduler.runAfter(0, internal.pipeline.retention.expirePlaybackReports, {});
    return null;
  },
});

/** Play reports that started more than 90 days ago, in pages. */
export const expirePlaybackReports = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const cutoff = Date.now() - DEFAULT_LIMITS.playbackReportTtlMs;
    const expired = await ctx.db
      .query('playbackReports')
      .withIndex('by_started', (q) => q.lt('startedAt', cutoff))
      .take(PAGE);
    for (const row of expired) await ctx.db.delete(row._id);
    if (expired.length === PAGE) await ctx.scheduler.runAfter(0, internal.pipeline.retention.expirePlaybackReports, {});
    // The daily run's last step: relay jobs no action is waiting on.
    else await ctx.scheduler.runAfter(0, internal.pipeline.retention.cleanUpRelayJobs, {});
    return null;
  },
});

/**
 * The relay deletes its `indexer` job once it has read the answer, or
 * cancels it after 90 s. An action that died in between leaves the
 * job behind, so one older than an hour has no reader: an ended or unclaimed
 * one is deleted, a leased one is cancelled and goes on a later run, once
 * its lease ends.
 *
 * An ended job can hold a whole result page (`indexerOutcome`), so those are
 * read in smaller pages: 200 of them could pass Convex's read limit, and the
 * run would then fail every day.
 */
const ENDED_RELAY_PAGE = 50;

export const cleanUpRelayJobs = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const cutoff = Date.now() - DEFAULT_LIMITS.relayJobAbandonedMs;
    let full = false;
    for (const status of ['queued', 'waiting', 'leased', 'done', 'failed', 'cancelled'] as const) {
      const page = status === 'queued' || status === 'waiting' || status === 'leased' ? PAGE : ENDED_RELAY_PAGE;
      const jobs = await ctx.db
        .query('jobs')
        .withIndex('by_status_class', (q) => q.eq('status', status).eq('class', 'indexer').lt('_creationTime', cutoff))
        .take(page);
      for (const job of jobs) {
        if (status !== 'leased') await ctx.db.delete(job._id);
        else if (!job.cancelRequested) await cancelJob(ctx, job._id);
      }
      // Leased jobs stay until their lease ends, so they never ask for another page.
      if (jobs.length === page && status !== 'leased') full = true;
    }
    if (full) await ctx.scheduler.runAfter(0, internal.pipeline.retention.cleanUpRelayJobs, {});
    return null;
  },
});
