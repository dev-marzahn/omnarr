// The download reconciler's side of the worker contract:
// the reports it sends for changed downloads, and the active Downloads it
// compares its clients' items with.
import { Ack, DownloadProgressRequest, DownloadReportRequest, OrphansRequest, WatchedDownloads, WatchedDownloadsRequest } from '@omnarr/contracts';

import { workerMutation, workerQuery } from '../lib/functions';
import { raiseIssue } from '../lib/issues';
import { downloadDone, downloadProgress, seedingEnded } from './results';
import { acceptedSession } from './worker';

/**
 * The progress-only poll: every 5 s while a Download is
 * active, one batch of the Downloads whose percent, bytes or speed changed.
 * Only an active Download's client status is written; no event, no stage, no
 * recompute. Stages and outcomes stay with `report`.
 */
export const progress = workerMutation({
  args: DownloadProgressRequest.shape,
  returns: Ack,
  handler: async (ctx, { sessionId, progress: entries }) => {
    await acceptedSession(ctx, sessionId);
    for (const { downloadId, clientStatus } of entries) {
      const download = await ctx.db.get(downloadId);
      if (download?.state === 'active') await ctx.db.patch(download._id, { clientStatus });
    }
    return null;
  },
});

/**
 * Applies each changed entry. For an `active` Download: a new client stage, or
 * the download's end. For a `completed` torrent: its seeding outcomes,
 * and, without an outcome, its seeding progress until the goal is met; any
 * other outcome on it is ignored.
 */
export const report = workerMutation({
  args: DownloadReportRequest.shape,
  returns: Ack,
  handler: async (ctx, { sessionId, reports }) => {
    await acceptedSession(ctx, sessionId);
    for (const entry of reports) {
      const download = await ctx.db.get(entry.downloadId);
      if (!download) continue;
      if (download.state === 'completed') {
        if (entry.outcome === 'seedingDone' || entry.outcome === 'seedingLost') await seedingEnded(ctx, download, { ...entry, outcome: entry.outcome });
        // Seeding progress: a torrent still seeding keeps its latest reading.
        else if (!entry.outcome && download.seedingDoneAt === undefined) await ctx.db.patch(download._id, { clientStatus: entry.clientStatus });
        continue;
      }
      if (download.state !== 'active') continue;
      if (entry.outcome === 'seedingDone' || entry.outcome === 'seedingLost') continue;
      if (entry.outcome) await downloadDone(ctx, download, { ...entry, outcome: entry.outcome });
      else await downloadProgress(ctx, download, entry);
    }
    return null;
  },
});

/**
 * The startup reconciliation's client items that match no active Download:
 * those whose tag names no Grab are raised as one deduplicated
 * `orphanClientItem` Issue. They are never deleted silently; the Issue's
 * `removeClientItem` removes them. Items of a finished Grab are the
 * platform's own and stay out of it.
 */
export const orphans = workerMutation({
  args: OrphansRequest.shape,
  returns: Ack,
  handler: async (ctx, { sessionId, items }) => {
    await acceptedSession(ctx, sessionId);
    const stray = [];
    for (const item of items) {
      const tag = item.correlationTag;
      const known =
        tag !== undefined &&
        (await ctx.db
          .query('downloads')
          .withIndex('by_correlation_tag', (q) => q.eq('correlationTag', tag))
          .first()) !== null;
      if (!known) stray.push(item);
    }
    if (stray.length > 0)
      await raiseIssue(ctx, {
        code: 'orphanClientItem',
        detail: stray
          .map((item) => `${item.clientKind} ${item.clientRef}: ${item.name}`)
          .join('\n')
          .slice(0, 2000),
        orphanItems: stray,
      });
    return null;
  },
});

/**
 * The Downloads the reconciler watches, with their correlation tags, for its
 * comparison and the startup reconciliation: every `active` one, and every
 * `completed` torrent until it is removed. One worker per installation holds
 * few at a time, and seeding torrents are bounded by disk, so they're read whole.
 */
export const watched = workerQuery({
  args: WatchedDownloadsRequest.shape,
  returns: WatchedDownloads,
  handler: async (ctx, { sessionId }) => {
    await acceptedSession(ctx, sessionId);
    const active = await ctx.db
      .query('downloads')
      .withIndex('by_state', (q) => q.eq('state', 'active'))
      .collect();
    const seeding = (
      await ctx.db
        .query('downloads')
        .withIndex('by_state', (q) => q.eq('state', 'completed'))
        .collect()
    ).filter((row) => row.clientKind === 'qbittorrent');
    return [...active, ...seeding].map((row) => ({
      downloadId: row._id,
      clientKind: row.clientKind,
      ...(row.clientRef ? { clientRef: row.clientRef } : {}),
      correlationTag: row.correlationTag,
      clientStage: row.clientStage,
      state: row.state as 'active' | 'completed',
      ...(row.seedGoal ? { seedGoal: row.seedGoal } : {}),
    }));
  },
});
