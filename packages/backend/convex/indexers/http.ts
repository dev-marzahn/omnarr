// Every indexer request goes through here: the URL with its
// key, a timeout, and transport failures and HTTP statuses classified into
// an IndexerFailure. Nothing returned or logged contains the request URL.
// Site indexers use `siteFetch` (no key); a DDoS-Guard or Cloudflare check
// is `challenged` for both.
import { indexerFailureCode, type IndexerFailure, type IndexerFailureKind, type SiteChallenge } from '@omnarr/contracts';

/** 10 s for the connection test, 30 s for search and RSS. */
export const TEST_TIMEOUT_MS = 10_000;
export const SEARCH_TIMEOUT_MS = 30_000;

export type FetchTarget = { apiUrl: string; apiKey: string };

export type HttpResult = { ok: true; body: string; latencyMs: number } | { ok: false; failure: IndexerFailure; latencyMs: number };

/** Host and endpoint path: what an error may name. */
export function whereOf(apiUrl: string): { host: string; path: string } {
  try {
    const url = new URL(apiUrl);
    return { host: url.host, path: url.pathname };
  } catch {
    return { host: 'invalid', path: '' };
  }
}

const failure = (kind: IndexerFailureKind, at: { host: string; path: string }, extra: Partial<IndexerFailure> = {}): IndexerFailure => ({
  kind,
  code: indexerFailureCode(kind),
  ...extra,
  host: at.host,
  path: at.path,
});

function statusKind(status: number): IndexerFailureKind {
  if (status === 429) return 'rateLimited';
  if (status === 401 || status === 403) return 'authRejected';
  return 'httpError';
}

/** The titles of the browser-check pages, as Prowlarr's CloudFlareDetectionService has them. */
const CHALLENGE_TITLES: Record<string, SiteChallenge> = { 'just a moment...': 'cloudflare', 'attention required!': 'cloudflare', 'ddos-guard': 'ddosGuard' };

/**
 * A DDoS-Guard or Cloudflare browser check: a 403 or 503 whose
 * `server` header names either, or whose body's `<title>` is a known check
 * title, or that says `error code: 1020` (Cloudflare's). The body is read
 * only for this.
 */
async function challengeOf(response: Response): Promise<SiteChallenge | undefined> {
  if (response.status !== 403 && response.status !== 503) return undefined;
  const server = response.headers.get('server')?.trim().toLowerCase();
  if (server === 'cloudflare') return 'cloudflare';
  if (server === 'ddos-guard') return 'ddosGuard';
  let body: string;
  try {
    body = await response.text();
  } catch {
    return undefined;
  }
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(body)?.[1]?.trim().toLowerCase();
  return (title === undefined ? undefined : CHALLENGE_TITLES[title]) ?? (body.includes('error code: 1020') ? 'cloudflare' : undefined);
}

/** One GET of `url`, its failures named by `at`. */
async function send(url: URL, at: { host: string; path: string }, timeoutMs: number, headers?: Record<string, string>): Promise<HttpResult> {
  const started = Date.now();
  const latency = () => Date.now() - started;
  let response: Response;
  try {
    response = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), ...(headers ? { headers } : {}) });
  } catch (error) {
    const name = error instanceof Error || error instanceof DOMException ? error.name : '';
    const kind = name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unreachable';
    return { ok: false, failure: failure(kind, at), latencyMs: latency() };
  }
  if (!response.ok) {
    const challenge = await challengeOf(response);
    if (challenge) return { ok: false, failure: failure('challenged', at, { httpStatus: response.status, challenge }), latencyMs: latency() };
    const retryAfter = response.headers.get('retry-after') ?? undefined;
    const kind = statusKind(response.status);
    return {
      ok: false,
      failure: failure(kind, at, { httpStatus: response.status, ...(kind === 'rateLimited' && retryAfter ? { retryAfter } : {}) }),
      latencyMs: latency(),
    };
  }
  try {
    return { ok: true, body: await response.text(), latencyMs: latency() };
  } catch {
    return { ok: false, failure: failure('timeout', at), latencyMs: latency() };
  }
}

/** One request: `params` plus the key, answered within `timeoutMs`. */
export async function indexerFetch(target: FetchTarget, params: Record<string, string>, timeoutMs: number): Promise<HttpResult> {
  const url = new URL(target.apiUrl);
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  url.searchParams.set('apikey', target.apiKey);
  return send(url, whereOf(target.apiUrl), timeoutMs);
}

/**
 * One request to a site indexer: the same timeouts and failure
 * classes, with no key. A failure names the host and the URL's path, never
 * its query.
 */
export function siteFetch(url: URL, options: { timeoutMs: number; headers?: Record<string, string> }): Promise<HttpResult> {
  return send(url, { host: url.host, path: url.pathname }, options.timeoutMs, options.headers);
}
