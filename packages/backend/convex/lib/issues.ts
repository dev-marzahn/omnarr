// Raised failures. Only these appear under Issues; failures
// that recover on their own stay on the timeline.
import { FAILURE_CLASS, FAILURE_SCOPE, FIX_ACTIONS, type FailureCode, type ItemLeftInClient } from '@omnarr/contracts';

import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';

export type RaiseIssue = {
  code: FailureCode;
  /** Required for codes with unit scope, absent for system ones. */
  unitId?: Id<'units'>;
  grabId?: Id<'grabs'>;
  jobId?: Id<'jobs'>;
  /** For example needed vs. free bytes, or ffmpeg's exit code and last lines. */
  detail?: string;
  /** `orphanClientItem`: the client items it names; a raise again adds new ones. */
  orphanItems?: ItemLeftInClient[];
  /** `orphanAfterDelete`: the rows it names; a raise again adds new ones (`removeOrphans`). */
  orphanRows?: OrphanRows;
};

export type OrphanRows = { jobIds: Id<'jobs'>[]; grabIds: Id<'grabs'>[] };

/** The rows of both, each once. */
const mergeRows = (known: OrphanRows = { jobIds: [], grabIds: [] }, added: OrphanRows): OrphanRows => ({
  jobIds: [...new Set([...known.jobIds, ...added.jobIds])],
  grabIds: [...new Set([...known.grabIds, ...added.grabIds])],
});

const itemKey = (item: ItemLeftInClient) => `${item.clientKind}:${item.clientRef ?? `tag:${item.correlationTag}`}`;

/** The items of both lists, each once. */
const mergeItems = (known: ItemLeftInClient[] = [], added: ItemLeftInClient[] = []) => [
  ...new Map([...known, ...added].map((item) => [itemKey(item), item])).values(),
];

async function findOpen(ctx: QueryCtx, code: FailureCode, unitId?: Id<'units'>): Promise<Doc<'issues'> | null> {
  if (unitId) {
    const rows = await ctx.db
      .query('issues')
      .withIndex('by_unit', (q) => q.eq('unitId', unitId))
      .filter((q) => q.and(q.eq(q.field('state'), 'open'), q.eq(q.field('failureCode'), code)))
      .first();
    return rows;
  }
  return await ctx.db
    .query('issues')
    .withIndex('by_state_scope', (q) => q.eq('state', 'open').eq('scope', 'system'))
    .filter((q) => q.eq(q.field('failureCode'), code))
    .first();
}

/**
 * Opens an Issue, or refreshes the open one with the same scope, Unit and
 * code, so a repeated failure stays one Issue.
 */
export async function raiseIssue(ctx: MutationCtx, issue: RaiseIssue): Promise<Id<'issues'>> {
  const scope = FAILURE_SCOPE[issue.code];
  if (scope === 'unit' && !issue.unitId) throw new Error(`raiseIssue: ${issue.code} is raised per Unit and needs a unitId`);
  const unitId = scope === 'unit' ? issue.unitId : undefined;
  const open = await findOpen(ctx, issue.code, unitId);
  if (open) {
    await ctx.db.patch(open._id, {
      detail: issue.detail ?? open.detail,
      jobId: issue.jobId ?? open.jobId,
      grabId: issue.grabId ?? open.grabId,
      ...(issue.orphanItems ? { orphanItems: mergeItems(open.orphanItems, issue.orphanItems) } : {}),
      ...(issue.orphanRows ? { orphanRows: mergeRows(open.orphanRows, issue.orphanRows) } : {}),
    });
    return open._id;
  }
  return await ctx.db.insert('issues', {
    scope,
    unitId,
    grabId: issue.grabId,
    jobId: issue.jobId,
    failureCode: issue.code,
    class: FAILURE_CLASS[issue.code],
    state: 'open',
    fixActions: FIX_ACTIONS[issue.code],
    detail: issue.detail,
    ...(issue.orphanItems ? { orphanItems: mergeItems([], issue.orphanItems) } : {}),
    ...(issue.orphanRows ? { orphanRows: mergeRows(undefined, issue.orphanRows) } : {}),
  });
}

const resolve = (ctx: MutationCtx, issue: Doc<'issues'>) => ctx.db.patch(issue._id, { state: 'resolved', resolvedAt: Date.now() });

/** Which open Issues a resolve point resolves: these codes, or every code of these classes. */
export type IssueMatch = FailureCode[] | ((issue: Doc<'issues'>) => boolean);

const matches = (issue: Doc<'issues'>, match: IssueMatch) => (typeof match === 'function' ? match(issue) : match.includes(issue.failureCode));

/** Resolves a Unit's open Issues that `match` selects. */
export async function resolveIssuesForUnit(ctx: MutationCtx, unitId: Id<'units'>, match: IssueMatch): Promise<void> {
  const open = await ctx.db
    .query('issues')
    .withIndex('by_unit', (q) => q.eq('unitId', unitId))
    .filter((q) => q.eq(q.field('state'), 'open'))
    .collect();
  for (const issue of open) if (matches(issue, match)) await resolve(ctx, issue);
}

/** Resolves the open Issues raised for a Grab's run that `match` selects. */
export async function resolveIssuesForGrab(ctx: MutationCtx, grabId: Id<'grabs'>, match: IssueMatch): Promise<void> {
  const rows = await ctx.db
    .query('grabUnits')
    .withIndex('by_grab', (q) => q.eq('grabId', grabId))
    .collect();
  for (const { unitId } of rows) {
    const open = await ctx.db
      .query('issues')
      .withIndex('by_unit', (q) => q.eq('unitId', unitId))
      .filter((q) => q.and(q.eq(q.field('state'), 'open'), q.eq(q.field('grabId'), grabId)))
      .collect();
    for (const issue of open) if (matches(issue, match)) await resolve(ctx, issue);
  }
}

/** Resolves the open system Issue with this code, if there is one. */
export async function resolveSystemIssue(ctx: MutationCtx, code: FailureCode): Promise<void> {
  const open = await findOpen(ctx, code);
  if (open) await resolve(ctx, open);
}

/** Dismisses an open Issue; a code whose fix actions lack `dismiss` would only reopen, so it throws. */
export async function dismissIssue(ctx: MutationCtx, issueId: Id<'issues'>): Promise<void> {
  const issue = await ctx.db.get(issueId);
  if (!issue || issue.state !== 'open') return;
  if (!FIX_ACTIONS[issue.failureCode].includes('dismiss')) throw new Error(`A ${issue.failureCode} Issue can't be dismissed: it resolves itself.`);
  await ctx.db.patch(issueId, { state: 'dismissed', resolvedAt: Date.now() });
}
