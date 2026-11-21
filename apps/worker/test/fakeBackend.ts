// An in-memory stand-in for the worker functions, with lease fencing, so the
// runtime can be tested without a Convex backend.
import {
  type ActiveDownload,
  type ActivePlay,
  type ClientItemRef,
  type ClientStatusReport,
  type DesiredClientConfig,
  type ConnectResponse,
  type DownloadProgressRequest,
  type DownloadReport,
  type JellyfinConnection,
  type JobClass,
  type JobPayload,
  type LeasedJob,
  PROTOCOL_VERSION,
  type QueueCounts,
  type ResolveFilesRequest,
  type ResolveFilesResponse,
  type ScanEntry,
  type ScanRecordProbesRequest,
  type ScanReportBatchRequest,
  type SupportBundleData,
} from '@omnarr/contracts';
import { ConvexError } from 'convex/values';

import type { WorkerBackend } from '../src/convex.ts';

type FakeJob = { jobId: string; class: JobClass; payload: JobPayload; status: 'queued' | 'leased' | 'done' | 'failed' | 'cancelled'; leaseEpoch: number };

export class FakeBackend implements WorkerBackend {
  public readonly protocolVersion = PROTOCOL_VERSION;
  public jobs: FakeJob[] = [];
  public calls: { fn: string; args: unknown }[] = [];
  public cancel = new Set<string>();
  public connectResponses: ConnectResponse[] = [];
  private watchers: { classes: JobClass[]; onCounts: (counts: QueueCounts) => void }[] = [];

  public add(payload: JobPayload, jobId = `job${this.jobs.length + 1}`): string {
    this.jobs.push({ jobId, class: payload.class, payload, status: 'queued', leaseEpoch: 0 });
    this.notify();
    return jobId;
  }

  public count(fn: string): number {
    return this.calls.filter((call) => call.fn === fn).length;
  }

  private record(fn: string, args: unknown) {
    this.calls.push({ fn, args });
  }

  private notify() {
    for (const watcher of this.watchers) watcher.onCounts(this.counts(watcher.classes));
  }

  private counts(classes: JobClass[]): QueueCounts {
    return classes.map((cls) => ({ class: cls, count: this.jobs.filter((job) => job.class === cls && job.status === 'queued').length }));
  }

  private fenced(jobId: string, leaseEpoch: number): FakeJob {
    const job = this.jobs.find((j) => j.jobId === jobId);
    if (!job || job.status !== 'leased' || job.leaseEpoch !== leaseEpoch) throw new ConvexError({ code: 'staleLease' });
    return job;
  }

  public async connect(args: unknown): Promise<ConnectResponse> {
    this.record('connect', args);
    return this.connectResponses.shift() ?? { accepted: true, sessionId: 'session1' as never };
  }

  /** When set, every heartbeat is refused with this code. */
  public heartbeatError: string | undefined;

  public async heartbeat(args: unknown) {
    this.record('heartbeat', args);
    if (this.heartbeatError) throw new ConvexError({ code: this.heartbeatError });
    const held = this.jobs.filter((job) => job.status === 'leased' && this.cancel.has(job.jobId));
    return { cancelJobIds: held.map((job) => job.jobId as never), leaseExpiresAt: Date.now() + 60_000 };
  }

  public async claim(args: { class: JobClass; max: number }): Promise<LeasedJob[]> {
    this.record('claim', args);
    const claimed = this.jobs.filter((job) => job.class === args.class && job.status === 'queued').slice(0, args.max);
    for (const job of claimed) Object.assign(job, { status: 'leased', leaseEpoch: job.leaseEpoch + 1 });
    if (claimed.length) this.notify();
    return claimed.map((job) => ({ jobId: job.jobId as never, class: job.class, leaseEpoch: job.leaseEpoch, payload: job.payload }));
  }

  public async progress(args: { jobId: string; leaseEpoch: number }) {
    this.fenced(args.jobId, args.leaseEpoch);
    this.record('progress', args);
  }

  /**
   * How many of the next `complete` and `fail` calls fail as a server error, as Convex answers a mutation
   * past its time limit (a plain Error, not a ConvexError; CI run 44461776793). The call changes nothing.
   */
  public transientFailures = { complete: 0, fail: 0 };

  private transient(fn: 'complete' | 'fail', args: object) {
    if (this.transientFailures[fn] <= 0) return;
    this.transientFailures[fn]--;
    this.record(`${fn}:serverError`, args);
    throw new Error(`[CONVEX M(jobs/queue:${fn})] Server Error\nFunction execution timed out (maximum duration: 1s)`);
  }

  public async complete(args: { jobId: string; leaseEpoch: number }) {
    this.transient('complete', args);
    this.fenced(args.jobId, args.leaseEpoch).status = 'done';
    this.record('complete', args);
  }

  public async fail(args: { jobId: string; leaseEpoch: number; failureCode: string }) {
    this.transient('fail', args);
    this.fenced(args.jobId, args.leaseEpoch).status = args.failureCode === 'cancelled' ? 'cancelled' : 'failed';
    this.record('fail', args);
  }

  public async release(args: { jobId: string; leaseEpoch: number }) {
    this.fenced(args.jobId, args.leaseEpoch).status = 'queued';
    this.record('release', args);
  }

  /** Takes a job's lease away, as the supervision cron does when it expires. */
  public expireLease(jobId: string) {
    const job = this.jobs.find((j) => j.jobId === jobId)!;
    Object.assign(job, { status: 'queued', leaseEpoch: job.leaseEpoch });
  }

  public watchQueue(classes: JobClass[], onCounts: (counts: QueueCounts) => void) {
    const watcher = { classes, onCounts };
    this.watchers.push(watcher);
    queueMicrotask(() => onCounts(this.counts(classes)));
    return () => {
      this.watchers = this.watchers.filter((w) => w !== watcher);
    };
  }

  /** The backend's watched Downloads, as `downloads.watched` returns them. */
  public active: ActiveDownload[] = [];
  /** Every `downloads.report` batch and `downloads.orphans` list received. */
  public reports: DownloadReport[] = [];
  public orphanReports: ClientItemRef[][] = [];
  /** The `downloadClients` rows, as `downloadClients.desired` returns them. */
  public desired: DesiredClientConfig[] = [];
  /** Every `downloadClients.report` batch received. */
  public clientReports: ClientStatusReport[][] = [];

  public async watchedDownloads(args: unknown) {
    this.record('watchedDownloads', args);
    return this.active.map((row) => ({ ...row }));
  }

  public async desiredClients(args: unknown) {
    this.record('desiredClients', args);
    return this.desired.map((row) => structuredClone(row));
  }

  public async reportClients(args: { reports: ClientStatusReport[] }) {
    this.record('reportClients', args);
    this.clientReports.push(args.reports);
    // The backend records the applied version, as `downloadClients.report` does.
    for (const report of args.reports) {
      const row = this.desired.find((entry) => entry.kind === report.kind);
      if (row && report.appliedConfigVersion !== undefined) row.appliedConfigVersion = report.appliedConfigVersion;
    }
  }

  /** Every `downloads.progress` batch received. */
  public progressReports: DownloadProgressRequest['progress'][] = [];

  public async downloadProgress(args: { progress: DownloadProgressRequest['progress'] }) {
    this.record('downloadProgress', args);
    this.progressReports.push(args.progress);
  }

  public async report(args: { reports: DownloadReport }) {
    this.record('report', args);
    this.reports.push(args.reports);
    // The backend applies a new stage, and ends the Download on an outcome. A
    // completed torrent stays watched; its seeding outcomes leave it watched
    // until a removeDownload ends it.
    for (const entry of args.reports) {
      const row = this.active.find((d) => d.downloadId === entry.downloadId);
      if (row && entry.clientStage) row.clientStage = entry.clientStage;
      if (row && entry.outcome === 'completed' && row.clientKind === 'qbittorrent') row.state = 'completed';
      else if (entry.outcome && entry.outcome !== 'seedingDone' && entry.outcome !== 'seedingLost')
        this.active = this.active.filter((d) => d.downloadId !== entry.downloadId);
    }
  }

  public async orphans(args: { items: ClientItemRef[] }) {
    this.record('orphans', args);
    this.orphanReports.push(args.items);
  }

  /** `jellyfin.setup.connection`: its subscribers, and whether the first value is held back. */
  public jellyfinConnectionHeld = false;
  public jellyfinConnection: JellyfinConnection | null = null;
  private jellyfinListeners = new Set<(value: JellyfinConnection | null) => void>();
  public get jellyfinWatchers(): number {
    return this.jellyfinListeners.size;
  }

  public watchJellyfinConnection(sessionId: unknown, onValue: (value: JellyfinConnection | null) => void) {
    this.record('watchJellyfinConnection', { sessionId });
    this.jellyfinListeners.add(onValue);
    if (!this.jellyfinConnectionHeld) queueMicrotask(() => onValue(this.jellyfinConnection));
    return () => void this.jellyfinListeners.delete(onValue);
  }

  /** The backend's connection changed: every subscriber gets it. */
  public pushJellyfinConnection(value: JellyfinConnection | null) {
    this.jellyfinConnection = value;
    for (const listener of this.jellyfinListeners) listener(value);
  }

  /** Every `jellyfin.playback.report` received, and the code to refuse the next ones with. */
  public playReports: { sessionId: unknown; plays: ActivePlay[] }[] = [];
  public reportPlaysError: string | undefined;

  public async reportPlays(sessionId: unknown, plays: ActivePlay[]) {
    this.record('reportPlays', { sessionId, plays });
    if (this.reportPlaysError) throw new ConvexError({ code: this.reportPlaysError });
    this.playReports.push({ sessionId, plays });
  }

  /** `imports.resolveFiles`: the test's answer per file (relPath → Unit IDs); a file it doesn't name resolves to nothing. */
  public resolved: Record<string, string[]> = {};
  /** A file's revision as `resolveFiles` sends it for a proper or repack (relPath → revision). */
  public revisions: Record<string, { version: number; real: number }> = {};

  public async resolveFiles(args: ResolveFilesRequest): Promise<ResolveFilesResponse> {
    this.record('resolveFiles', args);
    this.fenced(args.jobId, args.leaseEpoch);
    return args.files.map(({ relPath }) => {
      const unitIds = this.resolved[relPath] ?? [];
      const revision = this.revisions[relPath];
      return { relPath, unitIds: unitIds as never[], ...(unitIds.length ? {} : { problem: 'noNumbers' as const }), ...(revision ? { revision } : {}) };
    });
  }

  /** The paths and inodes `scan.reportBatch` treats as held by a `files` row. */
  public trackedPaths = new Set<string>();
  public trackedInodes = new Set<string>();
  /** Every `scan.reportBatch` batch and `scan.recordProbes` list received. */
  public scanBatches: ScanEntry[][] = [];
  public scanProbes: ScanRecordProbesRequest['probes'][] = [];

  public async scanReportBatch(args: ScanReportBatchRequest): Promise<string[]> {
    this.record('scanReportBatch', args);
    this.fenced(args.jobId, args.leaseEpoch);
    this.scanBatches.push(args.entries);
    return args.entries.filter(({ path, inode }) => !this.trackedPaths.has(path) && !this.trackedInodes.has(inode)).map(({ path }) => path);
  }

  public async scanRecordProbes(args: ScanRecordProbesRequest): Promise<void> {
    this.record('scanRecordProbes', args);
    this.fenced(args.jobId, args.leaseEpoch);
    this.scanProbes.push(args.probes);
  }

  /** What `worker.bundleData` answers. */
  public bundle: SupportBundleData | undefined;

  public async bundleData(args: { jobId: string; leaseEpoch: number }): Promise<SupportBundleData> {
    this.record('bundleData', args);
    this.fenced(args.jobId, args.leaseEpoch);
    if (!this.bundle) throw new Error('no bundle data set');
    return this.bundle;
  }

  /** `worker.artifactUploadUrl`: a fresh URL per call. */
  public async artifactUploadUrl(args: { jobId: string; leaseEpoch: number }) {
    this.record('artifactUploadUrl', args);
    this.fenced(args.jobId, args.leaseEpoch);
    return { uploadUrl: `http://convex.invalid/upload/${this.count('artifactUploadUrl')}` };
  }

  /** A leased job, as a handler test that calls the backend needs it: fencing then passes for `leaseEpoch` 1. */
  public lease(payload: JobPayload, jobId = `job${this.jobs.length + 1}`): LeasedJob {
    this.jobs.push({ jobId, class: payload.class, payload, status: 'leased', leaseEpoch: 1 });
    return { jobId: jobId as never, class: payload.class, leaseEpoch: 1, payload };
  }

  public async close() {}
}
