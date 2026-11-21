// The VPN on the real stack: gluetun v3.41.3 against a test WireGuard
// server (linuxserver/wireguard), with qBittorrent in gluetun's network
// namespace and the web seed reachable only through the tunnel
// (compose.wireguard.test.yml).
//
//   1. the VPN chosen in the direct layout: a WireGuard config saved through saveVpn;
//      the worker writes vpn/, binds qBittorrent to tun0, reports notActive;
//      vpnDown opens with the .env step, and torrent submits wait (vpnWait);
//   2. the user's step (compose.vpn.yml, `docker compose up -d`): the worker
//      reaches qBittorrent at gluetun:8080 and the control API with the
//      generated key, a request without it is refused; up resolves vpnDown and
//      wakes the waiting submits;
//   3. S01E01 downloads through the tunnel;
//   4. the WireGuard server stops: vpnDown opens, the trickling S01E04 moves
//      no byte, and its stall clock stays paused past the stall time;
//   5. the server starts again: vpnDown resolves and S01E04 moves again;
//   6. gluetun is recreated by a changed VPN file, and qBittorrent keeps a
//      network;
//   7. OpenVPN: an OpenVPN file against the test OpenVPN server, with
//      `tls-exit` as gluetun's built-in providers have it; the server is
//      blocked both ways and the VPN goes down, never up in between, then
//      comes back.
import { makeFunctionReference } from 'convex/server';
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test';

import { vpnCatalogue } from './fakes/torrent/catalogue.ts';
import {
  blockOpenvpnServer,
  compose,
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

let d: Deployment;
let conf: string;

const qbittorrentRow = async () => (await query('api/system:status')).clients.find((client: { clientKind: string }) => client.clientKind === 'qbittorrent');
const vpnState = async (): Promise<string | undefined> => (await qbittorrentRow())?.vpn?.state;
const vpnIssues = () => rows<Row>(d.env, 'issues').filter((issue) => issue.failureCode === 'vpnDown');
const torrent = (guid: string) => qbittorrentApi<TorrentInfo[]>('torrents/info').find((info) => info.hash === hashOf(guid));
const containerId = (service: string) => compose(['ps', '-q', service], ['test', 'worker']).trim();

beforeAll(async () => {
  d = await up({ layout: 'wireguard', torrents: { seedGoal: { seedTimeMs: 120 * MINUTE } }, torrentStallMs: STALL_MS });
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
    await waitFor('the VPN up', async () => ((await vpnState()) === 'up' ? true : undefined), 300_000, 1_000);

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
    await waitFor('the VPN up again', async () => ((await vpnState()) === 'up' ? true : undefined), 420_000, 1_000);
    expect(vpnIssues().every((issue) => issue.state === 'resolved')).toBe(true);
  });

  test('a changed VPN file recreates gluetun on `docker compose up -d`, and qBittorrent keeps a network', async () => {
    const gluetunBefore = containerId('gluetun');
    const envBefore = exec('worker', ['cat', '/vpn/gluetun.env']);
    await mutation('api/downloadClients:saveVpn', { input: { kind: 'wireguardFile', wireguardConf: `${conf}\n# rotated\n` } });
    await waitFor('gluetun.env rewritten', async () => (exec('worker', ['cat', '/vpn/gluetun.env']) !== envBefore ? true : undefined), 120_000, 500);
    compose(['up', '-d', '--wait'], ['test', 'worker']);
    expect(containerId('gluetun')).not.toBe(gluetunBefore);
    await waitFor('the VPN up after the recreate', async () => ((await vpnState()) === 'up' ? true : undefined), 300_000, 1_000);
    expect(qbittorrentApi<string>('app/version')).toMatch(/^v?5\.3\.0/);
    expect(torrent('hl-t-s01e01')).toBeDefined();
  });
});

describe('OpenVPN', () => {
  test('an OpenVPN file: `docker compose up -d` recreates gluetun, and the VPN is up through the OpenVPN server', async () => {
    const envBefore = exec('worker', ['cat', '/vpn/gluetun.env']);
    await mutation('api/downloadClients:saveVpn', { input: { kind: 'openvpnFile', openvpnConf: openvpnClientConf() } });
    await waitFor('gluetun.env rewritten', async () => (exec('worker', ['cat', '/vpn/gluetun.env']) !== envBefore ? true : undefined), 120_000, 500);
    expect(vpnFiles()).toEqual(['custom.ovpn', 'gluetun.env']);
    compose(['up', '-d', '--wait'], ['test', 'worker']);
    // The exit IP is what the web seed saw: the OpenVPN server's address on its network, not the WireGuard server's.
    const row = await waitFor(
      'the VPN up through OpenVPN',
      async () => {
        const current = await qbittorrentRow();
        return current?.vpn?.state === 'up' && current.vpn.publicIp === `${VPN_NET.far}.201` ? current : undefined;
      },
      420_000,
      1_000,
    );
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
    await waitFor('the VPN up again', async () => ((await vpnState()) === 'up' ? true : undefined), 420_000, 1_000);
    expect(vpnIssues().every((issue) => issue.state === 'resolved')).toBe(true);
    expect(qbittorrentApi<string>('app/version')).toMatch(/^v?5\.3\.0/);
  });
});
