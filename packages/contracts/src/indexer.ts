// Indexer contracts: what the Newznab and Torznab adapters
// take and return, what a call records, and the indexer DTOs.
import { zid } from 'convex-helpers/server/zod4';
import { z } from 'zod';

import { IndexerHealth } from './dto/system.ts';
import { IndexerFailureKind, SiteChallenge } from './failures.ts';
import { CandidateTorrent } from './release.ts';
import { SiteSettings } from './sites.ts';

/** Newznab and Torznab APIs, and the site indexers: Nyaa, and the definitions the worker's engine runs. */
export const IndexerKind = z.enum(['newznab', 'torznab', 'nyaa', 'definition']);
export type IndexerKind = z.infer<typeof IndexerKind>;

export const DownloadProtocol = z.enum(['usenet', 'torrent']);
export type DownloadProtocol = z.infer<typeof DownloadProtocol>;

/** What an indexer of this kind finds: Newznab usenet, every other kind torrents. */
export const protocolOf = (kind: IndexerKind): DownloadProtocol => (kind === 'newznab' ? 'usenet' : 'torrent');

/** The ID parameters a request and an item can carry. IMDb values have no `tt` prefix here. */
export const IndexerIds = z.object({ tvdbid: z.string().optional(), tmdbid: z.string().optional(), imdbid: z.string().optional() }).strict();
export type IndexerIds = z.infer<typeof IndexerIds>;

/**
 * An indexer's API use, read from either spelling of the `apilimits` element.
 * Times are epoch milliseconds.
 */
export const ApiLimits = z.object({
  apiCurrent: z.number(),
  apiMax: z.number(),
  apiOldestTime: z.number().optional(),
  apiNextAvailable: z.number().optional(),
});
export type ApiLimits = z.infer<typeof ApiLimits>;

/** A release as an indexer lists it, before parsing. `downloadUrl` can carry the API key: internal only. */
export const IndexerItem = z.object({
  guid: z.string(),
  title: z.string(),
  downloadUrl: z.string(),
  sizeBytes: z.number(),
  protocol: DownloadProtocol,
  publishedAt: z.number(),
  categories: z.array(z.number()),
  ids: IndexerIds,
  torrent: CandidateTorrent.optional(),
});
export type IndexerItem = z.infer<typeof IndexerItem>;

/** One results page. `offset` is the page's first item; `total` is the indexer's count, when it gives one. */
export const IndexerPage = z.object({
  items: z.array(IndexerItem),
  total: z.number().optional(),
  offset: z.number(),
  apiLimits: ApiLimits.optional(),
});
export type IndexerPage = z.infer<typeof IndexerPage>;

/**
 * A failed call: the host and endpoint path, never the URL with its key, and
 * never the indexer's own description text. `retryAfter` is the raw header;
 * the backend computes the time from it.
 */
export const IndexerFailure = z
  .object({
    kind: IndexerFailureKind,
    code: z.enum(['indexerTimeout', 'indexerError', 'indexerRateLimited']),
    httpStatus: z.number().optional(),
    errorCode: z.number().optional(),
    challenge: SiteChallenge.optional(),
    /** A site search answered with a redirect: the host it points to, so the message says where the site moved. */
    redirectHost: z.string().optional(),
    retryAfter: z.string().optional(),
    apiLimits: ApiLimits.optional(),
    host: z.string(),
    path: z.string(),
  })
  .strict();
export type IndexerFailure = z.infer<typeof IndexerFailure>;

/** A response read: the value, or the failure. What the feed, caps and site readers return. */
export type IndexerOutcome<T> = { ok: true; value: T } | { ok: false; failure: IndexerFailure; skipped?: never };

/**
 * What an adapter call returns. `skipped: 'paced'`: a site indexer's pacing
 * slot was refused, so no request was sent; the Newznab and Torznab
 * adapters never return it.
 */
export type IndexerResult<T> = IndexerOutcome<T> | { ok: false; skipped: 'paced'; failure?: never };

export const SearchMode = z.enum(['search', 'tv-search', 'movie-search']);
export type SearchMode = z.infer<typeof SearchMode>;

export const IndexerCategory = z.object({ id: z.number(), name: z.string(), parentId: z.number().optional() });
export type IndexerCategory = z.infer<typeof IndexerCategory>;

/**
 * The parsed caps. `pageLimit` is the page size, not a daily limit.
 * `defaulted` marks a mode whose caps gave no `supportedParams`, so the
 * revision 1.1 defaults stand in: the ID rule depends on it.
 */
export const IndexerCaps = z.object({
  searchModes: z.array(z.object({ mode: SearchMode, available: z.boolean(), supportedParams: z.array(z.string()), defaulted: z.boolean().optional() })),
  pageLimit: z.object({ max: z.number().optional(), default: z.number().optional() }),
  categories: z.array(IndexerCategory),
  fetchedAt: z.number(),
});
export type IndexerCaps = z.infer<typeof IndexerCaps>;

/** One request of the request plan. */
export const IndexerRequest = z.object({
  fn: z.enum(['search', 'tvsearch', 'movie']),
  q: z.string().optional(),
  season: z.string().optional(),
  ep: z.string().optional(),
  ids: IndexerIds.optional(),
  categories: z.array(z.number()),
  limit: z.number(),
  offset: z.number(),
});
export type IndexerRequest = z.infer<typeof IndexerRequest>;

/** The kinds of search group `groupUnits` makes. */
export const SearchGroupKind = z.enum(['episode', 'season', 'animeEpisode', 'animeSeason', 'movie']);
export type SearchGroupKind = z.infer<typeof SearchGroupKind>;

/**
 * Why an indexer sits out a search. `noCategories`: none for the Work's kind; `animeOnly`: anime
 * categories only, for a series without anime numbering; `paced`: its pacing slot was more than
 * 5 minutes away.
 */
export const IndexerSkip = z.enum(['disabled', 'rateLimited', 'share', 'protocol', 'noCategories', 'animeOnly', 'paced']);
export type IndexerSkip = z.infer<typeof IndexerSkip>;

/**
 * A skip as stored in `indexerResults[].skipped`: `IndexerSkip`, or `category` on rows written before
 * it was split, which stood for either `noCategories` or `animeOnly`. Never written now.
 */
export const StoredIndexerSkip = z.union([IndexerSkip, z.literal('category')]);
export type StoredIndexerSkip = z.infer<typeof StoredIndexerSkip>;

/** Which rule set `rateLimitedUntil`. */
export const RateLimitReason = z.enum(['retryAfter', 'apilimits', 'ownCount', 'fallback']);
export type RateLimitReason = z.infer<typeof RateLimitReason>;

/** One hour of traffic; an indexer keeps the last 24. */
export const IndexerUsageHour = z.object({ hourStart: z.number(), requests: z.number(), errors: z.number() });
export type IndexerUsageHour = z.infer<typeof IndexerUsageHour>;

/** A daily request limit, from an `apilimits` element or entered by the user. */
export const ApiLimit = z.object({ max: z.number(), source: z.enum(['apilimits', 'user']) });
export type ApiLimit = z.infer<typeof ApiLimit>;

/** One request, as `store.recordCalls` records it into usage and health. */
export const IndexerCall = z.object({
  at: z.number(),
  ok: z.boolean(),
  latencyMs: z.number(),
  kind: z.enum(['search', 'rss', 'test']),
  failure: IndexerFailure.optional(),
  apiLimits: ApiLimits.optional(),
  count: z.number().optional(),
  newItems: z.number().optional(),
  matched: z.number().optional(),
});
export type IndexerCall = z.infer<typeof IndexerCall>;

/** A new URL and key, or a stored indexer with its URL or key optionally replaced. */
export const IndexerTestInput = z.union([
  z.object({ url: z.string(), apiKey: z.string() }).strict(),
  z.object({ indexerId: zid('indexers'), url: z.string().optional(), apiKey: z.string().optional() }).strict(),
]);
export type IndexerTestInput = z.infer<typeof IndexerTestInput>;

/** The connection test's answer. `kind` is absent when the response didn't decide it. */
export const IndexerTestResult = z
  .object({
    ok: z.boolean(),
    kind: IndexerKind.optional(),
    searchModes: IndexerCaps.shape.searchModes,
    categories: z.array(IndexerCategory),
    apiLimit: ApiLimit.optional(),
    latencyMs: z.number(),
    failure: z
      .object({
        kind: IndexerFailureKind,
        httpStatus: z.number().optional(),
        errorCode: z.number().optional(),
        challenge: SiteChallenge.optional(),
        redirectHost: z.string().optional(),
        host: z.string(),
        path: z.string(),
      })
      .strict()
      .optional(),
    /** A site indexer's pacing slot was refused, so no request was sent: "Busy". */
    skipped: z.literal('paced').optional(),
  })
  .strict();
export type IndexerTestResult = z.infer<typeof IndexerTestResult>;

/** The connection test of a site indexer not yet saved. */
/**
 * A site, by kind: Nyaa alone, or a definition with its id, link and
 * settings (one flat object, as function arguments must be; the handler
 * refuses a definition without its id, and Nyaa with definition fields).
 */
const SiteInput = z
  .object({
    kind: z.enum(['nyaa', 'definition']),
    definitionId: z.string().min(1).optional(),
    /** One of the definition's links; absent, the first. */
    baseUrl: z.string().optional(),
    settings: SiteSettings.optional(),
  })
  .strict();

/** A definition's test runs in the worker with these values; Nyaa's in Convex. */
export const IndexerTestSiteInput = SiteInput;
export type IndexerTestSiteInput = z.infer<typeof IndexerTestSiteInput>;

export const IndexerCategories = z.object({ series: z.array(z.number()), movies: z.array(z.number()) });
export type IndexerCategories = z.infer<typeof IndexerCategories>;

export const IndexerCreateInput = z.object({
  name: z.string().trim().min(1),
  url: z.string(),
  apiKey: z.string().min(1),
  kind: IndexerKind.optional(),
  categories: IndexerCategories.optional(),
  priority: z.number().int().min(1).max(50).optional(),
  rssIntervalMinutes: z.number().int().min(10).optional(),
  apiLimitMax: z.number().int().min(1).optional(),
});
export type IndexerCreateInput = z.infer<typeof IndexerCreateInput>;

/** A site indexer, added by its kind alone: no URL and no key. */
export const IndexerCreateSiteInput = SiteInput.extend({ name: z.string().trim().min(1).optional() }).strict();
export type IndexerCreateSiteInput = z.infer<typeof IndexerCreateSiteInput>;

/** Every field optional; an absent `apiKey` keeps the stored one. */
export const IndexerPatch = IndexerCreateInput.partial().extend({
  /** A definition indexer's link and settings; an empty text or password value keeps the stored one. */
  baseUrl: z.string().optional(),
  settings: SiteSettings.optional(),
});
export type IndexerPatch = z.infer<typeof IndexerPatch>;

/** A row of the Indexers page and the System page's indexer card. */
export const IndexerRow = z
  .object({
    id: zid('indexers'),
    name: z.string(),
    kind: IndexerKind,
    host: z.string(),
    enabled: z.boolean(),
    priority: z.number(),
    // Lazy: dto/system.ts reaches this module through protocol.ts and jobs.ts (the indexer job class).
    health: z.lazy(() => IndexerHealth),
    rateLimitedUntil: z.number().optional(),
    rateLimitReason: RateLimitReason.optional(),
    apiUse24h: z.number(),
    errors24h: z.number(),
    effectiveRssIntervalMinutes: z.number(),
    /** A site indexer's minimum interval between two requests. Absent: not paced. */
    pacingIntervalMs: z.number().optional(),
    /** A definition indexer's definition name, which the row shows as its kind. */
    definitionName: z.string().optional(),
  })
  .strict();
export type IndexerRow = z.infer<typeof IndexerRow>;

/** The indexer form. The key is never returned, only whether one is stored. */
export const IndexerDetail = IndexerRow.extend({
  apiUrl: z.string(),
  caps: IndexerCaps.pick({ searchModes: true, categories: true, pageLimit: true }),
  categories: IndexerCategories,
  apiLimit: ApiLimit.optional(),
  apiKeySet: z.boolean(),
  /** The interval the user set; the row's effective interval may be longer (the RSS share). */
  rssIntervalMinutes: z.number(),
  /**
   * A definition indexer's site: `select` and `checkbox` values as
   * stored; `text` and `password` values never, only which are set.
   */
  site: z
    .object({ definitionId: z.string(), baseUrl: z.string(), settings: SiteSettings, secretsSet: z.array(z.string()) })
    .strict()
    .optional(),
}).strict();
export type IndexerDetail = z.infer<typeof IndexerDetail>;
