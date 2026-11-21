// Interactive search and manual grab. "Search and pick" is a user search
// whose results are offered instead of picked; `grabCandidate` grabs any of
// its rows within the hour, rejected ones too. A row whose numbering didn't
// decide its Units is grabbed for the search's Unit and imported as it.
import { type CandidateReason, type GrabCandidateResponse, OFFER_TTL_MS } from '@omnarr/contracts';
import { ConvexError } from 'convex/values';

import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { appendEvent } from '../lib/events';
import { transition } from '../lib/stateMachine';
import { removeForCandidate } from './blocklist';
import { startGrab } from './grabs';
import { startSearch } from './search';

/** The Units a grab of the row covers: its own, else the search's, for a release of a wrong title or episode. */
export const coveredBy = (row: Doc<'candidates'>, attempt: Doc<'searchAttempts'>): Id<'units'>[] => (row.unitIds.length > 0 ? row.unitIds : attempt.unitIds);

/**
 * The Units a grab of the row is imported as, whatever its name says: set
 * for a release whose numbers didn't name the search's Unit, unclear or
 * another episode's, and for one whose title wasn't recognised: the grab is
 * the user's choice of episode ("Possibly misread").
 * Absent for every other row, which imports normally.
 */
export function importAsFor(row: Doc<'candidates'>, attempt: Doc<'searchAttempts'>): Id<'units'>[] | undefined {
  const chosen = row.reason === 'wrongTitleOrEpisode' && (row.matchDetail === 'episode' || row.matchDetail === 'otherEpisode' || row.matchDetail === 'title');
  return chosen ? attempt.unitIds : undefined;
}

/** "Search and pick" for one Unit: a user search whose results wait for the user's grab. */
export async function searchInteractive(ctx: MutationCtx, unitId: Id<'units'>): Promise<Id<'searchAttempts'>> {
  const [attemptId] = await startSearch(ctx, [unitId], 'interactive');
  if (!attemptId) throw new ConvexError('This episode can no longer be searched.');
  return attemptId;
}

/**
 * Grabs one row of an offered "Search and pick": refused
 * when the results are over an hour old, a covered Unit has a running Grab,
 * or the row is a pack whose season isn't clear. A blocklisted row comes off
 * the blocklist first. The row is picked by the user, its Grab starts, and
 * the attempt is picked; the other rows keep their outcome. The pick step
 * records the rejection the user confirmed.
 */
export async function grabCandidate(ctx: MutationCtx, candidateId: Id<'candidates'>, confirmReason?: CandidateReason): Promise<GrabCandidateResponse> {
  const row = await ctx.db.get(candidateId);
  const attempt = row && (await ctx.db.get(row.searchAttemptId));
  if (!row || !attempt || attempt.trigger !== 'interactive' || attempt.state !== 'offered') throw new ConvexError('These results are not open for picking.');
  if (Date.now() > attempt._creationTime + OFFER_TTL_MS) return { outcome: 'expired' };

  const importAs = importAsFor(row, attempt);
  // v1 imports a manual grab as one Unit, so a pack needs numbers that name its season.
  if (importAs && row.parsed.pack !== undefined) return { outcome: 'packNeedsSeason' };
  const unitIds = coveredBy(row, attempt);
  for (const unitId of unitIds) {
    const busy = (await ctx.db.get(unitId))?.activeGrabId;
    if (busy) return { outcome: 'busy', grabId: busy };
  }

  if (row.reason === 'blocklisted') await removeForCandidate(ctx, candidateId);
  await ctx.db.patch(candidateId, { outcome: 'picked', pickedBy: 'user' });
  await transition(ctx, 'searchAttempt', attempt._id, 'picked', { kind: 'decision', message: 'You picked a release.' });
  const grabId = await startGrab(ctx, candidateId, { unitIds, ...(importAs ? { importAs } : {}) });
  await appendEvent(ctx, {
    grabId,
    stage: 'search',
    kind: 'decision',
    message: `You picked ${row.title}.`,
    ...(confirmReason ? { data: { confirmReason } } : {}),
  });
  return { outcome: 'grabbed', grabId };
}
