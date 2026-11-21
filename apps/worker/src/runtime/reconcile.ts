// The download reconciler and the startup reconciliation. Every 30 s a pass:
//
//   1. reads `downloadClients.desired` into the client runtime store;
//   2. converges each enabled client's config: on the session's first
//      pass, after a save raised `configVersion`, and after a failed apply,
//      under the client's lock;
//   3. lists each client's items and compares them with the watched
//      Downloads, reporting only changes. An active one: a new client stage,
//      completion, failure, a stall on the byte-based clock, or an item missing
//      for two passes in a row. A completed torrent: its goal met, or its
//      files lost;
//   4. reads each client's status and reports it with the apply's outcome and
//      the seeding problems, only when something changed.
//
// The startup reconciliation is the first pass, before any claim: it also
// empties staging and reports client items no watched Download owns.
import { readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';

import {
  type ActiveDownload,
  type ClientKind,
  type ClientStatusReport,
  DEFAULT_LIMITS,
  DEFAULT_SEED_GOAL,
  type DesiredClientConfig,
  type DownloadProgressRequest,
  type DownloadReport,
  type FailureCode,
  type Limits,
  type SeedGoal,
  type SeedingProblem,
  type VpnRuntime,
} from '@omnarr/contracts';
import type { GenericId } from 'convex/values';

import type { ClientItem, DownloadClient, SeedingProblemState } from '../clients/downloadClient.ts';
import { workerErrorCode, type WorkerBackend } from '../convex.ts';
import { errorFailureCode } from '../failures.ts';
import type { DataLayout } from '../fs/layout.ts';
import { renderVpnFiles, syncVpnFiles } from '../vpn/files.ts';
import type { ClientRuntimeStore } from './clientRuntime.ts';
import { JobFailure } from './lease.ts';
import type { VpnMonitor } from './vpnMonitor.ts';

export type ReconcilerOptions = {
  backend: WorkerBackend;
  sessionId: GenericId<'workerSessions'>;
  clients: Partial<Record<ClientKind, DownloadClient>>;
  layout: DataLayout;
  /** Shared with `download.submit`; a new reconciler starts a new session in it. */
  runtime: ClientRuntimeStore;
  /**
   * `torrentStallMs` (no downloaded byte for this much counted time is a stall), `goalGraceMs`,
   * `seedingLostAfterMs` and `missingItemPasses`; the e2e lowers the first two (`OMNARR_TEST_LIMITS`).
   */
  limits?: Limits;
  /** `QBITTORRENT_PEER_PORT`, the published peer port qBittorrent listens on in the direct layout. */
  peerPort?: number;
  /** With qBittorrent: the VPN monitor, which knows the layout. */
  vpn?: VpnMonitor;
  /** The `vpn/` bind mount the qBittorrent apply writes gluetun's files into. */
  vpnDir?: string;
  now?: () => number;
  log: (message: string) => void;
};

/** What the reconciler last told the backend about a client, to send only changes. */
type Reading = Pick<ClientStatusReport, 'reachable' | 'clientVersion' | 'connectionStatus' | 'peerPort' | 'seedingProblems' | 'vpn' | 'usenetUsage'>;

/** A reading without the VPN's check time, which changes on every pass. */
const comparable = (reading: Reading | undefined) => {
  if (!reading?.vpn) return JSON.stringify(reading);
  const { checkedAt: _, ...vpn } = reading.vpn;
  return JSON.stringify({ ...reading, vpn });
};

/** A torrent's stall clock: the bytes last seen, the counted time without a new one, and the pass that last counted. */
type StallClock = { bytes: number; counted: number; at?: number };

const HOUR_MS = 3_600_000;

const codeOf = (error: unknown): FailureCode => (error instanceof JobFailure ? error.code : (errorFailureCode(error) ?? 'clientUnreachable'));

/**
 * qBittorrent without a row: torrents are on, with the default goal (a
 * protocol counts as disabled only when its row exists with enabled =
 * false), so the session's first pass configures it all the same.
 */
const DEFAULT_QBITTORRENT: DesiredClientConfig = {
  kind: 'qbittorrent',
  clientId: 'qbittorrent-defaults' as GenericId<'downloadClients'>,
  enabled: true,
  configVersion: 0,
  qbittorrent: { seedGoal: { ...DEFAULT_SEED_GOAL } },
};

/** Whether qBittorrent's stop means the goal is met: either limit reached. A torrent without a goal stopped at no limit of ours. */
function goalMet(goal: SeedGoal | undefined, item: ClientItem): boolean {
  if (!goal) return true;
  const ratio = goal.ratio !== undefined && (item.ratio ?? 0) >= goal.ratio - 0.005;
  // qBittorrent's limit is in whole minutes, rounded up, so its seed time is never short of the goal.
  const time = goal.seedTimeMs !== undefined && (item.seedingTimeMs ?? 0) >= goal.seedTimeMs - 1000;
  return ratio || time;
}

export class Reconciler {
  /** Per torrent Download: its stall clock. */
  private readonly clocks = new Map<string, StallClock>();
  /** Per Download: in how many passes in a row its item was missing from a client that answered. */
  private readonly missing = new Map<string, number>();
  /** Per completed torrent: its seeding problem since the first pass that saw it. */
  private readonly problems = new Map<string, { state: SeedingProblemState; since: number }>();
  /** Per client: whether the last apply in this session failed, so the next pass tries again. */
  private readonly applyFailed = new Set<ClientKind>();
  private readonly sent = new Map<ClientKind, Reading>();
  /** The active Downloads the last pass watched; the progress poll runs only while there are some. */
  private active: ActiveDownload[] = [];
  /** Per active Download: its bytes at the previous progress poll, for NZBGet's rate, and the values last sent. */
  private readonly samples = new Map<string, { doneBytes: number; at: number }>();
  private readonly progressSent = new Map<string, string>();
  /** Per seeding torrent: the rounded ratio and seed time last sent. */
  private readonly seedingSent = new Map<string, string>();
  private ticking = false;
  private readonly now: () => number;
  private readonly limits: Limits;

  public constructor(private readonly options: ReconcilerOptions) {
    this.now = options.now ?? Date.now;
    this.limits = options.limits ?? DEFAULT_LIMITS;
    options.runtime.newSession();
  }

  /** The rows, with qBittorrent's defaults when it has no row and the worker has a qBittorrent client. */
  private effective(desired: DesiredClientConfig[]): DesiredClientConfig[] {
    if (!this.options.clients.qbittorrent || desired.some((entry) => entry.kind === 'qbittorrent')) return desired;
    return [...desired, DEFAULT_QBITTORRENT];
  }

  /**
   * The `vpn/` files, as part of qBittorrent's apply: a
   * chosen VPN's files; with "No VPN", deleted only in the base layout, so in
   * the VPN layout gluetun keeps working until the user switches back.
   */
  private async syncVpnFiles(entry: DesiredClientConfig): Promise<void> {
    const { vpn, vpnDir, log } = this.options;
    if (!vpn || !vpnDir) return;
    const chosen = entry.qbittorrent?.vpn;
    if (!chosen && vpn.vpnLayout) return;
    const { changed } = await syncVpnFiles(vpnDir, chosen ? renderVpnFiles(chosen) : null);
    if (changed) log(chosen ? `reconcile: vpn files written (${chosen.kind})` : 'reconcile: vpn files removed');
  }

  /** Applies one client's config if it is due, and says what came of it. */
  private async converge(entry: DesiredClientConfig): Promise<Partial<ClientStatusReport> | undefined> {
    const { runtime, clients, log } = this.options;
    const client = clients[entry.kind];
    if (!client || !entry.enabled) return undefined;
    const due = !runtime.configured(entry.kind) || this.applyFailed.has(entry.kind) || entry.configVersion > (entry.appliedConfigVersion ?? 0);
    if (!due) return undefined;
    try {
      if (entry.kind === 'qbittorrent') await this.syncVpnFiles(entry);
      const result = await runtime.withClientLock(entry.kind, () => client.applyConfig(entry, AbortSignal.timeout(120_000)));
      runtime.markConfigured(entry.kind);
      this.applyFailed.delete(entry.kind);
      if (result.changed) log(`reconcile: ${entry.kind} config ${entry.configVersion} applied`);
      return { reachable: true, ...(result.clientVersion ? { clientVersion: result.clientVersion } : {}), appliedConfigVersion: entry.configVersion };
    } catch (error) {
      const code = codeOf(error);
      this.applyFailed.add(entry.kind);
      log(`reconcile: ${entry.kind} config not applied (${code})`);
      return { reachable: code !== 'clientUnreachable', applyFailure: code };
    }
  }

  /** Each client's items, or none for a client that can't be reached this pass. */
  private async items(): Promise<Map<ClientKind, ClientItem[]>> {
    const lists = new Map<ClientKind, ClientItem[]>();
    for (const [kind, client] of Object.entries(this.options.clients) as [ClientKind, DownloadClient][]) {
      try {
        lists.set(kind, await client.list(AbortSignal.timeout(20_000)));
      } catch (error) {
        this.options.log(`reconcile: ${kind} unreachable (${(error as { code?: string }).code ?? workerErrorCode(error) ?? 'error'})`);
      }
    }
    return lists;
  }

  /** What changed for an active Download, if anything. */
  private compare(download: ActiveDownload, item: ClientItem): DownloadReport[number] | undefined {
    const base = { downloadId: download.downloadId, clientStatus: item.status };
    if (item.unchanged) return undefined;
    if (item.stage === 'completed')
      return {
        ...base,
        outcome: 'completed',
        ...(item.contentPath ? { contentPath: item.contentPath } : {}),
        ...(item.isPrivate !== undefined ? { private: item.isPrivate } : {}),
      };
    if (item.stage === 'failed') return { ...base, outcome: 'failed', ...(item.failureCode ? { failureCode: item.failureCode } : {}) };
    if (item.stage === 'removed') return { ...base, outcome: 'removed' };
    if (download.clientKind === 'qbittorrent' && this.stalled(download, item)) return { ...base, outcome: 'stalled', failureCode: 'torrentStalled' };
    if (item.stage !== download.clientStage) return { ...base, clientStage: item.stage };
    return undefined;
  }

  /**
   * The stall rule: an incomplete torrent that isn't checking or
   * allocating stalls when its downloaded byte count hasn't grown for
   * `torrentStallMs` of counted time. Time counts only between two passes that
   * listed it; a checking pass, like one that couldn't reach qBittorrent,
   * pauses the clock, and a byte of progress restarts it.
   */
  private stalled(download: ActiveDownload, item: ClientItem): boolean {
    const now = this.now();
    const bytes = item.downloadedBytes ?? 0;
    const clock = this.clocks.get(download.downloadId);
    if (!clock || clock.bytes !== bytes) {
      this.clocks.set(download.downloadId, { bytes, counted: 0, at: now });
      return false;
    }
    // Checking, allocating, or held back by the VPN gate: the clock pauses.
    if (item.checking || item.stage !== 'downloading' || this.options.runtime.vpnGated()) {
      clock.at = undefined;
      return false;
    }
    if (clock.at !== undefined) clock.counted += now - clock.at;
    clock.at = now;
    return clock.counted >= this.limits.torrentStallMs;
  }

  /** A pass without the client's list: every torrent's stall clock pauses. */
  private pause(download: ActiveDownload): void {
    const clock = this.clocks.get(download.downloadId);
    if (clock) clock.at = undefined;
  }

  /**
   * A completed torrent: stopped with its goal met
   * is `seedingDone`, reported on every pass until it leaves (the backend
   * waits for the Grab to end); missing files, an error or an unknown state is
   * a seeding problem, and `seedingLost` once it has lasted
   * `seedingLostAfterMs`; anything else is nothing.
   */
  private watchedChange(download: ActiveDownload, item: ClientItem): DownloadReport[number] | undefined {
    const base = { downloadId: download.downloadId, clientStatus: item.status };
    if (item.stage === 'failed') {
      const state = item.problem ?? 'unknown';
      const problem = this.problems.get(download.downloadId) ?? { state, since: this.now() };
      this.problems.set(download.downloadId, { ...problem, state });
      return this.now() - problem.since >= this.limits.seedingLostAfterMs ? { ...base, outcome: 'seedingLost' } : undefined;
    }
    this.problems.delete(download.downloadId);
    if (item.stopped && goalMet(download.seedGoal, item))
      return {
        ...base,
        outcome: 'seedingDone',
        ...(item.ratio !== undefined ? { seedRatio: item.ratio } : {}),
        ...(item.seedingTimeMs !== undefined ? { seedTimeMs: item.seedingTimeMs } : {}),
      };
    return this.seedingProgress(download, item);
  }

  /**
   * A seeding torrent's ratio, seed time and uploaded bytes, for the UI: on
   * its client status, without an outcome,
   * sent only once the ratio moved by 0.01 or the seed time by 1 % of the
   * goal's (an hour without a time goal), so a long goal isn't a write per pass.
   */
  private seedingProgress(download: ActiveDownload, item: ClientItem): DownloadReport[number] | undefined {
    if (item.ratio === undefined && item.seedingTimeMs === undefined) return undefined;
    const step = download.seedGoal?.seedTimeMs ? download.seedGoal.seedTimeMs / 100 : HOUR_MS;
    const key = JSON.stringify([Math.round((item.ratio ?? 0) * 100), Math.floor((item.seedingTimeMs ?? 0) / step)]);
    if (this.seedingSent.get(download.downloadId) === key) return undefined;
    this.seedingSent.set(download.downloadId, key);
    return {
      downloadId: download.downloadId,
      clientStatus: {
        ...item.status,
        ...(item.ratio !== undefined ? { ratio: item.ratio } : {}),
        ...(item.seedingTimeMs !== undefined ? { seedTimeMs: item.seedingTimeMs } : {}),
        ...(item.uploadedBytes !== undefined ? { uploadedBytes: item.uploadedBytes } : {}),
      },
    };
  }

  /**
   * A completed torrent still seeding `goalGraceMs` past its seed time goal,
   * counted from its completion: qBittorrent holds the limit but applies it
   * only when it refreshes the torrent, which a tracker announce does, so a
   * seeder with no working tracker can sit past it.
   * A ratio goal needs uploads, which refresh the torrent anyway.
   */
  private overdue(download: ActiveDownload, item: ClientItem): boolean {
    const goal = download.seedGoal?.seedTimeMs;
    if (goal === undefined || item.stopped || item.stage !== 'completed' || item.completedAt === undefined) return false;
    return this.now() - item.completedAt >= goal + this.limits.goalGraceMs;
  }

  /** Makes the client refresh the torrent, once this pass; a failure waits for the next pass. */
  private async nudge(download: ActiveDownload, item: ClientItem): Promise<void> {
    const client = this.options.clients[download.clientKind];
    if (!client?.refreshTorrent) return;
    await client
      .refreshTorrent(item.clientRef, AbortSignal.timeout(20_000))
      .catch((error: unknown) => this.options.log(`reconcile: goal nudge failed (${codeOf(error)})`));
  }

  /**
   * A watched Download whose item a client that answered doesn't list,
   * though its `clientRef` is set: after two passes in a row an active one
   * fails with `unknownClientFailure`, and a seeding one is `seedingLost`.
   * It never ends as a cancel and never deletes data.
   */
  private missingItem(download: ActiveDownload): DownloadReport[number] | undefined {
    const passes = (this.missing.get(download.downloadId) ?? 0) + 1;
    this.missing.set(download.downloadId, passes);
    if (passes < this.limits.missingItemPasses) return undefined;
    this.missing.delete(download.downloadId);
    if (download.state === 'completed')
      return { downloadId: download.downloadId, outcome: 'seedingLost', clientStatus: { stage: 'missing', progress: 1, raw: {} } };
    return {
      downloadId: download.downloadId,
      outcome: 'failed',
      failureCode: 'unknownClientFailure',
      clientStatus: { stage: 'missing', progress: 0, raw: {} },
    };
  }

  private seedingProblems(): SeedingProblem[] {
    return [...this.problems].map(([downloadId, problem]) => ({ downloadId: downloadId as GenericId<'downloads'>, ...problem }));
  }

  /** Each client's status with what its apply did this pass, sent only when it changed. */
  private async clientReports(
    desired: DesiredClientConfig[],
    applies: Map<ClientKind, Partial<ClientStatusReport>>,
    vpn: VpnRuntime | undefined,
  ): Promise<ClientStatusReport[]> {
    const reports: ClientStatusReport[] = [];
    for (const entry of desired) {
      const client = this.options.clients[entry.kind];
      if (!client) continue;
      const applied = applies.get(entry.kind);
      let reading: Reading;
      // An apply that just answered (or didn't) says whether the client is reachable; qBittorrent's
      // connection status is read on every pass all the same.
      if (applied?.reachable !== undefined && (entry.kind !== 'qbittorrent' || !applied.reachable))
        reading = { reachable: applied.reachable, ...(applied.clientVersion ? { clientVersion: applied.clientVersion } : {}) };
      else {
        const status = await client.status(AbortSignal.timeout(20_000)).catch(() => ({ reachable: false, version: undefined, connectionStatus: undefined }));
        const version = status.version ?? applied?.clientVersion;
        reading = {
          reachable: status.reachable,
          ...(version ? { clientVersion: version } : {}),
          ...(status.connectionStatus ? { connectionStatus: status.connectionStatus } : {}),
        };
      }
      if (entry.kind === 'qbittorrent') {
        // Under the VPN the peer port is the provider's: the forwarded or static port while up, else none,
        // since the published port isn't in use there.
        const peerPort = this.options.vpn?.vpnLayout ? (vpn?.state === 'up' ? vpn.port.port : undefined) : this.options.peerPort;
        if (peerPort !== undefined) reading.peerPort = peerPort;
        const problems = this.seedingProblems();
        if (problems.length > 0) reading.seedingProblems = problems;
      }
      if (entry.kind === 'qbittorrent' && vpn) reading.vpn = vpn;
      if (entry.kind === 'nzbget' && reading.reachable) {
        const usage = await this.enforceLimits(entry, client, applied);
        if (usage?.length) reading.usenetUsage = usage;
      }
      const last = this.sent.get(entry.kind);
      const changed = comparable(last) !== comparable(reading);
      if (!applied && !changed) continue;
      this.sent.set(entry.kind, reading);
      reports.push({ kind: entry.kind, ...reading, ...applied });
    }
    return reports;
  }

  /**
   * The servers' monthly limits, on this pass: only
   * once NZBGet runs the saved config, so its ServerIDs are the saved servers. A failed check is
   * logged and leaves the servers as they are until the next pass.
   */
  private async enforceLimits(
    entry: DesiredClientConfig,
    client: DownloadClient,
    applied: Partial<ClientStatusReport> | undefined,
  ): Promise<ClientStatusReport['usenetUsage']> {
    const { runtime, log, now } = this.options;
    if (!client.enforceLimits || !entry.nzbget || !runtime.configured(entry.kind) || this.applyFailed.has(entry.kind)) return undefined;
    if ((applied?.appliedConfigVersion ?? entry.appliedConfigVersion) !== entry.configVersion) return undefined;
    try {
      return await runtime.withClientLock(entry.kind, () => client.enforceLimits!(entry.nzbget!, (now ?? Date.now)(), AbortSignal.timeout(20_000)));
    } catch (error) {
      log(`reconcile: nzbget server limits not checked (${codeOf(error)})`);
      return undefined;
    }
  }

  /** The VPN monitor's reading for this pass, into the runtime store; none without qBittorrent. */
  private async readVpn(desired: DesiredClientConfig[]): Promise<VpnRuntime | undefined> {
    const { vpn, clients, runtime } = this.options;
    if (!vpn || !clients.qbittorrent) return undefined;
    const chosen = desired.find((entry) => entry.kind === 'qbittorrent')?.qbittorrent?.vpn;
    const reading = await vpn.read(chosen, AbortSignal.timeout(20_000));
    runtime.setVpnState(reading.state);
    return reading;
  }

  /** One pass. With `orphans`, the startup reconciliation's report of unowned client items too. */
  public async pass({ orphans = false } = {}): Promise<void> {
    const { backend, sessionId, runtime } = this.options;
    const desired = this.effective(await backend.desiredClients({ sessionId }));
    runtime.setDesired(desired);
    // The VPN first: its state gates torrent submits and the stall clock, and a transition to up sets the listen port.
    const vpn = await this.readVpn(desired);
    const applies = new Map<ClientKind, Partial<ClientStatusReport>>();
    for (const entry of desired) {
      const outcome = await this.converge(entry);
      if (outcome) applies.set(entry.kind, outcome);
    }

    const downloads = await backend.watchedDownloads({ sessionId });
    const lists = await this.items();
    const reports: DownloadReport = [];
    for (const download of downloads) {
      const list = lists.get(download.clientKind);
      // A client that couldn't be listed: nothing to compare, nothing counts as missing, and the stall clock pauses.
      if (!list) {
        this.pause(download);
        continue;
      }
      const item = list.find(
        (candidate) =>
          candidate.correlationTags.includes(download.correlationTag) || (download.clientRef !== undefined && candidate.clientRef === download.clientRef),
      );
      if (!item) {
        // A Download not submitted yet has no item to miss.
        const change = download.clientRef === undefined ? undefined : this.missingItem(download);
        if (change) reports.push(change);
        continue;
      }
      this.missing.delete(download.downloadId);
      const change = download.state === 'completed' ? this.watchedChange(download, item) : this.compare(download, item);
      if (change) reports.push(change);
      if (!change?.outcome && download.state === 'completed' && this.overdue(download, item)) await this.nudge(download, item);
    }
    const watched = new Set(downloads.map((download) => download.downloadId as string));
    for (const map of [this.clocks, this.problems, this.missing, this.samples, this.progressSent, this.seedingSent])
      for (const id of map.keys()) if (!watched.has(id)) map.delete(id);
    const ended = new Set(reports.filter((report) => report.outcome).map((report) => report.downloadId as string));
    this.active = downloads.filter((download) => download.state === 'active' && download.clientRef !== undefined && !ended.has(download.downloadId));
    if (reports.length > 0) await backend.report({ sessionId, reports });

    if (orphans) {
      const unowned = [];
      for (const [clientKind, items] of lists)
        for (const item of items)
          if (!downloads.some((download) => item.correlationTags.includes(download.correlationTag) || download.clientRef === item.clientRef))
            unowned.push({
              clientKind,
              clientRef: item.clientRef,
              ...(item.correlationTags[0] ? { correlationTag: item.correlationTags[0] } : {}),
              name: item.name ?? item.clientRef,
            });
      if (unowned.length > 0) await backend.orphans({ sessionId, items: unowned });
    }

    const clientReports = await this.clientReports(desired, applies, vpn);
    if (clientReports.length > 0) await backend.reportClients({ sessionId, reports: clientReports });
  }

  /**
   * The progress-only poll, every `progressPollMs` between
   * passes, only while the last pass watched an active Download: lists the
   * clients those Downloads are in and sends, in one batch, the client status
   * of each one still queued or downloading whose percent, bytes or rate
   * changed. NZBGet gives no rate per item, so it is the change in bytes
   * since the previous poll. Stages and outcomes stay with the pass.
   */
  public async progressTick(): Promise<void> {
    if (this.active.length === 0 || this.ticking) return;
    this.ticking = true;
    try {
      const { backend, sessionId, clients } = this.options;
      const kinds = new Set(this.active.map((download) => download.clientKind));
      const lists = new Map<ClientKind, ClientItem[]>();
      for (const kind of kinds) {
        const list = await clients[kind]?.list(AbortSignal.timeout(10_000)).catch(() => undefined);
        if (list) lists.set(kind, list);
      }
      const now = this.now();
      const progress: DownloadProgressRequest['progress'] = [];
      for (const download of this.active) {
        const item = lists
          .get(download.clientKind)
          ?.find((candidate) => candidate.correlationTags.includes(download.correlationTag) || candidate.clientRef === download.clientRef);
        if (!item || (item.stage !== 'queued' && item.stage !== 'downloading')) continue;
        const status = { ...item.status };
        if (status.doneBytes !== undefined) {
          const previous = this.samples.get(download.downloadId);
          this.samples.set(download.downloadId, { doneBytes: status.doneBytes, at: now });
          if (status.bytesPerSec === undefined && previous && now > previous.at)
            status.bytesPerSec = Math.max(0, Math.round(((status.doneBytes - previous.doneBytes) * 1000) / (now - previous.at)));
        }
        const key = JSON.stringify([status.progress, status.doneBytes, status.totalBytes, status.bytesPerSec]);
        if (this.progressSent.get(download.downloadId) === key) continue;
        this.progressSent.set(download.downloadId, key);
        progress.push({ downloadId: download.downloadId, clientStatus: status });
      }
      if (progress.length > 0) await backend.downloadProgress({ sessionId, progress });
    } finally {
      this.ticking = false;
    }
  }

  /**
   * Before the worker claims anything: staging is emptied, since no
   * job is held yet and an import re-links what it needs, except `held/`,
   * whose upgrade files wait for their prepare job; then the first pass
   * applies the client config and reports the client items no watched
   * Download owns, which the backend raises as `orphanClientItem` when their
   * tag names no Grab. Nothing in a client is removed here.
   */
  public async startup(): Promise<void> {
    const { layout } = this.options;
    for (const entry of await readdir(layout.staging).catch(() => [])) {
      const path = join(layout.staging, entry);
      if (path !== layout.held) await rm(path, { recursive: true, force: true });
    }
    await this.pass({ orphans: true });
  }
}
