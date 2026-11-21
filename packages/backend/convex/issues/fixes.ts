// `issues.act`: the fix actions the backend
// runs. "Search and pick", "Set up Jellyfin again" and "Enter a metadata key"
// are the web app's own (`CLIENT_FIX_ACTIONS`). A fix that starts a run moves
// its Issue to "In progress"; the run's success resolves it.
import { type IssueAction, type IssueActResponse, JOB_CLASSES, MappingSourceName } from '@omnarr/contracts';
import { ConvexError } from 'convex/values';

import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { enqueueJob } from '../jobs/queue';
import { recomputeUnits } from '../lib/derivedState';
import { dismissIssue } from '../lib/issues';
import { removeOrphans } from '../library/deleteWork';
import { moveUnitFiles, publishAt } from '../library/naming';
import { enqueueSourceFetch } from '../metadata/pool';
import { addToBlocklist, blocklistEntryFor, removeForCandidate } from '../pipeline/blocklist';
import { cancelGrab, startGrab } from '../pipeline/grabs';
import { sourceForUnit, start as startPreparation } from '../pipeline/preparation';
import { startSearch } from '../pipeline/search';
import { playablePrimary } from '../pipeline/upgrades';
import { workflow } from '../pipeline/workflow';
import { offeredActions } from './rows';

const refuse = (message: string): never => {
  throw new ConvexError(message);
};

const DONE: IssueActResponse = { outcome: 'done' };

/** The Grab the Issue names, or a refusal. */
async function grabOf(ctx: MutationCtx, issue: Doc<'issues'>): Promise<Doc<'grabs'>> {
  const grab = issue.grabId ? await ctx.db.get(issue.grabId) : null;
  return grab ?? refuse('This Issue names no run.');
}

/** The Units a new run of the Grab's release covers: its monitored Units, each free of another running Grab. */
async function freeUnitsOf(ctx: MutationCtx, grab: Doc<'grabs'>): Promise<Id<'units'>[]> {
  const rows = await ctx.db
    .query('grabUnits')
    .withIndex('by_grab', (q) => q.eq('grabId', grab._id))
    .collect();
  const unitIds: Id<'units'>[] = [];
  for (const { unitId } of rows) {
    const unit = await ctx.db.get(unitId);
    if (!unit?.monitored) continue;
    if (unit.activeGrabId !== undefined) refuse('The episode already has a running grab. Cancel that grab first.');
    unitIds.push(unitId);
  }
  if (unitIds.length === 0) refuse('No monitored episode is left for this release.');
  return unitIds;
}

/** "Retry this release" and "Retry now" after a run that ended: the same release in a new run, for the same Units. */
async function regrab(ctx: MutationCtx, grab: Doc<'grabs'>): Promise<void> {
  const unitIds = await freeUnitsOf(ctx, grab);
  const candidate = (await ctx.db.get(grab.candidateId))!;
  await startGrab(ctx, grab.candidateId, {
    unitIds,
    ...(grab.importAs ? { importAs: grab.importAs } : {}),
    message: `Grabbed ${candidate.title} again.`,
  });
}

/** The Unit's file versions whose Publication failed: "Retry now" publishes them again (`jellyfinUnavailable`). */
async function republishFailed(ctx: MutationCtx, unitId: Id<'units'>): Promise<boolean> {
  const publications = await ctx.db
    .query('publications')
    .withIndex('by_unit', (q) => q.eq('unitId', unitId))
    .filter((q) => q.eq(q.field('state'), 'failed'))
    .collect();
  const files = new Set<Id<'files'>>();
  for (const publication of publications) {
    const version = await ctx.db.get(publication.fileVersionId);
    if (version) files.add(version.fileId);
  }
  for (const fileId of files) {
    const file = (await ctx.db.get(fileId))!;
    await publishAt(ctx, fileId, file.path, { failed: true }, 'Publishing again.');
  }
  return files.size > 0;
}

/** `diskFull`'s "Retry now": the jobs waiting for space are queued at once; their space check runs again. */
async function wakeDiskWaits(ctx: MutationCtx): Promise<void> {
  for (const cls of JOB_CLASSES) {
    const waiting = await ctx.db
      .query('jobs')
      .withIndex('by_status_class', (q) => q.eq('status', 'waiting').eq('class', cls))
      .collect();
    for (const job of waiting) if (job.failureCode === 'diskFull') await ctx.db.patch(job._id, { status: 'queued', availableAt: undefined });
  }
}

async function retryNow(ctx: MutationCtx, issue: Doc<'issues'>): Promise<void> {
  if (issue.failureCode === 'diskFull') return wakeDiskWaits(ctx);
  if (issue.failureCode === 'metadataSourceUnavailable') {
    for (const source of MappingSourceName.options) await enqueueSourceFetch(ctx, source);
    await ctx.scheduler.runAfter(0, internal.metadata.schedule.tick, {});
    return;
  }
  // A file already in the library only needs its publish again; anything earlier needs the release again.
  if (issue.unitId && (await republishFailed(ctx, issue.unitId))) return;
  await regrab(ctx, await grabOf(ctx, issue));
}

/** "Try next-best release": the failed release is blocklisted (it is already for a bad release), then a fresh search. */
async function tryNextBest(ctx: MutationCtx, issue: Doc<'issues'>): Promise<void> {
  const unit = issue.unitId ? await ctx.db.get(issue.unitId) : null;
  if (!unit) return refuse('This Issue names no episode.');
  if (unit.activeGrabId !== undefined) refuse('The episode already has a running grab. Cancel that grab first.');
  const grab = issue.grabId ? await ctx.db.get(issue.grabId) : null;
  if (grab && !(await blocklistEntryFor(ctx, grab.candidateId))) {
    const candidate = (await ctx.db.get(grab.candidateId))!;
    const attempt = (await ctx.db.get(candidate.searchAttemptId))!;
    await addToBlocklist(ctx, { workId: attempt.workId, item: candidate, reason: issue.failureCode, grabId: grab._id });
  }
  // A Unit that plays gets an upgrade search, so the upgrade rule and the cooldown apply.
  await startSearch(ctx, [unit._id], (await playablePrimary(ctx, unit._id)) ? 'upgrade' : 'nextBest');
}

/** `removeClientItem`: each orphan item goes from its client with its data, by a `maintenance` job; the Issue resolves. */
async function removeClientItems(ctx: MutationCtx, issue: Doc<'issues'>): Promise<void> {
  for (const item of issue.orphanItems ?? []) {
    const torrent = item.clientKind === 'qbittorrent';
    await enqueueJob(ctx, {
      payload: {
        class: 'maintenance',
        action: 'removeDownload',
        clientKind: item.clientKind,
        clientRef: item.clientRef,
        deleteData: true,
        // A torrent loses only this tag, and goes once no Grab's tag is left on it.
        ...(torrent && item.correlationTag ? { correlationTag: item.correlationTag } : {}),
      },
      idempotencyKey: `removeDownload:${item.clientKind}:${item.clientRef}`,
    });
  }
  await ctx.db.patch(issue._id, { state: 'resolved', resolvedAt: Date.now() });
}

/** Runs one fix action on an open Issue, if the Issue offers it now. */
export async function act(ctx: MutationCtx, issueId: Id<'issues'>, action: IssueAction): Promise<IssueActResponse> {
  const issue = await ctx.db.get(issueId);
  if (!issue || issue.state !== 'open') return refuse('This Issue is no longer open.');
  if (!(await offeredActions(ctx, issue)).includes(action)) refuse(`This Issue doesn't offer ${action} now.`);

  switch (action) {
    case 'retryNow':
      await retryNow(ctx, issue);
      break;
    case 'tryNextBest':
      await tryNextBest(ctx, issue);
      break;
    case 'retryRelease': {
      const grab = await grabOf(ctx, issue);
      await removeForCandidate(ctx, grab.candidateId);
      await regrab(ctx, grab);
      break;
    }
    case 'blocklistRemove':
      await removeForCandidate(ctx, (await grabOf(ctx, issue)).candidateId);
      break;
    case 'retryPreparation': {
      const sourceId = issue.unitId ? await sourceForUnit(ctx, issue.unitId) : null;
      if (!sourceId || !(await startPreparation(ctx, sourceId, 'retry'))) refuse('The file has nothing left to prepare.');
      break;
    }
    case 'downloadLog': {
      const job = issue.jobId ? await ctx.db.get(issue.jobId) : null;
      const url = job?.artifactStorageId ? await ctx.storage.getUrl(job.artifactStorageId) : null;
      return url ? { outcome: 'url', url } : refuse('The log is no longer stored (logs are kept 14 days).');
    }
    case 'resumeRun': {
      const grab = await grabOf(ctx, issue);
      try {
        await workflow.resume(ctx, grab.workflowId!);
      } catch {
        refuse("The run isn't paused any more.");
      }
      break;
    }
    case 'cancelRun':
      await cancelGrab(ctx, (await grabOf(ctx, issue))._id);
      break;
    case 'removeClientItem':
      await removeClientItems(ctx, issue);
      break;
    case 'removeOrphans':
      await removeOrphans(ctx, issue.orphanRows ?? { jobIds: [], grabIds: [] });
      await ctx.db.patch(issue._id, { state: 'resolved', resolvedAt: Date.now() });
      break;
    case 'moveToLibraryNaming':
      if (!issue.unitId || (await moveUnitFiles(ctx, issue.unitId)) === 0) refuse('The file already has its library name.');
      break;
    case 'dismiss':
      try {
        await dismissIssue(ctx, issueId);
      } catch (error) {
        refuse((error as Error).message);
      }
      break;
  }
  if (issue.unitId) await recomputeUnits(ctx, [issue.unitId]);
  return DONE;
}
