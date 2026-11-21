import type { AuthConfig } from 'convex/server';

// Convex accepts the JWTs the Better Auth convex plugin issues (RS256),
// verified against its JWKS on the backend's own HTTP actions over loopback
//: the backend never fetches its public auth URL, so a public
// CONVEX_SITE_URL behind the user's proxy needs no route back.
export default {
  providers: [
    {
      type: 'customJwt',
      issuer: `${process.env.CONVEX_SITE_URL}`,
      applicationID: 'convex',
      algorithm: 'RS256',
      jwks: 'http://127.0.0.1:3211/api/auth/convex/jwks',
    },
  ],
} satisfies AuthConfig;
