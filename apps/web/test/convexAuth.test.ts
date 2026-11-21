// A bug: right after sign-in, the library page's first query failed as
// unauthorized until a reload. The Convex client asked for a token once, at
// startup, before there was a session, and never again.
import { describe, expect, test, vi } from 'vite-plus/test';

import { connectConvexAuth, type ConvexAuthTarget, type SessionAuth } from '../lib/convexAuth';

/** A Better Auth client: a session that can start, and the signal it fires when it does. */
function fakeAuth() {
  let token: string | null = null;
  const listeners: ((value: boolean) => void)[] = [];
  const auth: SessionAuth = {
    convex: { token: async () => ({ data: token ? { token } : null }) },
    $store: { listen: (_signal, listener) => void listeners.push(listener) },
  };
  return {
    auth,
    signIn: (jwt: string) => {
      token = jwt;
      for (const listener of listeners) listener(true);
    },
    signOut: () => {
      token = null;
      for (const listener of listeners) listener(false);
    },
  };
}

/** A Convex client that, like ConvexClient, fetches a token only when setAuth is called. */
function fakeConvex() {
  const tokens: (string | null)[] = [];
  const convex: ConvexAuthTarget = {
    setAuth: vi.fn((fetchToken: () => Promise<string | null | undefined>) => {
      void fetchToken().then((token) => tokens.push(token ?? null));
    }),
  };
  return { convex, tokens };
}

describe('connectConvexAuth', () => {
  test('a sign-in after the client started gives Convex the new session token, without a reload', async () => {
    const { auth, signIn } = fakeAuth();
    const { convex, tokens } = fakeConvex();
    connectConvexAuth(convex, auth);
    await vi.waitFor(() => expect(tokens).toEqual([null]));

    signIn('session-jwt');
    await vi.waitFor(() => expect(tokens).toEqual([null, 'session-jwt']));
  });

  test('a sign-out drops the token', async () => {
    const { auth, signIn, signOut } = fakeAuth();
    const { convex, tokens } = fakeConvex();
    connectConvexAuth(convex, auth);
    signIn('session-jwt');
    signOut();
    await vi.waitFor(() => expect(tokens.at(-1)).toBeNull());
  });
});
