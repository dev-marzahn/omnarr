// The worker's fetch of a release file: a GET of the
// candidate's own download URL, with no credentials, at most 5 redirects over
// http(s), never to a platform service or a loopback, link-local or 0.0.0.0
// IP literal, within a timeout and a size cap. The answer is classified:
// `releaseFetchFailed` may pass on retry (transient), `releaseFileInvalid` is
// the release's fault (bad release). Indexer text and the URL never reach a
// detail: it names the indexer and the endpoint path. Pure apart from the injected `fetch`. A torrent must be a
// bencoded dict with an `info` dict, and its last hop may be a magnet, which
// is not fetched.
import { DEFAULT_LIMITS, type DownloadProtocol } from '@omnarr/contracts';

import { errorFailureCode } from '../failures.ts';
import { JobFailure } from '../runtime/lease.ts';
import { validateNzb } from './nzb.ts';
import { parseMagnet, parseTorrent } from './torrent.ts';

export type ReleaseFetch = (url: string, init: RequestInit) => Promise<Response>;

/** What the fetch found: an NZB, a .torrent with its info hash, or the magnet a torrent link redirected to. */
export type FetchedFile =
  | { kind: 'nzb'; bytes: Uint8Array }
  | { kind: 'torrentFile'; bytes: Uint8Array; infoHash: string }
  | { kind: 'magnet'; uri: string; infoHash: string };

/** The hostnames that name a platform service on the internal network. */
export const REFUSED_HOSTS: ReadonlySet<string> = new Set(['backend', 'worker', 'web', 'setup', 'nzbget', 'qbittorrent', 'gluetun', 'jellyfin']);

const MAX_REDIRECTS = 5;

export type FetchReleaseOptions = {
  protocol: DownloadProtocol;
  /** Names the indexer in every detail, instead of its URL. */
  indexerName: string;
  fetch: ReleaseFetch;
  /** The job's signal: its abort is a cancellation and passes through unchanged. */
  signal: AbortSignal;
  timeoutMs?: number;
  maxBytes?: number;
};

/** Loopback (127/8, ::1), link-local (169.254/16, fe80::/10) and unspecified (0.0.0.0, ::) IP literals. */
function refusedAddress(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  const v4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    return a === 127 || (a === 169 && b === 254) || host === '0.0.0.0';
  }
  if (!host.includes(':')) return false;
  if (host === '::' || host === '::1') return true;
  const mapped = /^::ffff:(.+)$/.exec(host)?.[1];
  if (mapped && refusedAddress(mapped)) return true;
  return /^fe[89ab][0-9a-f]?:/.test(host);
}

/** The URL if every rule of a hop holds, else undefined. */
function allowed(url: string, base?: URL): URL | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url, base);
  } catch {
    return undefined;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return undefined;
  const host = parsed.hostname.replace(/\.$/, '').toLowerCase();
  if (REFUSED_HOSTS.has(host) || refusedAddress(parsed.hostname)) return undefined;
  return parsed;
}

/** Newznab `<error>` codes and the platform's words for them (Newznab API, error codes). */
const NEWZNAB_ERRORS: Record<number, { transient: boolean; reason: string }> = {
  100: { transient: true, reason: 'the indexer refused the API key' },
  101: { transient: true, reason: 'the account is suspended' },
  102: { transient: true, reason: "the account isn't allowed to download" },
  500: { transient: true, reason: 'the request limit is reached' },
  501: { transient: true, reason: 'the download limit is reached' },
  900: { transient: true, reason: 'the indexer reported an unknown error' },
  910: { transient: true, reason: 'the indexer has its API turned off' },
  200: { transient: false, reason: 'the indexer reported a missing parameter' },
  201: { transient: false, reason: 'the indexer reported an incorrect parameter' },
  202: { transient: false, reason: "the indexer doesn't know the function" },
  203: { transient: false, reason: "the indexer doesn't offer the function" },
  300: { transient: false, reason: 'the indexer has no such item' },
};

/** The `<error code="…">` of a Newznab error answer, if the body is one. */
function newznabErrorCode(text: string): number | undefined {
  const match = /^\s*(?:<\?xml[^>]*\?>\s*)?<error\b[^>]*\bcode\s*=\s*["'](\d+)["']/i.exec(text);
  return match ? Number(match[1]) : undefined;
}

/** Reads the body, refusing it as soon as it passes the cap. */
async function readCapped(response: Response, maxBytes: number): Promise<Uint8Array | undefined> {
  const declared = Number(response.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > maxBytes) {
    await response.body?.cancel().catch(() => undefined);
    return undefined;
  }
  if (!response.body) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  const reader = response.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > maxBytes) {
      await reader.cancel().catch(() => undefined);
      return undefined;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

const MiB = 1024 * 1024;

/** Fetches and validates a release file, or throws a JobFailure with `releaseFetchFailed` or `releaseFileInvalid`. */
export async function fetchRelease(downloadUrl: string, options: FetchReleaseOptions): Promise<FetchedFile> {
  const { indexerName, signal } = options;
  const first = allowed(downloadUrl);
  // The endpoint path of the candidate's own URL, never its query (where the API key is).
  const where = `(GET ${first?.pathname ?? '/'})`;
  const transient = (detail: string) => new JobFailure('releaseFetchFailed', detail);
  const invalid = (detail: string) => new JobFailure('releaseFileInvalid', detail);
  if (!first) throw invalid(`The download link of ${indexerName} points somewhere the worker doesn't fetch from ${where}.`);

  const maxBytes = options.maxBytes ?? (options.protocol === 'usenet' ? DEFAULT_LIMITS.nzbMaxBytes : DEFAULT_LIMITS.torrentMaxBytes);
  const timeout = AbortSignal.timeout(options.timeoutMs ?? DEFAULT_LIMITS.releaseFetchTimeoutMs);
  const combined = AbortSignal.any([signal, timeout]);

  let url = first;
  try {
    for (let hops = 0; ; hops++) {
      const response = await options.fetch(url.href, { method: 'GET', redirect: 'manual', credentials: 'omit', headers: { accept: '*/*' }, signal: combined });
      if (response.status >= 300 && response.status < 400 && response.headers.has('location')) {
        await response.body?.cancel().catch(() => undefined);
        if (hops + 1 > MAX_REDIRECTS) throw invalid(`${indexerName} redirected more than ${MAX_REDIRECTS} times ${where}.`);
        const location = response.headers.get('location')!;
        // A torrent link may end in a magnet: the last hop, never fetched.
        if (options.protocol === 'torrent' && /^magnet:/i.test(location)) {
          const magnet = parseMagnet(location);
          if (!magnet) throw invalid(`${indexerName} linked a magnet without a hash ${where}.`);
          return { kind: 'magnet', uri: location, infoHash: magnet.infoHash };
        }
        const next = allowed(location, url);
        if (!next) throw invalid(`${indexerName} redirected somewhere the worker doesn't fetch from ${where}.`);
        url = next;
        continue;
      }
      const retryAfter = response.headers.get('retry-after');
      const after = retryAfter && /^\d+$/.test(retryAfter.trim()) ? ` Retry after ${retryAfter.trim()} s.` : '';
      if (!response.ok) {
        await response.body?.cancel().catch(() => undefined);
        const text = `${indexerName} answered HTTP ${response.status} ${where}.${after}`;
        throw response.status === 404 || response.status === 410 ? invalid(text) : transient(text);
      }
      const bytes = await readCapped(response, maxBytes);
      if (!bytes) throw invalid(`${indexerName} sent a file larger than ${Math.round(maxBytes / MiB)} MiB ${where}.`);
      const code = newznabErrorCode(new TextDecoder().decode(bytes.subarray(0, 512)));
      if (code !== undefined) {
        const known = NEWZNAB_ERRORS[code];
        const text = `${indexerName}: ${known?.reason ?? `the indexer reported error ${code}`} ${where}.${after}`;
        throw known && !known.transient ? invalid(text) : transient(text);
      }
      if (options.protocol === 'torrent') {
        const torrent = parseTorrent(bytes);
        if (!torrent) throw invalid(`${indexerName} sent a file that is not a torrent ${where}.`);
        return { kind: 'torrentFile', bytes, infoHash: torrent.infoHash };
      }
      if (!validateNzb(bytes)) throw invalid(`${indexerName} sent a file that is not an NZB ${where}.`);
      return { kind: 'nzb', bytes };
    }
  } catch (error) {
    if (error instanceof JobFailure || signal.aborted) throw error;
    if (timeout.aborted) throw transient(`${indexerName} did not answer in time ${where}.`);
    if (errorFailureCode(error) !== undefined) throw transient(`${indexerName} did not answer ${where}.`);
    throw error;
  }
}
