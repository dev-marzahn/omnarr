// The worker's view of the backend: the worker functions, with the
// worker token and protocol version added to every call. The runtime talks
// only to this interface, so tests run it against a fake.
import { api } from '@omnarr/backend/api';
import {
  type ActiveDownload,
  type ActivePlay,
  type ClientReportsRequest,
  type DesiredClientConfig,
  type DownloadProgressRequest,
  type DownloadReportRequest,
  type OrphansRequest,
  type ClaimRequest,
  type CompleteRequest,
  type ConnectRequest,
  type ConnectResponse,
  type DefinitionFile,
  type DefinitionFileRequest,
  type FinishDefinitionSyncRequest,
  type FinishDefinitionSyncResponse,
  type ReservePacingRequest,
  type ReservePacingResponse,
  type SiteConfig,
  type SiteConfigRequest,
  type UpsertDefinitionsRequest,
  type FailRequest,
  type HeartbeatRequest,
  type HeartbeatResponse,
  type JellyfinConnection,
  type JobClass,
  type Lease,
  type LeasedJob,
  type ProgressRequest,
  PROTOCOL_VERSION,
  type QueueCounts,
  type ReleaseRequest,
  type ResolveFilesRequest,
  type ResolveFilesResponse,
  type ScanRecordProbesRequest,
  type ScanReportBatchRequest,
  type FileCheckPageRequest,
  type FileCheckPageResponse,
  type FileCheckReportRequest,
  type SupportBundleData,
  type WorkerErrorCode,
} from '@omnarr/contracts';
import { ConvexClient } from 'convex/browser';
import { ConvexError, type GenericId } from 'convex/values';

export interface WorkerBackend {
  /** The protocol version every call carries. */
  readonly protocolVersion: number;
  connect(request: Omit<ConnectRequest, 'protocolVersion'>): Promise<ConnectResponse>;
  heartbeat(request: HeartbeatRequest): Promise<HeartbeatResponse>;
  claim(request: ClaimRequest): Promise<LeasedJob[]>;
  progress(request: ProgressRequest): Promise<void>;
  complete(request: CompleteRequest): Promise<void>;
  fail(request: FailRequest): Promise<void>;
  release(request: ReleaseRequest): Promise<void>;
  /** Calls `onCounts` whenever the claimable jobs of these classes change. Returns an unsubscribe. */
  watchQueue(classes: JobClass[], onCounts: (counts: QueueCounts) => void): () => void;
  /** The download reconciler's calls. */
  watchedDownloads(request: { sessionId: GenericId<'workerSessions'> }): Promise<ActiveDownload[]>;
  report(request: DownloadReportRequest): Promise<void>;
  /** The progress-only poll's batch. */
  downloadProgress(request: DownloadProgressRequest): Promise<void>;
  orphans(request: OrphansRequest): Promise<void>;
  desiredClients(request: { sessionId: GenericId<'workerSessions'> }): Promise<DesiredClientConfig[]>;
  reportClients(request: ClientReportsRequest): Promise<void>;
  /** `jellyfin.setup.connection`: calls `onValue` with every new value. Returns an unsubscribe. */
  watchJellyfinConnection(sessionId: GenericId<'workerSessions'>, onValue: (value: JellyfinConnection | null) => void): () => void;
  /** `jellyfin.playback.report`:the plays running now, sent when the set changed. */
  reportPlays(sessionId: GenericId<'workerSessions'>, plays: ActivePlay[]): Promise<void>;
  /** `imports.resolveFiles`: the Units each of an import's files holds. Fenced on the lease. */
  resolveFiles(request: ResolveFilesRequest): Promise<ResolveFilesResponse>;
  /** `scan.reportBatch`: a batch of found videos; answers the paths no `files` row holds. Fenced on the lease. */
  scanReportBatch(request: ScanReportBatchRequest): Promise<string[]>;
  /** `scan.recordProbes`: the untracked videos with their probes. Fenced on the lease. */
  scanRecordProbes(request: ScanRecordProbesRequest): Promise<void>;
  fileCheckPage(request: FileCheckPageRequest): Promise<FileCheckPageResponse>;
  fileCheckReport(request: FileCheckReportRequest): Promise<void>;
  /** `worker.artifactUploadUrl`: where a job POSTs its log; the upload answers with `{ storageId }`. Fenced on the lease. */
  artifactUploadUrl(request: Lease): Promise<{ uploadUrl: string }>;
  /** `worker.bundleData`: the support bundle's DTOs, for a leased `buildSupportBundle` job. */
  bundleData(request: Lease): Promise<SupportBundleData>;
  close(): Promise<void>;
}

/** The definition indexers' worker functions, each fenced on the lease of the job it serves. */
export interface SitesBackend {
  /** `worker.reservePacing`: a definition indexer's next slot. */
  reservePacing(request: ReservePacingRequest): Promise<ReservePacingResponse>;
  /** `sites.config`: the definition, base URL and settings, secrets included. Never log it. */
  siteConfig(request: SiteConfigRequest): Promise<SiteConfig | null>;
  /** `sites.definitionFile`: a definition's file, for a test before the indexer is saved. */
  definitionFile(request: DefinitionFileRequest): Promise<DefinitionFile | null>;
  /** `definitions.upsertBatch` and `definitions.finishSync`. */
  upsertDefinitions(request: UpsertDefinitionsRequest): Promise<void>;
  finishDefinitionSync(request: FinishDefinitionSyncRequest): Promise<FinishDefinitionSyncResponse>;
}

/** The `WorkerErrorCode` a worker call was refused with, if it was. */
export function workerErrorCode(error: unknown): WorkerErrorCode | undefined {
  if (!(error instanceof ConvexError)) return undefined;
  const code = (error.data as { code?: unknown } | undefined)?.code;
  return typeof code === 'string' ? (code as WorkerErrorCode) : undefined;
}

/**
 * An upload URL from `generateUploadUrl`, on the origin the worker reaches
 * Convex at. A self-hosted backend without `CONVEX_CLOUD_ORIGIN` answers
 * with a path only, and one with it writes that public origin into the URL,
 * which a worker on the stack's internal network may not reach.
 */
export function uploadUrlFor(uploadUrl: string, convexUrl: string): string {
  const upload = new URL(uploadUrl, convexUrl);
  return `${new URL(convexUrl).origin}${upload.pathname}${upload.search}`;
}

/**
 * A subscription that survives a failed query. ConvexClient.onUpdate throws a query's error from its
 * WebSocket handler when no onError is given, which ends the worker process (CI run 44448549101: a
 * query past Convex's 1 s limit on a loaded backend). An errored result stays until the query's data
 * changes, so the query is subscribed to again after `retryMs`.
 */
export function resilientWatch<T>(
  subscribe: (onValue: (value: T) => void, onError: (error: Error) => void) => () => void,
  onValue: (value: T) => void,
  options: { retryMs: number; log: (line: string) => void; name?: string },
): () => void {
  let stopped = false;
  let unsubscribe: (() => void) | undefined;
  let retry: NodeJS.Timeout | undefined;
  const start = () => {
    unsubscribe = subscribe(onValue, (error) => {
      options.log(`watch ${options.name ?? 'query'} failed, again in ${options.retryMs / 1000} s: ${error.message.split('\n')[0]}`);
      unsubscribe?.();
      unsubscribe = undefined;
      retry = setTimeout(() => {
        if (!stopped) start();
      }, options.retryMs);
    });
  };
  start();
  return () => {
    stopped = true;
    clearTimeout(retry);
    unsubscribe?.();
  };
}

/** How long after a failed query the worker subscribes to it again. */
const WATCH_RETRY_MS = 2_000;

export function convexBackend(options: {
  url: string;
  workerToken: string;
  protocolVersion?: number;
  log?: (line: string) => void;
}): WorkerBackend & SitesBackend {
  const client = new ConvexClient(options.url);
  const log = options.log ?? ((line: string) => console.log(`[worker] ${line}`));
  const call = { workerToken: options.workerToken, protocolVersion: options.protocolVersion ?? PROTOCOL_VERSION };
  return {
    protocolVersion: call.protocolVersion,
    connect: (request) => client.mutation(api.jobs.worker.connect, { ...call, ...request }),
    heartbeat: (request) => client.mutation(api.jobs.worker.heartbeat, { ...call, ...request }),
    claim: (request) => client.mutation(api.jobs.queue.claim, { ...call, ...request }),
    progress: async (request) => void (await client.mutation(api.jobs.queue.progress, { ...call, ...request })),
    complete: async (request) => void (await client.mutation(api.jobs.queue.complete, { ...call, ...request })),
    fail: async (request) => void (await client.mutation(api.jobs.queue.fail, { ...call, ...request })),
    release: async (request) => void (await client.mutation(api.jobs.queue.release, { ...call, ...request })),
    watchQueue: (classes, onCounts) =>
      resilientWatch((onValue, onError) => client.onUpdate(api.jobs.queue.queue, { ...call, classes }, onValue, onError), onCounts, {
        retryMs: WATCH_RETRY_MS,
        log,
        name: 'jobs/queue:queue',
      }),
    watchedDownloads: (request) => client.query(api.jobs.downloads.watched, { ...call, ...request }),
    report: async (request) => void (await client.mutation(api.jobs.downloads.report, { ...call, ...request })),
    downloadProgress: async (request) => void (await client.mutation(api.jobs.downloads.progress, { ...call, ...request })),
    orphans: async (request) => void (await client.mutation(api.jobs.downloads.orphans, { ...call, ...request })),
    desiredClients: (request) => client.query(api.jobs.clients.desired, { ...call, ...request }),
    reportClients: async (request) => void (await client.mutation(api.jobs.clients.report, { ...call, ...request })),
    watchJellyfinConnection: (sessionId, onValue) =>
      resilientWatch((onResult, onError) => client.onUpdate(api.jellyfin.setup.connection, { ...call, sessionId }, onResult, onError), onValue, {
        retryMs: WATCH_RETRY_MS,
        log,
        name: 'jellyfin/setup:connection',
      }),
    reportPlays: async (sessionId, plays) => void (await client.mutation(api.jellyfin.playback.report, { ...call, sessionId, plays })),
    resolveFiles: (request) => client.query(api.jobs.imports.resolveFiles, { ...call, ...request }),
    scanReportBatch: (request) => client.mutation(api.scan.report.reportBatch, { ...call, ...request }),
    scanRecordProbes: async (request) => void (await client.mutation(api.scan.report.recordProbes, { ...call, ...request })),
    fileCheckPage: (request) => client.mutation(api.library.missingFiles.page, { ...call, ...request }),
    fileCheckReport: async (request) => void (await client.mutation(api.library.missingFiles.report, { ...call, ...request })),
    artifactUploadUrl: async (request) => {
      const { uploadUrl } = await client.mutation(api.jobs.worker.artifactUploadUrl, { ...call, ...request });
      return { uploadUrl: uploadUrlFor(uploadUrl, options.url) };
    },
    bundleData: (request) => client.query(api.jobs.worker.bundleData, { ...call, ...request }),
    reservePacing: (request) => client.mutation(api.jobs.worker.reservePacing, { ...call, ...request }),
    siteConfig: (request) => client.query(api.sites.config.config, { ...call, ...request }),
    definitionFile: (request) => client.query(api.sites.config.definitionFile, { ...call, ...request }),
    upsertDefinitions: async (request) => void (await client.mutation(api.sites.definitions.upsertBatch, { ...call, ...request })),
    finishDefinitionSync: (request) => client.mutation(api.sites.definitions.finishSync, { ...call, ...request }),
    close: () => client.close(),
  };
}
