// The session poller, in the pattern of the download
// reconciler (reconcile.ts): it starts and stops with a worker session, and
// while Jellyfin's connection is `ready` it asks the target for the running
// plays every `playbackPollMs`. It sends the set only when it differs from
// the last one sent, so nothing is written while nothing changes; the first
// set of a session is always sent, which ends plays a previous session left
// open. A failed call is logged, and the next pass tries again.
import { type ActivePlay, DEFAULT_LIMITS, type JellyfinConnection } from '@omnarr/contracts';
import type { GenericId } from 'convex/values';

import { workerErrorCode, type WorkerBackend } from '../convex.ts';
import type { PlaybackTarget } from '../targets/playbackTarget.ts';
import { JobFailure } from './lease.ts';

export type PlaybackWatchOptions = {
  backend: Pick<WorkerBackend, 'reportPlays'>;
  sessionId: GenericId<'workerSessions'>;
  target: Pick<PlaybackTarget, 'observe'>;
  /** The session's latest `jellyfin.setup.connection` value. */
  connection: () => JellyfinConnection | null;
  /** The poll interval, `playbackPollMs` (30 s; the e2e lowers it through `OMNARR_TEST_LIMITS`). */
  pollMs?: number;
  log: (message: string) => void;
};

/** The same plays in any order are the same set. */
const setKey = (plays: ActivePlay[]) =>
  JSON.stringify(
    plays.map((play) => JSON.stringify([play.deviceId, play.itemRef, play.deviceName, play.client, play.method, play.reasons, play.rawReasons])).sort(),
  );

/** Starts the poller for one session; the returned function stops it and aborts a running call. */
export function startPlaybackWatch({ backend, sessionId, target, connection, pollMs = DEFAULT_LIMITS.playbackPollMs, log }: PlaybackWatchOptions): () => void {
  const controller = new AbortController();
  let sent: string | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;

  const pass = async () => {
    if (connection()?.state !== 'ready') return;
    let plays: ActivePlay[];
    try {
      plays = await target.observe(controller.signal);
    } catch (error) {
      if (!controller.signal.aborted) log(`playback poll failed: ${error instanceof JobFailure ? error.message : 'error'}`);
      return;
    }
    const key = setKey(plays);
    if (controller.signal.aborted || key === sent) return;
    try {
      await backend.reportPlays(sessionId, plays);
      sent = key;
    } catch (error) {
      log(`playback report failed: ${workerErrorCode(error) ?? 'error'}`);
    }
  };

  // One pass at a time: the next is scheduled when this one ends.
  const schedule = () => {
    timer = setTimeout(() => void pass().finally(() => controller.signal.aborted || schedule()), pollMs);
  };
  schedule();

  return () => {
    clearTimeout(timer);
    controller.abort();
  };
}
