// The Better Auth client. Auth runs on the Convex deployment's site URL, a
// different origin from the web app, so the session travels through the
// cross-domain plugin instead of a cookie.
import { convexClient, crossDomainClient } from '@convex-dev/better-auth/client/plugins';
import { adminClient, usernameClient } from 'better-auth/client/plugins';
import { createAuthClient } from 'better-auth/vue';

export function makeAuthClient(convexSiteUrl: string) {
  return createAuthClient({
    baseURL: convexSiteUrl,
    plugins: [usernameClient(), adminClient(), convexClient(), crossDomainClient()],
  });
}

export type AuthClient = ReturnType<typeof makeAuthClient>;
