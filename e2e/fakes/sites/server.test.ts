// The fake definitions server and Star Site, over HTTP.
import type { AddressInfo } from 'node:net';

import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test';

import { createSitesFake, starTorrents } from './server.ts';
import { crc32 } from './zip.ts';

const fake = createSitesFake({ origin: 'http://sites:4160' });
let base: string;
beforeAll(async () => {
  await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
});
afterAll(() => new Promise<void>((resolve) => fake.server.close(() => resolve())));

const get = async (path: string, init: RequestInit = {}) => {
  const res = await fetch(`${base}${path}`, { headers: { 'user-agent': 'omnarr/test' }, ...init });
  return { status: res.status, bytes: new Uint8Array(await res.arrayBuffer()) };
};
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

/** The names and contents of a stored zip, read by its local headers. */
function unzip(bytes: Uint8Array): Record<string, string> {
  const view = new DataView(bytes.buffer, bytes.byteOffset);
  const files: Record<string, string> = {};
  for (let at = 0; view.getUint32(at, true) === 0x04034b50;) {
    const size = view.getUint32(at + 18, true);
    const nameLength = view.getUint16(at + 26, true);
    const name = text(bytes.subarray(at + 30, at + 30 + nameLength));
    const data = bytes.subarray(at + 30 + nameLength, at + 30 + nameLength + size);
    expect(view.getUint32(at + 14, true)).toBe(crc32(data));
    files[name] = text(data);
    at += 30 + nameLength + size;
  }
  return files;
}

describe('the definitions server', () => {
  test('serves v12 package.zip with the three hand-written definitions, and the broken update when asked', async () => {
    const pkg = unzip((await get('/12/package.zip')).bytes);
    expect(Object.keys(pkg).sort()).toEqual(['nyaasi.yml', 'privy.yml', 'starsite.yml']);
    expect(pkg['starsite.yml']).toContain('- http://sites:4160/star/');
    await fetch(`${base}/_fake/update?variant=broken`, { method: 'POST' });
    expect(unzip((await get('/12/package.zip')).bytes)['starsite.yml']).toContain('name: sparkle');
    await fetch(`${base}/_fake/update?variant=good`, { method: 'POST' });
  });
});

describe('the Star Site', () => {
  test('lists its torrent without a magnet; a search matches the title words', async () => {
    const latest = text((await get('/star/latest?q=&sort=added')).bytes);
    expect(latest).toContain('[SubsPlease] Star Lantern - 01 (1080p)');
    expect(latest).not.toContain('magnet:');
    expect(text((await get('/star/search?q=Star+Lantern+01&sort=added')).bytes)).toContain('Star Lantern - 01');
    expect(text((await get('/star/search?q=Other+Show&sort=added')).bytes)).not.toContain('Star Lantern');
  });

  test("the details page links the .torrent, which is the web seed's torrent", async () => {
    expect(text((await get('/star/t/1')).bytes)).toContain('<a class="download" href="/star/dl/1.torrent">');
    expect((await get('/star/dl/1.torrent')).bytes).toEqual(starTorrents()[0]!.torrent.bytes);
  });

  test('logs the requests with their User-Agent, without the control routes', async () => {
    const log = (await (await fetch(`${base}/_fake/requests`)).json()) as { path: string; userAgent: string }[];
    expect(log.length).toBeGreaterThan(0);
    expect(log.every((entry) => !entry.path.startsWith('/_fake') && entry.userAgent === 'omnarr/test')).toBe(true);
  });
});
