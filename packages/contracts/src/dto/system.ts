// System DTOs: the indexer health the `indexers` table stores,
// and `system.status` for the System page and the worker banner.
import { zid } from 'convex-helpers/server/zod4';
import { z } from 'zod';

import { ClientConfigState, ConnectionStatus } from '../downloadClients.ts';
import { FailureCode, IndexerFailureKind, SiteChallenge } from '../failures.ts';
import { ClientKind, JobClass, StorageArea } from '../kinds.ts';
import { VpnRuntime } from '../vpn.ts';
import { JellyfinStatus } from './jellyfin.ts';

/** How one indexer call went (`searchAttempts.indexerResults`). */
export const IndexerCallStatus = z.enum(['ok', 'timeout', 'rateLimited', 'error']);
export type IndexerCallStatus = z.infer<typeof IndexerCallStatus>;

/** An indexer's health on the System and Indexers pages, from its last call. */
export const IndexerHealth = z.object({
  status: z.union([IndexerCallStatus, z.literal('unknown')]),
  checkedAt: z.number().optional(),
  failureCode: FailureCode.optional(),
  detail: z
    .object({
      kind: IndexerFailureKind,
      httpStatus: z.number().optional(),
      errorCode: z.number().optional(),
      challenge: SiteChallenge.optional(),
      /** A site search that was redirected: the host it was sent to. */
      redirectHost: z.string().optional(),
    })
    .optional(),
  latencyMs: z.number().optional(),
  lastSearch: z.object({ at: z.number(), status: IndexerCallStatus, count: z.number() }).optional(),
  lastRss: z.object({ at: z.number(), newItems: z.number(), matched: z.number() }).optional(),
});
export type IndexerHealth = z.infer<typeof IndexerHealth>;

/** The newest worker session: connected or not, and its version against the backend's. */
export const WorkerStatus = z
  .object({
    workerId: z.string(),
    /** Seen within the liveness window (60 s) on an accepted session. */
    connected: z.boolean(),
    accepted: z.boolean(),
    protocolVersion: z.number(),
    expectedVersion: z.number(),
    connectedAt: z.number(),
    lastSeenAt: z.number(),
    ffmpegVersion: z.string(),
    encoders: z.array(z.string()),
  })
  .strict();
export type WorkerStatus = z.infer<typeof WorkerStatus>;

/**
 * The /data areas from the worker's last heartbeat: free bytes,
 * device and whether the last write check passed, per area, and whether
 * imports can hard-link (`downloadsSameDevice`) and renames are atomic
 * (`librarySameDevice`: staging, originals and both libraries on one device).
 */
export const StorageStatus = z
  .object({
    areas: z.record(StorageArea, z.object({ freeBytes: z.number(), device: z.string(), writable: z.boolean() }).strict()),
    librarySameDevice: z.boolean(),
    downloadsSameDevice: z.boolean(),
    reportedAt: z.number(),
  })
  .strict();
export type StorageStatus = z.infer<typeof StorageStatus>;

/**
 * A download client on the System page: its `downloadClients` row,
 * the worker's last report, and its active Downloads. qBittorrent's row adds
 * its seeding torrents, their problems, the connection status and the peer
 * port, and the VPN line.
 */
export const ClientStatusRow = z
  .object({
    clientKind: ClientKind,
    enabled: z.boolean(),
    reachable: z.boolean(),
    clientVersion: z.string().optional(),
    config: ClientConfigState,
    activeDownloads: z.number(),
    seedingCount: z.number().optional(),
    seedingProblemCount: z.number().optional(),
    connectionStatus: ConnectionStatus.optional(),
    peerPort: z.number().optional(),
    /** qBittorrent only, once the worker has reported its VPN state. */
    vpn: VpnRuntime.omit({ checkedAt: true }).strict().optional(),
  })
  .strict();
export type ClientStatusRow = z.infer<typeof ClientStatusRow>;

export const JobCount = z.object({ class: JobClass, queued: z.number(), waiting: z.number(), leased: z.number() }).strict();
/**
 * One row per class, read through `jobs.by_status_class`; each count is
 * capped at `QUEUE_COUNT_CAP`. A list, not a record by class: Convex field names
 * can't hold the `.` of `download.submit`.
 */
export const JobCounts = z.array(JobCount);
export type JobCounts = z.infer<typeof JobCounts>;

/** The latest support bundle. */
export const SupportBundle = z.object({ builtAt: z.number(), expiresAt: z.number(), url: z.string() }).strict();
export type SupportBundle = z.infer<typeof SupportBundle>;

/** The one banner every page shows: a version mismatch wins over offline. */
export const WorkerBanner = z.enum(['protocolMismatch', 'workerOffline']);
export type WorkerBanner = z.infer<typeof WorkerBanner>;

export const IndexerStatusRow = z.object({ indexerId: zid('indexers'), name: z.string(), enabled: z.boolean(), health: IndexerHealth }).strict();

/**
 * `system.librarySize`: the bytes the library's tracked files take, each
 * inode once (a hardlink or a second row is the same data), by Work kind.
 * Measured when asked, not live: `measuredAt` says when.
 */
export const LibrarySize = z.object({ totalBytes: z.number(), seriesBytes: z.number(), moviesBytes: z.number(), measuredAt: z.number() }).strict();
export type LibrarySize = z.infer<typeof LibrarySize>;

/** `system.status`. */
export const SystemStatus = z
  .object({
    banner: WorkerBanner.optional(),
    worker: WorkerStatus.optional(),
    indexers: z.array(IndexerStatusRow),
    clients: z.array(ClientStatusRow),
    storage: StorageStatus.optional(),
    jobCounts: JobCounts,
    supportBundle: SupportBundle.optional(),
    /** Jellyfin's setup and version, without the key. */
    jellyfin: JellyfinStatus,
    /**
     * The release the deployment last applied (`CONVEX_RELEASE_VERSION`), and
     * from the daily update check a newer release with its page.
     */
    release: z.object({ version: z.string(), latest: z.string().optional(), releaseUrl: z.string().optional() }).strict(),
  })
  .strict();
export type SystemStatus = z.infer<typeof SystemStatus>;
