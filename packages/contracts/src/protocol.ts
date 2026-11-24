// The worker protocol: what the worker sends and gets back.
// Every worker call carries `WorkerCall`; the backend's worker wrappers check
// it before the function's own arguments.
import { zid } from 'convex-helpers/server/zod4';
import { z } from 'zod';

import { FailureCode, JellyfinSetupReason } from './failures.ts';
import { SetupStep } from './jellyfin.ts';
import { ClientKind, ClientStage, ClientStatus, JobClass, JobPayload, JobResult } from './jobs.ts';
import { STORAGE_AREAS, StorageArea } from './kinds.ts';
import { ActivePlay, ProbeSummary } from './playback.ts';
import { SeedGoal } from './seedGoal.ts';

/** Rises on any breaking change to this package. */
export const PROTOCOL_VERSION = 3;

/** The arguments every worker call carries. */
export const WorkerCall = z.object({
  workerToken: z.string(),
  protocolVersion: z.number(),
});
export type WorkerCall = z.infer<typeof WorkerCall>;

/** Codes of the `ConvexError`s worker calls throw, in `error.data.code`. */
export const WorkerErrorCode = z.enum(['unauthorized', 'protocolMismatch', 'sessionNotAccepted', 'staleLease', 'invalidResult', 'invalidCapabilities']);
export type WorkerErrorCode = z.infer<typeof WorkerErrorCode>;

export { STORAGE_AREAS, StorageArea };

/** One area's free bytes (`statfs`) and device (`stat`), as the heartbeat sends them. */
export const AreaSpace = z.object({ freeBytes: z.number(), device: z.string() });
export type AreaSpace = z.infer<typeof AreaSpace>;
export const StorageSpace = z.object(Object.fromEntries(STORAGE_AREAS.map((area) => [area, AreaSpace])) as Record<StorageArea, typeof AreaSpace>);
export type StorageSpace = z.infer<typeof StorageSpace>;

/** At connect and after a write failure, also whether each area is writable. */
export const AreaStorage = AreaSpace.extend({ writable: z.boolean() });
export type AreaStorage = z.infer<typeof AreaStorage>;
export const Storage = z.object(Object.fromEntries(STORAGE_AREAS.map((area) => [area, AreaStorage])) as Record<StorageArea, typeof AreaStorage>);
export type Storage = z.infer<typeof Storage>;

export const Capabilities = z.object({
  ffmpegVersion: z.string(),
  encoders: z.array(z.string()),
  storage: Storage,
});
export type Capabilities = z.infer<typeof Capabilities>;

export const ConnectRequest = z.object({
  workerId: z.string(),
  protocolVersion: z.number(),
  /**
   * The worker sends `Capabilities`; the backend parses it only once the
   * versions match, so a worker of another release always reaches the
   * version check.
   */
  capabilities: z.unknown(),
});
export type ConnectRequest = z.infer<typeof ConnectRequest>;

export const ConnectResponse = z.discriminatedUnion('accepted', [
  z.object({ accepted: z.literal(true), sessionId: zid('workerSessions') }),
  z.object({ accepted: z.literal(false), expectedVersion: z.number() }),
]);
export type ConnectResponse = z.infer<typeof ConnectResponse>;

export const HeartbeatRequest = z.object({
  sessionId: zid('workerSessions'),
  storage: StorageSpace,
  /** The write check's result when it ran again since the last beat, after an `EACCES` or `EROFS` job failure. */
  writable: z.record(StorageArea, z.boolean()).optional(),
});
export type HeartbeatRequest = z.infer<typeof HeartbeatRequest>;

export const HeartbeatResponse = z.object({
  /** Leased jobs of this session the user cancelled: abort them and `fail(…, 'cancelled')`. */
  cancelJobIds: z.array(zid('jobs')),
  leaseExpiresAt: z.number(),
});
export type HeartbeatResponse = z.infer<typeof HeartbeatResponse>;

export const QueueRequest = z.object({ classes: z.array(JobClass) });
export type QueueRequest = z.infer<typeof QueueRequest>;

/** Claimable jobs per requested class. A count is capped at `QUEUE_COUNT_CAP`. */
export const QueueCounts = z.array(z.object({ class: JobClass, count: z.number() }));
export type QueueCounts = z.infer<typeof QueueCounts>;
export const QUEUE_COUNT_CAP = 100;

export const ClaimRequest = z.object({
  sessionId: zid('workerSessions'),
  class: JobClass,
  max: z.number().int().min(1).max(QUEUE_COUNT_CAP),
});
export type ClaimRequest = z.infer<typeof ClaimRequest>;

export const LeasedJob = z.object({
  jobId: zid('jobs'),
  class: JobClass,
  leaseEpoch: z.number(),
  payload: JobPayload,
});
export type LeasedJob = z.infer<typeof LeasedJob>;

export const ClaimResponse = z.array(LeasedJob);
export type ClaimResponse = z.infer<typeof ClaimResponse>;

/** Every call about a leased job names it with the `leaseEpoch` it was claimed at (fencing). */
export const Lease = z.object({ jobId: zid('jobs'), leaseEpoch: z.number() });
export type Lease = z.infer<typeof Lease>;

export const ProgressRequest = Lease.extend({ fraction: z.number().min(0).max(1), detail: z.string().optional() });
export type ProgressRequest = z.infer<typeof ProgressRequest>;

export const CompleteRequest = Lease.extend({ result: JobResult });
export type CompleteRequest = z.infer<typeof CompleteRequest>;

/** The structured reason for a failed Jellyfin setup or publish; the backend reads it only for `setupJellyfin` and `publish`. */
export const FailureData = z.object({ reason: JellyfinSetupReason, step: SetupStep.optional() });
export type FailureData = z.infer<typeof FailureData>;

/** `cancelled` answers a cancellation from the heartbeat; every other value is a failure code. */
export const FailRequest = Lease.extend({
  failureCode: z.union([FailureCode, z.literal('cancelled')]),
  detail: z.string(),
  data: FailureData.optional(),
  /** The job's uploaded log (a prepare job's `ffmpeg.log`), stored on the job. */
  artifactStorageId: zid('_storage').optional(),
});
export type FailRequest = z.infer<typeof FailRequest>;

/** `jellyfin.setup.connection(sessionId)`. */
export const JellyfinConnectionRequest = z.object({ sessionId: zid('workerSessions') });
export type JellyfinConnectionRequest = z.infer<typeof JellyfinConnectionRequest>;

export const ReleaseRequest = Lease;

/** `imports.resolveFiles`: the Units each file of an import holds, by `resolveUnits`. Fenced on the lease. */
export const ResolveFilesRequest = Lease.extend({ files: z.array(z.object({ relPath: z.string(), sizeBytes: z.number() })) });
export type ResolveFilesRequest = z.infer<typeof ResolveFilesRequest>;
export const ResolvedFile = z.object({
  relPath: z.string(),
  unitIds: z.array(zid('units')),
  /** Why no Unit was found: no numbers in the name, or numbers no Unit has. */
  problem: z.enum(['noNumbers', 'unitNotFound']).optional(),
  /** A proper, repack or REAL's revision, for "the higher revision, then the larger"; absent for a first release. */
  revision: z.object({ version: z.number(), real: z.number() }).optional(),
});
export type ResolvedFile = z.infer<typeof ResolvedFile>;
export const ResolveFilesResponse = z.array(ResolvedFile);
export type ResolveFilesResponse = z.infer<typeof ResolveFilesResponse>;

/** A video the scan found: its absolute path, size and `<device>:<inode>`. */
export const ScanEntry = z.object({ path: z.string(), sizeBytes: z.number(), inode: z.string() });
export type ScanEntry = z.infer<typeof ScanEntry>;
/** `scan.reportBatch`: up to `scanBatchSize` found videos; the answer is the paths no `files` row holds. Fenced on the lease. */
export const ScanReportBatchRequest = Lease.extend({ scanRunId: zid('scanRuns'), entries: z.array(ScanEntry) });
export type ScanReportBatchRequest = z.infer<typeof ScanReportBatchRequest>;
export const ScanReportBatchResponse = z.array(z.string());
/** `scan.recordProbes`: the untracked videos with their probes; no probe for a file ffprobe couldn't read. Fenced on the lease. */
export const ScanRecordProbesRequest = Lease.extend({
  scanRunId: zid('scanRuns'),
  probes: z.array(ScanEntry.extend({ probe: ProbeSummary.optional() })),
});
export type ScanRecordProbesRequest = z.infer<typeof ScanRecordProbesRequest>;

export const CheckedFile = z.object({ fileId: zid('files'), path: z.string() });
export type CheckedFile = z.infer<typeof CheckedFile>;
export const FileCheckPageRequest = Lease.extend({ root: z.string(), cursor: z.string().nullable() });
export type FileCheckPageRequest = z.infer<typeof FileCheckPageRequest>;
export const FileCheckPageResponse = z.object({ files: z.array(CheckedFile), cursor: z.string(), done: z.boolean() });
export type FileCheckPageResponse = z.infer<typeof FileCheckPageResponse>;
export const FileCheckReportRequest = Lease.extend({ verdicts: z.array(CheckedFile.extend({ verdict: z.enum(['present', 'missing']) })) });
export type FileCheckReportRequest = z.infer<typeof FileCheckReportRequest>;

/** `jellyfin.playback.report(sessionId, plays)`: the poller's current set of plays, sent when it changes. */
export const PlaybackReportRequest = z.object({ sessionId: zid('workerSessions'), plays: z.array(ActivePlay) });
export type PlaybackReportRequest = z.infer<typeof PlaybackReportRequest>;

/** `worker.artifactUploadUrl(jobId, leaseEpoch)`: a file-storage upload URL for a job's ffmpeg log or support bundle. */
export const ArtifactUploadUrlRequest = Lease;
export const ArtifactUploadUrlResponse = z.object({ uploadUrl: z.string() });
/** `worker.bundleData(jobId, leaseEpoch)`: the support bundle's DTOs, for a leased `buildSupportBundle` job. */
export const BundleDataRequest = Lease;
export type ReleaseRequest = Lease;

/** What progress, complete, fail and release return: nothing; a refusal throws. */
export const Ack = z.null();
export type Ack = z.infer<typeof Ack>;

/** The download reconciler's changes since its last report. */
export const DownloadReport = z.array(
  z.object({
    downloadId: zid('downloads'),
    clientStage: ClientStage.optional(),
    /**
     * `removed`: deleted in the client by someone; the run ends as a cancel would.
     * `seedingDone` and `seedingLost`: a completed torrent's goal was met, or its files are gone.
     */
    outcome: z.enum(['completed', 'failed', 'stalled', 'removed', 'seedingDone', 'seedingLost']).optional(),
    failureCode: FailureCode.optional(),
    clientStatus: ClientStatus,
    contentPath: z.string().optional(),
    /** On `completed`, for a torrent: qBittorrent's `private` flag. */
    private: z.boolean().optional(),
    /** On `seedingDone`: the final ratio and seed time, for the event. */
    seedRatio: z.number().optional(),
    seedTimeMs: z.number().optional(),
  }),
);
export type DownloadReport = z.infer<typeof DownloadReport>;

/** `downloads.report(batch)`, from an accepted session. */
export const DownloadReportRequest = z.object({ sessionId: zid('workerSessions'), reports: DownloadReport });
export type DownloadReportRequest = z.infer<typeof DownloadReportRequest>;

/**
 * `downloads.progress`: the progress-only poll's batch, every
 * `progressPollMs` while a Download is active, with only the Downloads whose
 * percent, bytes or speed changed. It writes the client status and nothing
 * else: stages and outcomes stay with the 30 s pass's `downloads.report`.
 */
export const DownloadProgressRequest = z.object({
  sessionId: zid('workerSessions'),
  progress: z.array(z.object({ downloadId: zid('downloads'), clientStatus: ClientStatus })),
});
export type DownloadProgressRequest = z.infer<typeof DownloadProgressRequest>;

/** `downloads.watched(sessionId)`. */
export const WatchedDownloadsRequest = z.object({ sessionId: zid('workerSessions') });

/**
 * A Download the reconciler compares with its client's items, a watched
 * Download: an `active` one, or a `completed` torrent that is still seeding.
 */
export const ActiveDownload = z.object({
  downloadId: zid('downloads'),
  clientKind: ClientKind,
  clientRef: z.string().optional(),
  correlationTag: z.string(),
  clientStage: ClientStage,
  state: z.enum(['active', 'completed']),
  seedGoal: SeedGoal.optional(),
});
export type ActiveDownload = z.infer<typeof ActiveDownload>;
export const WatchedDownloads = z.array(ActiveDownload);

/** A client item, as the startup reconciliation reports the ones that match no active Download. */
export const ClientItemRef = z.object({
  clientKind: ClientKind,
  clientRef: z.string(),
  correlationTag: z.string().optional(),
  /** The item's name in the client, for the Issue's detail. */
  name: z.string(),
});
export type ClientItemRef = z.infer<typeof ClientItemRef>;

/** `downloads.orphans`: the backend raises `orphanClientItem` for the items no Grab owns. */
export const OrphansRequest = z.object({ sessionId: zid('workerSessions'), items: z.array(ClientItemRef) });
export type OrphansRequest = z.infer<typeof OrphansRequest>;
