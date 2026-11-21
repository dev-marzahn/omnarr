// The pick: ranks an attempt's accepted candidates
// with selectCandidates, writes every verdict, starts one Grab per pick, and
// for a season attempt starts the per-episode follow-ups.
import { selectCandidates, type StoredCandidate } from '@omnarr/scoring';

import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { supportsSeason } from '../indexers/requestPlan';
import { transition } from '../lib/stateMachine';
import { raiseNoneLeft, startGrab } from './grabs';
import { startSearch } from './search';

const asStored = (row: Doc<'candidates'>): StoredCandidate => row as unknown as StoredCandidate;

/**
 * Per-episode follow-ups for a season attempt's uncovered Units: only
 * when an indexer's result was truncated, or its tv-search can't search by
 * season. Otherwise the season result already holds every episode it has.
 */
async function followUps(ctx: MutationCtx, attempt: Doc<'searchAttempts'>, covered: Set<Id<'units'>>): Promise<void> {
  if (attempt.groupKind !== 'season' && attempt.groupKind !== 'animeSeason') return;
  const uncovered = attempt.wantedUnitIds.filter((unitId) => !covered.has(unitId));
  if (uncovered.length === 0) return;
  let needed = false;
  for (const result of attempt.indexerResults) {
    if (result.skipped || result.status !== 'ok') continue;
    const indexer = await ctx.db.get(result.indexerId);
    if (result.truncated || (indexer && !supportsSeason(indexer.caps))) needed = true;
  }
  if (needed) await startSearch(ctx, uncovered, attempt.trigger, { perUnit: true });
}

/** Picks for one attempt, in the mutation that recorded its last page (search) or its candidates (RSS). */
export async function pickInMutation(ctx: MutationCtx, attemptId: Id<'searchAttempts'>): Promise<Id<'grabs'>[]> {
  const attempt = (await ctx.db.get(attemptId))!;
  const work = (await ctx.db.get(attempt.workId))!;
  const profile = (await ctx.db.get(work.releaseProfileId))!;
  const pending = await ctx.db
    .query('candidates')
    .withIndex('by_attempt_outcome', (q) => q.eq('searchAttemptId', attemptId).eq('outcome', 'pending'))
    .collect();

  const busyUnitIds: Id<'units'>[] = [];
  for (const unitId of new Set(pending.flatMap((row) => row.unitIds))) {
    const unit = await ctx.db.get(unitId);
    if (unit?.activeGrabId !== undefined) busyUnitIds.push(unitId);
  }
  const indexerPriority: Record<string, number> = {};
  for (const indexerId of new Set(pending.map((row) => row.indexerId))) {
    const indexer = await ctx.db.get(indexerId);
    if (indexer) indexerPriority[indexerId] = indexer.priority;
  }

  const { picks, verdicts } = selectCandidates(pending.map(asStored), {
    profile: { preferredProtocol: profile.preferredProtocol, preferSeasonPacks: profile.preferSeasonPacks },
    group: { kind: attempt.groupKind, wantedUnitIds: attempt.wantedUnitIds as unknown as StoredCandidate['unitIds'] },
    indexerPriority,
    busyUnitIds: busyUnitIds as unknown as StoredCandidate['unitIds'],
    mode: attempt.trigger === 'interactive' ? 'offer' : 'auto',
  });
  // "Search and pick": the accepted rows keep `pending` with their rank, and the user grabs one.
  if (attempt.trigger === 'interactive') {
    for (const verdict of verdicts) await ctx.db.patch(verdict.candidateId as unknown as Id<'candidates'>, { rank: verdict.rank });
    // Rejected rows can be grabbed too, so the event counts every row.
    const rows = await ctx.db
      .query('candidates')
      .withIndex('by_attempt', (q) => q.eq('searchAttemptId', attemptId))
      .collect();
    await transition(ctx, 'searchAttempt', attemptId, 'offered', {
      kind: 'decision',
      message: `Offered ${rows.length} release${rows.length === 1 ? '' : 's'} to pick from, ${pending.length} of them acceptable.`,
    });
    return [];
  }
  for (const verdict of verdicts) {
    await ctx.db.patch(verdict.candidateId as unknown as Id<'candidates'>, {
      outcome: verdict.outcome === 'picked' ? 'picked' : 'rejected',
      rank: verdict.rank,
      ...(verdict.reason ? { reason: verdict.reason } : {}),
      ...(verdict.lostOn ? { lostOn: verdict.lostOn } : {}),
    });
  }

  const grabs: Id<'grabs'>[] = [];
  const covered = new Set<Id<'units'>>();
  for (const pick of picks) {
    const candidateId = pick as unknown as Id<'candidates'>;
    grabs.push(await startGrab(ctx, candidateId));
    for (const unitId of (await ctx.db.get(candidateId))!.unitIds) covered.add(unitId);
  }
  await transition(ctx, 'searchAttempt', attemptId, grabs.length > 0 ? 'picked' : 'noAcceptable', {
    kind: 'decision',
    message: grabs.length > 0 ? `Picked ${grabs.length} release${grabs.length === 1 ? '' : 's'}.` : 'No acceptable release.',
  });
  await followUps(ctx, attempt, covered);
  await raiseNoneLeft(ctx, attempt);
  return grabs;
}
