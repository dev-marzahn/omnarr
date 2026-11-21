// The engine's entry points: search, rss, test and download for one
// definition indexer, as an IndexerResult. Definitions are loaded once per
// file hash; each indexer keeps a cookie jar for the worker's life. Every
// request takes a pacing slot; a refused slot answers `skipped: 'paced'`.
import type { IndexerFailure, IndexerItem, IndexerPage, IndexerRequest, IndexerResult, IndexerTestResult, SiteSettings } from '@omnarr/contracts';

import { buildCaps } from './caps.ts';
import { type Definition, loadDefinition, siteLinkOf } from './definition.ts';
import { type Downloaded, runDownload } from './download.ts';
import { CookieJar, PacedSkip, type Pace, SITE_TIMEOUT_MS, type SiteFetch, siteFailure, siteRequest, TEST_TIMEOUT_MS } from './http.ts';
import { andMatch, parseResponse, type Release, toItem } from './parse.ts';
import { baseVariables, searchRequests } from './request.ts';

/** A definition indexer as the engine runs it (`sites.config`). */
export type EngineIndexer = { indexerId: string; baseUrl: string; settings: SiteSettings };

export type EngineDeps = {
  fetch: SiteFetch;
  /** Takes the indexer's pacing slot (`worker.reservePacing`). */
  pace: (indexerId: string) => Promise<'go' | 'skip'>;
  now?: () => number;
  signal?: AbortSignal;
  /** Called once per indexer whose stored base URL is a legacy link: it runs as `links[0]`, and the rewrite is logged once. */
  onLegacyLink?: (indexerId: string, from: string, to: string) => void;
};

const definitions = new Map<string, Definition>();

/** The definition for a file, loaded once per hash. Throws when it doesn't load (the support check passed it, so it should). */
export function definitionFor(sha256: string, yaml: string): Definition {
  const cached = definitions.get(sha256);
  if (cached) return cached;
  const loaded = loadDefinition(yaml);
  if (!loaded.ok) throw new Error(`the definition doesn't load: ${loaded.reason}`);
  if (definitions.size > 200) definitions.clear();
  definitions.set(sha256, loaded.definition);
  return loaded.definition;
}

const jars = new Map<string, CookieJar>();
const jarOf = (indexerId: string) => {
  let jar = jars.get(indexerId);
  if (!jar) jars.set(indexerId, (jar = new CookieJar()));
  return jar;
};
const legacyLogged = new Set<string>();

function context(indexer: EngineIndexer, definition: Definition, deps: EngineDeps, timeoutMs: number) {
  const siteLink = siteLinkOf(definition, indexer.baseUrl);
  if (siteLink !== indexer.baseUrl && !legacyLogged.has(indexer.indexerId)) {
    legacyLogged.add(indexer.indexerId);
    deps.onLegacyLink?.(indexer.indexerId, indexer.baseUrl, siteLink);
  }
  const pace: Pace = () => deps.pace(indexer.indexerId);
  return {
    siteLink,
    now: deps.now?.() ?? Date.now(),
    http: { fetch: deps.fetch, pace, jar: jarOf(indexer.indexerId), encoding: definition.encoding, timeoutMs, ...(deps.signal ? { signal: deps.signal } : {}) },
  };
}

type Run = { ok: true; items: IndexerItem[]; rows: number } | { ok: false; failure: IndexerFailure } | { ok: false; skipped: 'paced' };

/** Every search path's request, parsed and mapped. A keywordless run (RSS, test) that finds no rows is `unexpectedPage`. */
async function run(indexer: EngineIndexer, definition: Definition, deps: EngineDeps, request: IndexerRequest | undefined, timeoutMs: number): Promise<Run> {
  const { siteLink, now, http } = context(indexer, definition, deps, timeoutMs);
  const planned = searchRequests(definition, { siteLink, settings: indexer.settings, ...(request ? { request } : {}), now });
  let releases: Release[] = [];
  let lastUrl = siteLink;
  try {
    for (const { request: siteReq, path, variables } of planned) {
      lastUrl = siteReq.url;
      const response = await siteRequest(siteReq, http);
      if (!response.ok) return response;
      const parsed = parseResponse(response.body, { definition, path, requestUrl: response.url, variables, now });
      if (!parsed.ok) return { ok: false, failure: siteFailure('unexpectedPage', siteReq.url) };
      releases.push(...parsed.releases);
    }
  } catch (error) {
    if (error instanceof PacedSkip) return { ok: false, skipped: 'paced' };
    throw error;
  }
  const keywords = (planned[0]?.variables['.Keywords'] as string | null | undefined) ?? '';
  const rows = releases.length;
  if (!keywords.trim() && rows === 0) return { ok: false, failure: siteFailure('unexpectedPage', lastUrl) };
  if (definition.search.rows.filters?.some((filter) => filter.name === 'andmatch')) {
    const ids = request?.ids ?? {};
    releases = andMatch(releases, request?.q, !!(ids.imdbid || ids.tvdbid || ids.tmdbid));
  }
  const mapped = releases.flatMap((release) => toItem(release, { isPrivate: definition.type !== 'public', now }) ?? []);
  // Several torrents behind one details page (a movie's qualities) keep the page and add their own hash or link.
  const shared = new Map<string, number>();
  for (const item of mapped) shared.set(item.guid, (shared.get(item.guid) ?? 0) + 1);
  const seen = new Set<string>();
  const items: IndexerItem[] = [];
  for (const item of mapped) {
    const guid = (shared.get(item.guid) ?? 0) > 1 ? `${item.guid}#${item.torrent?.infoHash ?? item.downloadUrl}` : item.guid;
    if (seen.has(guid)) continue;
    seen.add(guid);
    items.push({ ...item, guid });
  }
  return { ok: true, items, rows };
}

const asResult = (outcome: Run, offset: number): IndexerResult<IndexerPage> => (outcome.ok ? { ok: true, value: { items: outcome.items, offset } } : outcome);

/** One search request, as the indexer adapter makes it.Paging isn't done by sites: the relay answers offsets past 0 itself. */
export async function search(indexer: EngineIndexer, definition: Definition, request: IndexerRequest, deps: EngineDeps): Promise<IndexerResult<IndexerPage>> {
  return asResult(await run(indexer, definition, deps, request, SITE_TIMEOUT_MS), request.offset);
}

/** RSS: the search with no keywords, as Prowlarr runs it. */
export async function rss(indexer: EngineIndexer, definition: Definition, deps: EngineDeps): Promise<IndexerResult<IndexerPage>> {
  return asResult(await run(indexer, definition, deps, undefined, SITE_TIMEOUT_MS), 0);
}

/** "Test connection":the RSS search, which must find rows that parse. */
export async function test(indexer: EngineIndexer, definition: Definition, deps: EngineDeps): Promise<IndexerTestResult> {
  const started = deps.now?.() ?? Date.now();
  const outcome = await run(indexer, definition, deps, undefined, TEST_TIMEOUT_MS);
  const caps = buildCaps(definition, started);
  const base = { kind: 'definition' as const, searchModes: caps.searchModes, categories: caps.categories, latencyMs: (deps.now?.() ?? Date.now()) - started };
  if (outcome.ok) return { ok: true, ...base };
  if ('skipped' in outcome) return { ok: false, ...base, skipped: 'paced' };
  const { failure } = outcome;
  return {
    ok: false,
    ...base,
    failure: {
      kind: failure.kind,
      ...(failure.httpStatus !== undefined ? { httpStatus: failure.httpStatus } : {}),
      ...(failure.challenge !== undefined ? { challenge: failure.challenge } : {}),
      ...(failure.redirectHost !== undefined ? { redirectHost: failure.redirectHost } : {}),
      host: failure.host,
      path: failure.path,
    },
  };
}

/** A grab's `siteUrl`: the torrent's bytes or a magnet. */
export async function download(
  indexer: EngineIndexer,
  definition: Definition,
  url: string,
  deps: EngineDeps,
): Promise<{ ok: true; value: Downloaded } | { ok: false; failure: IndexerFailure } | { ok: false; skipped: 'paced' }> {
  const { siteLink, now, http } = context(indexer, definition, deps, SITE_TIMEOUT_MS);
  try {
    return await runDownload(definition, url, { http, now, variables: baseVariables(definition, siteLink, indexer.settings, now) });
  } catch (error) {
    if (error instanceof PacedSkip) return { ok: false, skipped: 'paced' };
    throw error;
  }
}
