// The VPN choice and its Issue: `saveVpn`
// keeps stored secrets and checks a WireGuard config, `get` shows only flags,
// `desired` hands the settings to the reconciler, and the worker's VPN state
// raises and resolves `vpnDown`. A torrent submit waits on `vpnWait` without
// counting an attempt, and the transition to `up` wakes it.
import { DEFAULT_LIMITS, type VpnRuntime, type VpnSettingsInput } from '@omnarr/contracts';
import { beforeEach, describe, expect, test, vi } from 'vite-plus/test';

import { api } from '../convex/_generated/api';
import type { FakeWorker } from './fakeWorker';
import { E1_RELEASES, pipelineHarness } from './harness';

const h = pipelineHarness();
let w: FakeWorker;

beforeEach(async () => {
  w = await h.worker();
});

const WG_KEY = 'planted-wg-private-key-7f3a';
const WG_CONF = `[Interface]\nAddress = 10.13.13.2\nPrivateKey = ${WG_KEY}\n\n[Peer]\nPublicKey = pub\nEndpoint = 10.213.1.200:51820\nAllowedIPs = 0.0.0.0/0\n`;
const PIA_PASSWORD = 'planted-pia-password-c41d';

const get = () => h.admin.query(api.api.downloadClients.get, {});
const saveVpn = (input: VpnSettingsInput | null) => h.admin.mutation(api.api.downloadClients.saveVpn, { input });
const qbittorrent = async () => (await h.all('downloadClients')).find((row) => row.kind === 'qbittorrent');
const runtime = (state: VpnRuntime['state'], extra: Partial<VpnRuntime> = {}): VpnRuntime => ({
  state,
  layoutWithoutChoice: false,
  port: { kind: 'none' },
  checkedAt: Date.now(),
  ...extra,
});
const reportVpn = (vpn: VpnRuntime) => w.reportClients([{ kind: 'qbittorrent', reachable: true, vpn }]);
const vpnIssues = async () => (await h.all('issues')).filter((issue) => issue.failureCode === 'vpnDown');

describe('downloadClients.saveVpn', () => {
  test('the first save creates the qBittorrent row with torrents on, at configVersion 1, and the choice', async () => {
    await saveVpn({ kind: 'wireguardFile', wireguardConf: WG_CONF });
    expect(await qbittorrent()).toMatchObject({ enabled: true, configVersion: 1, vpn: { kind: 'wireguardFile', wireguardConf: WG_CONF } });
  });

  test('a change raises configVersion; the same choice again changes nothing', async () => {
    await saveVpn({ kind: 'wireguardFile', wireguardConf: WG_CONF });
    await saveVpn({ kind: 'wireguardFile', staticForwardedPort: 51413 });
    expect((await qbittorrent())!.configVersion).toBe(2);
    await saveVpn({ kind: 'wireguardFile', staticForwardedPort: 51413 });
    expect((await qbittorrent())!.configVersion).toBe(2);
  });

  test('a save without the config keeps the stored one', async () => {
    await saveVpn({ kind: 'wireguardFile', wireguardConf: WG_CONF });
    await saveVpn({ kind: 'wireguardFile', staticForwardedPort: 51413 });
    expect((await qbittorrent())!.vpn).toMatchObject({ wireguardConf: WG_CONF, staticForwardedPort: 51413 });
  });

  test('a WireGuard config with a hostname endpoint is refused with the reason', async () => {
    await expect(saveVpn({ kind: 'wireguardFile', wireguardConf: WG_CONF.replace('10.213.1.200', 'vpn.example') })).rejects.toThrow(/must be an IP address/);
    expect(await qbittorrent()).toBeUndefined();
  });

  test('a kind without its secret is refused', async () => {
    await expect(saveVpn({ kind: 'pia', username: 'p1234567' })).rejects.toThrow(/username and password/);
  });

  test('"No VPN" clears the choice and raises configVersion; with no choice it changes nothing', async () => {
    await saveVpn(null);
    expect(await qbittorrent()).toBeUndefined();
    await saveVpn({ kind: 'pia', username: 'p1234567', password: PIA_PASSWORD });
    await saveVpn(null);
    const row = await qbittorrent();
    expect(row!.vpn).toBeUndefined();
    expect(row!.configVersion).toBe(2);
  });

  test('keeps the torrent settings saved before it', async () => {
    await h.admin.mutation(api.api.downloadClients.saveTorrents, { input: { enabled: false, seedGoal: { ratio: 1 } } });
    await saveVpn({ kind: 'pia', username: 'p1234567', password: PIA_PASSWORD });
    expect(await qbittorrent()).toMatchObject({ enabled: false, seedGoal: { ratio: 1 }, configVersion: 2 });
  });
});

describe('downloadClients.get, the VPN card', () => {
  test('without a choice: No VPN, nothing stored', async () => {
    expect((await get()).vpn).toEqual({ hasVpnConfig: false, hasVpnCredentials: false });
  });

  test('shows the kind, the countries and the flags, never a secret', async () => {
    await saveVpn({ kind: 'pia', username: 'p1234567', password: PIA_PASSWORD, serverCountries: ['DE Berlin'] });
    const detail = await get();
    expect(detail.vpn).toEqual({ kind: 'pia', serverCountries: ['DE Berlin'], savedAt: expect.any(Number), hasVpnConfig: false, hasVpnCredentials: true });
    expect(JSON.stringify(detail)).not.toContain(PIA_PASSWORD);
    expect(JSON.stringify(detail)).not.toContain('p1234567');
    await saveVpn({ kind: 'wireguardFile', wireguardConf: WG_CONF });
    expect((await get()).vpn).toMatchObject({ kind: 'wireguardFile', hasVpnConfig: true, hasVpnCredentials: false });
    expect(JSON.stringify(await get())).not.toContain(WG_KEY);
  });

  test('carries the worker’s last VPN reading', async () => {
    await saveVpn({ kind: 'wireguardFile', wireguardConf: WG_CONF });
    await reportVpn(runtime('up', { publicIp: '203.0.113.7', port: { kind: 'static', port: 51413 } }));
    expect((await get()).vpn.runtime).toMatchObject({ state: 'up', publicIp: '203.0.113.7', port: { kind: 'static', port: 51413 } });
  });
});

describe('desired', () => {
  test('carries the VPN settings with their secrets, for the reconciler', async () => {
    await saveVpn({ kind: 'wireguardFile', wireguardConf: WG_CONF });
    const entry = (await w.desiredClients()).find((desired) => desired.kind === 'qbittorrent');
    expect(entry!.qbittorrent).toMatchObject({ vpn: { kind: 'wireguardFile', wireguardConf: WG_CONF } });
  });
});

describe('vpnDown', () => {
  beforeEach(async () => {
    await saveVpn({ kind: 'wireguardFile', wireguardConf: WG_CONF });
  });

  test('a chosen VPN that isn’t active opens one system Issue with the step to take, and no fix action', async () => {
    await reportVpn(runtime('notActive'));
    const [issue] = await vpnIssues();
    expect(issue).toMatchObject({ scope: 'system', state: 'open', fixActions: [] });
    expect(issue!.detail).toContain('COMPOSE_FILE=compose.yml:compose.vpn.yml');
    expect(issue!.detail).toContain('docker compose up -d');
  });

  test('a tunnel down opens it with its own detail; up resolves it', async () => {
    await reportVpn(runtime('down'));
    expect((await vpnIssues())[0]).toMatchObject({ state: 'open', detail: expect.stringMatching(/tunnel is down/) });
    await reportVpn(runtime('up'));
    expect((await vpnIssues()).map((issue) => issue.state)).toEqual(['resolved']);
  });

  test('down while gluetun answers running and healthy but has no exit IP: the detail adds the restart step', async () => {
    await reportVpn(runtime('down', { exitIpMissing: true }));
    expect((await vpnIssues())[0]!.detail).toBe(
      'The VPN tunnel is down. qBittorrent moves no traffic until it is back, and torrent downloads wait. If the tunnel works, run docker compose restart gluetun.',
    );
  });

  test('a real outage has no restart step, and loses it when a later reading shows one', async () => {
    await reportVpn(runtime('down'));
    expect((await vpnIssues())[0]!.detail).not.toContain('restart gluetun');
    await reportVpn(runtime('down', { exitIpMissing: true }));
    await reportVpn(runtime('down'));
    expect((await vpnIssues()).map((issue) => [issue.state, issue.detail?.includes('restart gluetun')])).toEqual([['open', false]]);
  });

  test('connecting leaves the Issue as it is', async () => {
    await reportVpn(runtime('connecting'));
    expect(await vpnIssues()).toEqual([]);
    await reportVpn(runtime('down'));
    await reportVpn(runtime('connecting'));
    expect((await vpnIssues()).map((issue) => issue.state)).toEqual(['open']);
  });

  test('off, after the user switched back, resolves it', async () => {
    await reportVpn(runtime('notActive'));
    await saveVpn(null);
    await reportVpn(runtime('off'));
    expect((await vpnIssues()).map((issue) => issue.state)).toEqual(['resolved']);
  });

  test('a repeated down stays one Issue', async () => {
    await reportVpn(runtime('down'));
    await reportVpn(runtime('down', { checkedAt: Date.now() + 30_000 }));
    expect(await vpnIssues()).toHaveLength(1);
  });

  test('the reading lands on the System page’s qBittorrent row', async () => {
    await reportVpn(runtime('up', { publicIp: '203.0.113.7', port: { kind: 'forwarded', port: 40123 } }));
    const row = (await h.admin.query(api.api.system.status, {})).clients.find((client) => client.clientKind === 'qbittorrent');
    expect(row!.vpn).toEqual({ state: 'up', layoutWithoutChoice: false, publicIp: '203.0.113.7', port: { kind: 'forwarded', port: 40123 } });
  });
});

describe('vpnWait', () => {
  beforeEach(async () => {
    await saveVpn({ kind: 'wireguardFile', wireguardConf: WG_CONF });
    await h.indexer(E1_RELEASES);
    await h.subscribe();
  });

  test('a submit that fails vpnDown waits vpnWaitRetryMs without counting an attempt or raising an Issue of its own', async () => {
    const [job] = await w.claim('download.submit');
    await w.fail(job!, 'vpnDown', 'A VPN is chosen and it is not up.');
    const row = await h.get(job!.jobId);
    expect(row).toMatchObject({ status: 'waiting', attempt: 0, failureCode: 'vpnDown' });
    expect(Math.abs(row!.availableAt! - (Date.now() + DEFAULT_LIMITS.vpnWaitRetryMs))).toBeLessThan(1000);
    expect(await h.all('issues')).toEqual([]);
  });

  test("the e2e's OMNARR_TEST_LIMITS lowers the wait (vpnWaitRetryMs)", async () => {
    vi.stubEnv('OMNARR_TEST_LIMITS', '{"vpnWaitRetryMs":5000}');
    try {
      const [job] = await w.claim('download.submit');
      await w.fail(job!, 'vpnDown', 'A VPN is chosen and it is not up.');
      expect(Math.abs((await h.get(job!.jobId))!.availableAt! - (Date.now() + 5000))).toBeLessThan(1000);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  test('the transition to up resolves the Issue and wakes the waiting submits', async () => {
    const [job] = await w.claim('download.submit');
    await w.fail(job!, 'vpnDown', 'A VPN is chosen and it is not up.');
    await reportVpn(runtime('notActive'));
    await reportVpn(runtime('up'));
    expect((await h.get(job!.jobId))!.status).toBe('queued');
    expect(await w.claim('download.submit')).toHaveLength(1);
  });

  test('a job waiting for disk space isn’t woken by the VPN', async () => {
    const [job] = await w.claim('download.submit');
    await w.fail(job!, 'diskFull', 'Needs 1.5 GB.');
    await reportVpn(runtime('up'));
    expect((await h.get(job!.jobId))!.status).toBe('waiting');
  });
});
