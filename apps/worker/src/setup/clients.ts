// `setup-clients`: the setup container runs it before the
// clients start, on every `docker compose up`. It generates each control
// secret only when its file is absent,
// and writes the client's control keys: into a missing config file, or into
// an existing one only when the secret was just generated, so a running
// client's file is never touched. It writes NZBGet's control keys,
// qBittorrent's WebUI keys and gluetun's auth file.
//
//   OMNARR_SECRETS_DIR   the secrets volume (default /run/omnarr/secrets)
//   NZBGET_CONFIG        the path of nzbget.conf; unset skips NZBGet
//   QBITTORRENT_CONFIG   the path of qBittorrent.conf: qBittorrent/config/qBittorrent.conf
//                        on the official image's /config volume; unset skips qBittorrent
//   GLUETUN_AUTH         the path of config.toml on the gluetun-auth volume, which
//                        gluetun mounts at /gluetun/auth; unset skips gluetun
//
// Exit 0 on success; 1 with the failing path, never a secret, on any error.
import { pbkdf2Sync, randomBytes } from 'node:crypto';
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { readSecret, secretsDir } from '../secrets.ts';

/** The control secret's file, generated when absent (32 random bytes, base64url) and kept otherwise. */
export function ensureSecret(dir: string, name: string): { value: string; generated: boolean } {
  const path = join(dir, name);
  if (existsSync(path)) return { value: readSecret(name, dir), generated: false };
  mkdirSync(dir, { recursive: true });
  const value = randomBytes(32).toString('base64url');
  writeFileSync(path, value, { mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
  return { value, generated: true };
}

/** The NZBGet keys setup writes:the worker's control login, and no other NZBGet user. */
const nzbgetKeys = (password: string): [string, string][] => [
  ['ControlUsername', 'omnarr'],
  ['ControlPassword', password],
  ['ControlIP', '0.0.0.0'],
  ['ControlPort', '6789'],
  ['RestrictedUsername', ''],
  ['AddUsername', ''],
];

/**
 * Creates a missing nzbget.conf with only the control keys (NZBGet uses its
 * defaults for the rest until the worker's first apply), or replaces
 * those keys in an existing one when the secret was just generated.
 */
export function writeNzbgetControlKeys(confPath: string, password: string, { generated }: { generated: boolean }): void {
  const keys = nzbgetKeys(password);
  if (!existsSync(confPath)) {
    mkdirSync(dirname(confPath), { recursive: true });
    writeFileSync(confPath, `${keys.map(([key, value]) => `${key}=${value}`).join('\n')}\n`, { mode: 0o600 });
    return;
  }
  if (!generated) return;
  const lines = readFileSync(confPath, 'utf8').split('\n');
  const written = new Set<string>();
  const edited = lines.map((line) => {
    const key = /^([A-Za-z0-9.]+)=/.exec(line)?.[1];
    const entry = keys.find(([name]) => name === key);
    if (!entry) return line;
    written.add(entry[0]);
    return `${entry[0]}=${entry[1]}`;
  });
  const missing = keys.filter(([key]) => !written.has(key)).map(([key, value]) => `${key}=${value}`);
  if (edited.at(-1) === '') edited.splice(-1, 0, ...missing);
  else edited.push(...missing);
  writeFileSync(confPath, edited.join('\n'));
}

/**
 * qBittorrent's WebUI password hash: PBKDF2-HMAC-SHA512, 100,000
 * iterations, a 16-byte salt and a 64-byte key, each base64, as qBittorrent
 * writes `WebUI\Password_PBKDF2` itself.
 */
export function pbkdf2Hash(password: string, salt: Uint8Array = randomBytes(16)): string {
  const key = pbkdf2Sync(password, salt, 100_000, 64, 'sha512');
  return `@ByteArray(${Buffer.from(salt).toString('base64')}:${key.toString('base64')})`;
}

/**
 * The qBittorrent keys setup writes: the worker's WebUI login, and no subnet
 * whitelist. qBittorrent 5.3 reads them from `[WebUI]`; it migrates the
 * `[Preferences] WebUI\…` spelling there on a first start and ignores a hash
 * left under `[Preferences]` afterwards.
 */
const qbittorrentKeys = (password: string): [string, string][] => [
  ['Username', 'omnarr'],
  ['Password_PBKDF2', `"${pbkdf2Hash(password)}"`],
  ['LocalHostAuth', 'true'],
  ['AuthSubnetWhitelistEnabled', 'false'],
  ['Port', '8080'],
];

/**
 * Creates a missing qBittorrent.conf with only `[WebUI]` and its keys, so
 * qBittorrent starts without generating a random password; or replaces those
 * keys in an existing one when the secret was just generated, keeping every
 * other line and section, and dropping their old `[Preferences]` spelling.
 */
export function writeQbittorrentWebUiKeys(confPath: string, password: string, { generated }: { generated: boolean }): void {
  const keys = qbittorrentKeys(password);
  const lines = keys.map(([key, value]) => `${key}=${value}`);
  if (!existsSync(confPath)) {
    mkdirSync(dirname(confPath), { recursive: true });
    writeFileSync(confPath, `[WebUI]\n${lines.join('\n')}\n`, { mode: 0o600 });
    return;
  }
  if (!generated) return;
  const names = new Set(keys.map(([key]) => key));
  let current = '';
  const kept = readFileSync(confPath, 'utf8')
    .split('\n')
    .filter((line) => {
      if (line.startsWith('[')) current = line;
      const key = line.split('=', 1)[0]!;
      if (current === '[WebUI]') return !names.has(key);
      return !(current === '[Preferences]' && key.startsWith('WebUI\\') && names.has(key.slice('WebUI\\'.length)));
    });
  const section = kept.indexOf('[WebUI]');
  if (section < 0) {
    if (kept.at(-1) === '') kept.pop();
    kept.push('[WebUI]', ...lines, '');
  } else kept.splice(section + 1, 0, ...lines);
  writeFileSync(confPath, kept.join('\n'));
}

/**
 * Gluetun's control-server auth file: one role with the three read
 * routes the worker needs and the API key, so every other route, every `PUT`
 * included, is denied. Gluetun reads it only when it starts, so writing it
 * again with the same key is harmless; it is written only when it differs,
 * as after a rotation.
 */
export function writeGluetunAuth(path: string, apiKey: string): boolean {
  const content = [
    '[[roles]]',
    'name = "omnarr-worker"',
    'routes = ["GET /v1/vpn/status", "GET /v1/publicip/ip", "GET /v1/portforward"]',
    'auth = "apikey"',
    `apikey = "${apiKey}"`,
    '',
  ].join('\n');
  if (existsSync(path) && readFileSync(path, 'utf8') === content) return false;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content, { mode: 0o600 });
  chmodSync(path, 0o600);
  return true;
}

export function runSetupClients(env: NodeJS.ProcessEnv, log: (line: string) => void): number {
  const dir = secretsDir(env);
  let step = dir;
  try {
    if (env.NZBGET_CONFIG) {
      step = join(dir, 'nzbget_control_password');
      const secret = ensureSecret(dir, 'nzbget_control_password');
      step = env.NZBGET_CONFIG;
      writeNzbgetControlKeys(env.NZBGET_CONFIG, secret.value, secret);
      log(`setup-clients: NZBGet control keys ${secret.generated ? 'written' : 'kept'} (${env.NZBGET_CONFIG})`);
    }
    if (env.QBITTORRENT_CONFIG) {
      step = join(dir, 'qbittorrent_control_password');
      const secret = ensureSecret(dir, 'qbittorrent_control_password');
      step = env.QBITTORRENT_CONFIG;
      writeQbittorrentWebUiKeys(env.QBITTORRENT_CONFIG, secret.value, secret);
      log(`setup-clients: qBittorrent WebUI keys ${secret.generated ? 'written' : 'kept'} (${env.QBITTORRENT_CONFIG})`);
    }
    if (env.GLUETUN_AUTH) {
      step = join(dir, 'gluetun_api_key');
      const secret = ensureSecret(dir, 'gluetun_api_key');
      step = env.GLUETUN_AUTH;
      const written = writeGluetunAuth(env.GLUETUN_AUTH, secret.value);
      log(`setup-clients: gluetun auth file ${written ? 'written' : 'kept'} (${env.GLUETUN_AUTH})`);
    }
    return 0;
  } catch (error) {
    const code = (error as { code?: string }).code;
    log(`setup-clients: failed at ${step}${code ? ` (${code})` : ''}`);
    return 1;
  }
}
