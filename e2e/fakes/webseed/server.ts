// The web-seed fake: the torrents e2e's content, over HTTP as a
// BEP 19 web seed (`url-list` ending in `/files/`, so a client asks for
// `/files/<name>`), with byte ranges; and as a seeding peer for magnets
// (peer.ts), since a magnet's metadata can't come from a web seed. Each file
// can be told to stall (never answer) or to trickle. No package
// dependencies: the compose service runs it with plain `node`.
//
//   WEBSEED_PORT=4130 WEBSEED_PEER_PORT=6881 node e2e/fakes/webseed/server.ts
//
// With WEBSEED_DNS_ANSWER, it also answers DNS on UDP 53 (dns.ts).
import { createServer, type Server } from 'node:http';
import { fileURLToPath } from 'node:url';

import { nyaaCatalogue, torrentCatalogue } from '../torrent/catalogue.ts';
import { bencode } from '../torrent/torrent.ts';
import { createDnsResponder } from './dns.ts';
import { createSeedPeer } from './peer.ts';

export type WebSeedFile = {
  name: string;
  content: Uint8Array;
  /** `stall`: the request is accepted and never answered. `bytesPerSecond`: the body trickles. */
  mode?: 'stall' | { bytesPerSecond: number };
};

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** `bytes=a-b` or `bytes=a-`, within the file; undefined for no or an unsupported range. */
function rangeOf(header: string | undefined, size: number): { start: number; end: number } | undefined {
  const match = header ? /^bytes=(\d+)-(\d*)$/.exec(header.trim()) : null;
  if (!match) return undefined;
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return start <= end ? { start, end } : undefined;
}

/** The `info_hash` of an announce, as hex: 20 raw bytes, percent-encoded or not, which URLSearchParams would read as UTF-8. */
function infoHashOf(url: string): string | undefined {
  const raw = /[?&]info_hash=([^&]*)/.exec(url)?.[1];
  if (raw === undefined) return undefined;
  const bytes: number[] = [];
  for (let i = 0; i < raw.length; i++)
    if (raw[i] === '%') {
      bytes.push(Number.parseInt(raw.slice(i + 1, i + 3), 16));
      i += 2;
    } else bytes.push(raw.charCodeAt(i));
  return Buffer.from(bytes).toString('hex');
}

/** The seed peer the tracker hands out for the torrents it holds (peer.ts). */
export type TrackerPeer = { seededHashes: string[]; peerPort: number };

export function createWebSeed(files: WebSeedFile[], peer?: TrackerPeer): { server: Server; requests: (name: string) => number; announces: () => number } {
  const byName = new Map(files.map((file) => [file.name, file]));
  const counts = new Map<string, number>();
  const seeded = new Set(peer?.seededHashes ?? []);
  let announces = 0;
  const server = createServer(async (req, res) => {
    // An HTTP tracker (BEP 3, compact peers): qBittorrent 5.3 applies a seeding limit only when a
    // torrent's status is refreshed, which an announce does (5.3.0-2 recordings), so the torrents name
    // it; and it hands out the seed peer for a magnet, since qBittorrent drops a magnet's `x.pe`.
    // libtorrent announces at most every 5 minutes, whatever the interval.
    if (/^\/announce(\?|$)/.test(req.url ?? '')) {
      announces++;
      const hash = infoHashOf(req.url ?? '');
      const address = req.socket.localAddress?.replace(/^::ffff:/, '');
      const peers =
        peer && hash && seeded.has(hash) && address && /^\d+\.\d+\.\d+\.\d+$/.test(address)
          ? Buffer.from([...address.split('.').map(Number), peer.peerPort >> 8, peer.peerPort & 0xff])
          : new Uint8Array();
      res.writeHead(200, { 'content-type': 'text/plain' }).end(bencode({ complete: 1, incomplete: 0, interval: 30, 'min interval': 30, peers }));
      return;
    }
    // Gluetun's public-IP lookup (`PUBLICIP_API=echoip#http://<seed>`, compose.vpn.test.yml), in echoip's shape:
    // behind the VPN, the caller's address is the test VPN server's, so the exit IP shows which tunnel carried it.
    if (/^\/json(\?|$)/.test(req.url ?? '')) {
      const ip = req.socket.remoteAddress?.replace(/^::ffff:/, '');
      res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ ip, country: 'Testland' }));
      return;
    }
    const match = /^\/files\/([^?]+)/.exec(req.url ?? '');
    const name = match ? decodeURIComponent(match[1]!) : undefined;
    const file = name === undefined ? undefined : byName.get(name);
    if (!file) {
      res.writeHead(404).end('Not found');
      return;
    }
    counts.set(file.name, (counts.get(file.name) ?? 0) + 1);
    if (file.mode === 'stall') return; // held open, never answered
    const size = file.content.length;
    const range = rangeOf(req.headers.range, size);
    const { start, end } = range ?? { start: 0, end: size - 1 };
    const body = file.content.subarray(start, end + 1);
    res.writeHead(range ? 206 : 200, {
      'accept-ranges': 'bytes',
      'content-length': String(body.length),
      'content-type': 'application/octet-stream',
      ...(range ? { 'content-range': `bytes ${start}-${end}/${size}` } : {}),
    });
    if (req.method === 'HEAD') return void res.end();
    if (typeof file.mode !== 'object') return void res.end(body);
    const chunk = Math.max(1, Math.floor(file.mode.bytesPerSecond / 10));
    for (let at = 0; at < body.length && !res.destroyed; at += chunk) {
      res.write(body.subarray(at, at + chunk));
      await sleep(100);
    }
    res.end();
  });
  return { server, requests: (fileName) => counts.get(fileName) ?? 0, announces: () => announces };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.WEBSEED_PORT ?? 4130);
  const peerPort = Number(process.env.WEBSEED_PEER_PORT ?? 6881);
  // The torrents scenario's, and the nyaa scenario's magnets.
  const catalogue = [...torrentCatalogue(), ...nyaaCatalogue()];
  // Only the magnet entries are seeded as a peer: the others must download from the web seed.
  const magnets = catalogue.filter((entry) => entry.magnet);
  createWebSeed(
    catalogue.map((entry) => ({ name: entry.fileName, content: entry.content, ...(entry.mode ? { mode: entry.mode } : {}) })),
    { seededHashes: magnets.map((entry) => entry.torrent.infoHash), peerPort },
  ).server.listen(port, () => console.log(`Web seed and tracker on :${port}, ${catalogue.length} files`));
  createSeedPeer(magnets.map((entry) => ({ ...entry.torrent, content: entry.content }))).listen(peerPort, () => console.log(`Seed peer on :${peerPort}`));
  // The vpn scenario: DNS for gluetun behind the test VPN servers (dns.ts).
  const dnsAnswerIp = process.env.WEBSEED_DNS_ANSWER;
  if (dnsAnswerIp) createDnsResponder(dnsAnswerIp).bind(53, () => console.log(`DNS on :53, every A query answered ${dnsAnswerIp}`));
}
