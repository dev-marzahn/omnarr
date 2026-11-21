// What a run leaves behind, removed by `maintenance` jobs.
import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { enqueueJob } from '../jobs/queue';

/** Only a folder inside NZBGet's tree goes with its item; the worker checks again. */
const USENET_ROOT = '/data/downloads/usenet/';
const usenetFolder = (path: string | undefined) => (path?.startsWith(USENET_ROOT) && path.length > USENET_ROOT.length ? path : undefined);

/**
 * Removes the Grab's items from their client, with their data. A Usenet
 * download's folder goes by its path, since NZBGet keeps a finished
 * download's files; qBittorrent deletes a torrent's own, and only once no
 * other Grab's tag is left on it, so each removal names its Grab.
 *
 * A completed private torrent stays to seed out its goal
 * even when its Grab failed or was cancelled (a private tracker counts an
 * early removal as hit-and-run); `seedingDone` removes it later.
 */
export async function removeDownloads(ctx: MutationCtx, grabId: Id<'grabs'>): Promise<void> {
  const downloads = await ctx.db
    .query('downloads')
    .withIndex('by_grab', (q) => q.eq('grabId', grabId))
    .collect();
  for (const download of downloads) {
    if (!download.clientRef || download.state === 'removed') continue;
    const torrent = download.clientKind === 'qbittorrent';
    if (torrent && download.state === 'completed' && download.private === true) continue;
    const contentPath = download.clientKind === 'nzbget' ? usenetFolder(download.contentPath) : undefined;
    await enqueueJob(ctx, {
      payload: {
        class: 'maintenance',
        action: 'removeDownload',
        downloadId: download._id,
        clientKind: download.clientKind,
        clientRef: download.clientRef,
        deleteData: true,
        ...(contentPath ? { contentPath } : {}),
        ...(torrent ? { correlationTag: download.correlationTag } : {}),
      },
      idempotencyKey: `removeDownload:${download._id}`,
      grabId,
    });
  }
}

/** Removes the import's staging folders. */
export async function cleanStaging(ctx: MutationCtx, grabId: Id<'grabs'>): Promise<void> {
  const imports = await ctx.db
    .query('importJobs')
    .withIndex('by_grab', (q) => q.eq('grabId', grabId))
    .collect();
  if (imports.length === 0) return;
  await enqueueJob(ctx, {
    payload: { class: 'maintenance', action: 'cleanStaging', paths: imports.map((row) => row.stagingPath) },
    idempotencyKey: `cleanStaging:${grabId}`,
    grabId,
  });
}
