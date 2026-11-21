// The setup container's `setup` and `show-setup-password` commands.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';

import { type Mounts, runSetup, showSetupPassword } from '../src/setup/setup.ts';

let root: string;
let mounts: Mounts;
let owners: Map<string, string>;
const chown = (path: string, uid: number, gid: number) => void owners.set(path, `${uid}:${gid}`);

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'omnarr-setup-'));
  mounts = {
    backendSecrets: join(root, 'backend-secrets'),
    secrets: join(root, 'secrets'),
    nzbgetConfig: join(root, 'nzbget-config'),
    qbittorrentConfig: join(root, 'qbittorrent-config'),
    gluetunAuth: join(root, 'gluetun-auth'),
    jellyfinConfig: join(root, 'jellyfin-config'),
    jellyfinCache: join(root, 'jellyfin-cache'),
    data: join(root, 'data'),
    vpn: join(root, 'vpn'),
    backups: join(root, 'backups'),
    definitions: join(root, 'definitions'),
  };
  for (const dir of Object.values(mounts)) mkdirSync(dir);
  owners = new Map();
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const env = (extra: Record<string, string> = {}) => ({
  PUID: '1000',
  PGID: '1001',
  NZBGET_CONFIG: join(mounts.nzbgetConfig, 'nzbget.conf'),
  QBITTORRENT_CONFIG: join(mounts.qbittorrentConfig, 'qBittorrent/config/qBittorrent.conf'),
  GLUETUN_AUTH: join(mounts.gluetunAuth, 'config.toml'),
  OMNARR_SECRETS_DIR: mounts.secrets,
  ...extra,
});
const run = (extra: Record<string, string> = {}) => {
  const lines: string[] = [];
  const code = runSetup(env(extra), { mounts, chown, log: (line) => lines.push(line) });
  return { code, lines, output: lines.join('\n') };
};
const read = (path: string) => readFileSync(path, 'utf8');

test('generates the secrets once, and worker_token is the same on both volumes', () => {
  expect(run().code).toBe(0);
  const first = ['better_auth_secret', 'worker_token', 'setup_password'].map((name) => read(join(mounts.backendSecrets, name)));
  expect(first.every((value) => /^[A-Za-z0-9_-]{43}$/.test(value))).toBe(true);
  expect(read(join(mounts.secrets, 'worker_token'))).toBe(first[1]);
  for (const name of ['nzbget_control_password', 'qbittorrent_control_password', 'gluetun_api_key'])
    expect(read(join(mounts.secrets, name))).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(statSync(join(mounts.backendSecrets, 'better_auth_secret')).mode & 0o777).toBe(0o600);

  expect(run().code).toBe(0);
  expect(['better_auth_secret', 'worker_token', 'setup_password'].map((name) => read(join(mounts.backendSecrets, name)))).toEqual(first);
});

test('the generated setup password is printed on the run that generates it, and only then', () => {
  const first = run();
  const password = read(join(mounts.backendSecrets, 'setup_password'));
  expect(first.lines.filter((line) => line.includes(password))).toEqual([`[setup] Setup password (needed once, to create the admin account): ${password}`]);
  expect(run().output).not.toContain('Setup password');
});

test('with OMNARR_SETUP_PASSWORD set, none is generated or printed', () => {
  const { output } = run({ OMNARR_SETUP_PASSWORD: 'chosen-planted' });
  expect(() => statSync(join(mounts.backendSecrets, 'setup_password'))).toThrow();
  expect(output).not.toContain('Setup password');
  expect(output).not.toContain('chosen-planted');
});

test('no planted secret appears in the output but the one setup-password line', () => {
  const { lines } = run();
  const secrets = [
    ...['better_auth_secret', 'worker_token'].map((name) => read(join(mounts.backendSecrets, name))),
    ...['nzbget_control_password', 'qbittorrent_control_password', 'gluetun_api_key'].map((name) => read(join(mounts.secrets, name))),
  ];
  for (const secret of secrets) expect(lines.join('\n')).not.toContain(secret);
  expect(lines.filter((line) => !line.includes('Setup password')).every((line) => line.startsWith('[setup] '))).toBe(true);
});

test('creates the /data tree with PUID:PGID and 0775, and leaves existing files alone', () => {
  mkdirSync(join(mounts.data, 'library/series/Show'), { recursive: true });
  writeFileSync(join(mounts.data, 'library/series/Show/e1.mkv'), 'media');
  expect(run().code).toBe(0);
  // The parents too: the worker's write check writes into downloads/ and originals/.
  for (const folder of [
    'downloads',
    'downloads/usenet',
    'downloads/torrents',
    'staging',
    'originals',
    'originals/series',
    'originals/movies',
    'library',
    'library/series',
    'library/movies',
  ]) {
    expect(statSync(join(mounts.data, folder)).mode & 0o777).toBe(0o775);
    expect(owners.get(join(mounts.data, folder))).toBe('1000:1001');
  }
  expect(owners.has(join(mounts.data, 'library/series/Show'))).toBe(false);
  expect(owners.has(join(mounts.data, 'library/series/Show/e1.mkv'))).toBe(false);
  expect(read(join(mounts.data, 'library/series/Show/e1.mkv'))).toBe('media');
});

test('gives ./definitions, which Docker creates as root, PUID:PGID and 0775, and leaves its files alone', () => {
  writeFileSync(join(mounts.definitions, 'mysite.yml'), 'id: mysite');
  expect(run().code).toBe(0);
  expect(owners.get(mounts.definitions)).toBe('1000:1001');
  expect(statSync(mounts.definitions).mode & 0o777).toBe(0o775);
  expect(owners.has(join(mounts.definitions, 'mysite.yml'))).toBe(false);
  expect(read(join(mounts.definitions, 'mysite.yml'))).toBe('id: mysite');
});

test("the clients' files and the secrets get PUID:PGID; backend-secrets and backups stay root's", () => {
  expect(run().code).toBe(0);
  expect(owners.get(join(mounts.secrets, 'nzbget_control_password'))).toBe('1000:1001');
  expect(owners.get(join(mounts.secrets, 'worker_token'))).toBe('1000:1001');
  expect(owners.get(join(mounts.nzbgetConfig, 'nzbget.conf'))).toBe('1000:1001');
  expect(owners.get(join(mounts.qbittorrentConfig, 'qBittorrent/config/qBittorrent.conf'))).toBe('1000:1001');
  for (const dir of [mounts.jellyfinConfig, mounts.jellyfinCache, mounts.vpn]) expect(owners.get(dir)).toBe('1000:1001');
  expect(owners.get(mounts.backendSecrets)).toBe('0:0');
  expect(owners.get(join(mounts.backendSecrets, 'worker_token'))).toBe('0:0');
  expect(owners.get(mounts.backups)).toBe('0:0');
  expect(statSync(mounts.backups).mode & 0o777).toBe(0o700);
  expect([...owners.keys()].some((path) => path.startsWith(mounts.gluetunAuth))).toBe(false);
});

describe('checks', () => {
  test.each([
    ['PUID', '0'],
    ['PGID', 'abc'],
    ['PUID', '-1'],
  ])('a bad %s fails with its name, before any write', (name, value) => {
    const { code, output } = run({ [name]: value });
    expect(code).toBe(1);
    expect(output).toContain(`[setup] checks failed: ${name} is not a whole number above 0`);
    expect(() => statSync(join(mounts.backendSecrets, 'worker_token'))).toThrow();
  });

  test('a missing mount fails with its path, before any write', () => {
    rmSync(mounts.jellyfinCache, { recursive: true });
    const { code, output } = run();
    expect(code).toBe(1);
    expect(output).toContain(`[setup] checks failed: ${mounts.jellyfinCache} is not mounted`);
    expect(() => statSync(join(mounts.backendSecrets, 'worker_token'))).toThrow();
  });
});

describe('show-setup-password', () => {
  test('prints the generated one again', () => {
    run();
    const lines: string[] = [];
    expect(showSetupPassword({}, mounts, (line) => lines.push(line))).toBe(0);
    expect(lines).toEqual([read(join(mounts.backendSecrets, 'setup_password'))]);
  });

  test('says OMNARR_SETUP_PASSWORD is in use, without printing it', () => {
    const lines: string[] = [];
    expect(showSetupPassword({ OMNARR_SETUP_PASSWORD: 'chosen-planted' }, mounts, (line) => lines.push(line))).toBe(0);
    expect(lines.join('\n')).toContain('OMNARR_SETUP_PASSWORD');
    expect(lines.join('\n')).not.toContain('chosen-planted');
  });
});
