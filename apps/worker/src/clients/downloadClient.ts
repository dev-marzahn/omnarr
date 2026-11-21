// The download-client port the job handlers and the reconciler call. The
// adapters are NZBGet and qBittorrent.
import type {
  ClientKind,
  ClientStatus,
  ConnectionStatus,
  DesiredClientConfig,
  DownloadSubmitPayload,
  FailureCode,
  SeedGoal,
  UsenetServerUsage,
} from '@omnarr/contracts';

/**
 * A release file the worker fetched itself, so the client never sees
 * the indexer's URL or key. An NZB's `name` is the release title, which names
 * the item in NZBGet. A torrent is named by its info hash, known before it is
 * submitted: qBittorrent's `clientRef`.
 */
export type FetchedRelease =
  | { kind: 'nzb'; name: string; bytes: Uint8Array }
  | { kind: 'torrentFile'; bytes: Uint8Array; infoHash: string }
  | { kind: 'magnet'; uri: string; infoHash: string };

/** A completed torrent qBittorrent can't seed: a seeding problem once the Download is watched. */
export type SeedingProblemState = 'missingFiles' | 'error' | 'unknown';

export type ClientItem = {
  /** NZBGet NZBID or torrent info hash. */
  clientRef: string;
  /** The Grab IDs the platform tagged the item with: one for NZBGet, any number for a shared torrent. Empty on items it didn't add. */
  correlationTags: string[];
  /** `removed`: someone deleted the item in the client; the Grab ends as a cancel would. */
  stage: 'queued' | 'downloading' | 'postProcessing' | 'completed' | 'failed' | 'removed';
  status: ClientStatus;
  /** Where the finished content is, under /data/downloads. Only on `completed` items. */
  contentPath?: string;
  /** Why a `failed` item failed. */
  failureCode?: FailureCode;
  /** The item's name in the client, for an orphan's Issue. */
  name?: string;
  /** Torrents: the bytes downloaded so far, for the stall clock. */
  downloadedBytes?: number;
  /** Torrents: the share ratio and seed time, for the goal. */
  ratio?: number;
  seedingTimeMs?: number;
  /** Torrents: the bytes uploaded, for seeding progress. */
  uploadedBytes?: number;
  /** Torrents: qBittorrent stopped it (`stoppedUP`/`pausedUP`), as it does at a limit. */
  stopped?: boolean;
  /** Torrents: when the download completed (epoch ms), which doesn't go stale as the seed time can. */
  completedAt?: number;
  /** Torrents: from a private tracker. */
  isPrivate?: boolean;
  /** Torrents: the state of a `failed` row that a watched (completed) Download reads as a seeding problem. */
  problem?: SeedingProblemState;
  /** Torrents: still checking or allocating, which never counts towards a stall. */
  checking?: boolean;
  /** The reconciler reports no change for it this pass (qBittorrent still moving a finished torrent's files). */
  unchanged?: boolean;
};

export type SubmitOptions = {
  /** The Grab ID; the item is found again by it only. */
  correlationTag: string;
  category: DownloadSubmitPayload['category'];
  /** Torrents: the per-torrent limits qBittorrent enforces. */
  seedGoal?: SeedGoal;
};

export type ClientRuntimeReading = { reachable: boolean; version?: string; connectionStatus?: ConnectionStatus };

export interface DownloadClient {
  readonly kind: ClientKind;
  /** The item tagged with a Grab, so a re-claimed submit doesn't add it twice. */
  findByTag(correlationTag: string, signal: AbortSignal): Promise<ClientItem | null>;
  submit(release: FetchedRelease, options: SubmitOptions, signal: AbortSignal): Promise<{ clientRef: string }>;
  /** Every item in the queue and history, for the reconciler. */
  list(signal: AbortSignal): Promise<ClientItem[]>;
  /** `correlationTag` is the Grab whose tag a shared torrent loses; NZBGet items have one Grab. */
  remove(clientRef: string, correlationTag: string | undefined, deleteData: boolean, signal: AbortSignal): Promise<{ removed: boolean }>;
  /** Brings the client's config in line with the platform's; writes nothing when nothing differs. */
  applyConfig(desired: DesiredClientConfig, signal: AbortSignal): Promise<{ applied: boolean; changed: boolean; clientVersion?: string }>;
  /** Whether the client answers, its version, and qBittorrent's connection status. */
  status(signal: AbortSignal): Promise<ClientRuntimeReading>;
  /**
   * qBittorrent only: makes it refresh a torrent, and so apply a seed time limit it holds but
   * hasn't applied (see `goalGraceMs`).
   */
  refreshTorrent?(clientRef: string, signal: AbortSignal): Promise<void>;
  /**
   * NZBGet only: pauses each server whose monthly limit is used up and resumes it in the next
   * period, answering each limited server's usage.
   */
  enforceLimits?(desired: NonNullable<DesiredClientConfig['nzbget']>, now: number, signal: AbortSignal): Promise<UsenetServerUsage[]>;
}
