// The System page and the worker banner.
import {
  BuildSupportBundleResponse,
  type Capabilities,
  type ClientKind,
  DEFAULT_LIMITS,
  JOB_CLASSES,
  type JobCounts,
  LibrarySize,
  PROTOCOL_VERSION,
  QUEUE_COUNT_CAP,
  type StorageStatus,
  SystemStatus,
} from '@omnarr/contracts';

import type { Doc } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { configState } from '../downloadClients/store';
import { enqueueJob } from '../jobs/queue';
import { librarySameDevice } from '../jobs/worker';
import { adminAction, adminMutation, adminQuery } from '../lib/functions';
import { librarySizeOf } from '../library/size';
import { settingsRow } from '../setup/settings';
import { updateCheckOf } from '../updates';
import { jellyfinStatusOf } from './jellyfin';

/** The System page's VPN line: the reading without its check time. */
const vpnLine = ({ checkedAt: _checkedAt, ...line }: NonNullable<NonNullable<Doc<'downloadClients'>['status']>['vpn']>) => line;

/** The one banner: a version mismatch wins over offline. */
async function bannerOf(ctx: QueryCtx): Promise<SystemStatus['banner']> {
  const open = await ctx.db
    .query('issues')
    .withIndex('by_state_scope', (q) => q.eq('state', 'open').eq('scope', 'system'))
    .collect();
  if (open.some((issue) => issue.failureCode === 'protocolMismatch')) return 'protocolMismatch';
  if (open.some((issue) => issue.failureCode === 'workerOffline')) return 'workerOffline';
  return undefined;
}

async function jobCountsOf(ctx: QueryCtx): Promise<JobCounts> {
  const counts: JobCounts = [];
  for (const cls of JOB_CLASSES) {
    const count = async (status: 'queued' | 'waiting' | 'leased') =>
      (
        await ctx.db
          .query('jobs')
          .withIndex('by_status_class', (q) => q.eq('status', status).eq('class', cls))
          .take(QUEUE_COUNT_CAP)
      ).length;
    counts.push({ class: cls, queued: await count('queued'), waiting: await count('waiting'), leased: await count('leased') });
  }
  return counts;
}

/**
 * The /data areas from the session's last report: renames need the
 * library areas on one device; downloads on another only make imports copy
 * instead of hard-linking ("Downloads and library are on different filesystems").
 */
function storageOf(session: Doc<'workerSessions'>, { storage }: Capabilities): StorageStatus {
  return {
    areas: storage,
    librarySameDevice: librarySameDevice(storage),
    downloadsSameDevice: storage.downloads.device === storage.staging.device,
    reportedAt: session.lastSeenAt,
  };
}

/** Maintenance jobs of one action, still to run: queued, waiting or leased. */
async function pendingMaintenance(ctx: QueryCtx, action: 'buildSupportBundle'): Promise<Doc<'jobs'> | null> {
  for (const status of ['queued', 'waiting', 'leased'] as const) {
    const jobs = await ctx.db
      .query('jobs')
      .withIndex('by_status_class', (q) => q.eq('status', status).eq('class', 'maintenance'))
      .collect();
    const found = jobs.find((job) => job.payload?.class === 'maintenance' && job.payload.action === action);
    if (found) return found;
  }
  return null;
}

/** The newest finished support bundle that is still stored (kept 14 days). */
async function supportBundleOf(ctx: QueryCtx): Promise<SystemStatus['supportBundle']> {
  const done = await ctx.db
    .query('jobs')
    .withIndex('by_status_class', (q) => q.eq('status', 'done').eq('class', 'maintenance'))
    .order('desc')
    .filter((q) => q.neq(q.field('artifactStorageId'), undefined))
    .first();
  if (!done?.artifactStorageId) return undefined;
  const url = await ctx.storage.getUrl(done.artifactStorageId);
  const file = await ctx.db.system.get(done.artifactStorageId);
  if (!url || !file) return undefined;
  return { builtAt: file._creationTime, expiresAt: file._creationTime + DEFAULT_LIMITS.artifactTtlMs, url };
}

/** System's "Support bundle": queues a build, or returns the one still to run. */
export const buildSupportBundle = adminMutation({
  args: {},
  returns: BuildSupportBundleResponse,
  handler: async (ctx) => {
    const pending = await pendingMaintenance(ctx, 'buildSupportBundle');
    if (pending) return { jobId: pending._id };
    const jobId = await enqueueJob(ctx, {
      payload: { class: 'maintenance', action: 'buildSupportBundle' },
      idempotencyKey: `buildSupportBundle:${Date.now()}`,
    });
    return { jobId };
  },
});

/**
 * System › Free space's "Library" rows: what the tracked files take, by
 * kind. An action the page calls when it opens, not part of `status`: the
 * sum reads every file, too much for a reactive read.
 */
export const librarySize = adminAction({
  args: {},
  returns: LibrarySize,
  handler: (ctx) => librarySizeOf(ctx),
});

export const status = adminQuery({
  args: {},
  returns: SystemStatus,
  handler: (ctx) => systemStatusOf(ctx),
});

/** `system.status`, which the support bundle includes too. */
export async function systemStatusOf(ctx: QueryCtx): Promise<SystemStatus> {
  const now = Date.now();
  const session = await ctx.db.query('workerSessions').withIndex('by_last_seen').order('desc').first();
  // ffmpeg, the encoders and storage come from the newest accepted session; a rejected one stores none.
  const accepted = session?.accepted
    ? session
    : await ctx.db
        .query('workerSessions')
        .withIndex('by_last_seen')
        .order('desc')
        .filter((q) => q.eq(q.field('accepted'), true))
        .first();
  const capabilities = accepted?.capabilities;
  const indexers = await ctx.db.query('indexers').collect();
  const active = await ctx.db
    .query('downloads')
    .withIndex('by_state', (q) => q.eq('state', 'active'))
    .collect();
  const rows = await ctx.db.query('downloadClients').collect();
  // Completed torrents are the seeding ones; a missing Work doesn't matter here.
  const seeding = (
    await ctx.db
      .query('downloads')
      .withIndex('by_state', (q) => q.eq('state', 'completed'))
      .collect()
  ).filter((download) => download.clientKind === 'qbittorrent').length;
  // NZBGet is always shown; qBittorrent once its row exists or it holds a Download.
  const activeOf = (clientKind: ClientKind) => active.filter((download) => download.clientKind === clientKind).length;
  const clients = (['nzbget', 'qbittorrent'] as const)
    .filter((clientKind) => clientKind === 'nzbget' || rows.some((row) => row.kind === clientKind) || activeOf(clientKind) > 0 || seeding > 0)
    .map((clientKind) => {
      const row = rows.find((candidate) => candidate.kind === clientKind) ?? null;
      const torrent = clientKind === 'qbittorrent';
      return {
        clientKind,
        // Without a row torrents are on; NZBGet needs a saved provider.
        enabled: row?.enabled ?? torrent,
        reachable: row?.status?.reachable ?? false,
        ...(row?.clientVersion ? { clientVersion: row.clientVersion } : {}),
        config: configState(row),
        activeDownloads: activeOf(clientKind),
        ...(torrent ? { seedingCount: seeding, seedingProblemCount: row?.status?.seedingProblems?.length ?? 0 } : {}),
        ...(row?.status?.connectionStatus ? { connectionStatus: row.status.connectionStatus } : {}),
        ...(row?.status?.peerPort !== undefined ? { peerPort: row.status.peerPort } : {}),
        ...(torrent && row?.status?.vpn ? { vpn: vpnLine(row.status.vpn) } : {}),
      };
    });
  const banner = await bannerOf(ctx);
  const supportBundle = await supportBundleOf(ctx);
  // convex-release records the applied release; `convex-release deploy` doesn't.
  const version = process.env.CONVEX_RELEASE_VERSION || '0.0.0-dev';
  return {
    ...(banner ? { banner } : {}),
    ...(session
      ? {
          worker: {
            workerId: session.workerId,
            connected: session.accepted && session.lastSeenAt > now - DEFAULT_LIMITS.livenessMs,
            accepted: session.accepted,
            protocolVersion: session.protocolVersion,
            expectedVersion: PROTOCOL_VERSION,
            connectedAt: session.connectedAt,
            lastSeenAt: session.lastSeenAt,
            ffmpegVersion: capabilities?.ffmpegVersion ?? '',
            encoders: capabilities?.encoders ?? [],
          },
          ...(accepted && capabilities ? { storage: storageOf(accepted, capabilities) } : {}),
        }
      : {}),
    indexers: indexers.map((row) => ({ indexerId: row._id, name: row.name, enabled: row.enabled, health: row.health })),
    clients,
    jobCounts: await jobCountsOf(ctx),
    jellyfin: await jellyfinStatusOf(ctx),
    ...(supportBundle ? { supportBundle } : {}),
    release: { version, check: updateCheckOf(version, (await settingsRow(ctx))?.updateCheck) },
  };
}
