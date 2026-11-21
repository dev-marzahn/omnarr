// Maps adapter errors and client states to a FailureCode. The
// adapters wrap the code in a JobFailure with platform-written detail; the
// outside error text itself is never passed on.
import type { FailureCode } from '@omnarr/contracts';

import type { SeedingProblemState } from './clients/downloadClient.ts';
import type { NzbgetHistoryEntry } from './clients/nzbget.ts';

type HistoryStatus = Pick<NzbgetHistoryEntry, 'Status' | 'ParStatus' | 'UnpackStatus' | 'Health' | 'FailedArticles'>;

/** What a finished NZBGet item is: `completed`, `removed` (deleted in NZBGet, ends as a cancel), or `failed` with its code. */
export type NzbgetHistoryState = { stage: 'completed' } | { stage: 'removed' } | { stage: 'failed'; failureCode: FailureCode };

const failed = (failureCode: FailureCode): NzbgetHistoryState => ({ stage: 'failed', failureCode });

/**
 * The NZBGet history table for a `history` entry; the first matching
 * row wins:
 *
 * 1. `SUCCESS/*` → completed.
 * 2. `DELETED/*` other than `DELETED/HEALTH` → removed: someone deleted it in
 *    NZBGet, so the Grab ends as a cancel.
 * 3. `UnpackStatus SPACE` or `WARNING/SPACE` → `diskFull`: a full disk says
 *    nothing about the release, so it is never blocklisted for it.
 * 4. `FAILURE/HEALTH`, `DELETED/HEALTH`, or `Health < 1000` with
 *    `FailedArticles > 0` that par didn't repair → `missingArticles`, the root
 *    cause of a par or unpack failure that follows.
 * 5. `ParStatus FAILURE` or `WARNING/REPAIRABLE` → `parFailed`.
 * 6. `UnpackStatus PASSWORD` or `WARNING/PASSWORD` → `passwordProtected`.
 * 7. `UnpackStatus FAILURE` or `FAILURE/UNPACK` → `unpackFailed`.
 * 8. `FAILURE/BAD`, or `FAILURE/SCAN` (an NZB NZBGet 26.3 can't parse) →
 *    `releaseFileInvalid`.
 * 9. Anything else (`FAILURE/SCRIPT`, `FAILURE/MOVE`, `WARNING/DAMAGED`
 *    without failed articles, an unknown status, a `URL` record) →
 *    `unknownClientFailure`, which never blocklists a release.
 */
export function nzbgetHistoryState(entry: HistoryStatus): NzbgetHistoryState {
  const { Status: status } = entry;
  if (status.startsWith('SUCCESS/')) return { stage: 'completed' };
  if (status.startsWith('DELETED/') && status !== 'DELETED/HEALTH') return { stage: 'removed' };
  if (entry.UnpackStatus === 'SPACE' || status === 'WARNING/SPACE') return failed('diskFull');
  const unrepaired = entry.Health < 1000 && entry.FailedArticles > 0 && entry.ParStatus !== 'SUCCESS';
  if (status === 'FAILURE/HEALTH' || status === 'DELETED/HEALTH' || unrepaired) return failed('missingArticles');
  if (entry.ParStatus === 'FAILURE' || status === 'WARNING/REPAIRABLE') return failed('parFailed');
  if (entry.UnpackStatus === 'PASSWORD' || status === 'WARNING/PASSWORD') return failed('passwordProtected');
  if (entry.UnpackStatus === 'FAILURE' || status === 'FAILURE/UNPACK') return failed('unpackFailed');
  if (status === 'FAILURE/BAD' || status === 'FAILURE/SCAN') return failed('releaseFileInvalid');
  return failed('unknownClientFailure');
}

/**
 * What a qBittorrent torrent is. `checking`: checking or allocating,
 * which never counts towards a stall. `stopped`: qBittorrent stopped it, as
 * it does at a seeding limit. `unchanged`: report no change. `problem`: what a
 * completed (watched) torrent's failure is as a seeding problem.
 */
export type QbittorrentState = {
  stage: 'queued' | 'downloading' | 'completed' | 'failed';
  failureCode?: FailureCode;
  problem?: SeedingProblemState;
  checking?: true;
  stopped?: true;
  unchanged?: true;
};

const GiB = 1024 ** 3;

/**
 * The qBittorrent table for active Downloads; the first matching row wins.
 * `pausedXX` (4.x) and `stoppedXX` (5.x) read alike.
 *
 * 1. `queuedDL`, `checkingDL`, `checkingResumeData`, `allocating`, or
 *    `moving` below progress 1 → queued. `moving` at progress 1 is no change:
 *    the files aren't in their final place yet, and import relies on that.
 * 2. `metaDL`, `downloading`, `forcedDL`, `stalledDL`, `stoppedDL`/`pausedDL`
 *    → downloading; the reconciler's stall rule decides `torrentStalled`.
 * 3. `uploading`, `stalledUP`, `queuedUP`, `forcedUP`, `checkingUP`,
 *    `stoppedUP`/`pausedUP` → completed; then the Download is watched.
 * 4. `missingFiles` → `unknownClientFailure`.
 * 5. `error` → `diskFull` when the worker's last reading for `downloads` is
 *    below 1 GiB, else `unknownClientFailure`.
 * 6. `unknown`, or a state not in this table → `unknownClientFailure`, which
 *    never blocklists a release.
 */
export function qbittorrentState(info: { state: string; progress: number }, freeBytes: number): QbittorrentState {
  switch (info.state) {
    case 'queuedDL':
      return { stage: 'queued' };
    case 'checkingDL':
    case 'checkingResumeData':
    case 'allocating':
      return { stage: 'queued', checking: true };
    case 'moving':
      return info.progress < 1 ? { stage: 'queued', checking: true } : { stage: 'queued', unchanged: true };
    case 'metaDL':
    case 'downloading':
    case 'forcedDL':
    case 'stalledDL':
    case 'stoppedDL':
    case 'pausedDL':
      return { stage: 'downloading' };
    case 'uploading':
    case 'stalledUP':
    case 'queuedUP':
    case 'forcedUP':
      return { stage: 'completed' };
    case 'checkingUP':
      return { stage: 'completed', checking: true };
    case 'stoppedUP':
    case 'pausedUP':
      return { stage: 'completed', stopped: true };
    case 'missingFiles':
      return { stage: 'failed', failureCode: 'unknownClientFailure', problem: 'missingFiles' };
    case 'error':
      return { stage: 'failed', failureCode: freeBytes < GiB ? 'diskFull' : 'unknownClientFailure', problem: 'error' };
    default:
      return { stage: 'failed', failureCode: 'unknownClientFailure', problem: 'unknown' };
  }
}

/** A non-zero ffmpeg exit, or a kill by a signal (exit code null), is `transcodeFailed`. */
export function ffmpegFailure(exitCode: number | null): FailureCode | undefined {
  return exitCode === 0 ? undefined : 'transcodeFailed';
}

const UNREACHABLE = new Set(['ECONNREFUSED', 'ECONNRESET', 'EHOSTUNREACH', 'ENOTFOUND']);

/**
 * The code for a thrown network or file-system error, or undefined when it
 * isn't one this table knows. Node's fetch throws `TypeError('fetch failed')`
 * with the system error as its `cause`; `AbortSignal.timeout` aborts with a
 * `TimeoutError`. A plain `AbortError` is a cancellation, not a failure here.
 */
export function errorFailureCode(error: unknown): FailureCode | undefined {
  if (!(error instanceof Error)) return undefined;
  const code = (error as { code?: unknown }).code;
  if (typeof code === 'string' && UNREACHABLE.has(code)) return 'clientUnreachable';
  if (code === 'ENOSPC') return 'diskFull';
  if (error.name === 'TimeoutError') return 'clientUnreachable';
  if (error instanceof TypeError && error.message === 'fetch failed') return errorFailureCode(error.cause) ?? 'clientUnreachable';
  return undefined;
}
