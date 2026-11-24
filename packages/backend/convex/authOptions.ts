// The Better Auth options that decide the auth tables, shared by the runtime
// instance (auth.ts) and the locally installed component (betterAuth/), whose
// schema is generated from them. Nothing here imports _generated/, so the
// Better Auth CLI can load it before codegen has run.
import { convexAdapter } from '@convex-dev/better-auth';
import { convex, crossDomain } from '@convex-dev/better-auth/plugins';
import type { BetterAuthOptions } from 'better-auth';
import { admin, username } from 'better-auth/plugins';

import authConfig from './auth.config';
import { originsFor } from './setup/origins';

/**
 * The web app's origin for the crossDomain plugin's callback URLs, which
 * username sign-in doesn't use: `SITE_URL` (OMNARR_WEB_URL, set by the
 * backend's pre-push hook), or localhost on the web port.
 */
export const siteUrl = (): string => configuredSiteUrl() ?? `http://localhost:${process.env.WEB_PORT || '3000'}`;

export const configuredSiteUrl = (): string | undefined => process.env.SITE_URL || undefined;

export const baseAuthOptions = () =>
  ({
    // Better Auth is served by Convex HTTP actions, on the deployment's site URL.
    baseURL: process.env.CONVEX_SITE_URL,
    secret: process.env.BETTER_AUTH_SECRET,
    // Per request, for the origin check and CORS alike.
    trustedOrigins: (request?: Request) => originsFor(request, { siteUrl: configuredSiteUrl(), webPort: process.env.WEB_PORT }),
    emailAndPassword: {
      enabled: true,
      // Accounts are created by first-run setup, never by sign-up.
      disableSignUp: true,
    },
    plugins: [
      // Sign-in by username, because the Jellyfin admin needs one (brief, Jellyfin).
      username(),
      // Roles; v1 uses only `admin`.
      admin({ defaultRole: 'admin', adminRoles: ['admin'] }),
      // The web app and the Convex site are different origins.
      crossDomain({ siteUrl: siteUrl() }),
      convex({ authConfig }),
    ],
  }) satisfies Omit<BetterAuthOptions, 'database'>;

/** The options the auth schema is generated from, with a stand-in database. */
export const staticAuthOptions = (): BetterAuthOptions => ({
  ...baseAuthOptions(),
  // oxlint-disable-next-line typescript/no-explicit-any -- a stand-in adapter that only describes the schema
  database: convexAdapter({} as any, {} as any),
});
