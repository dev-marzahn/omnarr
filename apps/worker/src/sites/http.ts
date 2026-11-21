// The engine's HTTP: every site request takes a pacing slot
// first (`worker.reservePacing`), sends the omnarr User-Agent, keeps the
// indexer's cookies in memory, decodes the body in the site's encoding, and
// follows redirects only where the definition says `followredirect`. Failures
// are the indexer failure kinds, plus `challenged`; they name the host and the URL's
// path, never its query or the page's text.
import { indexerFailureCode, type IndexerFailure, type IndexerFailureKind, type SiteChallenge } from '@omnarr/contracts';

import { decodeBytes, encodeText } from './encoding.ts';

export type SiteFetch = (url: string, init: RequestInit) => Promise<Response>;

/** A request as the engine builds it. `form` is a POST's body, encoded in the site's encoding. */
export type SiteRequest = {
  url: string;
  method: 'GET' | 'POST';
  form?: [string, string][];
  headers?: Record<string, string>;
  followRedirect?: boolean;
  /** A grab's .torrent: the body is returned as bytes. */
  binary?: boolean;
};

export type SiteResponse =
  | { ok: true; status: number; url: string; body: string; bytes: Uint8Array; contentType: string }
  | { ok: false; failure: IndexerFailure };

export type Pace = () => Promise<'go' | 'skip'>;

/** The pacing slot was refused: no request was sent. */
export class PacedSkip extends Error {
  public constructor() {
    super('paced');
  }
}

export const SITE_TIMEOUT_MS = 30_000;
export const TEST_TIMEOUT_MS = 10_000;

export const siteUserAgent = () => `omnarr/${process.env.OMNARR_VERSION || '0.0.0-dev'}`;

const CHALLENGE_TITLES: Record<string, SiteChallenge> = { 'just a moment...': 'cloudflare', 'attention required!': 'cloudflare', 'ddos-guard': 'ddosGuard' };

/** A site's browser check, as Prowlarr's CloudFlareDetectionService detects it. */
export function challengeOf(status: number, server: string | null, body: string): SiteChallenge | undefined {
  if (status !== 403 && status !== 503) return undefined;
  const name = server?.trim().toLowerCase();
  if (name === 'cloudflare') return 'cloudflare';
  if (name === 'ddos-guard') return 'ddosGuard';
  const title = /<title[^>]*>([^<]*)<\/title>/i.exec(body)?.[1]?.trim().toLowerCase();
  return (title === undefined ? undefined : CHALLENGE_TITLES[title]) ?? (body.includes('error code: 1020') ? 'cloudflare' : undefined);
}

export const where = (url: string): { host: string; path: string } => {
  try {
    const parsed = new URL(url);
    return { host: parsed.host, path: parsed.pathname };
  } catch {
    return { host: 'invalid', path: '' };
  }
};

export const siteFailure = (kind: IndexerFailureKind, url: string, extra: Partial<IndexerFailure> = {}): IndexerFailure => ({
  kind,
  code: indexerFailureCode(kind),
  ...extra,
  ...where(url),
});

function statusKind(status: number): IndexerFailureKind {
  if (status === 429) return 'rateLimited';
  if (status === 401 || status === 403) return 'authRejected';
  return 'httpError';
}

/** One indexer's cookies, by host, kept in memory for the worker's life. */
export class CookieJar {
  private readonly byHost = new Map<string, Map<string, string>>();

  public header(url: string): string | undefined {
    const cookies = this.byHost.get(new URL(url).host);
    return cookies?.size ? [...cookies].map(([name, value]) => `${name}=${value}`).join('; ') : undefined;
  }

  public store(url: string, response: Response): void {
    const setCookies = response.headers.getSetCookie?.() ?? [];
    if (!setCookies.length) return;
    const host = new URL(url).host;
    const cookies = this.byHost.get(host) ?? new Map<string, string>();
    for (const line of setCookies) {
      const [pair] = line.split(';');
      const eq = pair!.indexOf('=');
      if (eq <= 0) continue;
      const name = pair!.slice(0, eq).trim();
      const value = pair!.slice(eq + 1).trim();
      if (/max-age=0|expires=thu, 01 jan 1970/i.test(line)) cookies.delete(name);
      else cookies.set(name, value);
    }
    this.byHost.set(host, cookies);
  }
}

export type SiteHttpOptions = { fetch: SiteFetch; pace: Pace; jar: CookieJar; encoding: string | undefined; timeoutMs: number; signal?: AbortSignal };

const formBody = (form: [string, string][], encoding: string | undefined) =>
  form.map(([name, value]) => `${percent(name, encoding)}=${percent(value, encoding)}`).join('&');

const percent = (text: string, encoding: string | undefined) =>
  [...encodeText(text, encoding)]
    .map((byte) =>
      /[A-Za-z0-9\-_.!*()]/.test(String.fromCharCode(byte))
        ? String.fromCharCode(byte)
        : byte === 0x20
          ? '+'
          : `%${byte.toString(16).toUpperCase().padStart(2, '0')}`,
    )
    .join('');

/** Sends one paced request. Throws PacedSkip when the slot was refused. */
export async function siteRequest(request: SiteRequest, options: SiteHttpOptions): Promise<SiteResponse> {
  if ((await options.pace()) === 'skip') throw new PacedSkip();
  const headers: Record<string, string> = { 'user-agent': siteUserAgent(), ...lowerKeys(request.headers ?? {}) };
  const cookie = options.jar.header(request.url);
  if (cookie) headers.cookie = cookie;
  let body: string | undefined;
  if (request.method === 'POST') {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = formBody(request.form ?? [], options.encoding);
  }
  const signals = [AbortSignal.timeout(options.timeoutMs), ...(options.signal ? [options.signal] : [])];
  let response: Response;
  try {
    response = await options.fetch(request.url, {
      method: request.method,
      headers,
      ...(body !== undefined ? { body } : {}),
      redirect: request.followRedirect ? 'follow' : 'manual',
      signal: AbortSignal.any(signals),
    });
  } catch (error) {
    const name = error instanceof Error || error instanceof DOMException ? error.name : '';
    return { ok: false, failure: siteFailure(name === 'TimeoutError' || name === 'AbortError' ? 'timeout' : 'unreachable', request.url) };
  }
  options.jar.store(request.url, response);
  let bytes: Uint8Array;
  try {
    bytes = new Uint8Array(await response.arrayBuffer());
  } catch {
    return { ok: false, failure: siteFailure('timeout', request.url) };
  }
  const text = request.binary && response.ok ? '' : decodeBytes(bytes, options.encoding);
  if (response.status >= 300 && response.status < 400) {
    // Only the host the site sent us to: it tells the user the site moved, and carries no path or query.
    let redirectHost: string | undefined;
    try {
      redirectHost = new URL(response.headers.get('location') ?? '', request.url).host;
    } catch {
      redirectHost = undefined;
    }
    return { ok: false, failure: siteFailure('httpError', request.url, { httpStatus: response.status, ...(redirectHost ? { redirectHost } : {}) }) };
  }
  if (!response.ok) {
    const challenge = challengeOf(response.status, response.headers.get('server'), text);
    if (challenge) return { ok: false, failure: siteFailure('challenged', request.url, { httpStatus: response.status, challenge }) };
    const kind = statusKind(response.status);
    const retryAfter = response.headers.get('retry-after') ?? undefined;
    return {
      ok: false,
      failure: siteFailure(kind, request.url, { httpStatus: response.status, ...(kind === 'rateLimited' && retryAfter ? { retryAfter } : {}) }),
    };
  }
  return { ok: true, status: response.status, url: response.url || request.url, body: text, bytes, contentType: response.headers.get('content-type') ?? '' };
}

const lowerKeys = (headers: Record<string, string>) => Object.fromEntries(Object.entries(headers).map(([name, value]) => [name.toLowerCase(), value]));
