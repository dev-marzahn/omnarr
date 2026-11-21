// Starting and ending scan runs: `start`
// enqueues the worker's read of both library roots, `cancel` stops a run,
// the old run's items go in pages, and the daily cron's schedule check
// starts a periodic run unless a review is in progress.
import type { ScanSchedule, ScanTrigger } from '@omnarr/contracts';
import { zid, zodToConvex, zodToConvexFields } from 'convex-helpers/server/zod4';
import { ConvexError } from 'convex/values';
import { z } from 'zod';

import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { internalMutation, type MutationCtx, type QueryCtx } from '../_generated/server';
import { cancelJob, enqueueJob } from '../jobs/queue';

const DAY_MS = 86_400_000;
/** How long after the last run a schedule is due. */
export const SCHEDULE_INTERVAL_MS: Record<Exclude<ScanSchedule, 'off'>, number> = { daily: DAY_MS, weekly: 7 * DAY_MS };
/** Old items deleted per mutation, to bound the Convex load. */
const DELETE_PAGE = 200;

export const EMPTY_COUNTS = { read: 0, tracked: 0, matched: 0, unmatched: 0, ignored: 0, imported: 0 };

/** The latest run, if any. */
export const latestRun = (ctx: QueryCtx): Promise<Doc<'scanRuns'> | null> => ctx.db.query('scanRuns').order('desc').first();

/** Whether a run is still reading or matching. */
export const isActive = (run: Doc<'scanRuns'> | null): boolean => run !== null && (run.state === 'reading' || run.state === 'matching');

export async function settingsOf(ctx: QueryCtx): Promise<{ schedule: ScanSchedule; lastRunAt?: number; _id?: Id<'scanSettings'> }> {
  const row = await ctx.db.query('scanSettings').first();
  return row ?? { schedule: 'off' };
}

/** The libraries in the scan's order: Series, then Movies. */
export const librariesInOrder = async (ctx: QueryCtx): Promise<Doc<'libraries'>[]> =>
  (await ctx.db.query('libraries').collect()).sort((a, b) => Number(a.kind === 'movies') - Number(b.kind === 'movies'));

/** A library root and the path of a folder under it. */
export const folderPath = (root: string, folder: string): string => (folder === '' ? root : `${root}/${folder}`);

/**
 * `scan.start(trigger)`: refuses while a run is reading or
 * matching, inserts the run, schedules the deletion of older runs' items,
 * and enqueues `scanLibrary` over both library roots with the ignored folders.
 */
export async function startRun(ctx: MutationCtx, trigger: ScanTrigger): Promise<Id<'scanRuns'>> {
  if (isActive(await latestRun(ctx))) throw new ConvexError({ code: 'scanRunning', message: 'A scan is already running.' });
  const scanRunId = await ctx.db.insert('scanRuns', { trigger, state: 'reading', counts: EMPTY_COUNTS, hasDecisions: false });
  await ctx.scheduler.runAfter(0, internal.scan.start.deleteOldItems, { keep: scanRunId });

  const libraries = await librariesInOrder(ctx);
  const ignores: string[] = [];
  for (const library of libraries) {
    const rows = await ctx.db
      .query('scanIgnores')
      .withIndex('by_library', (q) => q.eq('libraryId', library._id))
      .collect();
    ignores.push(...rows.map((row) => folderPath(library.rootPath, row.folder)));
  }
  const jobId = await enqueueJob(ctx, {
    payload: {
      class: 'maintenance',
      action: 'scanLibrary',
      scanRunId,
      roots: libraries.map((library) => ({ libraryId: library._id, path: library.rootPath })),
      ignores,
    },
    idempotencyKey: `scanLibrary:${scanRunId}`,
  });
  await ctx.db.patch(scanRunId, { jobId });

  const settings = await settingsOf(ctx);
  if (settings._id) await ctx.db.patch(settings._id, { lastRunAt: Date.now() });
  else await ctx.db.insert('scanSettings', { schedule: 'off', lastRunAt: Date.now() });
  return scanRunId;
}

/** `scan.cancel`: a reading run's job is cancelled; a matching run stops at its next page. */
export async function cancelRun(ctx: MutationCtx, scanRunId: Id<'scanRuns'>): Promise<void> {
  const run = await ctx.db.get(scanRunId);
  if (!run || !isActive(run)) return;
  if (run.jobId) await cancelJob(ctx, run.jobId);
  await ctx.db.patch(scanRunId, { state: 'cancelled', finishedAt: Date.now() });
}

/** Deletes the items of every run but `keep`, a page at a time. */
export const deleteOldItems = internalMutation({
  args: zodToConvexFields({ keep: zid('scanRuns') }),
  returns: zodToConvex(z.null()),
  handler: async (ctx, { keep }) => {
    const runs = await ctx.db.query('scanRuns').collect();
    let left = DELETE_PAGE;
    for (const run of runs) {
      if (run._id === keep) continue;
      const page = await ctx.db
        .query('scanItems')
        .withIndex('by_run_status', (q) => q.eq('scanRunId', run._id))
        .take(left);
      for (const item of page) await ctx.db.delete(item._id);
      left -= page.length;
      if (left === 0) {
        await ctx.scheduler.runAfter(0, internal.scan.start.deleteOldItems, { keep });
        return null;
      }
    }
    return null;
  },
});

/**
 * The daily cron's check: a `periodic` run when the schedule
 * is due, unless a run is active or the latest one is `ready` with decisions
 * the user made in its review. It never imports.
 */
export const checkSchedule = internalMutation({
  args: {},
  returns: zodToConvex(z.null()),
  handler: async (ctx) => {
    const settings = await settingsOf(ctx);
    if (settings.schedule === 'off') return null;
    if (settings.lastRunAt !== undefined && Date.now() - settings.lastRunAt < SCHEDULE_INTERVAL_MS[settings.schedule] - 60 * 60 * 1000) return null;
    const latest = await latestRun(ctx);
    if (isActive(latest) || (latest?.state === 'ready' && latest.hasDecisions)) return null;
    await startRun(ctx, 'periodic');
    return null;
  },
});
