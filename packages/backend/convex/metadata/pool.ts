// metadataPool: every background sync and source fetch runs here, at
// most 2 at a time, each action retried up to 3 attempts in all, from 30 s
// and doubling (the shape of the job queue's `backoff()`).
import { Workpool } from '@convex-dev/workpool';
import type { MappingSourceName } from '@omnarr/contracts';
import { v } from 'convex/values';

import { components, internal } from '../_generated/api';
import type { DataModel, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { workMetadataOf } from './write';

export const metadataPool = new Workpool(components.metadataPool, {
  maxParallelism: 2,
  retryActionsByDefault: true,
  defaultRetryBehavior: { maxAttempts: 3, initialBackoffMs: 30_000, base: 2 },
});

/**
 * Enqueues a Work's sync, unless one is already enqueued or running for it
 * (one sync per Work at a time). True when it enqueued one.
 */
export async function enqueueSync(ctx: MutationCtx, workId: Id<'works'>): Promise<boolean> {
  const metadata = await workMetadataOf(ctx, workId);
  if (!metadata || metadata.syncWorkId !== undefined) return false;
  const syncWorkId = await metadataPool.enqueueAction(
    ctx,
    internal.metadata.sync.syncWork,
    { workId },
    { onComplete: internal.metadata.pool.syncDone, context: { workId } },
  );
  await ctx.db.patch(metadata._id, { syncWorkId });
  return true;
}

/**
 * A sync finished, after its last attempt: the Work may sync again, and a
 * Work whose first write never succeeded is `failed`. TMDB's health is
 * recorded by the sync itself (`withProvider`).
 */
/** Enqueues a mapping source's fetch and stamps the attempt, so the next tick doesn't enqueue it again. */
export async function enqueueSourceFetch(ctx: MutationCtx, source: MappingSourceName): Promise<void> {
  const fetchFn = {
    animeLists: internal.mapping.animeLists.fetchAnimeLists,
    xem: internal.mapping.xem.fetchHavemap,
    xemNames: internal.mapping.xem.fetchXemNames,
    sceneMapping: internal.mapping.sceneMappings.fetchSceneMappings,
  }[source];
  await metadataPool.enqueueAction(ctx, fetchFn, {});
  const state = await ctx.db
    .query('mappingSourceState')
    .withIndex('by_source', (q) => q.eq('source', source))
    .unique();
  if (state) await ctx.db.patch(state._id, { lastAttemptAt: Date.now() });
  else await ctx.db.insert('mappingSourceState', { source, lastAttemptAt: Date.now() });
}

const syncContext = v.object({ workId: v.id('works') });

export const syncDone = metadataPool.defineOnComplete<DataModel, typeof syncContext>({
  context: syncContext,
  handler: async (ctx, { context, result }) => {
    const metadata = await workMetadataOf(ctx, context.workId);
    if (!metadata) return;
    await ctx.db.patch(metadata._id, {
      syncWorkId: undefined,
      ...(result.kind !== 'success' && metadata.buildState !== 'ready' ? { buildState: 'failed' as const } : {}),
    });
  },
});
