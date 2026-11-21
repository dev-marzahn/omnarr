// The artifact TTL: job artifacts, a failed
// prepare's ffmpeg log or a support bundle, are deleted from file storage
// after `artifactTtlMs`, and the job's `artifactStorageId` is cleared.
import { DEFAULT_LIMITS } from '@omnarr/contracts';
import { v } from 'convex/values';

import { internal } from '../_generated/api';
import { internalMutation } from '../_generated/server';

const PAGE = 100;

/**
 * Run hourly by `ttl.artifacts` (crons.ts). The oldest files are read
 * straight from `_storage`, which also removes a file a later attempt's
 * artifact replaced on its job. TMDB images live in file storage too and
 * are kept: their sync refreshes them. The files are read a
 * page at a time, so a page of images doesn't stop the artifacts behind it.
 */
export const expire = internalMutation({
  args: { cursor: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { cursor }) => {
    const cutoff = Date.now() - DEFAULT_LIMITS.artifactTtlMs;
    const page = await ctx.db.system
      .query('_storage')
      .withIndex('by_creation_time', (q) => q.lt('_creationTime', cutoff))
      .paginate({ cursor: cursor ?? null, numItems: PAGE });
    for (const file of page.page) {
      const image = await ctx.db
        .query('images')
        .withIndex('by_storage', (q) => q.eq('storageId', file._id))
        .first();
      if (image) continue;
      const jobs = await ctx.db
        .query('jobs')
        .withIndex('by_artifact', (q) => q.eq('artifactStorageId', file._id))
        .collect();
      for (const job of jobs) await ctx.db.patch(job._id, { artifactStorageId: undefined });
      await ctx.storage.delete(file._id);
    }
    if (!page.isDone) await ctx.scheduler.runAfter(0, internal.jobs.artifacts.expire, { cursor: page.continueCursor });
    return null;
  },
});
