// What the route middleware decides from (whether there is a session, and
// setup.state), kept between page changes. Fetching both on every click put
// an HTTP round trip and a query in front of every page, and on a busy
// server a click waited seconds for them. setup.state is a live
// subscription; a session, once seen, is kept until Better Auth signals a
// sign-in or sign-out (in this tab or another). A page change then waits on
// the network only when there is no session yet, or on the pages that
// change it (sign-in, setup).

import type { SetupState } from '@omnarr/contracts';

/**
 * Whether the browser has a session (throws when the check fails), and a listener for anything that
 * may have changed it: Better Auth's sign-in/sign-out signal, and its session store turning empty.
 */
export type SessionSource = {
  fetch(): Promise<boolean>;
  onChange(listener: () => void): void;
};

/** setup.state as a live query; returns its unsubscribe. */
export type StateSource = {
  subscribe(onValue: (state: SetupState) => void, onError: (error: unknown) => void): () => void;
};

export type Inputs = { signedIn: boolean; state: SetupState };

export type RouteInputs = {
  /**
   * The inputs. `fresh` asks for the session again even when one is kept: Better Auth fires its
   * signal only after `signIn` and `signOut` resolve, and their pages navigate at once. Throws when
   * setup.state fails; the next read subscribes again.
   */
  read(options?: { fresh?: boolean }): Promise<Inputs>;
  /**
   * Checks a kept session again, in the background of a page change, when the last check is older
   * than `recheckMs` or setup.state has no step for it, so a session the server ended still leads to
   * sign-in. Resolves to the new inputs when it ended, else undefined.
   */
  recheck(): Promise<Inputs | undefined>;
};

export function createRouteInputs(
  session: SessionSource,
  setup: StateSource,
  { settleMs = 2000, recheckMs = 60_000, now = Date.now }: { settleMs?: number; recheckMs?: number; now?: () => number } = {},
): RouteInputs {
  /** Set only while a session is known to exist. */
  let kept = false;
  let checkedAt = 0;
  let state: SetupState | undefined;
  let failure: unknown;
  const waiting = new Set<() => void>();

  let unsubscribe: () => void;
  const subscribe = () => {
    unsubscribe = setup.subscribe(
      (value) => {
        state = value;
        failure = undefined;
        for (const wake of waiting) wake();
      },
      (error) => {
        failure = error;
        for (const wake of waiting) wake();
      },
    );
  };
  subscribe();
  session.onChange(() => {
    kept = false;
  });

  /** Resolves once `ready()` holds, checked on each setup.state update, or after `timeoutMs`. */
  const until = (ready: () => boolean, timeoutMs = Infinity) =>
    new Promise<void>((resolve) => {
      if (ready()) return resolve();
      const timer = Number.isFinite(timeoutMs) ? setTimeout(done, timeoutMs) : undefined;
      function done() {
        clearTimeout(timer);
        waiting.delete(check);
        resolve();
      }
      function check() {
        if (ready()) done();
      }
      waiting.add(check);
    });

  /** The session as the server sees it; a failed check counts as none and isn't kept. */
  async function check(): Promise<boolean> {
    checkedAt = now();
    kept = await session.fetch().catch(() => false);
    return kept;
  }

  async function withState(signedIn: boolean, justSignedIn = false): Promise<Inputs> {
    // A failed setup.state is asked again on the next page change, as a one-shot query was: a
    // passing error (the server restarting) must not send every later page to sign-in.
    if (failure !== undefined) {
      unsubscribe();
      state = undefined;
      failure = undefined;
      subscribe();
    }
    await until(() => state !== undefined || failure !== undefined);
    if (failure !== undefined) throw failure;
    // Right after sign-in the Convex client may still be fetching its token; the step comes with it.
    // Only then: a session that isn't an admin's never gets a step, and must not wait on every click.
    const stepMissing = () => state!.adminExists && state!.step === undefined;
    if (justSignedIn && stepMissing()) await until(() => !stepMissing(), settleMs);
    return { signedIn, state: state! };
  }

  async function read({ fresh = false } = {}): Promise<Inputs> {
    if (kept && !fresh) return withState(true);
    const wasKept = kept;
    const signedIn = await check();
    return withState(signedIn, signedIn && !wasKept);
  }

  let rechecking: Promise<Inputs | undefined> | undefined;

  async function recheck(): Promise<Inputs | undefined> {
    if (!kept || rechecking) return undefined;
    // A kept session without a step may be one the server revoked (setup.state answers it as
    // signed out): ask at once rather than after recheckMs.
    const stepMissing = state !== undefined && state.adminExists && state.step === undefined;
    if (!stepMissing && now() - checkedAt < recheckMs) return undefined;
    checkedAt = now();
    rechecking = (async () => {
      // Only an answer ends a kept session: a check that fails (the server is busy or away) keeps it.
      const signedIn = await session.fetch().catch(() => true);
      if (signedIn || !kept) return undefined;
      kept = false;
      return withState(false);
    })().finally(() => (rechecking = undefined));
    return rechecking;
  }

  return { read, recheck };
}
