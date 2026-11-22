// Grabs: startGrab inserts the Grab and starts its run in
// one mutation; onRunComplete classifies how the run ended; cancelGrab ends a
// run wherever it waits; onRunPaused and endPauses track runs that can't
// replay.
import { type PauseInfo, sendEvent, vResultValidator, vWorkflowId } from '@dev-marzahn/convex-workflow-migrations';
import { DEFAULT_LIMITS, downloadEventName, FAILURE_CLASS, type FailureCode, type JobEventValue, PipelineRunResult, raiseRule } from '@omnarr/contracts';
import { v } from 'convex/values';

import { components, internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { internalMutation, type MutationCtx } from '../_generated/server';
import { cancelJob } from '../jobs/queue';
import { unknownFailureDetail } from '../jobs/results';
import { recomputeUnits } from '../lib/derivedState';
import { appendEvent } from '../lib/events';
import { raiseIssue, resolveIssuesForGrab } from '../lib/issues';
import { transition, unitsOfGrab } from '../lib/stateMachine';
import { addToBlocklist } from './blocklist';
import { cleanStaging, removeDownloads } from './cleanup';
import { runPublishJobs } from './steps';
import { playablePrimary } from './upgrades';
import { workflow } from './workflow';

/**
 * Starts a Grab for a picked candidate's covered Units: the Grab
 * (`submitting`), its `grabUnits`, `activeGrabId` on the Units, and its run,
 * whose ID is patched onto the Grab in the same mutation. The attempt's
 * candidates no longer expire: they explain the Grab.
 *
 * A manual grab or a retry of one names its Units (`unitIds`, the
 * attempt's for a release of unclear numbering) and the Unit its file is
 * imported as (`importAs`).
 */
export async function startGrab(
  ctx: MutationCtx,
  candidateId: Id<'candidates'>,
  options: { unitIds?: Id<'units'>[]; importAs?: Id<'units'>[]; message?: string } = {},
): Promise<Id<'grabs'>> {
  const found = (await ctx.db.get(candidateId))!;
  const named = options.unitIds ?? found.unitIds;
  // The pack's other Units that don't play yet, and no other Grab holds, are the Grab's too, so its file is linked to them.
  const also: Id<'units'>[] = [];
  for (const unitId of found.alsoContainsUnitIds) {
    if (named.includes(unitId) || (await ctx.db.get(unitId))?.activeGrabId !== undefined) continue;
    if (!(await playablePrimary(ctx, unitId))) also.push(unitId);
  }
  const candidate = { ...found, unitIds: [...named, ...also] };
  if (candidate.expiresAt !== undefined) {
    const rows = await ctx.db
      .query('candidates')
      .withIndex('by_attempt', (q) => q.eq('searchAttemptId', candidate.searchAttemptId))
      .collect();
    for (const row of rows) if (row.expiresAt !== undefined) await ctx.db.patch(row._id, { expiresAt: undefined });
  }
  // A Grab for Units that already play replaces their file: an upgrade, whoever picked it.
  let kind: 'initial' | 'upgrade' = 'initial';
  for (const unitId of candidate.unitIds) if (await playablePrimary(ctx, unitId)) kind = 'upgrade';
  const grabId = await ctx.db.insert('grabs', {
    candidateId,
    protocol: candidate.protocol,
    kind,
    state: 'submitting',
    cancelRequested: false,
    ...(options.importAs ? { importAs: options.importAs } : {}),
  });
  for (const unitId of candidate.unitIds) {
    await ctx.db.insert('grabUnits', { grabId, unitId, outcome: 'pending' });
    await ctx.db.patch(unitId, { activeGrabId: grabId });
  }
  const workflowId = await workflow.start(
    ctx,
    internal.pipeline.workflow.pipelineRun,
    { grabId },
    { onComplete: internal.pipeline.grabs.onRunComplete, context: { grabId } },
  );
  await ctx.db.patch(grabId, { workflowId });
  await appendEvent(ctx, {
    grabId,
    stage: 'grab',
    kind: 'stageStarted',
    message: options.message ?? `Grabbed ${candidate.title}.`,
    data: { entity: 'grab', entityId: grabId, to: 'submitting' },
  });
  await recomputeUnits(ctx, candidate.unitIds);
  return grabId;
}

const FINAL = new Set(['done', 'failed', 'cancelled']);

/**
 * Ends a Grab that didn't succeed: its final state, its pending Units marked
 * failed (cancelled ones too: the bad-release limit counts only failed
 * runs, so a cancel's rows are `skipped`), and the Units freed.
 */
async function endGrab(
  ctx: MutationCtx,
  grab: Doc<'grabs'>,
  to: 'failed' | 'cancelled',
  message: string,
  failureCode?: FailureCode,
): Promise<Doc<'grabUnits'>[]> {
  if (failureCode) await ctx.db.patch(grab._id, { failureCode });
  await transition(ctx, 'grab', grab._id, to, { kind: to === 'cancelled' ? 'cancelled' : 'stageFailed', message, ...(failureCode ? { failureCode } : {}) });
  const rows = await ctx.db
    .query('grabUnits')
    .withIndex('by_grab', (q) => q.eq('grabId', grab._id))
    .collect();
  for (const row of rows) {
    if (row.outcome === 'pending') await ctx.db.patch(row._id, { outcome: to === 'failed' ? 'failed' : 'skipped' });
    const unit = await ctx.db.get(row.unitId);
    if (unit?.activeGrabId === grab._id) await ctx.db.patch(row.unitId, { activeGrabId: undefined });
  }
  return rows;
}

/** The Grab's Work, through its candidate's attempt. */
async function workOf(ctx: MutationCtx, grab: Doc<'grabs'>): Promise<{ candidate: Doc<'candidates'>; workId: Id<'works'> }> {
  const candidate = (await ctx.db.get(grab.candidateId))!;
  const attempt = (await ctx.db.get(candidate.searchAttemptId))!;
  return { candidate, workId: attempt.workId };
}

/**
 * Removes what a run left in the client and in staging: the
 * download, with its data, by a `maintenance` job, and the import's staging
 * folder.
 */
async function cleanUp(ctx: MutationCtx, grabId: Id<'grabs'>): Promise<void> {
  await removeDownloads(ctx, grabId);
  await cleanStaging(ctx, grabId);
}

/** Whether a failed Grab is left out of the bad-release limit: the user picked its release, or it was an upgrade. */
async function notCounted(ctx: MutationCtx, grabId: Id<'grabs'>): Promise<boolean> {
  const grab = await ctx.db.get(grabId);
  const candidate = grab && (await ctx.db.get(grab.candidateId));
  return candidate?.pickedBy === 'user' || grab?.kind === 'upgrade';
}

/** The Unit's failed Grabs since its last import (the bad-release limit); user-picked releases and upgrades don't count. */
async function failedGrabsSinceImport(ctx: MutationCtx, unitId: Id<'units'>): Promise<number> {
  const rows = await ctx.db
    .query('grabUnits')
    .withIndex('by_unit', (q) => q.eq('unitId', unitId))
    .order('desc')
    .collect();
  let failed = 0;
  for (const row of rows) {
    if (row.outcome === 'imported') break;
    if (row.outcome === 'failed' && !(await notCounted(ctx, row.grabId))) failed++;
  }
  return failed;
}

/** A cancelled run: the download and staging removed, the release blocklisted if asked, the run's pause and error Issues resolved. */
async function cancelled(ctx: MutationCtx, grab: Doc<'grabs'>): Promise<void> {
  const rows = await endGrab(ctx, grab, 'cancelled', 'The grab was cancelled.');
  await cleanUp(ctx, grab._id);
  if (grab.cancelBlocklist) {
    const { candidate, workId } = await workOf(ctx, grab);
    await addToBlocklist(ctx, { workId, item: candidate, reason: 'manual', grabId: grab._id });
    await appendEvent(ctx, { grabId: grab._id, stage: 'grab', kind: 'blocklisted', message: `Blocklisted ${candidate.title}.` });
  }
  await resolveIssuesForGrab(ctx, grab._id, ['workflowPaused', 'pipelineError']);
  await recomputeUnits(
    ctx,
    rows.map((row) => row.unitId),
  );
}

/** The Issue detail of an `unknownClientFailure`: the failed Download's raw client status. */
async function unknownDetailOf(ctx: MutationCtx, grabId: Id<'grabs'>): Promise<string | undefined> {
  const download = await ctx.db
    .query('downloads')
    .withIndex('by_grab', (q) => q.eq('grabId', grabId))
    .filter((q) => q.eq(q.field('state'), 'failed'))
    .first();
  return download ? unknownFailureDetail(download) : undefined;
}

/**
 * A failed run: a bad release is blocklisted and its download removed; under
 * the 3-Grab limit a next-best search starts a new Grab, at the limit the
 * failure is raised. Any other class is raised when `raiseRule` says so.
 */
async function failed(ctx: MutationCtx, grab: Doc<'grabs'>, code: FailureCode, why?: string): Promise<void> {
  const rows = await endGrab(ctx, grab, 'failed', 'The run failed.', code);
  // A failure after import (publish) concerns the imported Units too; skipped ones are out of the Grab.
  const unitIds = rows.filter((row) => row.outcome !== 'skipped').map((row) => row.unitId);
  if (FAILURE_CLASS[code] === 'badRelease') {
    const { candidate, workId } = await workOf(ctx, grab);
    await addToBlocklist(ctx, { workId, item: candidate, reason: code, grabId: grab._id });
    await appendEvent(ctx, { grabId: grab._id, stage: 'grab', kind: 'blocklisted', message: `Blocklisted ${candidate.title}.`, data: { failureCode: code } });
    await cleanUp(ctx, grab._id);
    // The user picked it, and decides what to try next: no next-best, no Issue, not counted.
    // An upgrade's bad release gets no next-best either: the next RSS item or weekly search tries again.
    if (candidate.pickedBy === 'user' || grab.kind === 'upgrade') {
      const why = candidate.pickedBy === 'user' ? 'you picked this release' : 'an upgrade waits for the next RSS item or upgrade search';
      await appendEvent(ctx, { grabId: grab._id, stage: 'grab', kind: 'decision', message: `No next-best search: ${why}.` });
      await recomputeUnits(
        ctx,
        rows.map((row) => row.unitId),
      );
      return;
    }
    const retry: Id<'units'>[] = [];
    for (const unitId of unitIds) {
      const unit = await ctx.db.get(unitId);
      if (!unit?.monitored) continue;
      if (raiseRule(code, { failedGrabs: await failedGrabsSinceImport(ctx, unitId) })) await raiseIssue(ctx, { code, unitId, grabId: grab._id });
      else retry.push(unitId);
    }
    if (retry.length > 0) await ctx.scheduler.runAfter(0, internal.pipeline.search.nextBest, { unitIds: retry });
  } else {
    // An unknown client state is cleaned up like a bad release, without a blocklist entry or next-best.
    const unknown = code === 'unknownClientFailure';
    if (FAILURE_CLASS[code] !== 'system' || unknown) await cleanUp(ctx, grab._id);
    const detail = unknown ? await unknownDetailOf(ctx, grab._id) : why;
    // An upgrade raises only pipelineError (and workflowPaused, on its pause): the Unit still plays.
    const raises = grab.kind !== 'upgrade' || code === 'pipelineError';
    if (raises && raiseRule(code, { lastAttempt: true }))
      for (const unitId of unitIds) await raiseIssue(ctx, { code, unitId, grabId: grab._id, ...(detail ? { detail } : {}) });
  }
  await recomputeUnits(
    ctx,
    rows.map((row) => row.unitId),
  );
}

/** An Issue detail fits on the Unit page: the error's first line, at most this long. */
const DETAIL_CHARS = 300;

/** The run's error as a sentence: its first line, without the `Error:` its class name adds. */
const errorDetail = (prefix: string, error: string): string =>
  `${prefix}: ${error
    .split('\n')[0]!
    .replace(/^(Uncaught )?\w*Error: /, '')
    .trim()}`.slice(0, DETAIL_CHARS);

/**
 * Schedules the restart of a failed run, when it has restarts left. The
 * workflow component never retries a mutation, so one step (or replay of the
 * handler) that ran out of Convex's conflict retries fails the whole run. The
 * restart waits a backoff that doubles each time, so it doesn't meet the same
 * contention. A failed mutation committed nothing, so running it again is
 * safe; the steps before it keep their journal entries and replay their
 * results, so no job is enqueued twice. Returns whether a restart was
 * scheduled.
 */
async function scheduleRestart(ctx: MutationCtx, grab: Doc<'grabs'>, error: string): Promise<boolean> {
  const restarts = grab.runRestarts ?? 0;
  if (!grab.workflowId || restarts >= DEFAULT_LIMITS.runRestarts) return false;
  const {
    page: [last],
  } = await workflow.listSteps(ctx, grab.workflowId, { order: 'desc', paginationOpts: { cursor: null, numItems: 1 } });
  // A failed step is run again; a failed replay of the handler replays the same history.
  const fromStep = last?.runResult?.kind === 'failed' ? last.stepNumber : undefined;
  const delayMs = DEFAULT_LIMITS.runRestartBackoffMs * 2 ** restarts;
  await ctx.db.patch(grab._id, { runRestarts: restarts + 1 });
  await ctx.scheduler.runAfter(delayMs, internal.pipeline.grabs.restartRun, { grabId: grab._id, error, ...(fromStep !== undefined ? { fromStep } : {}) });
  const how = fromStep !== undefined ? 'Running the failed step again' : 'Replaying the run';
  await appendEvent(ctx, {
    grabId: grab._id,
    stage: 'grab',
    kind: 'retry',
    message: `${errorDetail('The run failed', error)}. ${how} in ${delayMs / 1000} s (${restarts + 1} of ${DEFAULT_LIMITS.runRestarts}).`,
    data: { attempt: restarts + 1 },
  });
  return true;
}

/**
 * Scheduled by `scheduleRestart`: restarts the run, unless the Grab ended
 * meanwhile (a cancel). A restart that throws (the migrations package
 * refuses `from` on a run whose migrations edited its history) ends the
 * Grab with the run's error instead, so its Units are freed.
 */
export const restartRun = internalMutation({
  args: { grabId: v.id('grabs'), error: v.string(), fromStep: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { grabId, error, fromStep }) => {
    const grab = await ctx.db.get(grabId);
    if (!grab?.workflowId || FINAL.has(grab.state)) return null;
    try {
      await workflow.restart(ctx, grab.workflowId, { ...(fromStep !== undefined ? { from: fromStep } : {}), startAsync: true });
    } catch (restartError) {
      console.error(`restartRun: Grab ${grabId}`, restartError);
      await failed(ctx, grab, 'pipelineError', errorDetail('The run failed', error));
    }
    return null;
  },
});

/** The Issue detail of a `pipelineError` a job reported: the job's last error. */
async function jobErrorOf(ctx: MutationCtx, jobId: Id<'jobs'> | undefined): Promise<string> {
  const job = jobId && (await ctx.db.get(jobId));
  return job?.lastError?.split('\n')[0]!.trim().slice(0, DETAIL_CHARS) || 'The worker reported a pipeline error without a detail.';
}

/**
 * The run's completion. A Grab with `cancelRequested` is
 * cancelled whatever the result kind, so a paused run ended with
 * `workflow.fail` doesn't raise `pipelineError`. A handler that threw
 * restarts from its failed step (`scheduleRestart`), and past the limit is a
 * `pipelineError` carrying the error; a job's `pipelineError` carries the
 * job's last error. The body is wrapped: the component
 * keeps an onComplete error where nothing reads it, so it is raised instead.
 */
export const onRunComplete = internalMutation({
  args: { workflowId: vWorkflowId, result: vResultValidator, context: v.object({ grabId: v.id('grabs') }) },
  returns: v.null(),
  handler: async (ctx, { result, context: { grabId } }) => {
    const grab = await ctx.db.get(grabId);
    if (!grab || FINAL.has(grab.state)) return null;
    try {
      const value = result.kind === 'success' ? PipelineRunResult.safeParse(result.returnValue) : undefined;
      if (grab.cancelRequested || result.kind === 'canceled' || value?.data?.outcome === 'cancelled') await cancelled(ctx, grab);
      else if (result.kind === 'failed') {
        if (!(await scheduleRestart(ctx, grab, result.error))) await failed(ctx, grab, 'pipelineError', errorDetail('The run failed', result.error));
      } else if (value && !value.success) await failed(ctx, grab, 'pipelineError', 'The run ended with a result this version cannot read.');
      else if (value?.data?.outcome === 'failed') {
        const code = value.data.failureCode ?? 'pipelineError';
        await failed(ctx, grab, code, code === 'pipelineError' ? await jobErrorOf(ctx, value.data.jobId) : undefined);
      }
    } catch (error) {
      console.error(`onRunComplete: Grab ${grabId}`, error);
      for (const row of await ctx.db
        .query('grabUnits')
        .withIndex('by_grab', (q) => q.eq('grabId', grabId))
        .collect())
        await raiseIssue(ctx, { code: 'pipelineError', unitId: row.unitId, grabId, detail: 'The run ended, but recording its end failed.' });
    }
    return null;
  },
});

/**
 * Called by the pick of a next-best attempt: a Unit it could not
 * grab has no acceptable release left, so its last failure is raised.
 */
export async function raiseNoneLeft(ctx: MutationCtx, attempt: Doc<'searchAttempts'>): Promise<void> {
  if (attempt.trigger !== 'nextBest') return;
  for (const unitId of attempt.wantedUnitIds) {
    const unit = await ctx.db.get(unitId);
    if (!unit?.monitored || unit.activeGrabId !== undefined) continue;
    const last = await ctx.db
      .query('grabUnits')
      .withIndex('by_unit', (q) => q.eq('unitId', unitId))
      .order('desc')
      .first();
    const grab = last && (await ctx.db.get(last.grabId));
    if (grab?.failureCode && raiseRule(grab.failureCode, { noneLeft: true })) {
      await raiseIssue(ctx, { code: grab.failureCode, unitId, grabId: grab._id, detail: 'No acceptable release is left.' });
      await recomputeUnits(ctx, [unitId]);
    }
  }
}

const RUN_JOBS = ['download.submit', 'import'] as const;

/** Cancels the run's live jobs: a queued one ends with its event, a leased one is asked to stop. Returns whether one was live. */
async function cancelRunJobs(ctx: MutationCtx, grabId: Id<'grabs'>): Promise<boolean> {
  let live = false;
  for (const cls of RUN_JOBS) {
    const job = await ctx.db
      .query('jobs')
      .withIndex('by_idempotency_key', (q) => q.eq('idempotencyKey', `${grabId}:${cls}`))
      .first();
    if (job && (await cancelJob(ctx, job._id))) live = true;
  }
  // The publish job is keyed by its Publications.
  for (const job of await runPublishJobs(ctx, grabId)) if (await cancelJob(ctx, job._id)) live = true;
  return live;
}

/**
 * The one entry point for a cancel: unmonitoring every covered Unit,
 * deleting the Work, or the user. It does nothing once the run has finished.
 * Otherwise it marks the Grab and ends the run where it waits: a queued job
 * is cancelled with its event, a leased one is asked to stop, a download
 * wait gets its event, and a paused run is failed. `onRunComplete` then
 * treats the run as cancelled. Returns whether a cancel was requested.
 */
export async function cancelGrab(ctx: MutationCtx, grabId: Id<'grabs'>, options: { blocklist?: boolean } = {}): Promise<boolean> {
  const grab = await ctx.db.get(grabId);
  if (!grab?.workflowId || FINAL.has(grab.state)) return false;
  const status = await workflow.status(ctx, grab.workflowId);
  // A failed run of a Grab that hasn't ended waits for its restart (scheduleRestart), or none is coming.
  if (status.type !== 'inProgress' && status.type !== 'failed') return false;
  const marks = { cancelRequested: true, ...(options.blocklist ? { cancelBlocklist: true } : {}) } as const;
  await ctx.db.patch(grabId, marks);
  if (!grab.cancelRequested) await appendEvent(ctx, { grabId, stage: 'grab', kind: 'cancelled', message: 'Cancelling.' });

  if (status.type === 'failed') {
    // No run is left to end the Grab: its live job is cancelled, and the Grab ends here; the restart then does nothing.
    await cancelRunJobs(ctx, grabId);
    await cancelled(ctx, { ...grab, ...marks });
    return true;
  }
  await recomputeUnits(ctx, await unitsOfGrab(ctx, grabId));
  if (grab.pausedAt !== undefined) {
    await workflow.fail(ctx, grab.workflowId, 'cancelled');
    return true;
  }
  if (await cancelRunJobs(ctx, grabId)) return true;
  if (grab.state === 'downloading') {
    const download = await ctx.db
      .query('downloads')
      .withIndex('by_grab', (q) => q.eq('grabId', grabId))
      .filter((q) => q.eq(q.field('state'), 'active'))
      .first();
    if (download?.jobId) {
      const value: JobEventValue = { outcome: 'cancelled', jobId: download.jobId };
      await sendEvent(ctx, components.workflow, { workflowId: grab.workflowId, name: downloadEventName(download._id), value });
    }
  }
  // Between two steps, the next step cancels the job it enqueues (steps.ts).
  return true;
}

/** `pipelineRun`'s function name, as the migrations package lists paused runs by it. */
const PIPELINE_RUN = 'pipeline/workflow:pipelineRun';

/**
 * Ends the pauses that are over (supervision): the package ends a
 * pause without a callback when a later replay succeeds, so each Grab with
 * `pausedAt` is checked against the runs still paused. For one no longer
 * paused, `pausedAt` is cleared, its `workflowPaused` Issue resolved and its
 * Units recomputed.
 */
export async function endPauses(ctx: MutationCtx): Promise<void> {
  const grabs = await ctx.db
    .query('grabs')
    .withIndex('by_paused', (q) => q.gt('pausedAt', 0))
    .collect();
  if (grabs.length === 0) return;
  const stillPaused = new Set<string>();
  let cursor: string | null = null;
  for (;;) {
    const page = await workflow.paused(ctx, { workflow: PIPELINE_RUN, cursor, numItems: 100 });
    for (const run of page.page) stillPaused.add(run.workflowId);
    if (page.isDone) break;
    cursor = page.continueCursor;
  }
  for (const grab of grabs) {
    if (grab.workflowId && stillPaused.has(grab.workflowId)) continue;
    await ctx.db.patch(grab._id, { pausedAt: undefined });
    await appendEvent(ctx, { grabId: grab._id, stage: 'grab', kind: 'resumed', message: 'The run replays again.' });
    await resolveIssuesForGrab(ctx, grab._id, ['workflowPaused']);
    await recomputeUnits(ctx, await unitsOfGrab(ctx, grab._id));
  }
}

/** A run that can't replay pauses: the Grab records it and its Units get a `workflowPaused` Issue. */
export async function onRunPaused(ctx: MutationCtx, info: PauseInfo): Promise<void> {
  const grab = await ctx.db
    .query('grabs')
    .withIndex('by_workflow', (q) => q.eq('workflowId', info.workflowId))
    .first();
  if (!grab) return;
  if (grab.pausedAt === undefined) await ctx.db.patch(grab._id, { pausedAt: Date.now() });
  const rows = await ctx.db
    .query('grabUnits')
    .withIndex('by_grab', (q) => q.eq('grabId', grab._id))
    .collect();
  for (const row of rows)
    await raiseIssue(ctx, { code: 'workflowPaused', unitId: row.unitId, grabId: grab._id, detail: `${info.reason}: ${info.detail}`.slice(0, 1000) });
  await recomputeUnits(
    ctx,
    rows.map((row) => row.unitId),
  );
}
