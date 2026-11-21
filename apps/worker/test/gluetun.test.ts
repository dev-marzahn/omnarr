// The gluetun reader against a fake of v3.41.3's control and
// health servers: the API key on every control call, a 5 s timeout, and only
// the three read routes the key's role allows, plus the health server.
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';

import { gluetunReader, type GluetunReader } from '../src/clients/gluetun.ts';
import { startFakeGluetun, type FakeGluetun } from './fakes/gluetun.ts';

const KEY = 'planted-gluetun-api-key-0b7e';
const signal = new AbortController().signal;

let fake: FakeGluetun;
let reader: GluetunReader;

beforeEach(async () => {
  fake = await startFakeGluetun(KEY);
  reader = gluetunReader({ url: fake.url, healthUrl: fake.url, apiKey: KEY });
});
afterEach(() => fake.close());

describe('the control API', () => {
  test('reads the VPN status, the public IP and the forwarded port, each with X-API-Key', async () => {
    fake.publicIp = '203.0.113.7';
    fake.port = 40123;
    expect(await reader.vpnStatus(signal)).toBe('running');
    expect(await reader.publicIp(signal)).toBe('203.0.113.7');
    expect(await reader.forwardedPort(signal)).toBe(40123);
    expect(fake.calls.map((call) => `${call.method} ${call.path} ${call.keyed}`)).toEqual([
      'GET /v1/vpn/status true',
      'GET /v1/publicip/ip true',
      'GET /v1/portforward true',
    ]);
  });

  test('an empty public IP is none, and port 0 is no forwarded port', async () => {
    expect(await reader.publicIp(signal)).toBeUndefined();
    expect(await reader.forwardedPort(signal)).toBe(0);
  });

  test('a refused key fails with platform text that never holds the key', async () => {
    const wrong = gluetunReader({ url: fake.url, healthUrl: fake.url, apiKey: 'wrong' });
    const error = await wrong.vpnStatus(signal).catch((caught: Error) => caught);
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toBe('Gluetun refused the control API key (GET /v1/vpn/status, HTTP 401).');
    expect(JSON.stringify(error)).not.toContain(KEY);
  });

  test('a call that takes longer than the timeout fails', async () => {
    fake.delayMs = 300;
    const quick = gluetunReader({ url: fake.url, healthUrl: fake.url, apiKey: KEY, timeoutMs: 50 });
    await expect(quick.vpnStatus(signal)).rejects.toThrow('Gluetun did not answer in time (GET /v1/vpn/status).');
  });

  test('the default timeout is 5 s', () => {
    expect(gluetunReader({ url: fake.url, healthUrl: fake.url, apiKey: KEY }).timeoutMs).toBe(5000);
  });

  test('an unreachable gluetun fails without its URL', async () => {
    const gone = gluetunReader({ url: 'http://127.0.0.1:1', healthUrl: 'http://127.0.0.1:1', apiKey: KEY });
    await expect(gone.forwardedPort(signal)).rejects.toThrow('Gluetun did not answer (GET /v1/portforward).');
  });
});

describe('the health server', () => {
  test('200 is healthy, 500 is not; it carries no key', async () => {
    expect(await reader.healthy(signal)).toBe(true);
    fake.healthy = false;
    expect(await reader.healthy(signal)).toBe(false);
    expect(fake.calls.map((call) => `${call.method} ${call.path} ${call.keyed}`)).toEqual(['GET / false', 'GET / false']);
  });
});
