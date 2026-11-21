// One worker heartbeat every 20 s: it renews every lease the session
// holds, sends each storage area's free bytes and device, and returns
// the jobs the user cancelled, which are aborted here. After a job failed on
// a refused write, the next beat runs the write check again and sends it.
import { DEFAULT_LIMITS, type StorageArea, type StorageSpace } from '@omnarr/contracts';
import type { GenericId } from 'convex/values';

import { workerErrorCode, type WorkerBackend } from '../convex.ts';

export type HeartbeatOptions = {
  backend: WorkerBackend;
  sessionId: GenericId<'workerSessions'>;
  storage: () => Promise<StorageSpace>;
  /** The write check (capabilities.ts); absent, a write failure sends nothing. */
  writeCheck?: () => Promise<Record<StorageArea, boolean>>;
  /** Aborts a held job. */
  cancel: (jobId: string) => void;
  /** The backend no longer accepts this session, after an upgrade or a rejected handshake. */
  onSessionLost: () => void;
  /** The interval, `heartbeatMs` (20 s; the e2e lowers it with the lease, `OMNARR_TEST_LIMITS`). */
  everyMs?: number;
  log: (message: string) => void;
};

export type Heartbeat = {
  stop: () => void;
  /** A job failed with `EACCES` or `EROFS`: the next beat carries a new write check. */
  recheckWritable: () => void;
};

const SESSION_LOST = new Set(['protocolMismatch', 'sessionNotAccepted']);

/** Starts the heartbeat. */
export function startHeartbeat(options: HeartbeatOptions): Heartbeat {
  const { backend, sessionId, log } = options;
  let recheck = false;
  const beat = async () => {
    const checking = recheck && !!options.writeCheck;
    recheck = false;
    try {
      const [storage, writable] = await Promise.all([options.storage(), checking ? options.writeCheck!() : undefined]);
      const { cancelJobIds } = await backend.heartbeat({ sessionId, storage, ...(writable ? { writable } : {}) });
      for (const jobId of cancelJobIds) options.cancel(jobId);
    } catch (error) {
      // A check the backend didn't get goes with the next beat.
      if (checking) recheck = true;
      const code = workerErrorCode(error);
      log(`heartbeat failed: ${code ?? 'error'}`);
      // A missed beat costs nothing until the leases run out (60 s); the next one
      // may succeed. A refused session won't, so the worker connects again.
      if (code && SESSION_LOST.has(code)) options.onSessionLost();
    }
  };
  const timer = setInterval(() => void beat(), options.everyMs ?? DEFAULT_LIMITS.heartbeatMs);
  return { stop: () => clearInterval(timer), recheckWritable: () => void (recheck = true) };
}
