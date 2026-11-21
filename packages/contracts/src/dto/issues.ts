// The Issues page: `issues.list` with its "Needs action" / "In progress" split,
// `issues.counts` for the sidebar badge, and `issues.act`. No field holds a
// URL but the artifact's storage URL, or a key: the schemas are strict.
import { zid } from 'convex-helpers/server/zod4';
import { z } from 'zod';

import { FailureClass, FailureCode, FailureScope, FixAction, IssueAction } from '../failures.ts';
import { UnitDownload, WorkKind } from './library.ts';

/** The Unit a unit-scope Issue is about, as the row names it. */
export const IssueUnit = z
  .object({
    unitId: zid('units'),
    workId: zid('works'),
    workTitle: z.string(),
    workKind: WorkKind,
    year: z.number().optional(),
    tmdbSeason: z.number().optional(),
    tmdbEpisode: z.number().optional(),
    title: z.string().optional(),
  })
  .strict();
export type IssueUnit = z.infer<typeof IssueUnit>;

/**
 * What is fixing an open Issue ("In progress"): the Unit's running
 * Grab and its stage, a pending Rendition (`preparing`), or a search that
 * hasn't picked yet (`searching`, after "Try next-best release").
 */
export const IssueInProgress = z
  .object({
    stage: z.enum(['searching', 'grabbed', 'downloading', 'repairUnpack', 'importing', 'preparing']),
    grabId: zid('grabs').optional(),
    /** While the running Grab downloads. */
    download: UnitDownload.optional(),
  })
  .strict();
export type IssueInProgress = z.infer<typeof IssueInProgress>;

/** One Issue on the Issues page and on its item. */
export const IssueRow = z
  .object({
    issueId: zid('issues'),
    scope: FailureScope,
    failureCode: FailureCode,
    class: FailureClass,
    state: z.enum(['open', 'resolved', 'dismissed']),
    /** The fix actions that apply now, in display order: the first is the row's primary button. */
    fixActions: z.array(FixAction),
    detail: z.string().optional(),
    raisedAt: z.number(),
    resolvedAt: z.number().optional(),
    grabId: zid('grabs').optional(),
    /** The release of the Grab that raised it. */
    release: z.string().optional(),
    unit: IssueUnit.optional(),
    /** The Work's stored poster. */
    posterUrl: z.string().optional(),
    inProgress: IssueInProgress.optional(),
  })
  .strict();
export type IssueRow = z.infer<typeof IssueRow>;

/** `issues.list`: the Issues page's tabs. "Resolved & dismissed" holds the last 30 days. */
export const IssueList = z
  .object({ needsAction: z.array(IssueRow), inProgress: z.array(IssueRow), system: z.array(IssueRow), resolved: z.array(IssueRow) })
  .strict();
export type IssueList = z.infer<typeof IssueList>;

/** `issues.counts`: the sidebar badge shows `needsAction + system`. */
export const IssueCounts = z.object({ needsAction: z.number(), inProgress: z.number(), system: z.number() }).strict();
export type IssueCounts = z.infer<typeof IssueCounts>;

/** `issues.act(issueId, action)`: every fix action but the web app's own (`CLIENT_FIX_ACTIONS`). */
export const IssueActRequest = z.object({ issueId: zid('issues'), action: IssueAction });
export type IssueActRequest = z.infer<typeof IssueActRequest>;

/** `done`, or for "Download ffmpeg log" the artifact's URL. A refusal throws with the reason. */
export const IssueActResponse = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('done') }).strict(),
  z.object({ outcome: z.literal('url'), url: z.string() }).strict(),
]);
export type IssueActResponse = z.infer<typeof IssueActResponse>;
