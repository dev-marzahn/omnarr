// The Issues page's rows: each Issue with its Unit,
// what is fixing it ("In progress"), and the fix actions that apply
// to it now.
import type { FixAction, IssueInProgress, IssueList, IssueRow } from '@omnarr/contracts';

import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { downloadOf } from '../library/read';
import { workImages } from '../metadata/images';
import { blocklistEntryFor } from '../pipeline/blocklist';

/** A Rendition of one of the Unit's files is pending. */
async function pendingRendition(ctx: QueryCtx, unitId: Id<'units'>): Promise<boolean> {
  const links = await ctx.db
    .query('fileUnits')
    .withIndex('by_unit', (q) => q.eq('unitId', unitId))
    .collect();
  for (const { fileId } of links) {
    const pending = await ctx.db
      .query('renditions')
      .withIndex('by_source_file', (q) => q.eq('sourceFileId', fileId))
      .filter((q) => q.eq(q.field('state'), 'pending'))
      .first();
    if (pending) return true;
  }
  return false;
}

const STAGE_OF_GRAB = { submitting: 'grabbed', downloading: 'downloading', importing: 'importing', publishing: 'importing' } as const;

/**
 * What is fixing the Unit now: its running Grab (a paused run isn't
 * running), else a pending Rendition, else a search that hasn't ended.
 */
export async function inProgressOf(ctx: QueryCtx, unit: Doc<'units'>): Promise<IssueInProgress | undefined> {
  const grab = unit.activeGrabId ? await ctx.db.get(unit.activeGrabId) : null;
  if (grab && grab.pausedAt === undefined && grab.state in STAGE_OF_GRAB) {
    const download = await downloadOf(ctx, grab);
    const stage =
      grab.state === 'downloading' && download?.stage === 'postProcessing' ? 'repairUnpack' : STAGE_OF_GRAB[grab.state as keyof typeof STAGE_OF_GRAB];
    return { stage, grabId: grab._id, ...(download && grab.state === 'downloading' ? { download } : {}) };
  }
  if (await pendingRendition(ctx, unit._id)) return { stage: 'preparing' };
  const attempt = unit.lastSearchAttemptId ? await ctx.db.get(unit.lastSearchAttemptId) : null;
  if (attempt?.state === 'running') return { stage: 'searching' };
  return undefined;
}

/**
 * The Issue's fix actions that apply now, in their stored order: "Unblock
 * release" only while the release is blocklisted, "Retry this release" only
 * with the Grab it names, and the ffmpeg log only once it is stored. On a
 * playable Unit a new release is an upgrade.
 */
export async function offeredActions(ctx: QueryCtx, issue: Doc<'issues'>): Promise<FixAction[]> {
  const grab = issue.grabId ? await ctx.db.get(issue.grabId) : null;
  const blocklisted = grab ? (await blocklistEntryFor(ctx, grab.candidateId)) !== null : false;
  const job = issue.jobId ? await ctx.db.get(issue.jobId) : null;
  return issue.fixActions.filter((action) => {
    if (action === 'retryRelease') return grab !== null;
    if (action === 'blocklistRemove') return blocklisted;
    if (action === 'downloadLog') return job?.artifactStorageId !== undefined;
    return true;
  });
}

/** One Issue as the page shows it. */
export async function issueRow(ctx: QueryCtx, issue: Doc<'issues'>): Promise<IssueRow> {
  const unit = issue.unitId ? await ctx.db.get(issue.unitId) : null;
  const work = unit ? await ctx.db.get(unit.workId) : null;
  const grab = issue.grabId ? await ctx.db.get(issue.grabId) : null;
  const candidate = grab ? await ctx.db.get(grab.candidateId) : null;
  const inProgress = issue.state === 'open' && unit ? await inProgressOf(ctx, unit) : undefined;
  const posterUrl = work ? (await workImages(ctx, work._id)).posterUrl : undefined;
  return {
    issueId: issue._id,
    scope: issue.scope,
    failureCode: issue.failureCode,
    class: issue.class,
    state: issue.state,
    fixActions: issue.state === 'open' ? await offeredActions(ctx, issue) : [],
    ...(issue.detail !== undefined ? { detail: issue.detail } : {}),
    raisedAt: issue._creationTime,
    ...(issue.resolvedAt !== undefined ? { resolvedAt: issue.resolvedAt } : {}),
    ...(issue.grabId ? { grabId: issue.grabId } : {}),
    ...(candidate ? { release: candidate.title } : {}),
    ...(unit && work
      ? {
          unit: {
            unitId: unit._id,
            workId: work._id,
            workTitle: work.title,
            workKind: work.kind,
            ...(work.year !== undefined ? { year: work.year } : {}),
            ...(unit.tmdbSeason !== undefined ? { tmdbSeason: unit.tmdbSeason } : {}),
            ...(unit.tmdbEpisode !== undefined ? { tmdbEpisode: unit.tmdbEpisode } : {}),
            ...(unit.title !== undefined ? { title: unit.title } : {}),
          },
        }
      : {}),
    ...(posterUrl ? { posterUrl } : {}),
    ...(inProgress ? { inProgress } : {}),
  };
}

/** Open Issues of one scope, newest first. */
export const openIssues = (ctx: QueryCtx, scope: 'unit' | 'system') =>
  ctx.db
    .query('issues')
    .withIndex('by_state_scope', (q) => q.eq('state', 'open').eq('scope', scope))
    .order('desc')
    .collect();

/** "Resolved & dismissed" shows the last 30 days. */
const RESOLVED_DAYS_MS = 30 * 86_400_000;
/** At most this many resolved rows are read per state and scope, newest first. */
const RESOLVED_PAGE = 200;

/** `issues.list`, which the support bundle includes too. */
export async function issueListOf(ctx: QueryCtx): Promise<IssueList> {
  const needsAction: IssueRow[] = [];
  const inProgress: IssueRow[] = [];
  for (const issue of await openIssues(ctx, 'unit')) {
    const row = await issueRow(ctx, issue);
    (row.inProgress ? inProgress : needsAction).push(row);
  }
  const system = await Promise.all((await openIssues(ctx, 'system')).map((issue) => issueRow(ctx, issue)));
  const since = Date.now() - RESOLVED_DAYS_MS;
  const resolved: IssueRow[] = [];
  for (const state of ['resolved', 'dismissed'] as const)
    for (const scope of ['unit', 'system'] as const) {
      const rows = await ctx.db
        .query('issues')
        .withIndex('by_state_scope', (q) => q.eq('state', state).eq('scope', scope))
        .order('desc')
        .take(RESOLVED_PAGE);
      for (const issue of rows) if ((issue.resolvedAt ?? issue._creationTime) >= since) resolved.push(await issueRow(ctx, issue));
    }
  resolved.sort((a, b) => (b.resolvedAt ?? b.raisedAt) - (a.resolvedAt ?? a.raisedAt));
  return { needsAction, inProgress, system, resolved };
}
