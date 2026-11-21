// The web-seed server: BEP 19 files over HTTP with ranges, and
// the stall and slow modes the torrents e2e uses.
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test';

import { createWebSeed } from './server.ts';

const content = new Uint8Array(1000).map((_, i) => i % 256);
const SEEDED = 'ab'.repeat(20);
const seed = createWebSeed(
  [
    { name: 'Good.mkv', content },
    { name: 'Stalled.mkv', content, mode: 'stall' },
    { name: 'Slow.mkv', content, mode: { bytesPerSecond: 2000 } },
  ],
  { seededHashes: [SEEDED], peerPort: 6881 },
);
let base: string;
beforeAll(async () => {
  await new Promise<void>((resolve) => seed.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(seed.server.address() as AddressInfo).port}/files`;
});
afterAll(() => {
  seed.server.closeAllConnections();
  return new Promise<void>((resolve) => seed.server.close(() => resolve()));
});

describe('the web seed', () => {
  test('serves a file by its name, as a client appends it to a url-list entry ending in /', async () => {
    const res = await fetch(`${base}/Good.mkv`);
    expect([res.status, res.headers.get('content-length'), res.headers.get('accept-ranges')]).toEqual([200, '1000', 'bytes']);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(content);
  });

  test('answers a byte range with 206 and Content-Range', async () => {
    const res = await fetch(`${base}/Good.mkv`, { headers: { range: 'bytes=10-19' } });
    expect([res.status, res.headers.get('content-range')]).toEqual([206, 'bytes 10-19/1000']);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(content.subarray(10, 20));
  });

  test('an open-ended range runs to the end', async () => {
    const res = await fetch(`${base}/Good.mkv`, { headers: { range: 'bytes=990-' } });
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(content.subarray(990));
  });

  test("answers gluetun's public-IP lookup in echoip's shape with the caller's address: the vpn e2e's exit IP", async () => {
    const res = await fetch(base.replace(/\/files$/, '/json'));
    expect([res.status, res.headers.get('content-type')]).toEqual([200, 'application/json']);
    expect(await res.json()).toEqual({ ip: '127.0.0.1', country: 'Testland' });
  });

  test('a file it does not hold is 404, and names are decoded', async () => {
    expect((await fetch(`${base}/Missing.mkv`)).status).toBe(404);
    expect((await fetch(`${base}/Good%2Emkv`)).status).toBe(200);
  });

  test('a stalled file never answers', async () => {
    await expect(fetch(`${base}/Stalled.mkv`, { signal: AbortSignal.timeout(300) })).rejects.toThrow();
  });

  test('a slow file trickles at its rate', async () => {
    const started = Date.now();
    const res = await fetch(`${base}/Slow.mkv`);
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(content);
    expect(Date.now() - started).toBeGreaterThanOrEqual(400);
  });

  const announce = async (hash: string) => {
    // A client sends the 20 raw bytes of the hash, percent-encoded.
    const infoHash = [...Buffer.from(hash, 'hex')].map((byte) => `%${byte.toString(16).padStart(2, '0')}`).join('');
    const res = await fetch(`${base.replace(/\/files$/, '')}/announce?info_hash=${infoHash}&peer_id=x&port=6881&uploaded=0&downloaded=0&left=0`);
    return { status: res.status, body: Buffer.from(await res.arrayBuffer()) };
  };

  test('answers a tracker announce with a 30-second interval and no peers, so a client refreshes the torrent', async () => {
    const { status, body } = await announce('cd'.repeat(20));
    expect(status).toBe(200);
    expect(body.toString('latin1')).toBe('d8:completei1e10:incompletei0e8:intervali30e12:min intervali30e5:peers0:e');
    expect(seed.announces()).toBeGreaterThan(0);
  });

  test('for a torrent the seed peer holds, the peer is its one compact peer: the address the request came in on, and the peer port', async () => {
    const { body } = await announce(SEEDED);
    const text = body.toString('latin1');
    const at = text.indexOf('5:peers6:') + '5:peers6:'.length;
    expect([...body.subarray(at, at + 6)]).toEqual([127, 0, 0, 1, 6881 >> 8, 6881 & 0xff]);
  });

  test('counts the requests per file', async () => {
    const before = seed.requests('Good.mkv');
    await (await fetch(`${base}/Good.mkv`)).arrayBuffer();
    expect(seed.requests('Good.mkv')).toBe(before + 1);
  });
});
