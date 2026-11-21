// The fake definitions server and fake public site for the `test` compose
// profile. One process serves both, so the stack needs one more
// service only:
//
//   GET  /12/package.zip            the package (definitions.ts), the worker's OMNARR_DEFINITIONS_URL
//   GET  /star/latest, /star/search the Star Site's listing: rows without magnets
//   GET  /star/t/<n>                a details page with the download link
//   GET  /star/dl/<n>.torrent       the torrent: the Star Lantern episode the web seed serves
//
// and the control routes the scenario calls from inside the container:
//
//   GET  /_fake/requests            the request log, control routes left out
//   POST /_fake/update?variant=…    `broken` serves Star Site's failing update, `good` the first
//
//   SITES_FAKE_PORT=4160 SITES_ORIGIN=http://sites:4160 node e2e/fakes/sites/server.ts
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';

import { nyaaCatalogue, type TorrentEntry } from '../torrent/catalogue.ts';
import { packageFiles } from './definitions.ts';
import { zipStored } from './zip.ts';

export type SitesRequest = { at: number; method: string; path: string; query: string; userAgent: string };

const ADDED = '2024-10-01 12:00:00';

/** The Star Site's torrents: episode 1 of Star Lantern, as the seed peer and web seed serve it. */
export const starTorrents = (): TorrentEntry[] => nyaaCatalogue().filter((entry) => entry.guid === 'sl-n-01');

const escape = (text: string) => text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** Every word of the query with letters must be in the title; numbers and episode marks are left to omnarr's parser. */
const matches = (title: string, q: string) =>
  q
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter((word) => /^\p{L}{2,}$/u.test(word))
    .every((word) => title.toLowerCase().includes(word));

function listing(torrents: TorrentEntry[]): string {
  const rows = torrents
    .map(
      (entry, i) =>
        `<tr><td class="name"><a href="/star/t/${i + 1}">${escape(entry.title)}</a></td><td class="size">1.4 GiB</td><td class="seeders">${entry.seeders}</td><td class="leechers">1</td><td class="added">${ADDED}</td></tr>`,
    )
    .join('\n');
  return `<!doctype html><html><head><title>Star Site</title></head><body><table id="torrents"><thead><tr><th>Name</th></tr></thead><tbody>\n${rows}\n</tbody></table></body></html>`;
}

export function createSitesFake(options: { origin: string }): { server: Server; requests: SitesRequest[] } {
  const requests: SitesRequest[] = [];
  const torrents = starTorrents();
  let broken = false;
  const send = (res: import('node:http').ServerResponse, status: number, type: string, body: string | Uint8Array) => {
    res.writeHead(status, { 'content-type': type });
    res.end(body);
  };
  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', options.origin);
    if (url.pathname === '/_fake/requests') return send(res, 200, 'application/json', JSON.stringify(requests));
    if (url.pathname === '/_fake/update' && req.method === 'POST') {
      const variant = url.searchParams.get('variant');
      if (variant !== 'broken' && variant !== 'good') return send(res, 400, 'text/plain', 'variant must be broken or good');
      broken = variant === 'broken';
      return void res.writeHead(204).end();
    }
    requests.push({
      at: Date.now(),
      method: req.method ?? 'GET',
      path: url.pathname,
      query: url.searchParams.toString(),
      userAgent: req.headers['user-agent'] ?? '',
    });
    if (url.pathname === '/12/package.zip') return send(res, 200, 'application/zip', zipStored(packageFiles(options.origin, broken)));
    if (url.pathname === '/star/latest') return send(res, 200, 'text/html; charset=utf-8', listing(torrents));
    if (url.pathname === '/star/search') {
      const q = url.searchParams.get('q') ?? '';
      return send(res, 200, 'text/html; charset=utf-8', listing(torrents.filter((entry) => matches(entry.title, q))));
    }
    const details = /^\/star\/t\/(\d+)$/.exec(url.pathname);
    if (details && torrents[Number(details[1]) - 1]) {
      const entry = torrents[Number(details[1]) - 1]!;
      return send(
        res,
        200,
        'text/html; charset=utf-8',
        `<!doctype html><html><body><h1>${escape(entry.title)}</h1><a class="download" href="/star/dl/${details[1]}.torrent">Download</a></body></html>`,
      );
    }
    const file = /^\/star\/dl\/(\d+)\.torrent$/.exec(url.pathname);
    if (file && torrents[Number(file[1]) - 1]) return send(res, 200, 'application/x-bittorrent', torrents[Number(file[1]) - 1]!.torrent.bytes);
    return send(res, 404, 'text/plain', 'not found');
  });
  return { server, requests };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.SITES_FAKE_PORT ?? 4160);
  const origin = process.env.SITES_ORIGIN ?? `http://127.0.0.1:${port}`;
  createSitesFake({ origin }).server.listen(port, () => console.log(`Definitions server and Star Site on :${port}`));
}
