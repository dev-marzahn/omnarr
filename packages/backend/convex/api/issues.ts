// The Issues page.
import { IssueActRequest, IssueActResponse, IssueCounts, IssueList } from '@omnarr/contracts';

import { act as runFix } from '../issues/fixes';
import { inProgressOf, issueListOf, openIssues } from '../issues/rows';
import { adminMutation, adminQuery } from '../lib/functions';

/**
 * The Issues page's tabs: open unit-scope Issues split by whether something is
 * fixing them, open system Issues, and those resolved or dismissed
 * in the last 30 days.
 */
export const list = adminQuery({
  args: {},
  returns: IssueList,
  handler: (ctx) => issueListOf(ctx),
});

/** The sidebar badge, on every page: it shows `needsAction + system`. */
export const counts = adminQuery({
  args: {},
  returns: IssueCounts,
  handler: async (ctx) => {
    let needsAction = 0;
    let inProgress = 0;
    for (const issue of await openIssues(ctx, 'unit')) {
      const unit = issue.unitId ? await ctx.db.get(issue.unitId) : null;
      if (unit && (await inProgressOf(ctx, unit))) inProgress += 1;
      else needsAction += 1;
    }
    return { needsAction, inProgress, system: (await openIssues(ctx, 'system')).length };
  },
});

/** Runs a fix action. A refusal throws with the reason the page shows. */
export const act = adminMutation({
  args: IssueActRequest.shape,
  returns: IssueActResponse,
  handler: (ctx, { issueId, action }) => runFix(ctx, issueId, action),
});
