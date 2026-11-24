// A bug: every page change waited for a session check over HTTP and a
// setup.state query before it rendered, which on a busy server took seconds
// a click. The route inputs now ask the network only when there is no
// session yet, on the sign-in and setup pages, and once a minute in the
// background.
import type { SetupState } from '@omnarr/contracts';
import { describe, expect, test, vi } from 'vite-plus/test';

import { createRouteInputs, type SessionSource, type StateSource } from '../lib/routeInputs';

const DONE: SetupState = { adminExists: true, step: 'done' };

function fakeSession(initial: boolean | Error) {
  let answer = initial;
  const listeners: (() => void)[] = [];
  const fetch = vi.fn(async () => {
    if (answer instanceof Error) throw answer;
    return answer;
  });
  const session: SessionSource = { fetch, onChange: (listener) => void listeners.push(listener) };
  return {
    session,
    fetch,
    answer: (value: boolean | Error) => void (answer = value),
    signal: () => listeners.forEach((listener) => listener()),
  };
}

/** setup.state's live query; a new subscription gets the server's current answer, as Convex sends it. */
function fakeState(initial?: SetupState) {
  let server: SetupState | Error | undefined = initial;
  let push: ((state: SetupState) => void) | undefined;
  let fail: ((error: unknown) => void) | undefined;
  const unsubscribe = vi.fn();
  const subscribe = vi.fn<StateSource['subscribe']>((onValue, onError) => {
    push = onValue;
    fail = onError;
    if (server instanceof Error) onError(server);
    else if (server) onValue(server);
    return unsubscribe;
  });
  const setup: StateSource = { subscribe };
  return {
    setup,
    subscribe,
    unsubscribe,
    push: (state: SetupState) => push!((server = state)),
    fail: (error: Error) => fail!((server = error)),
    /** What the server answers from now on, without pushing it to the current subscription. */
    answer: (value: SetupState | Error) => void (server = value),
  };
}

describe('createRouteInputs', () => {
  test('a kept session and the live setup.state answer later page changes without the network', async () => {
    const { session, fetch } = fakeSession(true);
    const { setup, subscribe } = fakeState(DONE);
    const inputs = createRouteInputs(session, setup);

    expect(await inputs.read()).toEqual({ signedIn: true, state: DONE });
    expect(await inputs.read()).toEqual({ signedIn: true, state: DONE });
    expect(await inputs.read()).toEqual({ signedIn: true, state: DONE });
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(1);
  });

  test('a page change reads the latest setup.state', async () => {
    const { session } = fakeSession(true);
    const { setup, push } = fakeState({ adminExists: true, step: 'address' });
    const inputs = createRouteInputs(session, setup);

    expect((await inputs.read()).state).toEqual({ adminExists: true, step: 'address' });
    push({ adminExists: true, step: 'indexer' });
    expect((await inputs.read()).state).toEqual({ adminExists: true, step: 'indexer' });
  });

  test('without a session every page change asks again, so a sign-in is seen at once', async () => {
    const { session, fetch, answer } = fakeSession(false);
    const { setup } = fakeState(DONE);
    const inputs = createRouteInputs(session, setup);

    expect((await inputs.read()).signedIn).toBe(false);
    // signIn resolved; Better Auth's signal comes 10 ms later, after the login page navigated.
    answer(true);
    expect((await inputs.read()).signedIn).toBe(true);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('the sign-in and setup pages ask again even with a kept session, so a sign-out is seen at once', async () => {
    const { session, answer } = fakeSession(true);
    const { setup } = fakeState(DONE);
    const inputs = createRouteInputs(session, setup);

    await inputs.read();
    // signOut resolved; the menu navigates to /login before the signal.
    answer(false);
    expect((await inputs.read({ fresh: true })).signedIn).toBe(false);
  });

  test("Better Auth's signal drops a kept session", async () => {
    const { session, answer, signal } = fakeSession(true);
    const { setup } = fakeState(DONE);
    const inputs = createRouteInputs(session, setup);

    await inputs.read();
    answer(false);
    signal();
    expect((await inputs.read()).signedIn).toBe(false);
  });

  test('a failed session check counts as signed out and is asked again next time', async () => {
    const { session, answer } = fakeSession(new Error('backend away'));
    const { setup } = fakeState(DONE);
    const inputs = createRouteInputs(session, setup);

    expect((await inputs.read()).signedIn).toBe(false);
    answer(true);
    expect((await inputs.read()).signedIn).toBe(true);
  });

  test('the first page change waits for setup.state, and a failing one throws', async () => {
    const { session } = fakeSession(true);
    const { setup, push, fail } = fakeState();
    const inputs = createRouteInputs(session, setup);

    const first = inputs.read();
    push(DONE);
    expect(await first).toEqual({ signedIn: true, state: DONE });

    fail(new Error('setup.state failed'));
    await expect(inputs.read()).rejects.toThrow('setup.state failed');
  });

  test('a setup.state error that passes is asked again on the next page change, not kept until a reload', async () => {
    const { session } = fakeSession(true);
    const { setup, subscribe, unsubscribe, fail, answer } = fakeState(DONE);
    const inputs = createRouteInputs(session, setup);
    await inputs.read();

    // The NAS hiccups: the live query errors, and the server is back before the next click.
    fail(new Error('backend restarting'));
    answer(DONE);
    expect(await inputs.read()).toEqual({ signedIn: true, state: DONE });
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(subscribe).toHaveBeenCalledTimes(2);
  });

  test('a setup.state error that lasts sends that page change to sign-in, and the next one tries again', async () => {
    const { session } = fakeSession(true);
    const { setup, fail, answer } = fakeState(DONE);
    const inputs = createRouteInputs(session, setup);
    await inputs.read();

    fail(new Error('backend away'));
    await expect(inputs.read()).rejects.toThrow('backend away');
    answer(DONE);
    expect(await inputs.read()).toEqual({ signedIn: true, state: DONE });
  });

  test('a kept session the server revoked costs no wait, and is rechecked at once', async () => {
    vi.useFakeTimers();
    try {
      const { session, fetch, answer } = fakeSession(true);
      const { setup, push } = fakeState(DONE);
      const inputs = createRouteInputs(session, setup, { settleMs: 2000, recheckMs: 60_000, now: () => 0 });
      await inputs.read();

      // Revoked: setup.state now answers the browser as signed out, without a step.
      push({ adminExists: true });
      answer(false);
      let answered = false;
      const next = inputs.read().then((value) => {
        answered = true;
        return value;
      });
      await vi.advanceTimersByTimeAsync(0);
      expect(answered).toBe(true);
      expect((await next).signedIn).toBe(true);

      // Well inside recheckMs, the missing step asks the server now.
      expect(await inputs.recheck()).toEqual({ signedIn: false, state: { adminExists: true } });
      expect(fetch).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  test('concurrent rechecks share one session check', async () => {
    const { session, fetch } = fakeSession(true);
    const { setup } = fakeState({ adminExists: true });
    const inputs = createRouteInputs(session, setup, { settleMs: 0, now: () => 0 });
    await inputs.read();

    await Promise.all([inputs.recheck(), inputs.recheck(), inputs.recheck()]);
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  test('right after sign-in it waits for the step that comes with the token, up to settleMs', async () => {
    vi.useFakeTimers();
    try {
      const { session } = fakeSession(true);
      const { setup, push } = fakeState({ adminExists: true });
      const inputs = createRouteInputs(session, setup, { settleMs: 2000 });

      const withToken = inputs.read();
      await vi.advanceTimersByTimeAsync(300);
      push({ adminExists: true, step: 'address' });
      expect((await withToken).state).toEqual({ adminExists: true, step: 'address' });
    } finally {
      vi.useRealTimers();
    }
  });

  test("a session that isn't an admin's (no step) waits settleMs once, at sign-in, not on every page change", async () => {
    vi.useFakeTimers();
    try {
      const { session } = fakeSession(true);
      const { setup } = fakeState({ adminExists: true });
      const inputs = createRouteInputs(session, setup, { settleMs: 2000 });

      const atSignIn = inputs.read();
      await vi.advanceTimersByTimeAsync(2000);
      expect((await atSignIn).state).toEqual({ adminExists: true });

      let answered = false;
      const later = inputs.read().then((value) => ((answered = true), value));
      await vi.advanceTimersByTimeAsync(0);
      expect(answered).toBe(true);
      expect((await later).state).toEqual({ adminExists: true });

      // The sign-in and setup pages ask again, but a session that was already there isn't a new sign-in.
      let freshAnswered = false;
      void inputs.read({ fresh: true }).then(() => (freshAnswered = true));
      await vi.advanceTimersByTimeAsync(0);
      expect(freshAnswered).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });

  describe('recheck', () => {
    test('asks at most once per recheckMs, and reports a session the server ended', async () => {
      let clock = 0;
      const { session, fetch, answer } = fakeSession(true);
      const { setup } = fakeState(DONE);
      const inputs = createRouteInputs(session, setup, { recheckMs: 60_000, now: () => clock });

      await inputs.read();
      expect(await inputs.recheck()).toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(1);

      clock = 61_000;
      expect(await inputs.recheck()).toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(2);

      clock = 122_000;
      answer(false);
      expect(await inputs.recheck()).toEqual({ signedIn: false, state: DONE });
      expect((await inputs.read()).signedIn).toBe(false);
    });

    test('a check that fails keeps the session', async () => {
      let clock = 0;
      const { session, answer } = fakeSession(true);
      const { setup } = fakeState(DONE);
      const inputs = createRouteInputs(session, setup, { now: () => clock });

      await inputs.read();
      clock = 61_000;
      answer(new Error('busy'));
      expect(await inputs.recheck()).toBeUndefined();
      expect((await inputs.read()).signedIn).toBe(true);
    });

    test('does nothing without a kept session', async () => {
      const { session, fetch } = fakeSession(false);
      const { setup } = fakeState(DONE);
      const inputs = createRouteInputs(session, setup, { now: () => 1e9 });

      await inputs.read();
      expect(await inputs.recheck()).toBeUndefined();
      expect(fetch).toHaveBeenCalledTimes(1);
    });
  });
});
