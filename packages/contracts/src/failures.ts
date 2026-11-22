// Failure codes, their classes and fix actions, the default limits, the
// backoff, and `raiseRule`, which onRunComplete uses.
import { z } from 'zod';

import type { JobClass, RenditionReason } from './jobs.ts';

export const FailureCode = z.enum([
  // transient
  'clientUnreachable',
  'leaseExpired',
  'jellyfinUnavailable',
  // The worker's fetch of the .nzb or .torrent may pass on retry: a timeout, 429, 5xx, a grab limit.
  'releaseFetchFailed',
  // bad release
  'missingArticles',
  'parFailed',
  'unpackFailed',
  'passwordProtected',
  'noMediaFile',
  'fakeOrWrongContent',
  'torrentStalled',
  'importMismatch',
  // A dead link, or a body that isn't a valid NZB or torrent.
  'releaseFileInvalid',
  // preparation
  'transcodeFailed',
  // system
  'diskFull',
  'workerOffline',
  'protocolMismatch',
  'orphanClientItem',
  // Jobs or a kept torrent run of a deleted Work that still haven't ended after `orphanSweepMaxMs`.
  'orphanAfterDelete',
  'pipelineError',
  'workflowPaused',
  // Jellyfin isn't set up or can't be used (blocks publishing); a password change didn't reach it
  'jellyfinSetupNeeded',
  'jellyfinPasswordNotPushed',
  // Jellyfin read a published file as another episode, under another series, or not as a movie.
  'jellyfinMisread',
  // A client state the platform doesn't map, or an active item missing from the client.
  'unknownClientFailure',
  // A /data area isn't writable, or staging, originals and the libraries aren't on one device.
  'storageUnavailable',
  // A chosen VPN isn't active yet, or the tunnel is down; torrent submits wait.
  'vpnDown',
  // metadata: TMDB rejected the token in use; a source failing for too long
  'metadataKeyRejected',
  'metadataSourceUnavailable',
  // indexer health: recorded on the attempt and the indexer, never raised
  'indexerTimeout',
  'indexerError',
  'indexerRateLimited',
]);
export type FailureCode = z.infer<typeof FailureCode>;

/** What went wrong with one indexer call. `code` maps it to a FailureCode with `INDEXER_FAILURE_CODE`. */
export const IndexerFailureKind = z.enum([
  'authRejected',
  'unreachable',
  'timeout',
  'notAnIndexerApi',
  'apiDisabled',
  'rateLimited',
  'httpError',
  'indexerError',
  // A DDoS-Guard or Cloudflare browser check, and a site page that isn't the expected feed or table.
  'challenged',
  'unexpectedPage',
  // The relay's job had no outcome within 90 s.
  'workerUnavailable',
]);
export type IndexerFailureKind = z.infer<typeof IndexerFailureKind>;

/** Whose browser check a `challenged` failure met, for its message. */
export const SiteChallenge = z.enum(['ddosGuard', 'cloudflare']);
export type SiteChallenge = z.infer<typeof SiteChallenge>;

export type IndexerFailureCode = Extract<FailureCode, 'indexerTimeout' | 'indexerError' | 'indexerRateLimited'>;

/** An indexer call's FailureCode: timeouts and rate limits (a challenge too) keep their own code, every other kind is `indexerError`. */
export function indexerFailureCode(kind: IndexerFailureKind): IndexerFailureCode {
  if (kind === 'timeout') return 'indexerTimeout';
  if (kind === 'rateLimited' || kind === 'challenged') return 'indexerRateLimited';
  return 'indexerError';
}

/** Why a release is on a Work's blocklist: the failure, or `manual` for a cancel with blocklisting and entries the user adds. */
export const BlocklistReason = z.union([FailureCode, z.literal('manual')]);
export type BlocklistReason = z.infer<typeof BlocklistReason>;

export const FailureClass = z.enum(['transient', 'badRelease', 'preparation', 'system']);
export type FailureClass = z.infer<typeof FailureClass>;

export const FailureScope = z.enum(['unit', 'system']);
export type FailureScope = z.infer<typeof FailureScope>;

export const FixAction = z.enum([
  'retryNow',
  'tryNextBest',
  'retryRelease',
  'blocklistRemove',
  'retryPreparation',
  'downloadLog',
  'rerunJellyfinSetup',
  'resumeRun',
  'cancelRun',
  'removeClientItem',
  /** Deletes the rows an `orphanAfterDelete` Issue names, ended or not. */
  'removeOrphans',
  /** Opens the metadata settings page to enter a TMDB token. */
  'enterMetadataKey',
  /** Moves the Unit's scanned file to library naming, which publishes it again. */
  'moveToLibraryNaming',
  /** An interactive search of the Issue's Unit, opened on its Candidates tab. */
  'searchAndPick',
  'dismiss',
]);
export type FixAction = z.infer<typeof FixAction>;

/**
 * Fix actions the web app runs itself: "Search and pick" calls
 * `units.searchInteractive` and opens the Candidates tab, "Set up
 * Jellyfin again" opens the Jellyfin password dialog, and "Enter a
 * metadata key" opens the metadata settings. `issues.act` takes the others.
 */
export const CLIENT_FIX_ACTIONS: readonly FixAction[] = ['searchAndPick', 'rerunJellyfinSetup', 'enterMetadataKey'];

/** The fix actions `issues.act(issueId, action)` runs. */
export const IssueAction = FixAction.exclude(['searchAndPick', 'rerunJellyfinSetup', 'enterMetadataKey']);
export type IssueAction = z.infer<typeof IssueAction>;

type Row = { class: FailureClass; scope: FailureScope; fixActions: FixAction[] };

// Every unit-scope Issue, orphanClientItem and orphanAfterDelete can be dismissed; the other
// system Issues resolve themselves and would reopen on the next check.
// "Search and pick" follows the first action of every bad-release code and of transcodeFailed.
const BAD_RELEASE: FixAction[] = ['tryNextBest', 'searchAndPick', 'retryRelease', 'blocklistRemove', 'dismiss'];
// Indexer errors are recorded on the attempt and the indexer's health, never
// raised, so they have no fix action. "Search now" and "Disable indexer" are
// ordinary controls.
const INDEXER: Row = { class: 'transient', scope: 'system', fixActions: [] };

const TABLE: Record<FailureCode, Row> = {
  clientUnreachable: { class: 'transient', scope: 'unit', fixActions: ['retryNow', 'dismiss'] },
  leaseExpired: { class: 'transient', scope: 'unit', fixActions: ['retryNow', 'dismiss'] },
  jellyfinUnavailable: { class: 'transient', scope: 'unit', fixActions: ['retryNow', 'dismiss'] },
  // Transient: no blocklist; like every unit-scope code it can be dismissed.
  releaseFetchFailed: { class: 'transient', scope: 'unit', fixActions: ['retryNow', 'dismiss'] },
  releaseFileInvalid: { class: 'badRelease', scope: 'unit', fixActions: BAD_RELEASE },
  missingArticles: { class: 'badRelease', scope: 'unit', fixActions: BAD_RELEASE },
  parFailed: { class: 'badRelease', scope: 'unit', fixActions: BAD_RELEASE },
  unpackFailed: { class: 'badRelease', scope: 'unit', fixActions: BAD_RELEASE },
  passwordProtected: { class: 'badRelease', scope: 'unit', fixActions: BAD_RELEASE },
  noMediaFile: { class: 'badRelease', scope: 'unit', fixActions: BAD_RELEASE },
  fakeOrWrongContent: { class: 'badRelease', scope: 'unit', fixActions: BAD_RELEASE },
  torrentStalled: { class: 'badRelease', scope: 'unit', fixActions: BAD_RELEASE },
  importMismatch: { class: 'badRelease', scope: 'unit', fixActions: ['tryNextBest', 'searchAndPick', 'blocklistRemove', 'dismiss'] },
  transcodeFailed: { class: 'preparation', scope: 'unit', fixActions: ['retryPreparation', 'searchAndPick', 'tryNextBest', 'downloadLog', 'dismiss'] },
  diskFull: { class: 'system', scope: 'system', fixActions: ['retryNow'] },
  workerOffline: { class: 'system', scope: 'system', fixActions: [] },
  protocolMismatch: { class: 'system', scope: 'system', fixActions: [] },
  orphanClientItem: { class: 'system', scope: 'system', fixActions: ['removeClientItem', 'dismiss'] },
  // Raised by deleteWork's sweep once its cap has passed; nothing else would ever delete those rows.
  orphanAfterDelete: { class: 'system', scope: 'system', fixActions: ['removeOrphans', 'dismiss'] },
  pipelineError: { class: 'system', scope: 'unit', fixActions: ['retryRelease', 'dismiss'] },
  workflowPaused: { class: 'system', scope: 'unit', fixActions: ['resumeRun', 'cancelRun', 'dismiss'] },
  // Both resolve on the next successful setup or push, so neither can be dismissed.
  jellyfinSetupNeeded: { class: 'system', scope: 'system', fixActions: ['rerunJellyfinSetup'] },
  jellyfinPasswordNotPushed: { class: 'system', scope: 'system', fixActions: ['rerunJellyfinSetup'] },
  // Raised at once by the check at publish; resolved by a publish of the Unit that Jellyfin reads right.
  jellyfinMisread: { class: 'system', scope: 'unit', fixActions: ['moveToLibraryNaming', 'dismiss'] },
  // Raised at once; no blocklist and no next-best, but cleaned up like a bad release.
  unknownClientFailure: { class: 'system', scope: 'unit', fixActions: ['retryRelease', 'tryNextBest', 'dismiss'] },
  // Raised and resolved by the worker's storage check; nothing to click.
  storageUnavailable: { class: 'system', scope: 'system', fixActions: [] },
  // Raised and resolved by downloadClients.report; its detail gives the step to take.
  vpnDown: { class: 'system', scope: 'system', fixActions: [] },
  // Both resolve themselves on the next success, so neither can be dismissed.
  metadataKeyRejected: { class: 'system', scope: 'system', fixActions: ['enterMetadataKey'] },
  // `retryNow` enqueues that source's fetch.
  metadataSourceUnavailable: { class: 'system', scope: 'system', fixActions: ['retryNow'] },
  indexerTimeout: INDEXER,
  indexerError: INDEXER,
  indexerRateLimited: INDEXER,
};

const project = <K extends keyof Row>(key: K) =>
  Object.fromEntries(Object.entries(TABLE).map(([code, row]) => [code, row[key]])) as Record<FailureCode, Row[K]>;

export const FAILURE_CLASS = project('class');
export const FAILURE_SCOPE = project('scope');
export const FIX_ACTIONS = project('fixActions');

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const DEFAULT_LIMITS = {
  // A relayed indexer request isn't retried; its failure stays on the search attempt.
  maxAttempts: { 'download.submit': 5, import: 5, publish: 5, prepare: 2, maintenance: 3, indexer: 1 } satisfies Record<JobClass, number>,
  concurrency: { 'download.submit': 4, import: 2, prepare: 1, publish: 2, maintenance: 2, indexer: 4 } satisfies Record<JobClass, number>,
  badReleaseGrabs: 3,
  // A Grab run whose step or replay failed (a mutation out of conflict retries) restarts from that step this many times, then fails.
  runRestarts: 3,
  // The wait before the first restart; it doubles for each next one.
  runRestartBackoffMs: 5 * SECOND,
  torrentStallMs: 6 * HOUR,
  leaseMs: 60 * SECOND,
  heartbeatMs: 20 * SECOND,
  progressMs: 5 * SECOND,
  livenessMs: 60 * SECOND,
  handshakeRetryMs: 60 * SECOND,
  diskFullRetryMs: 30 * MINUTE,
  reconcilerPollMs: 30 * SECOND,
  // The progress-only poll, only while a Download is active.
  progressPollMs: 5 * SECOND,
  candidateTtlMs: 30 * DAY,
  artifactTtlMs: 14 * DAY,
  jobRetentionMs: 30 * DAY,
  backoffBaseMs: 30 * SECOND,
  backoffCapMs: 30 * MINUTE,
  // Jellyfin: a publish waiting for setup, the wait for a file to be listed, the setup's reachable step, and the plays poll.
  jellyfinSetupRetryMs: 30 * MINUTE,
  publishWaitMs: 120 * SECOND,
  publishPollMs: 2 * SECOND,
  jellyfinReachableMs: 3 * MINUTE,
  playbackPollMs: 30 * SECOND,
  playbackReportTtlMs: 90 * DAY,
  // Downloads: fetching releases, the VPN, seeding and the client's items.
  releaseFetchTimeoutMs: 30 * SECOND,
  nzbMaxBytes: 64 * 1024 * 1024,
  torrentMaxBytes: 16 * 1024 * 1024,
  vpnDownAfterMs: 2 * MINUTE,
  // A tunnel back from `down` counts as up, and the down timer clears, only once it has been up this long.
  vpnStableMs: 2 * MINUTE,
  portForwardWaitMs: 5 * MINUTE,
  vpnWaitRetryMs: 5 * MINUTE,
  seedingLostAfterMs: HOUR,
  trackerPollMs: 5 * MINUTE,
  missingItemPasses: 2,
  // qBittorrent applies a seed time limit only when it refreshes the torrent:
  // a completed torrent still seeding this long past its goal is made to refresh, once per pass.
  goalGraceMs: 10 * MINUTE,
  // Import and preparation.
  freeSpaceMarginBytes: 1024 ** 3,
  videoSizeRatio: 2,
  prepareGroups: { import: 0, manual: 0, retry: 0, profileEdit: 1, bulk: 1 } satisfies Record<RenditionReason, 0 | 1>,
  previewChangeLimit: 4000,
  durationToleranceMs: 2 * SECOND,
  durationToleranceRatio: 0.002,
  ffprobeTimeoutMs: 120 * SECOND,
  unarTimeoutMs: 60 * MINUTE,
  ffmpegStallMs: 10 * MINUTE,
  // Scanning: videos per scan.reportBatch, folders per scan/match.run, probes at a time.
  scanBatchSize: 100,
  scanFoldersPerAction: 20,
  scanProbeConcurrency: 2,
  // Five wrong setup passwords lock admin creation this long.
  setupPasswordAttempts: 5,
  setupLockMs: 15 * MINUTE,
  // One request to Nyaa per 5 s, from nyaa.si's robots.txt (`Crawl-delay: 5`).
  nyaaIntervalMs: 5 * SECOND,
  // A definition indexer waits max(this, requestDelay) between requests, as Prowlarr's 2 s default.
  definitionMinIntervalMs: 2 * SECOND,
  // The relay polls its job every 250 ms and gives up after 90 s.
  relayPollMs: 250,
  relayTimeoutMs: 90 * SECOND,
  // An `indexer` job older than this has no relay reading it (one lives 90 s); daily retention removes it.
  relayJobAbandonedMs: HOUR,
  // A deleted Work's jobs and kept torrent run are swept hourly once they end; still there after 7 days, they are raised as `orphanAfterDelete`.
  orphanSweepRetryMs: HOUR,
  orphanSweepMaxMs: 7 * DAY,
  // A seeding torrent's outer limit, which doesn't restart: its goal's seed time plus orphanSweepMaxMs, or this with no time in its goal.
  orphanSeedingMaxMs: 60 * DAY,
} as const;

type Widen<T> = T extends number ? number : { readonly [K in keyof T]: Widen<T[K]> };
/** `DEFAULT_LIMITS`, or the same with some timers lowered for the e2e (`limitsFrom`). */
export type Limits = Widen<typeof DEFAULT_LIMITS>;

/**
 * The timers the e2e may lower through `OMNARR_TEST_LIMITS`, so that no
 * scenario waits on a production timer: the worker's container and the
 * backend's deployment read the same variable. Production never sets it.
 */
export const TEST_LIMIT_KEYS = [
  'torrentStallMs',
  'goalGraceMs',
  'vpnDownAfterMs',
  'vpnStableMs',
  'vpnWaitRetryMs',
  'reconcilerPollMs',
  'progressPollMs',
  'progressMs',
  'leaseMs',
  'heartbeatMs',
  'handshakeRetryMs',
  'jellyfinReachableMs',
  'playbackPollMs',
  'backoffBaseMs',
  'setupLockMs',
  'nyaaIntervalMs',
  'definitionMinIntervalMs',
] as const satisfies readonly (keyof typeof DEFAULT_LIMITS)[];
export type TestLimitKey = (typeof TEST_LIMIT_KEYS)[number];

/**
 * The limits with `OMNARR_TEST_LIMITS`' overrides, a JSON object such as
 * `{"vpnStableMs":5000}`. Unset or empty, `DEFAULT_LIMITS` itself. Each key
 * must be one of `TEST_LIMIT_KEYS` and each value a whole number of ms no
 * larger than the default, so an override can only make a test faster;
 * anything else throws, naming the key.
 */
export function limitsFrom(raw: string | undefined): Limits {
  if (!raw) return DEFAULT_LIMITS;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    parsed = undefined;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) throw new Error('OMNARR_TEST_LIMITS is not a JSON object');
  const keys: readonly string[] = TEST_LIMIT_KEYS;
  for (const [key, value] of Object.entries(parsed)) {
    if (!keys.includes(key)) throw new Error(`OMNARR_TEST_LIMITS: ${key} can't be overridden (only ${TEST_LIMIT_KEYS.join(', ')})`);
    const max = DEFAULT_LIMITS[key as TestLimitKey];
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > max)
      throw new Error(`OMNARR_TEST_LIMITS: ${key} must be a whole number from 1 to ${max}`);
  }
  return { ...DEFAULT_LIMITS, ...(parsed as Partial<Record<TestLimitKey, number>>) };
}

/** Why Jellyfin can't be used, in a `jellyfinSetupNeeded` failure's `data.reason`. */
export const JellyfinSetupReason = z.enum(['setupFailed', 'credentialsNeeded', 'keyRejected', 'libraryMissing']);
export type JellyfinSetupReason = z.infer<typeof JellyfinSetupReason>;

export type RetryPolicy = 'backoff' | 'diskWait' | 'vpnWait' | 'jellyfinSetupWait' | 'terminal';

/**
 * What a failed job attempt does next: transient and preparation
 * codes back off and count an attempt, `diskFull` and `vpnDown` wait without
 * counting one, a `publish` job waits for Jellyfin's setup without counting
 * one, and every other code fails the job.
 */
export function retryPolicy(code: FailureCode, jobClass?: JobClass): RetryPolicy {
  if (code === 'diskFull') return 'diskWait';
  if (code === 'vpnDown') return 'vpnWait';
  // Before the rule that a system code is terminal.
  if (code === 'jellyfinSetupNeeded' && jobClass === 'publish') return 'jellyfinSetupWait';
  const cls = FAILURE_CLASS[code];
  return cls === 'transient' || cls === 'preparation' ? 'backoff' : 'terminal';
}

/** What `raiseRule` counts about a failure. */
export type RaiseCounters = {
  /** The Unit's failed Grabs since its last import, this one included, for the bad-release limit. */
  failedGrabs?: number;
  /** The next-best search found no acceptable candidate that isn't blocklisted. */
  noneLeft?: boolean;
  /** The job failed on its last attempt, so no retry is left. */
  lastAttempt?: boolean;
};

const INDEXER_CODES = new Set<FailureCode>(['indexerTimeout', 'indexerError', 'indexerRateLimited']);

/**
 * Whether a failure becomes an Issue: a bad release at
 * the 3rd failed Grab for the Unit or when none is left, a transient or
 * preparation failure on its last attempt, a system failure at once. Indexer
 * errors stay on the attempt and the indexer's health.
 */
export function raiseRule(code: FailureCode, counters: RaiseCounters): boolean {
  if (INDEXER_CODES.has(code)) return false;
  const cls = FAILURE_CLASS[code];
  if (cls === 'badRelease') return (counters.failedGrabs ?? 0) >= DEFAULT_LIMITS.badReleaseGrabs || counters.noneLeft === true;
  if (cls === 'transient' || cls === 'preparation') return counters.lastAttempt === true;
  return true;
}

/**
 * The wait before attempt `attempt + 1`, in ms: exponential from
 * `backoffBaseMs`, ±20 % jitter, never above `backoffCapMs`.
 */
export function backoff(attempt: number, random: () => number = Math.random, limits: Limits = DEFAULT_LIMITS): number {
  const { backoffBaseMs, backoffCapMs } = limits;
  const exponential = backoffBaseMs * 2 ** Math.max(0, attempt - 1);
  const jittered = Math.min(exponential, backoffCapMs) * (0.8 + 0.4 * random());
  return Math.round(Math.min(jittered, backoffCapMs));
}
