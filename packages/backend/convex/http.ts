import { httpRouter } from 'convex/server';

import { authComponent, createAuth } from './auth';

const http = httpRouter();

// Better Auth under /api/auth, with CORS for the web app's origin (the
// trusted origins).
authComponent.registerRoutes(http, createAuth, { cors: true });

export default http;
