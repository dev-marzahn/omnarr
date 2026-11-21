// Authenticates the Convex client with the Better Auth session's JWT. The
// client fetches a token only when `setAuth` is called (and again when one
// expires), so it is called again whenever the session changes: a sign-in
// after the app started would otherwise leave the client unauthenticated
// until a reload.

/** The part of ConvexClient this needs. */
export type ConvexAuthTarget = { setAuth(fetchToken: () => Promise<string | null | undefined>): void };

/** The part of the Better Auth client this needs: the Convex token, and the signal sign-in and sign-out fire. */
export type SessionAuth = {
  convex: { token(options: { fetchOptions: { throw: false } }): Promise<{ data?: { token: string } | null }> };
  $store: { listen(signal: '$sessionSignal', listener: (value: boolean) => void): unknown };
};

export function connectConvexAuth(convex: ConvexAuthTarget, auth: SessionAuth): void {
  const fetchToken = async () => {
    const { data } = await auth.convex.token({ fetchOptions: { throw: false } });
    return data?.token ?? null;
  };
  convex.setAuth(fetchToken);
  auth.$store.listen('$sessionSignal', () => convex.setAuth(fetchToken));
}
