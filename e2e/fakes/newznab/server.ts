// A fake Newznab API for the `test` compose profile and the collect-titles
// test. It serves the catalogue in fixtures.ts through the
// fetch handler in handler.ts; with NEWZNAB_CATALOGUE=e2e, the releases the
// NNTP fake serves instead; with NEWZNAB_CATALOGUE=torrents, a Torznab
// indexer over the web-seed fake's torrents. NEWZNAB_FAILURE switches it to
// fail from the start (a failure kind of handler.ts, e.g. `limit500` or
// `http429:120`).
//
//   NEWZNAB_FAKE_PORT=4120 NEWZNAB_API_KEY=test-key node e2e/fakes/newznab/server.ts
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { fileURLToPath } from 'node:url';

import { torrentCatalogue, TRACKER_URL, type TorrentEntry, vpnCatalogue } from '../torrent/catalogue.ts';
import { loadCatalogue } from '../usenet/catalogue.ts';
import { e2eItems, type FakeItem } from './fixtures.ts';
import { createNewznabHandler, type NewznabFailure, type NewznabFakeOptions, type NewznabHandler } from './handler.ts';

export type { NewznabFakeOptions } from './handler.ts';

export function createNewznabFake(options: NewznabFakeOptions): { server: Server } & Omit<NewznabHandler, 'handle'> {
  const { handle, requests, setFailure } = createNewznabHandler(options);
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value);
    const host = req.headers.host ?? 'newznab.fake';
    const abort = new AbortController();
    res.on('close', () => abort.abort());
    try {
      const response = await handle(new Request(new URL(req.url ?? '/', `http://${host}`), { method: req.method, headers }), { signal: abort.signal });
      res.writeHead(response.status, Object.fromEntries(response.headers));
      // Bytes, not text: a .torrent file is binary.
      res.end(new Uint8Array(await response.arrayBuffer()));
    } catch {
      // The caller gave up on a timeout response: nothing is left to answer.
      res.destroy();
    }
  });
  return { server, requests, setFailure };
}

/**
 * The torrents scenario's catalogue as Torznab items: Harbour
 * Lights HD episodes a day apart, each with its .torrent file, or for a
 * magnet entry only its magnet, which names the web seed's tracker; the
 * tracker hands out the seed peer (qBittorrent drops a magnet's `x.pe`).
 */
export function torrentItems(catalogue: TorrentEntry[]): FakeItem[] {
  return catalogue.map((entry, index) => ({
    guid: entry.guid,
    title: entry.title,
    categories: [5000, 5040],
    sizeBytes: entry.content.length,
    publishedAt: new Date(Date.parse('2026-11-10T20:00:00Z') + index * 86_400_000).toISOString(),
    ids: { tvdbid: '7700001' },
    torrent: {
      infoHash: entry.torrent.infoHash,
      seeders: entry.seeders,
      ...(entry.magnet ? { magnetParams: `tr=${encodeURIComponent(TRACKER_URL)}` } : { file: entry.torrent.bytes }),
    },
  }));
}

const FAILURE_KINDS = ['limit500', 'http429', 'apilimitsAtMax', 'timeout', 'notAnApi', 'wrongKey', 'grabLimit501'] as const;

/** `NEWZNAB_FAILURE`: a failure kind, and for http429 an optional Retry-After as `http429:120`. */
function parseFailure(value: string | undefined): NewznabFailure | undefined {
  if (!value) return undefined;
  const [kind, retryAfter] = value.split(':');
  const known = FAILURE_KINDS.find((name) => name === kind);
  if (!known) throw new Error(`NEWZNAB_FAILURE must be one of ${FAILURE_KINDS.join(', ')}, not ${value}`);
  return known === 'http429' ? { kind: known, ...(retryAfter ? { retryAfter } : {}) } : { kind: known };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.NEWZNAB_FAKE_PORT ?? 4120);
  const apiKey = process.env.NEWZNAB_API_KEY ?? 'test-newznab-key';
  const catalogue = process.env.NEWZNAB_CATALOGUE;
  if (catalogue && !['e2e', 'torrents', 'vpn'].includes(catalogue)) throw new Error(`NEWZNAB_CATALOGUE must be e2e, torrents, vpn or unset, not ${catalogue}`);
  const failure = parseFailure(process.env.NEWZNAB_FAILURE);
  // The vpn scenario's web seed is behind the test WireGuard server, at WEBSEED_HOST (e2e/compose.wireguard.test.yml).
  const items =
    catalogue === 'e2e'
      ? e2eItems(loadCatalogue())
      : catalogue === 'torrents'
        ? torrentItems(torrentCatalogue())
        : catalogue === 'vpn'
          ? torrentItems(vpnCatalogue(process.env.WEBSEED_HOST ?? 'webseed:4130'))
          : undefined;
  const torznab = catalogue === 'torrents' || catalogue === 'vpn';
  createNewznabFake({ apiKey, failure, ...(torznab ? { kind: 'torznab' as const } : {}), ...(items ? { items } : {}) }).server.listen(port, () =>
    console.log(`Newznab fake on :${port}, ${catalogue ?? 'default'} catalogue${failure ? `, failing with ${failure.kind}` : ''}`),
  );
}
