// convex-test setup: the app's modules with the Better Auth and metadataPool
// components, a worker token and an admin session, the libraries first run
// creates, and the metadata fakes behind `fetch`.
import workpool from '@convex-dev/workpool/test';
import workflowMigrations from '@dev-marzahn/convex-workflow-migrations/test';
import { DEFAULT_DEVICES, PROTOCOL_VERSION, type Capabilities, type StorageSpace } from '@omnarr/contracts';
import { createTmdbHandler, type TmdbFakeOptions } from '@omnarr/e2e/fakes/tmdb';
import { SHIPPED_PROFILES, type ShippedKey } from '@omnarr/scoring';
import { convexTest } from 'convex-test';
import { vi } from 'vite-plus/test';

import { components } from '../convex/_generated/api';
import type { Doc, Id } from '../convex/_generated/dataModel';
import authSchema from '../convex/betterAuth/schema';
import { NYAA_CAPS, NYAA_CATEGORIES } from '../convex/indexers/nyaa';
import { parseAnimeList } from '../convex/mapping/animeListsParse';
import { setupDefaults } from '../convex/playback/profiles';
import schema from '../convex/schema';
import animeListXml from './fixtures/animeLists/anime-list.xml?raw';
import sceneMappingList from './fixtures/sceneMappings/scenemapping.json';

export const modules = import.meta.glob(['../convex/**/*.ts', '!../convex/betterAuth/**']);
const authModules = import.meta.glob('../convex/betterAuth/**/*.ts');

export const WORKER_TOKEN = 'test-worker-token-0123456789';

export function setup() {
  process.env.WORKER_TOKEN = WORKER_TOKEN;
  const t = convexTest(schema, modules);
  t.registerComponent('betterAuth', authSchema, authModules);
  workpool.register(t, 'metadataPool');
  // The Grab run's components: workflow (with its workpool) and workflowMigrations.
  workflowMigrations.register(t, { workflow: 'workflow', migrations: 'workflowMigrations' });
  return t;
}

export type Backend = ReturnType<typeof setup>;

/** The latest time a JavaScript Date holds. */
const LAST_DATE_MS = 8.64e15;

/**
 * The backend as a signed-in admin: a Better Auth user with role `admin`
 * and a session that lasts `sessionMs`, else one that never expires.
 *
 * The default can't be any fixed length. While a scheduled function runs,
 * `finishAllScheduledFunctions` advances the fake timers on every real
 * event-loop turn, so a drain moves the fake clock by an amount that depends
 * on how slow the host is: a 1.5 s stall in one function moves it over a day.
 * A session counted in fake time would then expire mid-test, and the next
 * admin call would fail as `unauthorized`.
 */
export async function asAdmin(t: Backend, sessionMs?: number) {
  const { userId, sessionId } = await t.run(async (ctx) => {
    const now = Date.now();
    const create = (input: object) => ctx.runMutation(components.betterAuth.adapter.create, { input } as never) as Promise<{ _id: string }>;
    const user = await create({
      model: 'user',
      data: { name: 'admin', email: 'admin@users.invalid', emailVerified: false, username: 'admin', role: 'admin', createdAt: now, updatedAt: now },
    });
    const session = await create({
      model: 'session',
      data: { userId: user._id, token: 'session-token', expiresAt: sessionMs === undefined ? LAST_DATE_MS : now + sessionMs, createdAt: now, updatedAt: now },
    });
    return { userId: user._id, sessionId: session._id };
  });
  return t.withIdentity({ subject: userId, sessionId });
}

/** How far the fake clock moves per round of `drainPool`: the pool's first retry delay. */
export const POOL_STEP_MS = 30_000;

/**
 * Runs the metadata pool's work to its end under fake timers, moving the
 * clock by a fixed step per round. `vi.runAllTimers` would move it to the
 * latest pending timer, which under load can be hours ahead and break tests
 * that count hours from "now".
 */
export const drainPool = (t: Backend) => t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(POOL_STEP_MS));

/**
 * Lets the searches subscribe starts run to their end. Without
 * an indexer each ends `failed`, so its Units show "wanted" again.
 */
export const settleSearches = (t: Backend) => t.finishAllScheduledFunctions(() => (vi.isFakeTimers() ? vi.advanceTimersByTime(POOL_STEP_MS) : undefined));

/**
 * A Nyaa indexer at `https://<host>`, as createSite saves it.
 * Its pacing interval is lowered to 1 ms (OMNARR_TEST_LIMITS), so no test
 * waits on the 5 s. A slot waits at most that millisecond: settleSearches
 * and withPacing move fake timers through it.
 */
export function seedNyaa(t: Backend, overrides: Partial<Doc<'indexers'>> & { host?: string } = {}): Promise<Id<'indexers'>> {
  process.env.OMNARR_TEST_LIMITS = JSON.stringify({ nyaaIntervalMs: 1 });
  const { host = 'nyaa.fake', ...fields } = overrides;
  return seedIndexer(t, {
    host,
    name: 'Nyaa',
    kind: 'nyaa',
    apiUrl: `https://${host}`,
    apiKey: '',
    categories: NYAA_CATEGORIES,
    caps: { ...NYAA_CAPS, fetchedAt: Date.now() },
    ...fields,
  });
}

/**
 * Awaits an action that may wait for a pacing slot under fake
 * timers, moving the clock a millisecond at a time until it ends.
 */
export async function withPacing<T>(running: Promise<T>): Promise<T> {
  let done = false;
  const settled = running.finally(() => {
    done = true;
  });
  while (!done && vi.isFakeTimers()) await vi.advanceTimersByTimeAsync(1);
  return settled;
}

/** The Newznab fake's key, a planted value no DTO or error may carry. */
export const INDEXER_KEY = 'planted-indexer-key-7f3a';

/** A Newznab indexer at `https://<host>/api`, as a passing connection test against the fake saves it. */
export function seedIndexer(t: Backend, overrides: Partial<Doc<'indexers'>> & { host?: string } = {}): Promise<Id<'indexers'>> {
  const { host = 'indexer.fake', ...fields } = overrides;
  return t.run((ctx) =>
    ctx.db.insert('indexers', {
      name: host,
      kind: 'newznab',
      apiUrl: `https://${host}/api`,
      apiKey: INDEXER_KEY,
      enabled: true,
      priority: 25,
      categories: { series: [5000, 5030, 5040, 5070, 105040], movies: [2000, 2040, 2045] },
      caps: {
        searchModes: [
          { mode: 'search', available: true, supportedParams: ['q'] },
          { mode: 'tv-search', available: true, supportedParams: ['q', 'tvdbid', 'imdbid', 'season', 'ep'] },
          { mode: 'movie-search', available: true, supportedParams: ['q', 'imdbid', 'tmdbid'] },
        ],
        pageLimit: { max: 100, default: 100 },
        categories: [
          { id: 5000, name: 'TV' },
          { id: 5070, name: 'Anime', parentId: 5000 },
          { id: 2000, name: 'Movies' },
        ],
        fetchedAt: Date.now(),
      },
      rssIntervalMinutes: 15,
      usage: [],
      consecutiveRateLimits: 0,
      health: { status: 'unknown' },
      ...fields,
    }),
  );
}

export type Libraries = { series: Id<'libraries'>; movies: Id<'libraries'>; releaseProfileId: Id<'releaseProfiles'> };

/** The shipped `web-1080p` profile as the reference seed writes it. */
export const shippedProfile = (key: ShippedKey = 'web-1080p') => ({
  ...SHIPPED_PROFILES[key].content,
  shippedKey: key,
  shippedVersion: SHIPPED_PROFILES[key].version,
  editedByUser: false,
});

/**
 * The Series and Movies libraries first run creates, with the
 * shipped `web-1080p` profile as their default and first run's devices:
 * `setupDefaults` gives each library its own playback profile with the
 * default target.
 */
export function seedLibraries(t: Backend): Promise<Libraries> {
  return t.run(async (ctx) => {
    // A placeholder the libraries need until setupDefaults gives each its own row.
    const playbackProfileId = await ctx.db.insert('playbackProfiles', { name: 'Series' });
    const releaseProfileId = await ctx.db.insert('releaseProfiles', shippedProfile());
    const library = (kind: 'series' | 'movies', name: string) =>
      ctx.db.insert('libraries', { kind, name, rootPath: `/data/library/${kind}`, playbackProfileId, defaultReleaseProfileId: releaseProfileId });
    const libraries = { series: await library('series', 'Series'), movies: await library('movies', 'Movies'), releaseProfileId };
    await setupDefaults(ctx, DEFAULT_DEVICES);
    return libraries;
  });
}

/** The Anime-Lists fixture (or another file's text) as a fetch leaves it: its entries, and the source's version. */
export async function seedAnimeLists(t: Backend, version = 'fixture-v1', xml = animeListXml): Promise<void> {
  const entries = await parseAnimeList(xml);
  await t.run(async (ctx) => {
    for (const entry of entries) await ctx.db.insert('animeListEntries', { ...entry, seenVersion: version });
    await ctx.db.insert('mappingSourceState', { source: 'animeLists', version, lastAttemptAt: Date.now() });
  });
}

/** XEM's `havemap` list as a fetch leaves it. */
export function seedXemList(t: Backend, tvdbIds: number[]): Promise<unknown> {
  return t.run((ctx) =>
    ctx.db.insert('mappingSourceState', { source: 'xem', version: new Date().toISOString(), lastAttemptAt: Date.now(), xemTvdbIds: tvdbIds }),
  );
}

export const TMDB_API_KEY = 'test-tmdb-key';

/** XEM as the fake serves it: the `havemap` list and each show's `/map/all` and `/map/names`. */
export type XemFake = { havemap?: number[]; shows?: Record<number, { all: unknown; names?: unknown }>; down?: boolean };
/** Anime-Lists as the fake serves it; `etag` answers a matching `If-None-Match` with 304. */
export type AnimeListsFake = { xml?: string; etag?: string; down?: boolean };
/** An indexer's API behind a host: the Newznab fake's `handle`, or a test's own answer. */
export type IndexerFake = (request: Request, init?: { signal?: AbortSignal }) => Promise<Response>;
/** GitHub's releases API as the update check reads it: the latest release, an error status, or no answer; `seen` collects each request's headers. */
export type GithubFake = { latest?: { tag_name: string; html_url: string }; status?: number; down?: boolean; seen?: Headers[] };
/** Sonarr's scene-mapping list as the fake serves it (the fixture unless `list` is given); `seen` collects each request's headers. */
export type SceneMappingsFake = { list?: unknown; down?: boolean; seen?: Headers[] };
export type MetadataFakes = Partial<TmdbFakeOptions> & {
  xem?: XemFake;
  animeLists?: AnimeListsFake;
  sceneMappings?: SceneMappingsFake;
  indexers?: Record<string, IndexerFake>;
  github?: GithubFake;
};

/** Every request the fakes answered, in order. */
export type FakeRequests = URL[];

const timeout = () => Promise.reject(new DOMException('The operation timed out.', 'TimeoutError'));

/**
 * Routes the backend's outside calls into fakes by host: TMDB into
 * e2e/fakes/tmdb, XEM and Anime-Lists into the hand-written fixtures, and
 * each indexer host into its fake.
 * Switches make a source time out, answer 304 or serve a changed file. A host
 * no fake serves is unreachable, as a refused connection is.
 */
export function useFetchFakes(options: MetadataFakes = {}): FakeRequests {
  process.env.TMDB_API_URL = 'https://tmdb.fake';
  // The image CDN, on its own host as image.tmdb.org is, served by the same fake.
  process.env.TMDB_IMAGE_URL = 'https://image.tmdb.fake';
  process.env.TMDB_API_TOKEN = TMDB_API_KEY;
  const { xem = {}, animeLists = {}, sceneMappings = {}, indexers = {}, github = {}, ...tmdb } = options;
  const handleTmdb = createTmdbHandler({ apiKey: TMDB_API_KEY, ...tmdb });
  const requests: FakeRequests = [];
  vi.stubGlobal('fetch', async (input: RequestInfo | URL, init?: RequestInit) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    requests.push(url);
    const indexer = indexers[url.hostname];
    if (indexer) return indexer(request, { signal: init?.signal ?? undefined });
    if (url.hostname === 'tmdb.fake' || url.hostname === 'image.tmdb.fake') return handleTmdb(request);
    if (url.hostname === 'thexem.info') {
      if (xem.down) return timeout();
      if (url.pathname === '/map/havemap') return Response.json({ result: 'success', data: (xem.havemap ?? []).map(String), message: '' });
      const show = xem.shows?.[Number(url.searchParams.get('id'))];
      const failure = { result: 'failure', data: [], message: 'no show found' };
      if (url.pathname === '/map/all') return Response.json(show?.all ?? failure);
      if (url.pathname === '/map/names') return Response.json(show?.names ?? failure);
    }
    if (url.hostname === 'raw.githubusercontent.com') {
      if (animeLists.down) return timeout();
      const etag = animeLists.etag ?? '"v1"';
      if (request.headers.get('if-none-match') === etag) return new Response(null, { status: 304 });
      return new Response(animeLists.xml ?? animeListXml, { headers: { etag } });
    }
    if (url.hostname === 'services.sonarr.tv' && url.pathname === '/v1/scenemapping') {
      sceneMappings.seen?.push(request.headers);
      if (sceneMappings.down) return timeout();
      return Response.json(sceneMappings.list ?? sceneMappingList);
    }
    if (url.hostname === 'api.github.com' && url.pathname === '/repos/dev-marzahn/omnarr/releases/latest') {
      github.seen?.push(request.headers);
      if (github.down) return timeout();
      if (github.status) return Response.json({ message: 'API rate limit exceeded' }, { status: github.status });
      return github.latest ? Response.json(github.latest) : Response.json({ message: 'Not Found' }, { status: 404 });
    }
    if (url.hostname.endsWith('.fake')) throw new TypeError('fetch failed: connection refused');
    return new Response('not found', { status: 404 });
  });
  return requests;
}

/** The metadata tests' name for the same routing. */
export const useMetadataFakes = useFetchFakes;

/** What every worker call carries. */
export const worker = { workerToken: WORKER_TOKEN, protocolVersion: PROTOCOL_VERSION };

/**
 * A definitions sync dated far ahead, so no worker connect in the test
 * enqueues one: for tests that drive other jobs and count them.
 */
export const skipDefinitionSync = (t: Backend) =>
  t.run(async (ctx) => {
    if (await ctx.db.query('definitionSync').first()) return;
    await ctx.db.insert('definitionSync', {
      at: Date.now() + 10 * 365 * 86_400_000,
      ok: true,
      source: 'indexers.test',
      supported: 0,
      unsupported: 0,
      pending: 0,
    });
  });

/** Every /data area on one device and writable, as the compose file sets it up. */
const area = { freeBytes: 1e12, device: '2049', writable: true };

export const capabilities: Capabilities = {
  ffmpegVersion: '7.1',
  encoders: ['libx264', 'aac'],
  storage: { downloads: area, staging: area, originals: area, series: area, movies: area },
};

/** What a heartbeat carries: each area's free bytes and device, without the write check. */
export const storageSpace = (storage: Capabilities['storage'] = capabilities.storage): StorageSpace =>
  Object.fromEntries(Object.entries(storage).map(([name, { freeBytes, device }]) => [name, { freeBytes, device }])) as StorageSpace;
