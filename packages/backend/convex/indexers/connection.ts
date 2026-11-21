// The connection test: caps, then one search with `limit=1` to
// tell Newznab from Torznab. At most two requests, both returned as calls for
// `usage`. Failures name the host and endpoint path only. A site indexer's
// test is one RSS request through its adapter.
import type { ApiLimits, IndexerCall, IndexerCaps, IndexerFailure, IndexerTestResult } from '@omnarr/contracts';

import type { IndexerAdapter } from './adapter';
import { capsApiLimits, defaultCategories, parseCaps } from './caps';
import { parseFeed } from './feed';
import { indexerFetch, TEST_TIMEOUT_MS, whereOf, type FetchTarget } from './http';
import { detectKind, requestParams } from './newznab';

export type ConnectionTest = { result: IndexerTestResult; calls: IndexerCall[]; caps?: IndexerCaps };

const failureOf = (failure: IndexerFailure): NonNullable<IndexerTestResult['failure']> => ({
  kind: failure.kind,
  ...(failure.httpStatus === undefined ? {} : { httpStatus: failure.httpStatus }),
  ...(failure.errorCode === undefined ? {} : { errorCode: failure.errorCode }),
  ...(failure.challenge === undefined ? {} : { challenge: failure.challenge }),
  host: failure.host,
  path: failure.path,
});

/**
 * A site indexer's connection test: one RSS request through
 * its adapter, which takes the pacing slot. A page that isn't the site's feed
 * fails as `unexpectedPage`; a refused slot sends nothing and records no call.
 */
export async function testSiteConnection(adapter: IndexerAdapter, caps: IndexerCaps, kind: 'nyaa'): Promise<ConnectionTest> {
  const started = Date.now();
  const response = await adapter.rss({ offset: 0 });
  const latencyMs = Date.now() - started;
  const base = { kind, searchModes: caps.searchModes, categories: caps.categories, latencyMs };
  if (!response.ok && response.skipped) return { result: { ok: false, ...base, skipped: 'paced' }, calls: [] };
  const call: IndexerCall = { at: Date.now(), ok: response.ok, latencyMs, kind: 'test', ...(response.ok ? {} : { failure: response.failure }) };
  if (!response.ok) return { result: { ok: false, ...base, failure: failureOf(response.failure) }, calls: [call] };
  return { result: { ok: true, ...base }, calls: [call], caps };
}

export async function testConnection(target: FetchTarget): Promise<ConnectionTest> {
  const calls: IndexerCall[] = [];
  const started = Date.now();
  const call = (latencyMs: number, failure?: IndexerFailure, apiLimits?: ApiLimits) =>
    calls.push({ at: Date.now(), ok: !failure, latencyMs, kind: 'test', ...(failure ? { failure } : {}), ...(apiLimits ? { apiLimits } : {}) });
  const fail = (failure: IndexerFailure, caps?: IndexerCaps): ConnectionTest => ({
    result: {
      ok: false,
      searchModes: caps?.searchModes ?? [],
      categories: caps?.categories ?? [],
      latencyMs: Date.now() - started,
      failure: failureOf(failure),
    },
    calls,
    ...(caps ? { caps } : {}),
  });

  const capsResponse = await indexerFetch(target, { t: 'caps' }, TEST_TIMEOUT_MS);
  if (!capsResponse.ok) {
    call(capsResponse.latencyMs, capsResponse.failure);
    return fail(capsResponse.failure);
  }
  const caps = parseCaps(capsResponse.body, whereOf(target.apiUrl), Date.now());
  const capsLimits = capsApiLimits(capsResponse.body);
  call(capsResponse.latencyMs, caps.ok ? undefined : caps.failure, capsLimits);
  if (!caps.ok) return fail(caps.failure);

  const defaults = defaultCategories(caps.value);
  const searchResponse = await indexerFetch(
    target,
    requestParams({ fn: 'search', categories: [...defaults.series, ...defaults.movies], limit: 1, offset: 0 }),
    TEST_TIMEOUT_MS,
  );
  if (!searchResponse.ok) {
    call(searchResponse.latencyMs, searchResponse.failure);
    return fail(searchResponse.failure, caps.value);
  }
  const page = parseFeed(searchResponse.body, { ...whereOf(target.apiUrl), protocol: 'usenet' });
  call(searchResponse.latencyMs, page.ok ? undefined : page.failure, page.ok ? page.value.apiLimits : page.failure.apiLimits);
  if (!page.ok) return fail(page.failure, caps.value);

  const limits = page.value.apiLimits ?? capsLimits;
  const kind = detectKind(searchResponse.body);
  return {
    result: {
      ok: true,
      ...(kind ? { kind } : {}),
      searchModes: caps.value.searchModes,
      categories: caps.value.categories,
      ...(limits ? { apiLimit: { max: limits.apiMax, source: 'apilimits' as const } } : {}),
      latencyMs: Date.now() - started,
    },
    calls,
    caps: caps.value,
  };
}
