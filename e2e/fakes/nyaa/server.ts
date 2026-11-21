// The fake Nyaa for the `test` compose profile: handler.ts over
// HTTP, with a few control routes the scenario calls from inside the
// container (`docker compose exec nyaa node -e …`):
//
//   GET  /_fake/requests            the request log, control routes left out
//   POST /_fake/publish             lists the held entries, published now
//   POST /_fake/failure?kind=…      ddosGuard, brokenPage, or none
//
// With NYAA_CATALOGUE=e2e it lists the nyaa scenario's torrents
// (../torrent/catalogue.ts), magnets naming the web seed's tracker, and 80
// look-alike uploads (`Starfall Lanterns`) that match the title query but not
// the Work, so a season search fills the feed and pages into the listing.
//
//   NYAA_FAKE_PORT=4140 NYAA_ORIGIN=http://nyaa:4140 node e2e/fakes/nyaa/server.ts
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';

import { nyaaCatalogue, TRACKER_URL } from '../torrent/catalogue.ts';
import { createNyaaHandler, type NyaaFailure, type NyaaHandler, type NyaaItem } from './handler.ts';

/** The guids `/_fake/publish` lists; the rest are listed from the start. */
const HELD = new Set(['sl-n-03']);
const TWO_YEARS_AGO = '2024-10-01T12:00:00Z';

/** The e2e catalogue: what is listed at the start, and what `/_fake/publish` adds. */
export function e2eNyaaItems(): { listed: NyaaItem[]; held: NyaaItem[] } {
  const entries = nyaaCatalogue().map((entry, i): NyaaItem & { guid: string } => ({
    guid: entry.guid,
    id: 2001 + i,
    title: entry.title,
    infoHash: entry.torrent.infoHash,
    size: '1.4 GiB',
    publishedAt: TWO_YEARS_AGO,
    seeders: entry.seeders,
    leechers: 1,
    magnetParams: `tr=${encodeURIComponent(TRACKER_URL)}`,
  }));
  const lookAlikes = Array.from({ length: 80 }, (_, i): NyaaItem => ({
    id: 1000 + i,
    title: `[Fill] Starfall Lanterns - ${String((i % 24) + 1).padStart(2, '0')} (1080p) [F${String(i).padStart(7, '0')}].mkv`,
    infoHash: (0xf000 + i).toString(16).padStart(40, '0'),
    size: '1.3 GiB',
    publishedAt: TWO_YEARS_AGO,
    seeders: 5,
    leechers: 0,
  }));
  const strip = ({ guid: _guid, ...item }: NyaaItem & { guid: string }): NyaaItem => item;
  return {
    listed: [...lookAlikes, ...entries.filter((entry) => !HELD.has(entry.guid)).map(strip)],
    held: entries.filter((entry) => HELD.has(entry.guid)).map(strip),
  };
}

const FAILURES = ['ddosGuard', 'brokenPage'] as const;

export function createNyaaFake(options: { origin: string; listed: NyaaItem[]; held?: NyaaItem[] }): { server: Server } & Omit<NyaaHandler, 'handle'> {
  const fake = createNyaaHandler({ items: options.listed, origin: options.origin });
  let listed = options.listed;
  let held = options.held ?? [];
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', options.origin);
    if (url.pathname === '/_fake/requests') {
      res.writeHead(200, { 'content-type': 'application/json' });
      return void res.end(JSON.stringify(fake.requests.map((r) => ({ at: r.at, path: r.path, query: r.params.toString(), userAgent: r.userAgent }))));
    }
    if (url.pathname === '/_fake/publish' && req.method === 'POST') {
      listed = [...listed, ...held.map((item) => ({ ...item, publishedAt: new Date().toISOString() }))];
      held = [];
      fake.setItems(listed);
      return void res.writeHead(204).end();
    }
    if (url.pathname === '/_fake/failure' && req.method === 'POST') {
      const kind = url.searchParams.get('kind');
      const failure = FAILURES.find((name) => name === kind);
      if (!failure && kind !== 'none') return void res.writeHead(400).end(`kind must be ${FAILURES.join(', ')} or none`);
      fake.setFailure(failure ? ({ kind: failure } as NyaaFailure) : undefined);
      return void res.writeHead(204).end();
    }
    const headers = new Headers();
    for (const [name, value] of Object.entries(req.headers)) if (typeof value === 'string') headers.set(name, value);
    const response = await fake.handle(new Request(url, { method: req.method, headers }));
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(await response.text());
  });
  return { server, requests: fake.requests, setFailure: fake.setFailure, setItems: fake.setItems };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.NYAA_FAKE_PORT ?? 4140);
  const origin = process.env.NYAA_ORIGIN ?? `http://127.0.0.1:${port}`;
  const catalogue = process.env.NYAA_CATALOGUE;
  if (catalogue && catalogue !== 'e2e') throw new Error(`NYAA_CATALOGUE must be e2e or unset, not ${catalogue}`);
  const { listed, held } = catalogue === 'e2e' ? e2eNyaaItems() : { listed: [], held: [] };
  createNyaaFake({ origin, listed, held }).server.listen(port, () => console.log(`Nyaa fake on :${port}, ${listed.length} listed, ${held.length} held`));
}
