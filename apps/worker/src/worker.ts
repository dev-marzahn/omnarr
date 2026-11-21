// The worker's life: handshake, then the lease runtime and the heartbeat, and
// shutdown. main.ts wires it to the environment.
import { type Capabilities, DEFAULT_LIMITS, type JellyfinConnection, type Limits, type JobClass, type StorageArea, type StorageSpace } from '@omnarr/contracts';
import type { GenericId } from 'convex/values';

import { workerErrorCode, type WorkerBackend } from './convex.ts';
import { startHeartbeat } from './runtime/heartbeat.ts';
import { type JobHandler, LeaseRuntime } from './runtime/lease.ts';
import { startPlaybackWatch } from './runtime/playbackWatch.ts';
import type { Reconciler } from './runtime/reconcile.ts';
import type { PlaybackTarget } from './targets/playbackTarget.ts';

export type WorkerOptions = {
  backend: WorkerBackend;
  /** Stable per container. */
  workerId: string;
  capabilities: () => Promise<Capabilities>;
  /** Each area's free bytes and device, for every heartbeat. */
  storage: () => Promise<StorageSpace>;
  /** The write check, run again after a job fails with `EACCES` or `EROFS`. */
  writeCheck?: () => Promise<Record<StorageArea, boolean>>;
  handlers: Partial<Record<JobClass, JobHandler>>;
  /** The download reconciler for a session (reconcile.ts); absent in tests that don't need one. */
  reconciler?: (sessionId: GenericId<'workerSessions'>) => Pick<Reconciler, 'startup' | 'pass'> & Partial<Pick<Reconciler, 'progressTick'>>;
  /**
   * Jellyfin's connection: each session subscribes and hands every
   * value on, and runs the play poller on `target`. Absent without
   * `JELLYFIN_URL`.
   */
  jellyfin?: { onConnection: (value: JellyfinConnection | null) => void; target?: Pick<PlaybackTarget, 'observe'> };
  /** `handshakeRetryMs`, `heartbeatMs`, `progressMs` and the reconciler's, progress and play polls; the e2e lowers them (`OMNARR_TEST_LIMITS`). */
  limits?: Limits;
  log: (message: string) => void;
};

export type Worker = {
  /** On SIGTERM: stops claiming, aborts running work and releases every held job. */
  stop: () => Promise<void>;
};

export function startWorker(options: WorkerOptions): Worker {
  const { backend, log } = options;
  const limits = options.limits ?? DEFAULT_LIMITS;
  let stopped = false;
  let runtime: LeaseRuntime | undefined;
  let stopHeartbeat: (() => void) | undefined;
  let stopReconciler: (() => void) | undefined;
  let wakeRetry: (() => void) | undefined;
  let endSession: (() => void) | undefined;

  const waitForRetry = () =>
    new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, limits.handshakeRetryMs);
      wakeRetry = () => {
        clearTimeout(timer);
        resolve();
      };
    });

  /**
   * Connects until the backend accepts. A version mismatch is logged and
   * retried every 60 s without exiting, so Docker never restart-loops.
   */
  const handshake = async (): Promise<GenericId<'workerSessions'> | undefined> => {
    const retrying = `retrying in ${limits.handshakeRetryMs / 1000} s`;
    while (!stopped) {
      try {
        const response = await backend.connect({ workerId: options.workerId, capabilities: await options.capabilities() });
        if (response.accepted) return response.sessionId;
        log(`protocol version mismatch: this worker speaks ${backend.protocolVersion}, the backend expects ${response.expectedVersion}; ${retrying}`);
      } catch (error) {
        log(`connect failed: ${workerErrorCode(error) ?? 'backend unreachable'}; ${retrying}`);
      }
      await waitForRetry();
    }
    return undefined;
  };

  /**
   * Subscribes to Jellyfin's connection and resolves on its first value, or
   * when the session ends first. The play poller runs on the session's latest
   * value until the returned function stops both.
   */
  const watchJellyfin = async (sessionId: GenericId<'workerSessions'>, lost: Promise<void>): Promise<() => void> => {
    const { jellyfin } = options;
    if (!jellyfin) return () => {};
    let latest: JellyfinConnection | null = null;
    let first: () => void = () => {};
    const arrived = new Promise<void>((resolve) => (first = resolve));
    const unwatch = backend.watchJellyfinConnection(sessionId, (value) => {
      latest = value;
      jellyfin.onConnection(value);
      first();
    });
    const stopPlays = jellyfin.target
      ? startPlaybackWatch({ backend, sessionId, target: jellyfin.target, connection: () => latest, pollMs: limits.playbackPollMs, log })
      : () => {};
    await Promise.race([arrived, lost]);
    return () => {
      stopPlays();
      unwatch();
    };
  };

  /**
   * One accepted session: the lease runtime and the heartbeat run until the
   * backend refuses the session (it was upgraded, say) or the worker stops.
   */
  const runSession = async (sessionId: GenericId<'workerSessions'>): Promise<void> => {
    log(`connected as session ${sessionId}`);
    const lost = new Promise<void>((resolve) => (endSession = resolve));
    // The startup reconciliation runs before any claim; a failed one is logged and the next pass catches up.
    const reconciler = options.reconciler?.(sessionId);
    await reconciler?.startup().catch((error: unknown) => log(`startup reconciliation failed: ${workerErrorCode(error) ?? 'error'}`));
    const poll = reconciler
      ? setInterval(
          () => void reconciler.pass().catch((error: unknown) => log(`reconcile failed: ${workerErrorCode(error) ?? 'error'}`)),
          limits.reconcilerPollMs,
        )
      : undefined;
    // The progress-only poll between passes; it does nothing while no Download is active.
    const progressPoll = reconciler?.progressTick
      ? setInterval(
          () => void reconciler.progressTick!().catch((error: unknown) => log(`progress poll failed: ${workerErrorCode(error) ?? 'error'}`)),
          limits.progressPollMs,
        )
      : undefined;
    stopReconciler = () => {
      clearInterval(poll);
      clearInterval(progressPoll);
    };
    // The connection's first value comes before any claim, so `publish` never runs on a stale key.
    const unwatchJellyfin = await watchJellyfin(sessionId, lost);
    const stopSessionWatches = stopReconciler;
    stopReconciler = () => {
      stopSessionWatches();
      unwatchJellyfin();
    };
    // stop() came while the session started, before these watches existed.
    if (stopped) return stopReconciler();
    const heartbeat = startHeartbeat({
      backend,
      sessionId,
      storage: options.storage,
      ...(options.writeCheck ? { writeCheck: options.writeCheck } : {}),
      cancel: (jobId) => current.cancel(jobId),
      onSessionLost: () => endSession?.(),
      everyMs: limits.heartbeatMs,
      log,
    });
    const current = new LeaseRuntime({ backend, sessionId, handlers: options.handlers, limits, onWriteFailure: () => heartbeat.recheckWritable(), log });
    runtime = current;
    stopHeartbeat = heartbeat.stop;
    current.start();
    await lost;
    if (stopped) return; // stop() tears the session down.
    log('the backend no longer accepts this session; connecting again');
    stopReconciler?.();
    stopHeartbeat();
    stopHeartbeat = undefined;
    runtime = undefined;
    await current.stop();
  };

  void (async () => {
    while (!stopped) {
      const sessionId = await handshake();
      if (!sessionId || stopped) return;
      await runSession(sessionId);
    }
  })();

  return {
    stop: async () => {
      stopped = true;
      wakeRetry?.();
      endSession?.();
      // Before the handshake succeeds the worker holds nothing, and a connect
      // to an unreachable backend may never settle, so it isn't awaited.
      stopReconciler?.();
      stopHeartbeat?.();
      await runtime?.stop();
    },
  };
}
