// The scan's worker functions: the worker sends the
// videos it found in batches and learns which ones no `files` row holds, then
// records those with their probes. Both are fenced on the job's lease.
import { Ack, ScanRecordProbesRequest, ScanReportBatchRequest, ScanReportBatchResponse } from '@omnarr/contracts';
import { parseRelease } from '@omnarr/parser';

import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { fenced } from '../jobs/queue';
import { workerError, workerMutation } from '../lib/functions';

/** The job, if it is this run's leased scan. */
async function scanJob(ctx: MutationCtx, jobId: Id<'jobs'>, leaseEpoch: number, scanRunId: Id<'scanRuns'>): Promise<Doc<'jobs'>> {
  const job = await fenced(ctx, jobId, leaseEpoch);
  if (job.payload?.class !== 'maintenance' || job.payload.action !== 'scanLibrary' || job.payload.scanRunId !== scanRunId)
    throw workerError('invalidResult', { expected: 'maintenance/scanLibrary' });
  return job;
}

/** Whether a `files` row holds this path, or this inode (a hard-linked copy of a tracked file isn't new). */
export async function isTracked(ctx: QueryCtx, path: string, inode: string): Promise<boolean> {
  const byPath = await ctx.db
    .query('files')
    .withIndex('by_path', (q) => q.eq('path', path))
    .first();
  if (byPath) return true;
  const byInode = await ctx.db
    .query('files')
    .withIndex('by_inode', (q) => q.eq('inode', inode))
    .first();
  return byInode !== null;
}

/** The library a path is under, and its Work folder: the first segment below the root, or `''` for a loose file. */
export function placeOf(libraries: Doc<'libraries'>[], path: string): { library: Doc<'libraries'>; folder: string } | null {
  for (const library of libraries) {
    const prefix = `${library.rootPath}/`;
    if (!path.startsWith(prefix)) continue;
    const segments = path.slice(prefix.length).split('/');
    return { library, folder: segments.length > 1 ? segments[0]! : '' };
  }
  return null;
}

/** A video's name without its extension. */
export const stemOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1).replace(/\.[A-Za-z0-9]{2,4}$/, '');

export const reportBatch = workerMutation({
  args: ScanReportBatchRequest.shape,
  returns: ScanReportBatchResponse,
  handler: async (ctx, { jobId, leaseEpoch, scanRunId, entries }) => {
    await scanJob(ctx, jobId, leaseEpoch, scanRunId);
    const untracked: string[] = [];
    for (const { path, inode } of entries) if (!(await isTracked(ctx, path, inode))) untracked.push(path);
    return untracked;
  },
});

export const recordProbes = workerMutation({
  args: ScanRecordProbesRequest.shape,
  returns: Ack,
  handler: async (ctx, { jobId, leaseEpoch, scanRunId, probes }) => {
    await scanJob(ctx, jobId, leaseEpoch, scanRunId);
    const libraries = await ctx.db.query('libraries').collect();
    for (const { path, sizeBytes, inode, probe } of probes) {
      const place = placeOf(libraries, path);
      if (!place) continue;
      const existing = await ctx.db
        .query('scanItems')
        .withIndex('by_run_path', (q) => q.eq('scanRunId', scanRunId).eq('path', path))
        .first();
      if (existing) continue;
      await ctx.db.insert('scanItems', {
        scanRunId,
        libraryId: place.library._id,
        path,
        folder: place.folder,
        sizeBytes,
        inode,
        parsed: parseRelease(stemOf(path), place.library.kind === 'movies' ? 'movie' : 'series'),
        // Matching sets the status; an unreadable file is unmatched for good.
        status: 'unmatched',
        ...(probe ? { probe } : { unmatchedReason: 'unreadable' as const }),
      });
    }
    return null;
  },
});
