// Pacing: a site indexer's requests are at least its interval
// apart, across every action that calls it at once and the worker's engine.
// `reserve` hands out the next slot; Convex runs mutations serializably, so
// two searches never get the same one. A slot more than 5 minutes away isn't
// taken: the caller skips the indexer (`paced`).
import { definitionIntervalMs, type IndexerKind, type IndexerSite } from '@omnarr/contracts';
import { v } from 'convex/values';

import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { type ActionCtx, internalMutation, type MutationCtx } from '../_generated/server';
import { limits } from '../lib/limits';

export const MAX_PACING_WAIT_MS = 5 * 60_000;

/**
 * A site indexer's minimum interval between two requests: Nyaa's 5 s (Q8); a
 * definition's max(2 s, requestDelay). Undefined for Newznab and
 * Torznab, which aren't paced.
 */
export function pacingIntervalOf(indexer: { kind: IndexerKind; site?: Pick<IndexerSite, 'requestDelayMs'> }): number | undefined {
  if (indexer.kind === 'nyaa') return limits().nyaaIntervalMs;
  if (indexer.kind === 'definition') return definitionIntervalMs((indexer.site?.requestDelayMs ?? 0) / 1000, limits().definitionMinIntervalMs);
  return undefined;
}

/** A site not yet saved as an indexer: its pre-save test is paced by the site's own row. */
export type PacedSite = 'nyaa';

type Reservation = { waitMs: number } | { skip: true };
type PacingRow = { _id: Id<'indexerPacing'>; nextAt: number };

async function takeSlot(
  ctx: MutationCtx,
  row: PacingRow | null,
  intervalMs: number,
  longestWaitMs: number,
  insert: (nextAt: number) => Promise<unknown>,
): Promise<Reservation> {
  const now = Date.now();
  const slot = Math.max(now, row?.nextAt ?? now);
  if (slot - now > longestWaitMs) return { skip: true as const };
  if (row) await ctx.db.patch(row._id, { nextAt: slot + intervalMs });
  else await insert(slot + intervalMs);
  return { waitMs: slot - now };
}

const indexerRow = (ctx: MutationCtx, indexerId: Id<'indexers'>) =>
  ctx.db
    .query('indexerPacing')
    .withIndex('by_indexer', (q) => q.eq('indexerId', indexerId))
    .unique();

const siteRow = (ctx: MutationCtx, site: PacedSite) =>
  ctx.db
    .query('indexerPacing')
    .withIndex('by_site', (q) => q.eq('site', site))
    .unique();

export async function reserveSlot(ctx: MutationCtx, indexerId: Id<'indexers'>, intervalMs: number, longestWaitMs: number): Promise<Reservation> {
  return await takeSlot(ctx, await indexerRow(ctx, indexerId), intervalMs, longestWaitMs, (nextAt) => ctx.db.insert('indexerPacing', { indexerId, nextAt }));
}

const reservation = v.union(v.object({ waitMs: v.number() }), v.object({ skip: v.literal(true) }));

export const reserve = internalMutation({
  args: { indexerId: v.id('indexers'), intervalMs: v.number(), longestWaitMs: v.number() },
  returns: reservation,
  handler: (ctx, { indexerId, intervalMs, longestWaitMs }) => reserveSlot(ctx, indexerId, intervalMs, longestWaitMs),
});

/**
 * The slot of a site not yet saved: repeated pre-save tests share it.
 * A row a test leaves behind blocks nothing once its `nextAt` has passed,
 * which is at most 5 minutes and one interval away.
 */
export const reserveSite = internalMutation({
  args: { site: v.literal('nyaa'), intervalMs: v.number() },
  returns: reservation,
  handler: async (ctx, { site, intervalMs }) =>
    await takeSlot(ctx, await siteRow(ctx, site), intervalMs, MAX_PACING_WAIT_MS, (nextAt) => ctx.db.insert('indexerPacing', { site, nextAt })),
});

/**
 * The site was saved as `indexerId`: the site's row becomes the indexer's, so
 * the next request waits for the slot after the pre-save test's. Without a
 * site row, the indexer takes a fresh slot.
 */
export const adoptSite = internalMutation({
  args: { site: v.literal('nyaa'), indexerId: v.id('indexers'), intervalMs: v.number() },
  returns: v.null(),
  handler: async (ctx, { site, indexerId, intervalMs }) => {
    const row = await siteRow(ctx, site);
    if (row && !(await indexerRow(ctx, indexerId))) await ctx.db.patch(row._id, { indexerId, site: undefined });
    else {
      if (row) await ctx.db.delete(row._id);
      await reserveSlot(ctx, indexerId, intervalMs, MAX_PACING_WAIT_MS);
    }
    return null;
  },
});

async function waitFor(slot: Reservation): Promise<'go' | 'skip'> {
  if ('skip' in slot) return 'skip';
  if (slot.waitMs > 0) await new Promise((resolve) => setTimeout(resolve, slot.waitMs));
  return 'go';
}

/** For actions: takes a slot and waits for it. `skip` when the slot was refused. */
export async function paced(ctx: Pick<ActionCtx, 'runMutation'>, indexerId: Id<'indexers'>, intervalMs: number, longestWaitMs: number): Promise<'go' | 'skip'> {
  return await waitFor(await ctx.runMutation(internal.indexers.pacing.reserve, { indexerId, intervalMs, longestWaitMs }));
}

/** `paced` for a site not yet saved. */
export async function pacedSite(ctx: Pick<ActionCtx, 'runMutation'>, site: PacedSite, intervalMs: number): Promise<'go' | 'skip'> {
  return await waitFor(await ctx.runMutation(internal.indexers.pacing.reserveSite, { site, intervalMs }));
}

/** With the indexer: its pacing row goes too. */
export async function deletePacing(ctx: MutationCtx, indexerId: Id<'indexers'>): Promise<void> {
  const row = await ctx.db
    .query('indexerPacing')
    .withIndex('by_indexer', (q) => q.eq('indexerId', indexerId))
    .unique();
  if (row) await ctx.db.delete(row._id);
}
