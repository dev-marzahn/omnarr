// fetchRelease: the worker's GET of the candidate's own
// download URL, its rules (schemes, redirects, refused hosts, no credentials,
// size caps) and every row of its classification table. `fetch` is injected,
// so the URLs below never leave the process.
import { DEFAULT_LIMITS, type FailureCode } from '@omnarr/contracts';
import { describe, expect, test } from 'vite-plus/test';

import { fetchRelease, REFUSED_HOSTS, type ReleaseFetch } from '../src/release/fetch.ts';
import { JobFailure } from '../src/runtime/lease.ts';

const KEY = 'planted-api-key-55aa';
const URL_ = `http://indexer.test/getnzb/abc.nzb?apikey=${KEY}`;

const NZB =
  '<?xml version="1.0"?><nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"><file subject="a"><segments><segment number="1">a@b</segment></segments></file></nzb>';

type Call = { url: string; init: RequestInit };

/** A fetch that answers each URL from the table, recording every call. */
function serve(routes: Record<string, () => Response | Promise<Response>>, calls: Call[] = []): ReleaseFetch {
  return async (url, init) => {
    calls.push({ url, init });
    const route = routes[url];
    if (!route) throw new Error(`unexpected fetch of ${url}`);
    return route();
  };
}

const newznabError = (code: number, description = 'x') =>
  new Response(`<?xml version="1.0" encoding="UTF-8"?><error code="${code}" description="${description}"/>`, {
    headers: { 'content-type': 'application/xml' },
  });

/** The JobFailure the fetch threw, as its code and detail. */
async function failure(promise: Promise<unknown>): Promise<{ failureCode: FailureCode; detail: string }> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof JobFailure) return { failureCode: error.code, detail: error.detail };
    throw error;
  }
  throw new Error('expected a JobFailure');
}

const fetchWith = (fetch: ReleaseFetch, url = URL_, extra: Partial<Parameters<typeof fetchRelease>[1]> = {}) =>
  fetchRelease(url, { protocol: 'usenet', indexerName: 'Main', fetch, signal: new AbortController().signal, ...extra });

describe('a valid NZB', () => {
  test('is returned as bytes', async () => {
    const release = await fetchWith(serve({ [URL_]: () => new Response(NZB) }));
    expect(release.kind).toBe('nzb');
    expect(release.kind === 'nzb' && new TextDecoder().decode(release.bytes)).toBe(NZB);
  });

  test('is fetched with no credentials, no cookie and no automatic redirect', async () => {
    const calls: Call[] = [];
    await fetchWith(serve({ [URL_]: () => new Response(NZB) }, calls));
    const headers = new Headers(calls[0]!.init.headers);
    expect(headers.has('authorization')).toBe(false);
    expect(headers.has('cookie')).toBe(false);
    expect(calls[0]!.init.redirect).toBe('manual');
    expect(calls[0]!.init.credentials).toBe('omit');
  });
});

describe('the classification table', () => {
  test.each<[number, FailureCode]>([
    [408, 'releaseFetchFailed'],
    [429, 'releaseFetchFailed'],
    [500, 'releaseFetchFailed'],
    [503, 'releaseFetchFailed'],
    [401, 'releaseFetchFailed'],
    [403, 'releaseFetchFailed'],
    [404, 'releaseFileInvalid'],
    [410, 'releaseFileInvalid'],
  ])('HTTP %i is %s', async (status, code) => {
    const error = await failure(fetchWith(serve({ [URL_]: () => new Response('nope', { status }) })));
    expect(error.failureCode).toBe(code);
    expect(error.detail).toContain(`HTTP ${status}`);
  });

  test.each<[number, FailureCode]>([
    [100, 'releaseFetchFailed'],
    [101, 'releaseFetchFailed'],
    [102, 'releaseFetchFailed'],
    [500, 'releaseFetchFailed'],
    [501, 'releaseFetchFailed'],
    [900, 'releaseFetchFailed'],
    [910, 'releaseFetchFailed'],
    [200, 'releaseFileInvalid'],
    [201, 'releaseFileInvalid'],
    [202, 'releaseFileInvalid'],
    [203, 'releaseFileInvalid'],
    [300, 'releaseFileInvalid'],
  ])('Newznab error %i is %s', async (errorCode, code) => {
    const error = await failure(fetchWith(serve({ [URL_]: () => newznabError(errorCode) })));
    expect(error.failureCode).toBe(code);
  });

  test("error 501 says the indexer's download limit is reached, with Retry-After, and never the indexer's text or the URL", async () => {
    const response = () => {
      const r = newznabError(501, `Download limit reached for key ${KEY}`);
      r.headers.set('retry-after', '3600');
      return r;
    };
    const error = await failure(fetchWith(serve({ [URL_]: response })));
    expect(error.failureCode).toBe('releaseFetchFailed');
    expect(error.detail).toBe('Main: the download limit is reached (GET /getnzb/abc.nzb). Retry after 3600 s.');
  });

  test('error 100 says the indexer refused the API key', async () => {
    const error = await failure(fetchWith(serve({ [URL_]: () => newznabError(100) })));
    expect(error.detail).toBe('Main: the indexer refused the API key (GET /getnzb/abc.nzb).');
  });

  test('a timeout is releaseFetchFailed', async () => {
    const hang: ReleaseFetch = (_url, init) =>
      new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(init.signal!.reason as Error)));
    const error = await failure(fetchWith(hang, URL_, { timeoutMs: 10 }));
    expect(error).toMatchObject({ failureCode: 'releaseFetchFailed', detail: 'Main did not answer in time (GET /getnzb/abc.nzb).' });
  });

  test('the timeout is 30 s by default', () => {
    expect(DEFAULT_LIMITS.releaseFetchTimeoutMs).toBe(30_000);
  });

  test('a connection error is releaseFetchFailed', async () => {
    const refused: ReleaseFetch = async () => {
      throw new TypeError('fetch failed', { cause: Object.assign(new Error(`connect ECONNREFUSED ${KEY}`), { code: 'ECONNREFUSED' }) });
    };
    const error = await failure(fetchWith(refused));
    expect(error).toMatchObject({ failureCode: 'releaseFetchFailed', detail: 'Main did not answer (GET /getnzb/abc.nzb).' });
  });

  test("the job's own abort passes through unchanged, as a cancellation", async () => {
    const controller = new AbortController();
    const hang: ReleaseFetch = (_url, init) =>
      new Promise((_resolve, reject) => init.signal!.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError'))));
    const pending = fetchWith(hang, URL_, { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.not.toBeInstanceOf(JobFailure);
  });

  test('a body that is not an NZB is releaseFileInvalid', async () => {
    const error = await failure(fetchWith(serve({ [URL_]: () => new Response('<html>log in</html>') })));
    expect(error).toMatchObject({ failureCode: 'releaseFileInvalid', detail: 'Main sent a file that is not an NZB (GET /getnzb/abc.nzb).' });
  });

  test('a body over the cap is releaseFileInvalid, whatever Content-Length says', async () => {
    const big = () => new Response(NZB.repeat(4));
    const error = await failure(fetchWith(serve({ [URL_]: big }), URL_, { maxBytes: NZB.length * 2 }));
    expect(error.failureCode).toBe('releaseFileInvalid');
    expect(error.detail).toContain('larger than');
  });

  test('a Content-Length over the NZB cap (64 MiB) is refused before the body is read', async () => {
    let read = false;
    const body = new ReadableStream(
      {
        pull: (controller) => {
          read = true;
          controller.close();
        },
      },
      { highWaterMark: 0 },
    );
    const response = () => new Response(body, { headers: { 'content-length': String(DEFAULT_LIMITS.nzbMaxBytes + 1) } });
    const error = await failure(fetchWith(serve({ [URL_]: response })));
    expect(error.failureCode).toBe('releaseFileInvalid');
    expect(read).toBe(false);
  });

  test('no detail ever carries the URL, its query or the API key', async () => {
    for (const status of [401, 404, 500]) {
      const error = await failure(fetchWith(serve({ [URL_]: () => new Response(KEY, { status }) })));
      expect(error.detail).not.toContain(KEY);
      expect(error.detail).not.toContain('indexer.test');
    }
  });
});

describe('redirects', () => {
  const hop = (n: number) => `http://indexer.test/hop/${n}`;
  const redirectTo =
    (location: string, status = 302) =>
    () =>
      new Response(null, { status, headers: { location } });

  test('up to 5 are followed', async () => {
    const routes: Record<string, () => Response> = { [URL_]: redirectTo(hop(1)) };
    for (let n = 1; n < 5; n++) routes[hop(n)] = redirectTo(hop(n + 1));
    routes[hop(5)] = () => new Response(NZB);
    const release = await fetchWith(serve(routes));
    expect(release.kind).toBe('nzb');
  });

  test('a 6th is refused as releaseFileInvalid', async () => {
    const routes: Record<string, () => Response> = { [URL_]: redirectTo(hop(1)) };
    for (let n = 1; n <= 5; n++) routes[hop(n)] = redirectTo(hop(n + 1));
    const error = await failure(fetchWith(serve(routes)));
    expect(error).toMatchObject({ failureCode: 'releaseFileInvalid', detail: 'Main redirected more than 5 times (GET /getnzb/abc.nzb).' });
  });

  test('a relative Location is resolved against the hop', async () => {
    const release = await fetchWith(serve({ [URL_]: redirectTo('/real/abc.nzb', 301), 'http://indexer.test/real/abc.nzb': () => new Response(NZB) }));
    expect(release.kind).toBe('nzb');
  });

  test.each(['ftp://indexer.test/abc.nzb', 'file:///etc/passwd', 'magnet:?xt=urn:btih:0123456789abcdef0123456789abcdef01234567'])(
    'a hop to %s is refused for an NZB',
    async (location) => {
      const calls: Call[] = [];
      const error = await failure(fetchWith(serve({ [URL_]: redirectTo(location) }, calls)));
      expect(error.failureCode).toBe('releaseFileInvalid');
      expect(calls).toHaveLength(1);
    },
  );

  test('a hop to a refused host is not fetched', async () => {
    const calls: Call[] = [];
    const error = await failure(fetchWith(serve({ [URL_]: redirectTo('http://backend:3210/api') }, calls)));
    expect(error.failureCode).toBe('releaseFileInvalid');
    expect(calls).toHaveLength(1);
  });
});

describe('refused hosts', () => {
  test('the platform services are one constant', () => {
    expect([...REFUSED_HOSTS].sort()).toEqual(['backend', 'gluetun', 'jellyfin', 'nzbget', 'qbittorrent', 'setup', 'web', 'worker']);
  });

  test.each([
    'http://nzbget:6789/jsonrpc',
    'http://NZBGET/x',
    'http://jellyfin.:8096/x',
    'http://127.0.0.1/x',
    'http://127.8.9.10:4120/getnzb/a.nzb',
    'http://[::1]/x',
    'http://169.254.169.254/latest/meta-data',
    'http://[fe80::1]/x',
    'http://0.0.0.0/x',
    'http://[::]/x',
    'ftp://indexer.test/a.nzb',
    'not a url',
  ])('%s is refused without a request', async (url) => {
    const calls: Call[] = [];
    const error = await failure(fetchWith(serve({}, calls), url));
    expect(error.failureCode).toBe('releaseFileInvalid');
    expect(calls).toEqual([]);
  });

  test.each(['http://newznab:4120/getnzb/a.nzb', 'https://10.0.0.5/getnzb/a.nzb', 'http://192.168.1.10/a.nzb'])('%s is allowed', async (url) => {
    const release = await fetchWith(serve({ [url]: () => new Response(NZB) }), url);
    expect(release.kind).toBe('nzb');
  });
});

describe('a .torrent file', () => {
  const TORRENT_URL = `http://tracker.test/dl/42.torrent?passkey=${KEY}`;
  const INFO = 'd6:lengthi5e4:name5:a.mkv12:piece lengthi16384e6:pieces20:ABCDEFGHIJKLMNOPQRSTe';
  const TORRENT = `d8:announce17:http://t.test/ann4:info${INFO}e`;
  // The SHA-1 of INFO, worked out independently with `printf '%s' "$INFO" | shasum`.
  const HASH = 'ff8eec90e746a1d8a797c6deaab27b40c8dd87e5';
  const torrentWith = (fetch: ReleaseFetch, url = TORRENT_URL, extra: Partial<Parameters<typeof fetchRelease>[1]> = {}) =>
    fetchRelease(url, { protocol: 'torrent', indexerName: 'Tracker', fetch, signal: new AbortController().signal, ...extra });

  test('a valid torrent is returned with its bytes and info hash', async () => {
    const release = await torrentWith(serve({ [TORRENT_URL]: () => new Response(TORRENT) }));
    expect(release).toMatchObject({ kind: 'torrentFile', infoHash: HASH });
    expect(release.kind === 'torrentFile' && new TextDecoder().decode(release.bytes)).toBe(TORRENT);
  });

  test('a body that is not a torrent is releaseFileInvalid', async () => {
    const error = await failure(torrentWith(serve({ [TORRENT_URL]: () => new Response('<html>please log in</html>') })));
    expect(error).toMatchObject({ failureCode: 'releaseFileInvalid', detail: 'Tracker sent a file that is not a torrent (GET /dl/42.torrent).' });
  });

  test('the torrent cap is 16 MiB', async () => {
    const big = () => new Response('x', { headers: { 'content-length': String(DEFAULT_LIMITS.torrentMaxBytes + 1) } });
    expect((await failure(torrentWith(serve({ [TORRENT_URL]: big })))).failureCode).toBe('releaseFileInvalid');
  });

  test('a redirect to a magnet is the last hop: its hash, without fetching it', async () => {
    const calls: Call[] = [];
    const magnet = 'magnet:?xt=urn:btih:ABCDEFGHIJKLMNOPQRSTUVWXYZ234567&dn=x';
    const release = await torrentWith(serve({ [TORRENT_URL]: () => new Response(null, { status: 302, headers: { location: magnet } }) }, calls));
    expect(release).toEqual({ kind: 'magnet', uri: magnet, infoHash: '00443214c74254b635cf84653a56d7c675be77df' });
    expect(calls).toHaveLength(1);
  });

  test('a redirect to a magnet without a hash is releaseFileInvalid', async () => {
    const error = await failure(torrentWith(serve({ [TORRENT_URL]: () => new Response(null, { status: 302, headers: { location: 'magnet:?dn=x' } }) })));
    expect(error).toMatchObject({ failureCode: 'releaseFileInvalid', detail: 'Tracker linked a magnet without a hash (GET /dl/42.torrent).' });
  });

  test('HTTP 404 is releaseFileInvalid and 503 releaseFetchFailed, as for an NZB', async () => {
    expect((await failure(torrentWith(serve({ [TORRENT_URL]: () => new Response('', { status: 404 }) })))).failureCode).toBe('releaseFileInvalid');
    expect((await failure(torrentWith(serve({ [TORRENT_URL]: () => new Response('', { status: 503 }) })))).failureCode).toBe('releaseFetchFailed');
  });

  test('no detail carries the passkey', async () => {
    const error = await failure(torrentWith(serve({ [TORRENT_URL]: () => new Response('nope') })));
    expect(error.detail).not.toContain(KEY);
  });
});
