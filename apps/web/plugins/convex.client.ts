// One ConvexClient for the app, authenticated with a JWT the Better Auth
// session issues. Convex calls the token fetcher again when the token expires,
// and connectConvexAuth hands it a new one whenever the session changes.
import { ConvexClient } from 'convex/browser';

import { useUrls } from '~/composables/useShell';
import { makeAuthClient } from '~/lib/authClient';
import { connectConvexAuth, type SessionAuth } from '~/lib/convexAuth';

export default defineNuxtPlugin(() => {
  // Read at the web container's start, or built from this page's address.
  const urls = useUrls();
  const auth = makeAuthClient(urls.convexSite);
  const convex = new ConvexClient(urls.convex);
  connectConvexAuth(convex, auth as unknown as SessionAuth);
  return { provide: { auth, convex } };
});
