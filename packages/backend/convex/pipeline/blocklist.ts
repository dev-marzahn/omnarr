// The blocklist: releases never grabbed again
// for a Work, keyed by GUID or info hash, and by normalized title.
import type { BlocklistReason, IndexerItem } from '@omnarr/contracts';
import { normalizeReleaseTitle } from '@omnarr/parser';
import { releaseKeyOf } from '@omnarr/scoring';

import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';

/** Both keys of every entry for the Work, as `evaluate` checks them. */
export async function keysForWork(ctx: QueryCtx, workId: Id<'works'>): Promise<{ releaseKeys: string[]; normalizedTitles: string[] }> {
  const rows = await ctx.db
    .query('blocklist')
    .withIndex('by_work_key', (q) => q.eq('workId', workId))
    .collect();
  return {
    releaseKeys: rows.map((row) => row.releaseKey),
    normalizedTitles: rows.map((row) => row.normalizedTitle).filter((title) => title !== undefined),
  };
}

/**
 * Availability failures:
 * they say only that this post, file or swarm can't be had, nothing about the
 * release's content. They are blocklisted by the release key alone, so a
 * repost under a new GUID or another protocol's copy of the same title stays
 * open. Every other reason keeps both keys.
 */
const AVAILABILITY_FAILURES: ReadonlySet<BlocklistReason> = new Set<BlocklistReason>(['missingArticles', 'releaseFileInvalid', 'torrentStalled']);

/** Adds a release to the Work's blocklist, once per key; an availability failure by its release key only. */
export async function addToBlocklist(
  ctx: MutationCtx,
  entry: { workId: Id<'works'>; item: Pick<IndexerItem, 'guid' | 'title' | 'protocol' | 'torrent'>; reason: BlocklistReason; grabId?: Id<'grabs'> },
): Promise<Id<'blocklist'>> {
  const releaseKey = releaseKeyOf(entry.item as IndexerItem);
  const existing = await ctx.db
    .query('blocklist')
    .withIndex('by_work_key', (q) => q.eq('workId', entry.workId).eq('releaseKey', releaseKey))
    .first();
  if (existing) return existing._id;
  return await ctx.db.insert('blocklist', {
    workId: entry.workId,
    releaseKey,
    ...(AVAILABILITY_FAILURES.has(entry.reason) ? {} : { normalizedTitle: normalizeReleaseTitle(entry.item.title) }),
    title: entry.item.title,
    protocol: entry.item.protocol,
    reason: entry.reason,
    ...(entry.grabId ? { grabId: entry.grabId } : {}),
  });
}

/** "Unblock release" on the Work page and in Settings › Blocklist: removes the one entry, if it's still there; nothing is grabbed. */
export async function unblockEntry(ctx: MutationCtx, entryId: Id<'blocklist'>): Promise<void> {
  if (await ctx.db.get(entryId)) await ctx.db.delete(entryId);
}

/** The Work's entries for a candidate's release, by either key. */
async function entriesFor(ctx: QueryCtx, candidateId: Id<'candidates'>): Promise<Doc<'blocklist'>[]> {
  const candidate = await ctx.db.get(candidateId);
  const attempt = candidate && (await ctx.db.get(candidate.searchAttemptId));
  if (!candidate || !attempt) return [];
  const releaseKey = releaseKeyOf(candidate as unknown as IndexerItem);
  const byKey = await ctx.db
    .query('blocklist')
    .withIndex('by_work_key', (q) => q.eq('workId', attempt.workId).eq('releaseKey', releaseKey))
    .collect();
  const byTitle = await ctx.db
    .query('blocklist')
    .withIndex('by_work_title', (q) => q.eq('workId', attempt.workId).eq('normalizedTitle', normalizeReleaseTitle(candidate.title)))
    .collect();
  return [...new Map([...byKey, ...byTitle].map((row) => [row._id, row])).values()];
}

/** The oldest entry that blocks a candidate's release, if any: when and why it was blocklisted. */
export async function blocklistEntryFor(ctx: QueryCtx, candidateId: Id<'candidates'>): Promise<Doc<'blocklist'> | null> {
  const rows = await entriesFor(ctx, candidateId);
  return rows.sort((a, b) => a._creationTime - b._creationTime)[0] ?? null;
}

/** Removes the entries a candidate's release left (`grabCandidate`, `retryRelease`, `blocklistRemove`). */
export async function removeForCandidate(ctx: MutationCtx, candidateId: Id<'candidates'>): Promise<void> {
  for (const row of await entriesFor(ctx, candidateId)) await ctx.db.delete(row._id);
}
