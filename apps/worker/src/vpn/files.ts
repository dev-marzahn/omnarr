// The `vpn/` files gluetun starts from: `gluetun.env`, which
// the host's `docker compose` reads as gluetun's env_file, and the secret
// files gluetun reads through its `*_SECRETFILE` variables. The folder is a
// bind mount: `/vpn` in the worker (read-write) and in gluetun (read-only).
// Which variables each kind needs is in gluetun's provider documentation.
import { createHash } from 'node:crypto';
import { chmod, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { VpnSettings } from '@omnarr/contracts';

/** Where gluetun sees the folder (compose.vpn.yml mounts it at /vpn). */
const GLUETUN_DIR = '/vpn';

/** Every file the platform writes here; only these are ever deleted. */
const OWNED = ['gluetun.env', 'wg0.conf', 'custom.ovpn', 'openvpn_user', 'openvpn_password', 'wireguard_private_key'] as const;

const at = (name: string) => `${GLUETUN_DIR}/${name}`;
/** A user's value on one line: a line break would start another variable. */
const oneLine = (value: string) => value.replace(/[\r\n]/g, '');

/**
 * The files for a choice. `gluetun.env` holds no secret: the secrets are in
 * their own files, and `OMNARR_VPN_FILES_HASH` (a SHA-256 over them) makes a
 * new secret change `gluetun.env`, so `docker compose up -d` recreates
 * gluetun, whose resolved config doesn't include a bind-mounted file.
 */
export function renderVpnFiles(settings: VpnSettings): Record<string, string> {
  const secrets: Record<string, string> = {};
  const vars: string[] = [];
  const credentials = () => {
    if (settings.username === undefined || settings.password === undefined) return;
    secrets.openvpn_user = settings.username;
    secrets.openvpn_password = settings.password;
    vars.push(`OPENVPN_USER_SECRETFILE=${at('openvpn_user')}`, `OPENVPN_PASSWORD_SECRETFILE=${at('openvpn_password')}`);
  };
  switch (settings.kind) {
    case 'wireguardFile':
      secrets['wg0.conf'] = settings.wireguardConf ?? '';
      vars.push('VPN_SERVICE_PROVIDER=custom', 'VPN_TYPE=wireguard', `WIREGUARD_CONF_SECRETFILE=${at('wg0.conf')}`);
      break;
    case 'openvpnFile':
      secrets['custom.ovpn'] = settings.openvpnConf ?? '';
      vars.push('VPN_SERVICE_PROVIDER=custom', 'VPN_TYPE=openvpn', `OPENVPN_CUSTOM_CONFIG=${at('custom.ovpn')}`);
      credentials();
      break;
    case 'protonvpn':
      // WireGuard with the account's key; gluetun picks a port-forwarding server itself (PORT_FORWARD_ONLY defaults on).
      secrets.wireguard_private_key = settings.wireguardPrivateKey ?? '';
      vars.push('VPN_SERVICE_PROVIDER=protonvpn', 'VPN_TYPE=wireguard', `WIREGUARD_PRIVATE_KEY_SECRETFILE=${at('wireguard_private_key')}`);
      vars.push('VPN_PORT_FORWARDING=on');
      if (settings.serverCountries?.length) vars.push(`SERVER_COUNTRIES=${settings.serverCountries.map(oneLine).join(',')}`);
      break;
    case 'pia':
      // OpenVPN only in gluetun; PIA's servers have regions, not countries.
      vars.push('VPN_SERVICE_PROVIDER=private internet access', 'VPN_TYPE=openvpn');
      credentials();
      vars.push('VPN_PORT_FORWARDING=on');
      if (settings.serverCountries?.length) vars.push(`SERVER_REGIONS=${settings.serverCountries.map(oneLine).join(',')}`);
      break;
  }
  // qBittorrent binds to tun0 whenever a VPN is chosen; gluetun names a WireGuard tunnel wg0 unless told.
  vars.push('VPN_INTERFACE=tun0');
  if (settings.staticForwardedPort !== undefined) vars.push(`FIREWALL_VPN_INPUT_PORTS=${settings.staticForwardedPort}`);
  const hash = createHash('sha256');
  for (const name of Object.keys(secrets).sort()) hash.update(`${name}\0${secrets[name]}\0`);
  const env = [
    '# Written by the omnarr worker from Settings › Downloads; changes here are overwritten.',
    ...vars,
    `OMNARR_VPN_FILES_HASH=${hash.digest('hex')}`,
  ];
  return { 'gluetun.env': `${env.join('\n')}\n`, ...secrets };
}

const modeOf = (name: string) => (name === 'gluetun.env' ? 0o644 : 0o600);

async function current(path: string): Promise<{ content: string; mode: number } | undefined> {
  try {
    const [content, info] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
    return { content, mode: info.mode & 0o777 };
  } catch {
    return undefined;
  }
}

/**
 * Brings the folder in line with `files`: each differing file is
 * written with its mode (`gluetun.env` 0644, since the host reads it; the
 * secrets 0600), through a temporary name, so gluetun and compose never read
 * half a file; a platform file not in `files` is deleted. `null` deletes them
 * all: "No VPN" in the base layout.
 */
export async function syncVpnFiles(dir: string, files: Record<string, string> | null): Promise<{ changed: boolean }> {
  let changed = false;
  const wanted = files ?? {};
  for (const name of OWNED) {
    const path = join(dir, name);
    const was = await current(path);
    const content = wanted[name];
    if (content === undefined) {
      if (was) {
        await rm(path, { force: true });
        changed = true;
      }
      continue;
    }
    const mode = modeOf(name);
    if (was?.content === content) {
      if (was.mode !== mode) {
        await chmod(path, mode);
        changed = true;
      }
      continue;
    }
    const temporary = join(dir, `.${name}.tmp`);
    await writeFile(temporary, content, { mode });
    await chmod(temporary, mode);
    await rename(temporary, path);
    changed = true;
  }
  return { changed };
}
