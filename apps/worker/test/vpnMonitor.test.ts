// The VPN monitor: gluetun's readings become the VPN and
// port states (2 minutes to `down`, 5 minutes of port wait), and qBittorrent's
// `listen_port` is set on every transition to `up` and on every port change.
// The reader is scripted, as the fake control server is in gluetun.test.ts.
import { readFileSync } from 'node:fs';

import { DEFAULT_LIMITS, type VpnSettings } from '@omnarr/contracts';
import { beforeEach, describe, expect, test } from 'vite-plus/test';

import { gluetunReader, type GluetunReader } from '../src/clients/gluetun.ts';
import { VpnMonitor } from '../src/runtime/vpnMonitor.ts';
import { startFakeGluetun } from './fakes/gluetun.ts';

const MINUTE = 60_000;
const signal = new AbortController().signal;
const WIREGUARD: VpnSettings = { kind: 'wireguardFile', wireguardConf: 'x', savedAt: 1 };
const PROTON: VpnSettings = { kind: 'protonvpn', wireguardPrivateKey: 'k', savedAt: 1 };

/** gluetun as the test scripts it; `answers: false` is a control server that doesn't answer. */
type Script = { status: string; healthy: boolean; publicIp?: string; port: number; answers: boolean };
let gluetun: Script;
let now: number;
let set: number[];

const reader: GluetunReader = {
  timeoutMs: 5000,
  vpnStatus: async () => {
    if (!gluetun.answers) throw new Error('Gluetun did not answer (GET /v1/vpn/status).');
    return gluetun.status;
  },
  publicIp: async () => gluetun.publicIp,
  forwardedPort: async () => gluetun.port,
  healthy: async () => gluetun.healthy,
};

const monitor = (layout: 'vpn' | 'direct' = 'vpn') =>
  new VpnMonitor({
    ...(layout === 'vpn' ? { gluetun: reader } : {}),
    peerPort: 6881,
    setListenPort: async (port) => void set.push(port),
    now: () => now,
  });

beforeEach(() => {
  gluetun = { status: 'running', healthy: true, publicIp: '203.0.113.7', port: 0, answers: true };
  now = 1_000_000;
  set = [];
});

describe('the VPN state', () => {
  test('off: no VPN chosen, base layout; nothing is gated, and qBittorrent listens on the published port', async () => {
    const m = monitor('direct');
    expect(await m.read(undefined, signal)).toEqual({ state: 'off', layoutWithoutChoice: false, port: { kind: 'none' }, checkedAt: now });
    expect(m.gated()).toBe(false);
    expect(m.listenPort()).toBe(6881);
  });

  test('notActive: a VPN chosen, but no GLUETUN_URL; torrents are gated', async () => {
    const m = monitor('direct');
    expect((await m.read(WIREGUARD, signal)).state).toBe('notActive');
    expect(m.gated()).toBe(true);
  });

  test('up: running and healthy, with the exit IP for display', async () => {
    gluetun.publicIp = '203.0.113.7';
    const m = monitor();
    expect(await m.read(WIREGUARD, signal)).toEqual({
      state: 'up',
      layoutWithoutChoice: false,
      publicIp: '203.0.113.7',
      port: { kind: 'none' },
      checkedAt: now,
    });
    expect(m.gated()).toBe(false);
  });

  test('running but failing its health check isn’t up: gluetun’s status stays running through a WireGuard outage', async () => {
    gluetun.healthy = false;
    const m = monitor();
    expect((await m.read(WIREGUARD, signal)).state).toBe('connecting');
    expect(m.gated()).toBe(true);
  });

  test('connecting for less than 2 minutes, then down; a control server that doesn’t answer counts the same', async () => {
    gluetun.answers = false;
    const m = monitor();
    expect((await m.read(WIREGUARD, signal)).state).toBe('connecting');
    now += 2 * MINUTE - 1;
    expect((await m.read(WIREGUARD, signal)).state).toBe('connecting');
    now += 1;
    expect((await m.read(WIREGUARD, signal)).state).toBe('down');
    expect(m.gated()).toBe(true);
  });

  test("the e2e's lowered limits: down after vpnDownAfterMs, and back up after vpnStableMs", async () => {
    gluetun.healthy = false;
    const m = new VpnMonitor({
      gluetun: reader,
      peerPort: 6881,
      setListenPort: async () => {},
      now: () => now,
      limits: { ...DEFAULT_LIMITS, vpnDownAfterMs: 3000, vpnStableMs: 5000 },
    });
    expect((await m.read(WIREGUARD, signal)).state).toBe('connecting');
    now += 3000;
    expect((await m.read(WIREGUARD, signal)).state).toBe('down');
    gluetun.healthy = true;
    expect((await m.read(WIREGUARD, signal)).state).toBe('down');
    now += 5000;
    expect((await m.read(WIREGUARD, signal)).state).toBe('up');
  });

  test('a status other than running isn’t up', async () => {
    gluetun.status = 'crashed';
    expect((await monitor().read(WIREGUARD, signal)).state).toBe('connecting');
  });

  test('the VPN layout without a choice: the rules still apply, with the flag set', async () => {
    const m = monitor();
    expect(await m.read(undefined, signal)).toMatchObject({ state: 'up', layoutWithoutChoice: true });
    gluetun.healthy = false;
    expect(await m.read(undefined, signal)).toMatchObject({ state: 'connecting', layoutWithoutChoice: true });
    expect(m.gated()).toBe(true);
  });
});

/** One recorded reading of gluetun v3.41.3 (fixtures/gluetun/README.md). */
type Recorded = { at: string; status: string; health: number; publicIp: string };
const recording = (name: string): Recorded[] => JSON.parse(readFileSync(new URL(`./fixtures/gluetun/${name}.json`, import.meta.url), 'utf8'));
const secondsOf = (at: string) => at.split(':').reduce((total, part) => total * 60 + Number(part), 0);

/**
 * Replays a recording at the reconciler's 30 s cadence, starting `phase` seconds in, and returns each pass's
 * time (seconds of the day) and state. Each pass sees the latest reading taken at or before it.
 */
async function replay(name: string, phase: number): Promise<{ at: number; state: string }[]> {
  const readings = recording(name);
  const start = secondsOf(readings[0]!.at);
  const end = secondsOf(readings.at(-1)!.at);
  const m = monitor();
  const passes: { at: number; state: string }[] = [];
  for (let at = start + phase; at <= end; at += 30) {
    const reading = readings.filter((r) => secondsOf(r.at) <= at).at(-1)!;
    gluetun = { status: reading.status, healthy: reading.health === 200, publicIp: reading.publicIp || undefined, port: 0, answers: true };
    now = at * 1000;
    passes.push({ at, state: (await m.read(WIREGUARD, signal)).state });
  }
  return passes;
}

describe('a dead OpenVPN tunnel, from recorded gluetun v3.41.3 readings', () => {
  const PHASES = [0, 5, 10, 15, 20, 25];

  test.each(PHASES)(
    'with tls-exit (PIA, ProtonVPN): never up while blocked, and down within 2 minutes of the first pass that sees it (phase %i s)',
    async (phase) => {
      const passes = await replay('openvpn-dead-server', phase);
      const unblocked = secondsOf('21:40:23');
      const firstNotUp = passes.find((pass) => pass.state !== 'up')!;
      // The first crash, at 21:31:25, cleared the public IP.
      expect(firstNotUp.at).toBeGreaterThanOrEqual(secondsOf('21:31:25'));
      expect(firstNotUp.at).toBeLessThan(secondsOf('21:31:25') + 30);
      const blocked = passes.filter((pass) => pass.at >= firstNotUp.at && pass.at < unblocked);
      expect(blocked.map((pass) => pass.state)).not.toContain('up');
      expect(blocked.find((pass) => pass.state === 'down')!.at - firstNotUp.at).toBeLessThanOrEqual(120);
    },
  );

  test.each(PHASES)('without tls-exit: the health server goes to 500, and the state follows (phase %i s)', async (phase) => {
    const passes = await replay('openvpn-dead-server-no-tls-exit', phase);
    const firstNotUp = passes.find((pass) => pass.state !== 'up')!;
    expect(firstNotUp.at).toBeLessThan(secondsOf('21:26:33') + 30);
    expect(passes.filter((pass) => pass.at >= firstNotUp.at && pass.at < secondsOf('21:28:09')).map((pass) => pass.state)).not.toContain('up');
  });
});

describe("a tunnel that answers without an exit IP (vpnDown's restart hint)", () => {
  test('running and healthy all along, with no public IP: down, flagged exitIpMissing', async () => {
    gluetun.publicIp = undefined;
    const m = monitor();
    expect(await m.read(WIREGUARD, signal)).toMatchObject({ state: 'connecting', exitIpMissing: true });
    now += 2 * MINUTE;
    expect(await m.read(WIREGUARD, signal)).toMatchObject({ state: 'down', exitIpMissing: true });
  });

  test('a real outage isn’t flagged: a failing health check, a crash or no answer', async () => {
    for (const fault of [{ healthy: false }, { status: 'crashed' }, { answers: false }]) {
      Object.assign(gluetun, { status: 'running', healthy: true, answers: true, publicIp: undefined }, fault);
      const m = monitor();
      await m.read(WIREGUARD, signal);
      now += 2 * MINUTE;
      expect(await m.read(WIREGUARD, signal), JSON.stringify(fault)).not.toHaveProperty('exitIpMissing');
    }
  });

  test('one crash since the tunnel stopped passing clears the flag for the rest of the outage', async () => {
    gluetun.publicIp = undefined;
    const m = monitor();
    await m.read(WIREGUARD, signal);
    gluetun.status = 'crashed';
    now += 30_000;
    await m.read(WIREGUARD, signal);
    gluetun.status = 'running';
    now += 90_000;
    expect(await m.read(WIREGUARD, signal)).toMatchObject({ state: 'down' });
    expect(await m.read(WIREGUARD, signal)).not.toHaveProperty('exitIpMissing');
  });

  test.each([0, 5, 10, 15, 20, 25])(
    'the recorded OpenVPN outage (running 200 without an IP for 60 s of every 75) is never flagged once down: a pass sees a crash first (phase %i s)',
    async (phase) => {
      const readings = recording('openvpn-dead-server');
      const m = monitor();
      const flagged: boolean[] = [];
      for (let at = secondsOf(readings[0]!.at) + phase; at < secondsOf('21:40:23'); at += 30) {
        const reading = readings.filter((r) => secondsOf(r.at) <= at).at(-1)!;
        gluetun = { status: reading.status, healthy: reading.health === 200, publicIp: reading.publicIp || undefined, port: 0, answers: true };
        now = at * 1000;
        const result = await m.read(WIREGUARD, signal);
        if (result.state === 'down') flagged.push(result.exitIpMissing === true);
      }
      // Passes 30 s apart can miss a 15 s `crashed` window, but within the 2 minutes to down they saw one at every phase.
      expect(flagged.length).toBeGreaterThan(10);
      expect(flagged).not.toContain(true);
    },
  );
});

describe('the down timer', () => {
  test('running and healthy without a public IP isn’t up: gluetun clears it when the VPN stops and looks it up only through a new tunnel', async () => {
    gluetun.publicIp = undefined;
    expect((await monitor().read(WIREGUARD, signal)).state).toBe('connecting');
  });

  test('one good reading between bad ones doesn’t reset it: the outage is still down 2 minutes after it began', async () => {
    const m = monitor();
    await m.read(WIREGUARD, signal);
    gluetun.healthy = false;
    expect((await m.read(WIREGUARD, signal)).state).toBe('connecting');
    now += MINUTE;
    gluetun.healthy = true;
    expect((await m.read(WIREGUARD, signal)).state).toBe('up');
    now += 30_000;
    gluetun.healthy = false;
    now += 30_000;
    expect((await m.read(WIREGUARD, signal)).state).toBe('down');
  });

  test('down holds until the tunnel has been up for 2 minutes; then up, and the timer starts afresh', async () => {
    const m = monitor();
    gluetun.healthy = false;
    await m.read(WIREGUARD, signal);
    now += 2 * MINUTE;
    expect((await m.read(WIREGUARD, signal)).state).toBe('down');
    gluetun.healthy = true;
    now += 30_000;
    expect((await m.read(WIREGUARD, signal)).state).toBe('down');
    now += 2 * MINUTE - 1;
    expect((await m.read(WIREGUARD, signal)).state).toBe('down');
    now += 1;
    expect((await m.read(WIREGUARD, signal)).state).toBe('up');
    expect(m.gated()).toBe(false);
    gluetun.healthy = false;
    now += 30_000;
    expect((await m.read(WIREGUARD, signal)).state).toBe('connecting');
  });

  test('a bad reading during that window keeps the old timer: still down', async () => {
    const m = monitor();
    gluetun.healthy = false;
    await m.read(WIREGUARD, signal);
    now += 2 * MINUTE;
    await m.read(WIREGUARD, signal);
    gluetun.healthy = true;
    now += MINUTE;
    await m.read(WIREGUARD, signal);
    gluetun.healthy = false;
    now += 30_000;
    expect((await m.read(WIREGUARD, signal)).state).toBe('down');
    gluetun.healthy = true;
    now += 90_000;
    // The window starts again from this good reading, not from the earlier one.
    expect((await m.read(WIREGUARD, signal)).state).toBe('down');
  });
});

describe('the port state, only while up', () => {
  test('forwarded: gluetun’s port above 0', async () => {
    gluetun.port = 40123;
    expect((await monitor().read(PROTON, signal)).port).toEqual({ kind: 'forwarded', port: 40123 });
  });

  test('static: the user’s port, when gluetun forwards none', async () => {
    expect((await monitor().read({ ...WIREGUARD, staticForwardedPort: 51413 }, signal)).port).toEqual({ kind: 'static', port: 51413 });
  });

  test('waiting: forwarding is on and the port has been 0 for less than 5 minutes after up; then none', async () => {
    const m = monitor();
    expect((await m.read(PROTON, signal)).port).toEqual({ kind: 'waiting' });
    now += 5 * MINUTE - 1;
    expect((await m.read(PROTON, signal)).port).toEqual({ kind: 'waiting' });
    now += 1;
    expect((await m.read(PROTON, signal)).port).toEqual({ kind: 'none' });
  });

  test('none: a kind that doesn’t forward', async () => {
    expect((await monitor().read(WIREGUARD, signal)).port).toEqual({ kind: 'none' });
  });

  test('not evaluated while the VPN isn’t up, so no port is never confused with VPN down', async () => {
    gluetun.port = 40123;
    gluetun.healthy = false;
    expect((await monitor().read(PROTON, signal)).port).toEqual({ kind: 'none' });
  });
});

describe('listen_port', () => {
  test('up with a port, the tunnel drops, comes back 10 minutes later with a new one', async () => {
    const m = monitor();
    gluetun.port = 40123;
    await m.read(PROTON, signal);
    expect(set).toEqual([40123]);
    expect(m.listenPort()).toBe(40123);

    gluetun.healthy = false;
    gluetun.port = 0;
    expect((await m.read(PROTON, signal)).state).toBe('connecting');
    now += 2 * MINUTE;
    expect((await m.read(PROTON, signal)).state).toBe('down');
    now += 8 * MINUTE;
    expect(set).toEqual([40123]);

    gluetun.healthy = true;
    gluetun.port = 51000;
    // Down holds until the tunnel has been up for the stable window.
    expect((await m.read(PROTON, signal)).state).toBe('down');
    now += 2 * MINUTE;
    expect(await m.read(PROTON, signal)).toMatchObject({ state: 'up', port: { kind: 'forwarded', port: 51000 } });
    expect(set).toEqual([40123, 51000]);
    expect(m.listenPort()).toBe(51000);
  });

  test('set again on every transition to up, even an unchanged port, since qBittorrent needs it after a reconnect', async () => {
    const m = monitor();
    gluetun.port = 40123;
    await m.read(PROTON, signal);
    await m.read(PROTON, signal);
    expect(set).toEqual([40123]);
    gluetun.healthy = false;
    await m.read(PROTON, signal);
    gluetun.healthy = true;
    await m.read(PROTON, signal);
    expect(set).toEqual([40123, 40123]);
  });

  test('a port change while up is set at once', async () => {
    const m = monitor();
    gluetun.port = 40123;
    await m.read(PROTON, signal);
    gluetun.port = 40999;
    await m.read(PROTON, signal);
    expect(set).toEqual([40123, 40999]);
  });

  test('without a forwarded or static port, the published port: set on up', async () => {
    const m = monitor();
    await m.read(WIREGUARD, signal);
    expect(set).toEqual([6881]);
    expect(m.listenPort()).toBe(6881);
  });

  test('a failed set is tried again on the next pass', async () => {
    let fail = true;
    const m = new VpnMonitor({
      gluetun: reader,
      peerPort: 6881,
      setListenPort: async (port) => {
        if (fail) throw new Error('qBittorrent did not answer');
        set.push(port);
      },
      now: () => now,
    });
    gluetun.port = 40123;
    expect((await m.read(PROTON, signal)).state).toBe('up');
    fail = false;
    await m.read(PROTON, signal);
    expect(set).toEqual([40123]);
  });

  test('against the fake control server: ProtonVPN forwards 40123, the tunnel drops for 10 minutes, and comes back with 51000', async () => {
    const fake = await startFakeGluetun('key');
    try {
      const m = new VpnMonitor({
        gluetun: gluetunReader({ url: fake.url, healthUrl: fake.url, apiKey: 'key' }),
        peerPort: 6881,
        setListenPort: async (port) => void set.push(port),
        now: () => now,
      });
      fake.port = 40123;
      fake.publicIp = '203.0.113.7';
      expect(await m.read(PROTON, signal)).toMatchObject({ state: 'up', publicIp: '203.0.113.7', port: { kind: 'forwarded', port: 40123 } });
      // Gluetun's status stays running; its health check fails, and the VPN restart it triggers clears the public IP.
      fake.healthy = false;
      fake.publicIp = '';
      fake.port = 0;
      expect((await m.read(PROTON, signal)).state).toBe('connecting');
      expect(m.gated()).toBe(true);
      now += 2 * MINUTE;
      expect((await m.read(PROTON, signal)).state).toBe('down');
      now += 8 * MINUTE;
      fake.healthy = true;
      fake.publicIp = '203.0.113.7';
      fake.port = 51000;
      expect((await m.read(PROTON, signal)).state).toBe('down');
      now += 2 * MINUTE;
      expect(await m.read(PROTON, signal)).toMatchObject({ state: 'up', port: { kind: 'forwarded', port: 51000 } });
      expect(set).toEqual([40123, 51000]);
      expect(m.gated()).toBe(false);
      expect(fake.calls.filter((call) => call.path !== '/').every((call) => call.keyed && call.method === 'GET')).toBe(true);
    } finally {
      await fake.close();
    }
  });

  test('the base layout never sets a port', async () => {
    const m = monitor('direct');
    await m.read(WIREGUARD, signal);
    await m.read(undefined, signal);
    expect(set).toEqual([]);
  });
});
