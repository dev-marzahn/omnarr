import { describe, expect, test } from 'vite-plus/test';

import { ClientStatusReport, DesiredClientConfig, DownloadClientsDetail } from '../src/downloadClients.ts';
import { DEFAULT_SEED_GOAL } from '../src/seedGoal.ts';
import { mergeVpnSettings, PortState, validateWireguardConf, VpnRuntime, VpnSettings, VpnSettingsInput } from '../src/vpn.ts';

const WG_CONF = [
  '[Interface]',
  'Address = 10.13.13.2',
  'PrivateKey = yNXQh+Iuwzh25tKbd0Qo69oi4AERzaASvcUUM6Z9pGw=',
  '',
  '[Peer]',
  'PublicKey = v6EdhFZnh/mn/hw2eh1D+pF6YIJGiVVdnMuVdzB+7hQ=',
  'Endpoint = 10.213.1.200:51820',
  'AllowedIPs = 0.0.0.0/0',
].join('\n');

describe('validateWireguardConf', () => {
  test('a config with a PrivateKey and an Endpoint at an IP address passes', () => {
    expect(validateWireguardConf(WG_CONF)).toEqual({ ok: true });
  });

  test('an IPv6 endpoint in brackets passes', () => {
    expect(validateWireguardConf(WG_CONF.replace('10.213.1.200:51820', '[2001:db8::1]:51820'))).toEqual({ ok: true });
  });

  test('a hostname endpoint is refused, since gluetun’s custom WireGuard doesn’t resolve names', () => {
    expect(validateWireguardConf(WG_CONF.replace('10.213.1.200', 'nl-01.vpn.example'))).toEqual({
      ok: false,
      message: 'The [Peer] Endpoint must be an IP address, not a hostname: the VPN container doesn’t resolve names for it.',
    });
  });

  test('a missing PrivateKey is refused', () => {
    expect(validateWireguardConf(WG_CONF.replace(/^PrivateKey.*$/m, ''))).toEqual({ ok: false, message: 'The config has no [Interface] PrivateKey.' });
  });

  test('a PrivateKey under [Peer] doesn’t count', () => {
    const moved = WG_CONF.replace(/^PrivateKey.*\n/m, '').replace('[Peer]', '[Peer]\nPrivateKey = yNXQh+Iuwzh25tKbd0Qo69oi4AERzaASvcUUM6Z9pGw=');
    expect(validateWireguardConf(moved).ok).toBe(false);
  });

  test('a missing Endpoint is refused', () => {
    expect(validateWireguardConf(WG_CONF.replace(/^Endpoint.*$/m, ''))).toEqual({ ok: false, message: 'The config has no [Peer] Endpoint.' });
  });

  test('section and key names are matched without regard to case and spacing, as wg-quick does', () => {
    expect(validateWireguardConf(WG_CONF.replace('[Interface]', '[interface]').replace('PrivateKey = ', 'privatekey=')).ok).toBe(true);
  });
});

describe('VpnSettingsInput, saveVpn’s input', () => {
  test('each kind takes its own fields', () => {
    expect(VpnSettingsInput.parse({ kind: 'wireguardFile', wireguardConf: WG_CONF })).toEqual({ kind: 'wireguardFile', wireguardConf: WG_CONF });
    expect(VpnSettingsInput.parse({ kind: 'openvpnFile', openvpnConf: 'client', username: 'u', password: 'p' })).toMatchObject({ kind: 'openvpnFile' });
    expect(VpnSettingsInput.parse({ kind: 'protonvpn', wireguardPrivateKey: 'k', serverCountries: ['Netherlands'] })).toMatchObject({ kind: 'protonvpn' });
    expect(VpnSettingsInput.parse({ kind: 'pia', username: 'p1234567', password: 'p', serverCountries: ['DE Berlin'] })).toMatchObject({ kind: 'pia' });
  });

  test('a field another kind owns is refused', () => {
    expect(() => VpnSettingsInput.parse({ kind: 'wireguardFile', wireguardConf: WG_CONF, username: 'u' })).toThrow();
    expect(() => VpnSettingsInput.parse({ kind: 'pia', wireguardPrivateKey: 'k' })).toThrow();
  });

  test('the static forwarded port is a port number', () => {
    expect(VpnSettingsInput.parse({ kind: 'wireguardFile', staticForwardedPort: 51413 })).toMatchObject({ staticForwardedPort: 51413 });
    expect(() => VpnSettingsInput.parse({ kind: 'wireguardFile', staticForwardedPort: 0 })).toThrow();
    expect(() => VpnSettingsInput.parse({ kind: 'wireguardFile', staticForwardedPort: 70_000 })).toThrow();
  });
});

describe('mergeVpnSettings: a secret left out keeps the stored one', () => {
  const stored: VpnSettings = { kind: 'pia', username: 'p1234567', password: 'old', serverCountries: ['DE Berlin'], savedAt: 1 };

  test('the same kind without its secrets keeps them, and takes the new countries', () => {
    expect(mergeVpnSettings({ kind: 'pia', serverCountries: ['Netherlands'] }, stored, 2)).toEqual({
      ok: true,
      settings: { kind: 'pia', username: 'p1234567', password: 'old', serverCountries: ['Netherlands'], savedAt: 2 },
    });
  });

  test('a new secret replaces the stored one', () => {
    expect(mergeVpnSettings({ kind: 'pia', password: 'new' }, stored, 2)).toMatchObject({ ok: true, settings: { username: 'p1234567', password: 'new' } });
  });

  test('another kind keeps nothing of the stored one, and needs its own secrets', () => {
    expect(mergeVpnSettings({ kind: 'protonvpn' }, stored, 2)).toEqual({ ok: false, message: 'ProtonVPN needs its WireGuard private key.' });
    expect(mergeVpnSettings({ kind: 'protonvpn', wireguardPrivateKey: 'k' }, stored, 2)).toEqual({
      ok: true,
      settings: { kind: 'protonvpn', wireguardPrivateKey: 'k', savedAt: 2 },
    });
  });

  test.each([
    [{ kind: 'wireguardFile' } as const, 'A WireGuard config file is needed.'],
    [{ kind: 'openvpnFile' } as const, 'An OpenVPN config file is needed.'],
    [{ kind: 'pia', username: 'p1' } as const, 'PIA needs its username and password.'],
  ])('a kind without its secret is refused: %o', (input, message) => {
    expect(mergeVpnSettings(input, undefined, 2)).toEqual({ ok: false, message });
  });

  test('a WireGuard config is checked, whether new or kept', () => {
    expect(mergeVpnSettings({ kind: 'wireguardFile', wireguardConf: WG_CONF.replace('10.213.1.200', 'vpn.example') }, undefined, 2)).toMatchObject({
      ok: false,
    });
    expect(mergeVpnSettings({ kind: 'wireguardFile', staticForwardedPort: 51413 }, { kind: 'wireguardFile', wireguardConf: WG_CONF, savedAt: 1 }, 2)).toEqual({
      ok: true,
      settings: { kind: 'wireguardFile', wireguardConf: WG_CONF, staticForwardedPort: 51413, savedAt: 2 },
    });
  });

  test('blank countries are dropped, and an empty list is no filter', () => {
    expect(mergeVpnSettings({ kind: 'pia', serverCountries: [' ', ''] }, stored, 2)).toEqual({
      ok: true,
      settings: { kind: 'pia', username: 'p1234567', password: 'old', savedAt: 2 },
    });
  });
});

describe('the VPN runtime', () => {
  test('a state with its port state', () => {
    const runtime = { state: 'up', layoutWithoutChoice: false, publicIp: '203.0.113.7', port: { kind: 'forwarded', port: 51413 }, checkedAt: 5 };
    expect(VpnRuntime.parse(runtime)).toEqual(runtime);
    expect(PortState.parse({ kind: 'none' })).toEqual({ kind: 'none' });
    expect(() => VpnRuntime.parse({ ...runtime, state: 'running' })).toThrow();
  });

  test('desired carries qBittorrent’s VPN settings with their secrets, and a report the VPN runtime', () => {
    const vpn = { kind: 'wireguardFile', wireguardConf: WG_CONF, savedAt: 1 };
    const desired = { kind: 'qbittorrent', clientId: 'c2', enabled: true, configVersion: 2, qbittorrent: { seedGoal: DEFAULT_SEED_GOAL, vpn } };
    expect(DesiredClientConfig.parse(desired)).toEqual(desired);
    const report = { kind: 'qbittorrent', reachable: true, vpn: { state: 'notActive', layoutWithoutChoice: false, port: { kind: 'none' }, checkedAt: 3 } };
    expect(ClientStatusReport.parse(report)).toEqual(report);
  });
});

describe('DownloadClientsDetail’s VPN part', () => {
  const usenet = { enabled: false, hasPassword: false, configVersion: 0, config: 'pending', backupServers: [] };
  const torrents = { enabled: true, seedGoal: DEFAULT_SEED_GOAL, configVersion: 1, config: 'pending' };
  const vpn = { kind: 'pia', serverCountries: ['DE Berlin'], savedAt: 4, hasVpnConfig: false, hasVpnCredentials: true };

  test('carries the choice and flags, never a secret', () => {
    expect(DownloadClientsDetail.parse({ usenet, torrents, vpn })).toEqual({ usenet, torrents, vpn });
    expect(DownloadClientsDetail.parse({ usenet, torrents, vpn: { hasVpnConfig: false, hasVpnCredentials: false } })).toBeTruthy();
  });

  test.each(['wireguardConf', 'openvpnConf', 'username', 'password', 'wireguardPrivateKey', 'apiKey'])('rejects %s', (key) => {
    expect(() => DownloadClientsDetail.parse({ usenet, torrents, vpn: { ...vpn, [key]: 'x' } })).toThrow();
  });
});
