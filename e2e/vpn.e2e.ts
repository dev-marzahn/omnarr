// The VPN on the real stack: gluetun v3.41.3 against a test WireGuard
// server (linuxserver/wireguard), with qBittorrent in gluetun's network
// namespace and the web seed reachable only through the tunnel
// (compose.wireguard.test.yml).
import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { makeFunctionReference } from 'convex/server';
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test';

import { vpnCatalogue } from './fakes/torrent/catalogue.ts';
import { publishedRelease } from './releases.ts';
import {
  blockOpenvpnServer,
  compose,
  deployLikeCoolify,
  down,
  exec,
  FAR_WEBSEED,
  gluetunApi,
  NEWZNAB_KEY,
  openvpnClientConf,
  qbittorrentApi,
  rows,
  startWireguardServer,
  startWorker,
  stopWireguardBeforeHealthCheck,
  switchToVpnLayout,
  up,
  useRelease,
  VPN_NET,
  vpnFiles,
  waitFor,
  wireguardPeerConf,
  type Deployment,
} from './stack.ts';

// oxlint-disable-next-line typescript/no-explicit-any
type Any = any;
const query = (name: string, args: object = {}): Promise<Any> => d.admin.query(makeFunctionReference<'query'>(name), args);
const action = (name: string, args: object): Promise<Any> => d.admin.action(makeFunctionReference<'action'>(name), args);
const mutation = (name: string, args: object): Promise<Any> => d.admin.mutation(makeFunctionReference<'mutation'>(name), args);

type Row = { _id: string } & Record<string, Any>;
type TorrentInfo = { hash: string; state: string; progress: number; downloaded: number };

const MINUTE = 60_000;
/**
 * The stall time, above all the time S01E04's clock counts without a byte, so a stall would show only
 * if the clock ran through the outage. It counts until the worker sees the dead tunnel: gluetun's small
 * health check, which the outage meets as it starts (stopWireguardBeforeHealthCheck), fails after its
 * 120 s of retries, and the next pass pauses the clock, about 125 s. It counts again from `up` after the
 * restart until qBittorrent's web seed moves again (libtorrent retries a failed web seed after 30 s):
 * up to about 30 s more. With 150 s the recovery could stall.
 */
const STALL_MS = 180_000;
/** After the stall time, how long the test still checks that nothing stalled: a few passes. */
const STALL_MARGIN_MS = 15_000;
const catalogue = vpnCatalogue(`${FAR_WEBSEED}:4130`);
const hashOf = (guid: string) => catalogue.find((entry) => entry.guid === guid)!.torrent.infoHash;
const VPN_STACK = { layout: 'wireguard', torrents: { seedGoal: { seedTimeMs: 120 * MINUTE } }, torrentStallMs: STALL_MS } as const;

let d: Deployment;
let conf: string;

const qbittorrentRow = async () => (await query('api/system:status')).clients.find((client: { clientKind: string }) => client.clientKind === 'qbittorrent');
const vpnState = async (): Promise<string | undefined> => (await qbittorrentRow())?.vpn?.state;
const vpnIssues = () => rows<Row>(d.env, 'issues').filter((issue) => issue.failureCode === 'vpnDown');
const torrent = (guid: string) => qbittorrentApi<TorrentInfo[]>('torrents/info').find((info) => info.hash === hashOf(guid));
const containerId = (service: string) => compose(['ps', '-q', service], ['test', 'worker']).trim();
const gluetunProcessEnv = () =>
  exec('gluetun', ['sh', '-c', `pid=$(pgrep -P 1 -f '^/gluetun-entrypoint') && tr "\\0" "\\n" < /proc/$pid/environ || true`], ['test', 'worker']);
const gluetunRunning = () => gluetunProcessEnv() !== '';
const OUTSIDE_THE_TUNNEL = { host: '1.1.1.1', port: 80 };
const succeeds = (run: () => unknown) => {
  try {
    run();
    return true;
  } catch {
    return false;
  }
};
const qbittorrentNamespaceReachesOutside = () =>
  succeeds(() => exec('gluetun', ['timeout', '5', 'nc', '-z', '-w', '3', OUTSIDE_THE_TUNNEL.host, String(OUTSIDE_THE_TUNNEL.port)], ['test', 'worker']));
const workerReachesOutside = () =>
  succeeds(() =>
    exec(
      'worker',
      [
        'node',
        '-e',
        `require('node:net').connect(${OUTSIDE_THE_TUNNEL.port}, '${OUTSIDE_THE_TUNNEL.host}').on('connect', () => process.exit(0)).on('error', () => process.exit(1)); setTimeout(() => process.exit(1), 5000);`,
      ],
      ['test', 'worker'],
    ),
  );
const filesHash = (env: string) => /^OMNARR_VPN_FILES_HASH=(\w+)$/m.exec(env)?.[1];
const qbittorrentConnected = async () =>
  waitFor('qBittorrent connected through tun0', async () =>
    qbittorrentApi<{ connection_status: string }>('transfer/info').connection_status !== 'disconnected' ? true : undefined,
  );
const savedVpnReachesGluetun = async (input: object) => {
  const env = await savedVpnWritten(input);
  await waitFor('gluetun restarted with the new settings', async () => (filesHash(gluetunProcessEnv()) === filesHash(env) ? true : undefined), 60_000, 1_000);
};
const savedVpnWritten = async (input: object) => {
  const envBefore = exec('worker', ['cat', '/vpn/gluetun.env']);
  await mutation('api/downloadClients:saveVpn', { input });
  return waitFor(
    'gluetun.env rewritten',
    async () => {
      const current = exec('worker', ['cat', '/vpn/gluetun.env']);
      return current !== envBefore ? current : undefined;
    },
    120_000,
    500,
  );
};
const vpnUp = (when: string, { exitIp, timeoutMs = 300_000 }: { exitIp?: string; timeoutMs?: number } = {}) =>
  waitFor(
    `the VPN up ${when}`,
    async () => {
      const row = await qbittorrentRow();
      return row?.vpn?.state === 'up' && (exitIp === undefined || row.vpn.publicIp === exitIp) ? row : undefined;
    },
    timeoutMs,
    1_000,
  );

beforeAll(async () => {
  d = await up(VPN_STACK);
  startWorker('worker');
}, 900_000);
afterAll(() => {
  if (process.env.E2E_KEEP !== '1') return down();
});

describe('the VPN layout', () => {
  test('setup: qBittorrent configured in the direct layout; the Torznab indexer', async () => {
    await waitFor('qBittorrent applied', async () => {
      const row = await qbittorrentRow();
      return row?.config === 'applied' && row.reachable ? row : undefined;
    });
    expect(await vpnState()).toBe('off');
    await action('api/indexers:create', { name: 'Torznab', url: 'http://torznab:4122/api', apiKey: NEWZNAB_KEY, priority: 10 });
    conf = await wireguardPeerConf();
  });

  test('chosen but not active: vpn/ written, qBittorrent bound to tun0, vpnDown with the step, and torrent submits wait', async () => {
    await mutation('api/downloadClients:saveVpn', { input: { kind: 'wireguardFile', wireguardConf: conf } });
    await waitFor('notActive', async () => ((await vpnState()) === 'notActive' ? true : undefined), 120_000, 500);

    expect(vpnFiles()).toEqual(['gluetun.env', 'wg0.conf']);
    const env = exec('worker', ['cat', '/vpn/gluetun.env']);
    expect(env).toContain('VPN_SERVICE_PROVIDER=custom\n');
    expect(env).toContain('VPN_INTERFACE=tun0\n');
    expect(env).not.toMatch(/PrivateKey|PresharedKey/);
    expect(qbittorrentApi<Record<string, unknown>>('app/preferences').current_network_interface).toBe('tun0');
    // qBittorrent has no tun0 in the direct layout, so it has no interface to use (fixtures README).
    await waitFor('qBittorrent disconnected', async () =>
      qbittorrentApi<{ connection_status: string }>('transfer/info').connection_status === 'disconnected' ? true : undefined,
    );

    const [issue] = vpnIssues();
    expect(issue).toMatchObject({ state: 'open', scope: 'system', fixActions: [] });
    expect(issue!.detail).toContain('COMPOSE_FILE=compose.yml:compose.vpn.yml');

    const { library } = await query('api/library:list', { kind: 'series' });
    await action('api/library:subscribe', {
      tmdbId: '900001',
      kind: 'series',
      libraryId: library.libraryId,
      releaseProfileId: library.defaultReleaseProfileId,
      seasons: [1],
    });
    const waiting = await waitFor(
      'both torrent submits waiting on the VPN',
      async () => {
        const jobs = rows<Row>(d.env, 'jobs').filter((job) => job.class === 'download.submit' && job.status === 'waiting' && job.failureCode === 'vpnDown');
        return jobs.length === 2 ? jobs : undefined;
      },
      240_000,
      1_000,
    );
    expect(waiting.every((job) => job.attempt === 0)).toBe(true);
    expect(qbittorrentApi<TorrentInfo[]>('torrents/info')).toEqual([]);
  });

  test('the user switches layouts: gluetun:8080 and the control API with the key; a request without it is refused; up resolves vpnDown', async () => {
    const qbittorrentBefore = containerId('qbittorrent');
    switchToVpnLayout();
    expect(containerId('qbittorrent')).not.toBe(qbittorrentBefore);
    await vpnUp('after the switch');

    // The worker reaches qBittorrent through gluetun's namespace, configured in its new session.
    const row = await waitFor('qBittorrent applied through gluetun', async () => {
      const current = await qbittorrentRow();
      return current?.reachable && current.config === 'applied' ? current : undefined;
    });
    expect(row.vpn).toMatchObject({ state: 'up', layoutWithoutChoice: false, port: { kind: 'none' } });
    expect(qbittorrentApi<string>('app/version')).toMatch(/^v?5\.3\.0/);

    expect(gluetunApi('/v1/vpn/status')).toMatchObject({ status: 200, body: expect.stringContaining('"status":"running"') });
    expect(gluetunApi('/v1/vpn/status', { key: false }).status).toBe(401);
    // A route the worker's role doesn't list, and every PUT, is refused even with the key.
    expect(gluetunApi('/v1/vpn/settings').status).toBe(401);
    expect(gluetunApi('/', { key: false, port: 9999 }).status).toBe(200);

    expect(vpnIssues().map((issue) => issue.state)).toEqual(['resolved']);
  });

  test('the waiting submits wake, and S01E01 downloads through the tunnel', async () => {
    await waitFor('both torrents in qBittorrent', async () => (torrent('hl-t-s01e01') && torrent('hl-t-s01e04-slow') ? true : undefined), 180_000, 1_000);
    await waitFor('S01E01 complete', async () => ((torrent('hl-t-s01e01')?.progress ?? 0) >= 1 ? true : undefined), 300_000, 1_000);
    // The web seed is only on the far network, which gluetun isn't on: the bytes came through tun0.
    expect(exec('gluetun', ['ip', '-o', 'link', 'show', 'tun0'], ['test', 'worker'])).toContain('tun0');
    // And nothing outside the test is reachable through the tunnel: no answer within 5 s. (BusyBox's `wget -T`
    // doesn't bound the connect, which took about 4 minutes of SYN retries, so `timeout` does.)
    expect(() => exec('gluetun', ['timeout', '5', 'wget', '-q', '-O', '-', 'http://1.1.1.1/'], ['test', 'worker'])).toThrow();
  });

  test('stopping the WireGuard server opens vpnDown, stops the transfer and pauses the stall clock', async () => {
    const e4 = () => rows<Row>(d.env, 'downloads').find((row) => row.clientRef === hashOf('hl-t-s01e04-slow'))!;
    await waitFor('S01E04 moving', async () => ((torrent('hl-t-s01e04-slow')?.downloaded ?? 0) > 0 ? true : undefined), 120_000, 1_000);
    const stoppedAt = await stopWireguardBeforeHealthCheck();

    await waitFor('the VPN down', async () => ((await vpnState()) === 'down' ? true : undefined), 480_000, 1_000);
    // Where the time goes: gluetun's check, then vpnDownAfterMs; the stall clock paused vpnDownAfterMs before this.
    process.stderr.write(`MEASURED: WireGuard outage: down ${((Date.now() - stoppedAt) / 1000).toFixed(0)} s after the server stopped\n`);
    expect(vpnIssues().find((issue) => issue.state === 'open')).toMatchObject({ detail: expect.stringMatching(/tunnel is down/) });

    const before = torrent('hl-t-s01e04-slow')!.downloaded;
    // Past the stall time since the server stopped, and a few passes more: with the clock running, S01E04 would have stalled.
    const waitMs = Math.max(STALL_MARGIN_MS, stoppedAt + STALL_MS + STALL_MARGIN_MS - Date.now());
    await new Promise((resolve) => setTimeout(resolve, waitMs));
    expect(torrent('hl-t-s01e04-slow')!.downloaded).toBe(before);
    expect(e4()).toMatchObject({ state: 'active' });
    expect(rows<Row>(d.env, 'grabs').some((grab) => grab.failureCode === 'torrentStalled')).toBe(false);
  });

  test('recovery: the server starts again, vpnDown resolves, and S01E04 moves again', async () => {
    // Counted from the restart: qBittorrent moves as soon as the tunnel works, while the worker's `up`
    // waits for gluetun's exit IP and then the stable window (2 minutes in production), by which time
    // the trickling S01E04 can have finished.
    const before = torrent('hl-t-s01e04-slow')!.downloaded;
    await startWireguardServer();
    const startedAt = Date.now();
    await waitFor('S01E04 moving again', async () => (torrent('hl-t-s01e04-slow')!.downloaded > before ? true : undefined), 300_000, 1_000);
    process.stderr.write(`MEASURED: WireGuard recovery: S01E04 moved again ${((Date.now() - startedAt) / 1000).toFixed(0)} s after the server started\n`);
    await vpnUp('again', { timeoutMs: 420_000 });
    expect(vpnIssues().every((issue) => issue.state === 'resolved')).toBe(true);
  });

  test('a changed VPN file restarts gluetun in its container without compose, and qBittorrent keeps a network', async () => {
    const gluetunBefore = containerId('gluetun');
    await savedVpnReachesGluetun({ kind: 'wireguardFile', wireguardConf: `${conf}\n# rotated\n` });
    expect(containerId('gluetun')).toBe(gluetunBefore);
    await vpnUp('after the restart');
    expect(qbittorrentApi<string>('app/version')).toMatch(/^v?5\.3\.0/);
    expect(torrent('hl-t-s01e01')).toBeDefined();
    await qbittorrentConnected();
  });

  test('a setting gluetun refuses stops only gluetun, which retries after a minute with no traffic outside the VPN; the fixed setting brings qBittorrent back without compose', async () => {
    const containers = { gluetun: containerId('gluetun'), qbittorrent: containerId('qbittorrent') };
    const refusals = () => compose(['logs', '--no-color', 'gluetun'], ['test', 'worker']).split('the country specified is not valid').length - 1;
    const refusedBefore = refusals();
    await savedVpnWritten({ kind: 'protonvpn', wireguardPrivateKey: 'wOEI9rqqbDwnN8/Bpp22sVz48T71vJ4fYmFWujulwUU=', serverCountries: ['Atlantis'] });
    await waitFor('gluetun stopped on the country', async () => (gluetunRunning() ? undefined : true), 60_000, 1_000);
    const stoppedAt = Date.now();
    await waitFor('the outage seen', async () => ((await vpnState()) !== 'up' ? true : undefined), 120_000, 1_000);
    expect(workerReachesOutside()).toBe(true);
    expect(gluetunRunning()).toBe(false);
    expect(qbittorrentNamespaceReachesOutside()).toBe(false);

    await waitFor('gluetun tried again', async () => (refusals() >= refusedBefore + 2 ? true : undefined), 120_000, 1_000);
    expect(Date.now() - stoppedAt).toBeGreaterThanOrEqual(50_000);
    expect(containerId('gluetun')).toBe(containers.gluetun);

    await savedVpnReachesGluetun({ kind: 'wireguardFile', wireguardConf: conf });
    expect(qbittorrentNamespaceReachesOutside()).toBe(false);
    await vpnUp('after the fix');
    expect(qbittorrentApi<string>('app/version')).toMatch(/^v?5\.3\.0/);
    await qbittorrentConnected();
    expect({ gluetun: containerId('gluetun'), qbittorrent: containerId('qbittorrent') }).toEqual(containers);
  });
});

describe('OpenVPN', () => {
  test('an OpenVPN file reaches gluetun without compose, and the VPN is up through the OpenVPN server', async () => {
    const gluetunBefore = containerId('gluetun');
    await savedVpnReachesGluetun({ kind: 'openvpnFile', openvpnConf: openvpnClientConf() });
    expect(vpnFiles()).toEqual(['custom.ovpn', 'gluetun.env']);
    expect(containerId('gluetun')).toBe(gluetunBefore);
    // The exit IP is what the web seed saw: the OpenVPN server's address on its network, not the WireGuard server's.
    const row = await vpnUp('through OpenVPN', { exitIp: `${VPN_NET.far}.201`, timeoutMs: 420_000 });
    expect(row.vpn).toMatchObject({ layoutWithoutChoice: false, port: { kind: 'none' } });
    expect(qbittorrentApi<string>('app/version')).toMatch(/^v?5\.3\.0/);
  });

  test('the OpenVPN server unreachable: the VPN goes down and vpnDown opens, never up in between', async () => {
    blockOpenvpnServer(true);
    const blockedAt = Date.now();
    const seen: { s: number; state: string; status: string; health: number; publicIp: string }[] = [];
    await waitFor(
      'the VPN down',
      async () => {
        const state = (await vpnState())!;
        const status = /"status":"(\w+)"/.exec(gluetunApi('/v1/vpn/status').body)?.[1] ?? '?';
        const health = gluetunApi('/', { key: false, port: 9999 }).status;
        const publicIp = /"public_ip":"([^"]*)"/.exec(gluetunApi('/v1/publicip/ip').body)?.[1] ?? '?';
        seen.push({ s: Math.round((Date.now() - blockedAt) / 1000), state, status, health, publicIp });
        return state === 'down' ? true : undefined;
      },
      600_000,
      2_000,
    );
    // For the report: what gluetun answered meanwhile (on a real install, `running`/`crashed` with health 200).
    console.log(`vpn e2e, OpenVPN blocked: ${JSON.stringify(seen)}`);
    const firstNotUp = seen.findIndex((reading) => reading.state !== 'up');
    expect(seen.slice(firstNotUp).map((reading) => reading.state)).not.toContain('up');
    expect(vpnIssues().find((issue) => issue.state === 'open')).toMatchObject({ detail: expect.stringMatching(/tunnel is down/) });
  });

  test('recovery: the server reachable again, the VPN up after the stable window, and vpnDown resolves', async () => {
    blockOpenvpnServer(false);
    await vpnUp('again', { timeoutMs: 420_000 });
    expect(vpnIssues().every((issue) => issue.state === 'resolved')).toBe(true);
    expect(qbittorrentApi<string>('app/version')).toMatch(/^v?5\.3\.0/);
  });
});

describe("Coolify's layout: compose runs from another folder than the install's, with the vpn/ bind absolute", () => {
  test('a redeploy: gluetun starts with the settings the app wrote, which compose itself cannot find', async () => {
    const deployDir = deployLikeCoolify();
    expect(existsSync(join(deployDir, 'vpn/gluetun.env'))).toBe(false);
    expect(readdirSync(deployDir)).toEqual([]);
    expect(gluetunProcessEnv()).toContain('OPENVPN_CUSTOM_CONFIG=/vpn/custom.ovpn\n');
    await vpnUp('through OpenVPN', { exitIp: `${VPN_NET.far}.201`, timeoutMs: 420_000 });
    expect(qbittorrentApi<string>('app/version')).toMatch(/^v?5\.3\.0/);
  });

  test('a VPN change in Settings reaches gluetun without a redeploy', async () => {
    const gluetunBefore = containerId('gluetun');
    await savedVpnReachesGluetun({ kind: 'wireguardFile', wireguardConf: conf });
    expect(containerId('gluetun')).toBe(gluetunBefore);
    await vpnUp('through WireGuard', { exitIp: `${VPN_NET.far}.200`, timeoutMs: 420_000 });
    await qbittorrentConnected();
  });
});

describe('an install upgraded from 100.0.2, whose worker wrote vpn/ and whose compose read gluetun.env on the host', () => {
  beforeAll(async () => {
    await down();
    useRelease(await publishedRelease('100.0.2'));
    d = await up(VPN_STACK);
    startWorker('worker');
    conf = await wireguardPeerConf();
  }, 900_000);

  test('on 100.0.2: a WireGuard file saved, the VPN layout switched to, and the VPN up', async () => {
    await waitFor('qBittorrent applied', async () => ((await qbittorrentRow())?.config === 'applied' ? true : undefined));
    await mutation('api/downloadClients:saveVpn', { input: { kind: 'wireguardFile', wireguardConf: conf } });
    await waitFor('vpn/ written by the 100.0.2 worker', async () => (vpnFiles().includes('gluetun.env') ? true : undefined), 120_000, 500);
    expect(exec('worker', ['stat', '-c', '%a', '/vpn/gluetun.env']).trim()).toBe('644');
    switchToVpnLayout();
    await vpnUp('on 100.0.2');
  });

  test("`docker compose up -d` with this release's files: gluetun loads vpn/ itself, the worker makes gluetun.env 0600, and qBittorrent keeps a network", async () => {
    const gluetunBefore = containerId('gluetun');
    const settings = exec('worker', ['cat', '/vpn/gluetun.env']);
    useRelease();
    switchToVpnLayout();
    expect(containerId('gluetun')).not.toBe(gluetunBefore);
    expect(filesHash(gluetunProcessEnv())).toBe(filesHash(settings));
    await vpnUp('after the upgrade');
    await waitFor(
      'gluetun.env 0600',
      async () => (exec('worker', ['stat', '-c', '%a', '/vpn/gluetun.env']).trim() === '600' ? true : undefined),
      120_000,
      1_000,
    );
    expect(qbittorrentApi<string>('app/version')).toMatch(/^v?5\.3\.0/);
    await qbittorrentConnected();
  });
});
