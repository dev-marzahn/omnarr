// The `vpn/` files: gluetun.env per kind, with no secret in
// it and a hash over the secret files, and the sync that writes each
// differing file with its mode and deletes the ones not used.
import { mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { VpnSettings } from '@omnarr/contracts';
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';

import { renderVpnFiles, syncVpnFiles } from '../src/vpn/files.ts';

const WG_CONF = '[Interface]\nPrivateKey = planted-wg-key\nAddress = 10.13.13.2\n\n[Peer]\nPublicKey = pub\nEndpoint = 10.213.1.200:51820\n';
const settings = (patch: Partial<VpnSettings> & Pick<VpnSettings, 'kind'>): VpnSettings => ({ savedAt: 1, ...patch });
/** gluetun.env's lines, without the comment, the hash and the interface name (tested on its own). */
const env = (files: Record<string, string>) =>
  files['gluetun.env']!.split('\n').filter(
    (line) => line && !line.startsWith('#') && !line.startsWith('OMNARR_VPN_FILES_HASH=') && line !== 'VPN_INTERFACE=tun0',
  );
const hashOf = (files: Record<string, string>) => /^OMNARR_VPN_FILES_HASH=([0-9a-f]{64})$/m.exec(files['gluetun.env']!)?.[1];

describe('renderVpnFiles', () => {
  test('a WireGuard file: the custom provider reading wg0.conf', () => {
    const files = renderVpnFiles(settings({ kind: 'wireguardFile', wireguardConf: WG_CONF }));
    expect(Object.keys(files).sort()).toEqual(['gluetun.env', 'wg0.conf']);
    expect(files['wg0.conf']).toBe(WG_CONF);
    expect(env(files)).toEqual(['VPN_SERVICE_PROVIDER=custom', 'VPN_TYPE=wireguard', 'WIREGUARD_CONF_SECRETFILE=/vpn/wg0.conf']);
  });

  test('an OpenVPN file with credentials', () => {
    const files = renderVpnFiles(
      settings({ kind: 'openvpnFile', openvpnConf: 'client\nremote 198.51.100.1 1194\n', username: 'u', password: 'planted-ovpn-pass' }),
    );
    expect(Object.keys(files).sort()).toEqual(['custom.ovpn', 'gluetun.env', 'openvpn_password', 'openvpn_user']);
    expect(files.openvpn_user).toBe('u');
    expect(env(files)).toEqual([
      'VPN_SERVICE_PROVIDER=custom',
      'VPN_TYPE=openvpn',
      'OPENVPN_CUSTOM_CONFIG=/vpn/custom.ovpn',
      'OPENVPN_USER_SECRETFILE=/vpn/openvpn_user',
      'OPENVPN_PASSWORD_SECRETFILE=/vpn/openvpn_password',
    ]);
  });

  test('an OpenVPN file without credentials writes no credential files', () => {
    const files = renderVpnFiles(settings({ kind: 'openvpnFile', openvpnConf: 'client\n' }));
    expect(Object.keys(files).sort()).toEqual(['custom.ovpn', 'gluetun.env']);
  });

  test('ProtonVPN: WireGuard with the private key, port forwarding, the countries', () => {
    const files = renderVpnFiles(settings({ kind: 'protonvpn', wireguardPrivateKey: 'planted-proton-key', serverCountries: ['Netherlands', 'Switzerland'] }));
    expect(Object.keys(files).sort()).toEqual(['gluetun.env', 'wireguard_private_key']);
    expect(env(files)).toEqual([
      'VPN_SERVICE_PROVIDER=protonvpn',
      'VPN_TYPE=wireguard',
      'WIREGUARD_PRIVATE_KEY_SECRETFILE=/vpn/wireguard_private_key',
      'VPN_PORT_FORWARDING=on',
      'SERVER_COUNTRIES=Netherlands,Switzerland',
    ]);
  });

  test('PIA: OpenVPN with the credentials, port forwarding, and its regions (PIA has no countries)', () => {
    const files = renderVpnFiles(settings({ kind: 'pia', username: 'p1234567', password: 'planted-pia-pass', serverCountries: ['DE Berlin'] }));
    expect(Object.keys(files).sort()).toEqual(['gluetun.env', 'openvpn_password', 'openvpn_user']);
    expect(env(files)).toEqual([
      'VPN_SERVICE_PROVIDER=private internet access',
      'VPN_TYPE=openvpn',
      'OPENVPN_USER_SECRETFILE=/vpn/openvpn_user',
      'OPENVPN_PASSWORD_SECRETFILE=/vpn/openvpn_password',
      'VPN_PORT_FORWARDING=on',
      'SERVER_REGIONS=DE Berlin',
    ]);
  });

  test.each([
    settings({ kind: 'wireguardFile', wireguardConf: WG_CONF }),
    settings({ kind: 'openvpnFile', openvpnConf: 'client\n' }),
    settings({ kind: 'protonvpn', wireguardPrivateKey: 'k' }),
    settings({ kind: 'pia', username: 'u', password: 'p' }),
  ])('every kind names the tunnel tun0, the interface qBittorrent binds to (gluetun names WireGuard’s wg0): $kind', (vpn) => {
    expect(renderVpnFiles(vpn)['gluetun.env']!.split('\n')).toContain('VPN_INTERFACE=tun0');
  });

  test('a static forwarded port opens it through gluetun’s firewall', () => {
    expect(env(renderVpnFiles(settings({ kind: 'wireguardFile', wireguardConf: WG_CONF, staticForwardedPort: 51413 })))).toContain(
      'FIREWALL_VPN_INPUT_PORTS=51413',
    );
  });

  test.each([
    settings({ kind: 'wireguardFile', wireguardConf: WG_CONF }),
    settings({ kind: 'openvpnFile', openvpnConf: 'client\n', username: 'u', password: 'planted-ovpn-pass' }),
    settings({ kind: 'protonvpn', wireguardPrivateKey: 'planted-proton-key' }),
    settings({ kind: 'pia', username: 'p1234567', password: 'planted-pia-pass' }),
  ])('gluetun.env holds no secret: $kind', (vpn) => {
    const text = renderVpnFiles(vpn)['gluetun.env']!;
    for (const secret of ['planted-wg-key', 'planted-ovpn-pass', 'planted-proton-key', 'planted-pia-pass', 'p1234567']) expect(text).not.toContain(secret);
  });

  test('the hash changes with a secret file, so compose recreates gluetun; the save time doesn’t change it', () => {
    const one = renderVpnFiles(settings({ kind: 'wireguardFile', wireguardConf: WG_CONF }));
    const again = renderVpnFiles(settings({ kind: 'wireguardFile', wireguardConf: WG_CONF, savedAt: 99 }));
    const other = renderVpnFiles(settings({ kind: 'wireguardFile', wireguardConf: WG_CONF.replace('planted-wg-key', 'another-key') }));
    expect(hashOf(one)).toMatch(/^[0-9a-f]{64}$/);
    expect(hashOf(again)).toBe(hashOf(one));
    expect(hashOf(other)).not.toBe(hashOf(one));
  });

  test('a line break in a country can’t add a variable', () => {
    expect(env(renderVpnFiles(settings({ kind: 'protonvpn', wireguardPrivateKey: 'k', serverCountries: ['Netherlands\nFIREWALL=off'] })))).toContain(
      'SERVER_COUNTRIES=NetherlandsFIREWALL=off',
    );
  });
});

describe('syncVpnFiles', () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'omnarr-vpn-'));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));
  const mode = (name: string) => statSync(join(dir, name)).mode & 0o777;

  test('writes gluetun.env 0644 and the secret files 0600', async () => {
    const files = renderVpnFiles(settings({ kind: 'pia', username: 'p1', password: 'pw' }));
    expect(await syncVpnFiles(dir, files)).toEqual({ changed: true });
    expect(readdirSync(dir).sort()).toEqual(['gluetun.env', 'openvpn_password', 'openvpn_user']);
    expect([mode('gluetun.env'), mode('openvpn_user'), mode('openvpn_password')]).toEqual([0o644, 0o600, 0o600]);
    expect(readFileSync(join(dir, 'openvpn_password'), 'utf8')).toBe('pw');
  });

  test('the same files again change nothing', async () => {
    const files = renderVpnFiles(settings({ kind: 'wireguardFile', wireguardConf: WG_CONF }));
    await syncVpnFiles(dir, files);
    expect(await syncVpnFiles(dir, files)).toEqual({ changed: false });
  });

  test('a file of another kind is deleted; a file the platform doesn’t own stays', async () => {
    writeFileSync(join(dir, 'notes.txt'), 'mine');
    await syncVpnFiles(dir, renderVpnFiles(settings({ kind: 'pia', username: 'p1', password: 'pw' })));
    await syncVpnFiles(dir, renderVpnFiles(settings({ kind: 'wireguardFile', wireguardConf: WG_CONF })));
    expect(readdirSync(dir).sort()).toEqual(['gluetun.env', 'notes.txt', 'wg0.conf']);
  });

  test('deleteAll removes every platform file ("No VPN" in the base layout)', async () => {
    await syncVpnFiles(dir, renderVpnFiles(settings({ kind: 'wireguardFile', wireguardConf: WG_CONF })));
    expect(await syncVpnFiles(dir, null)).toEqual({ changed: true });
    expect(readdirSync(dir)).toEqual([]);
    expect(await syncVpnFiles(dir, null)).toEqual({ changed: false });
  });

  test('a mode someone changed is set back', async () => {
    const files = renderVpnFiles(settings({ kind: 'wireguardFile', wireguardConf: WG_CONF }));
    await syncVpnFiles(dir, files);
    const { chmodSync } = await import('node:fs');
    chmodSync(join(dir, 'wg0.conf'), 0o644);
    expect(await syncVpnFiles(dir, files)).toEqual({ changed: true });
    expect(mode('wg0.conf')).toBe(0o600);
  });

  test('a missing folder with nothing to delete is no change', async () => {
    expect(await syncVpnFiles(join(dir, 'absent'), null)).toEqual({ changed: false });
  });
});
