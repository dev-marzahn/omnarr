// `setup-clients`: the control secrets, NZBGet's control
// keys, qBittorrent's WebUI keys and gluetun's auth file, written before the
// clients start.
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';

import { ensureSecret, pbkdf2Hash, runSetupClients, writeNzbgetControlKeys, writeQbittorrentWebUiKeys } from '../src/setup/clients.ts';

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'omnarr-setup-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const KEYS = (password: string) => [
  'ControlUsername=omnarr',
  `ControlPassword=${password}`,
  'ControlIP=0.0.0.0',
  'ControlPort=6789',
  'RestrictedUsername=',
  'AddUsername=',
];

describe('ensureSecret', () => {
  test('generates a secret when its file is absent, readable only by its owner', () => {
    const secrets = join(dir, 'secrets');
    const { value, generated } = ensureSecret(secrets, 'nzbget_control_password');
    expect(generated).toBe(true);
    expect(value).toMatch(/^[A-Za-z0-9_-]{32,}$/);
    expect(readFileSync(join(secrets, 'nzbget_control_password'), 'utf8')).toBe(value);
    expect(statSync(join(secrets, 'nzbget_control_password')).mode & 0o777).toBe(0o600);
  });

  test('keeps an existing secret', () => {
    writeFileSync(join(dir, 'nzbget_control_password'), 'kept-secret\n');
    expect(ensureSecret(dir, 'nzbget_control_password')).toEqual({ value: 'kept-secret', generated: false });
  });

  test('two secrets differ', () => {
    expect(ensureSecret(dir, 'a').value).not.toBe(ensureSecret(dir, 'b').value);
  });
});

describe('writeNzbgetControlKeys', () => {
  const conf = () => join(dir, 'nzbget', 'nzbget.conf');

  test('creates a missing file with only the control keys', () => {
    writeNzbgetControlKeys(conf(), 'pw1', { generated: false });
    expect(readFileSync(conf(), 'utf8')).toBe(`${KEYS('pw1').join('\n')}\n`);
  });

  test('edits an existing file only when the secret was just generated, keeping every other line', () => {
    mkdirSync(join(dir, 'nzbget'));
    writeFileSync(
      conf(),
      ['# NZBGet configuration', 'MainDir=/data/downloads/usenet', 'ControlUsername=nzbget', 'ControlPassword=old', 'Server1.Host=news.example', ''].join('\n'),
    );
    writeNzbgetControlKeys(conf(), 'pw2', { generated: true });
    const lines = readFileSync(conf(), 'utf8').split('\n');
    expect(lines).toEqual(expect.arrayContaining(['# NZBGet configuration', 'MainDir=/data/downloads/usenet', 'Server1.Host=news.example', ...KEYS('pw2')]));
    expect(lines.filter((line) => line.startsWith('ControlPassword='))).toEqual(['ControlPassword=pw2']);
    expect(lines.indexOf('ControlUsername=omnarr')).toBe(2);
  });

  test('leaves an existing file alone when the secret was kept', () => {
    mkdirSync(join(dir, 'nzbget'));
    writeFileSync(conf(), 'ControlPassword=running\n');
    writeNzbgetControlKeys(conf(), 'pw3', { generated: false });
    expect(readFileSync(conf(), 'utf8')).toBe('ControlPassword=running\n');
  });
});

describe('pbkdf2Hash', () => {
  test('PBKDF2-HMAC-SHA512, 100,000 iterations, 16-byte salt, 64-byte key, as @ByteArray(salt:key) in base64', () => {
    // From Python's hashlib.pbkdf2_hmac('sha512', b'pw1', bytes(range(16)), 100000, 64), an independent implementation.
    const salt = Uint8Array.from({ length: 16 }, (_, i) => i);
    expect(pbkdf2Hash('pw1', salt)).toBe(
      '@ByteArray(AAECAwQFBgcICQoLDA0ODw==:OHIy3Sf+n62G/ofYTv6exTL38NhSllWpu10YjXcZYfTfwnxP0Vacds1b06ALXeGd7e5itSA+UvQk2YY69n8V8A==)',
    );
  });

  test('a random salt each time', () => {
    expect(pbkdf2Hash('pw1')).not.toBe(pbkdf2Hash('pw1'));
    expect(pbkdf2Hash('pw1')).toMatch(/^@ByteArray\([A-Za-z0-9+/]{22}==:[A-Za-z0-9+/]{86}==\)$/);
  });
});

// qBittorrent 5.3 reads the WebUI login from `[WebUI]` (it migrates `[Preferences] WebUI\…` there on a
// first start, and ignores a `[Preferences]` hash afterwards; fixtures/qbittorrent/README.md).
describe('writeQbittorrentWebUiKeys', () => {
  const conf = () => join(dir, 'qBittorrent', 'config', 'qBittorrent.conf');
  const section = (text: string, name: string) => {
    const lines = text.split('\n');
    const start = lines.indexOf(`[${name}]`);
    const end = lines.findIndex((line, i) => i > start && line.startsWith('['));
    return start < 0 ? [] : lines.slice(start + 1, end < 0 ? undefined : end).filter(Boolean);
  };

  test('creates a missing file with only [WebUI] and its keys', () => {
    writeQbittorrentWebUiKeys(conf(), 'pw1', { generated: false });
    const text = readFileSync(conf(), 'utf8');
    expect(text.split('\n')[0]).toBe('[WebUI]');
    expect(section(text, 'WebUI')).toEqual([
      'Username=omnarr',
      expect.stringMatching(/^Password_PBKDF2="@ByteArray\(.+:.+\)"$/),
      'LocalHostAuth=true',
      'AuthSubnetWhitelistEnabled=false',
      'Port=8080',
    ]);
    expect(statSync(conf()).mode & 0o777).toBe(0o600);
  });

  test('edits an existing file only when the secret was just generated, keeping every other line and section, and dropping the old [Preferences] spelling', () => {
    mkdirSync(join(dir, 'qBittorrent', 'config'), { recursive: true });
    writeFileSync(
      conf(),
      [
        '[BitTorrent]',
        'Session\\Port=6881',
        '',
        '[Preferences]',
        'WebUI\\Password_PBKDF2="@ByteArray(older:older)"',
        'General\\Locale=en',
        '',
        '[WebUI]',
        'Username=admin',
        'Password_PBKDF2="@ByteArray(old:old)"',
        'CSRFProtection=true',
        '',
      ].join('\n'),
    );
    writeQbittorrentWebUiKeys(conf(), 'pw2', { generated: true });
    const text = readFileSync(conf(), 'utf8');
    expect(section(text, 'BitTorrent')).toEqual(['Session\\Port=6881']);
    expect(section(text, 'Preferences')).toEqual(['General\\Locale=en']);
    expect(section(text, 'WebUI')).toEqual([
      'Username=omnarr',
      expect.stringMatching(/^Password_PBKDF2="@ByteArray\(.+:.+\)"$/),
      'LocalHostAuth=true',
      'AuthSubnetWhitelistEnabled=false',
      'Port=8080',
      'CSRFProtection=true',
    ]);
    expect(text).not.toContain('old:old');
  });

  test('a file without [WebUI] gets the section', () => {
    mkdirSync(join(dir, 'qBittorrent', 'config'), { recursive: true });
    writeFileSync(conf(), '[BitTorrent]\nSession\\Port=6881\n');
    writeQbittorrentWebUiKeys(conf(), 'pw3', { generated: true });
    const text = readFileSync(conf(), 'utf8');
    expect(text).toContain('[BitTorrent]\nSession\\Port=6881\n');
    expect(text).toMatch(/\[WebUI\]\nUsername=omnarr\n/);
  });

  test('leaves an existing file alone when the secret was kept', () => {
    mkdirSync(join(dir, 'qBittorrent', 'config'), { recursive: true });
    writeFileSync(conf(), '[WebUI]\nUsername=running\n');
    writeQbittorrentWebUiKeys(conf(), 'pw4', { generated: false });
    expect(readFileSync(conf(), 'utf8')).toBe('[WebUI]\nUsername=running\n');
  });
});

describe('runSetupClients (the command)', () => {
  test("generates qBittorrent's secret and writes its WebUI keys; a second run changes nothing", () => {
    const env = { OMNARR_SECRETS_DIR: join(dir, 'secrets'), QBITTORRENT_CONFIG: join(dir, 'qBittorrent', 'qBittorrent.conf') };
    const out: string[] = [];
    expect(runSetupClients(env, (line) => out.push(line))).toBe(0);
    const password = readFileSync(join(dir, 'secrets', 'qbittorrent_control_password'), 'utf8');
    const first = readFileSync(env.QBITTORRENT_CONFIG, 'utf8');
    expect(first).toContain('[WebUI]\nUsername=omnarr');
    expect(first).not.toContain(password);
    expect(runSetupClients(env, () => {})).toBe(0);
    expect(readFileSync(env.QBITTORRENT_CONFIG, 'utf8')).toBe(first);
    expect(out.join('\n')).not.toContain(password);
  });

  test("generates NZBGet's secret and writes its keys; a second run changes nothing", () => {
    const env = { OMNARR_SECRETS_DIR: join(dir, 'secrets'), NZBGET_CONFIG: join(dir, 'nzbget', 'nzbget.conf') };
    const out: string[] = [];
    expect(runSetupClients(env, (line) => out.push(line))).toBe(0);
    const password = readFileSync(join(dir, 'secrets', 'nzbget_control_password'), 'utf8');
    expect(readFileSync(env.NZBGET_CONFIG, 'utf8')).toContain(`ControlPassword=${password}\n`);
    const first = readFileSync(env.NZBGET_CONFIG, 'utf8');
    expect(runSetupClients(env, () => {})).toBe(0);
    expect(readFileSync(env.NZBGET_CONFIG, 'utf8')).toBe(first);
    expect(out.join('\n')).not.toContain(password);
  });

  test("generates gluetun's API key and writes its auth file: one read-only role with the key; a second run changes nothing", () => {
    const env = { OMNARR_SECRETS_DIR: join(dir, 'secrets'), GLUETUN_AUTH: join(dir, 'gluetun-auth', 'config.toml') };
    const out: string[] = [];
    expect(runSetupClients(env, (line) => out.push(line))).toBe(0);
    const key = readFileSync(join(dir, 'secrets', 'gluetun_api_key'), 'utf8');
    expect(key).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(readFileSync(env.GLUETUN_AUTH, 'utf8')).toBe(
      [
        '[[roles]]',
        'name = "omnarr-worker"',
        'routes = ["GET /v1/vpn/status", "GET /v1/publicip/ip", "GET /v1/portforward"]',
        'auth = "apikey"',
        `apikey = "${key}"`,
        '',
      ].join('\n'),
    );
    expect(statSync(env.GLUETUN_AUTH).mode & 0o777).toBe(0o600);
    const first = statSync(env.GLUETUN_AUTH).mtimeMs;
    expect(runSetupClients(env, () => {})).toBe(0);
    expect(statSync(env.GLUETUN_AUTH).mtimeMs).toBe(first);
    expect(out.join('\n')).not.toContain(key);
  });

  test("gluetun's auth file follows the key: a rotated key is written into it", () => {
    const env = { OMNARR_SECRETS_DIR: join(dir, 'secrets'), GLUETUN_AUTH: join(dir, 'gluetun-auth', 'config.toml') };
    runSetupClients(env, () => {});
    rmSync(join(dir, 'secrets', 'gluetun_api_key'));
    runSetupClients(env, () => {});
    expect(readFileSync(env.GLUETUN_AUTH, 'utf8')).toContain(`apikey = "${readFileSync(join(dir, 'secrets', 'gluetun_api_key'), 'utf8')}"`);
  });

  test('a client whose variable is unset is skipped', () => {
    expect(runSetupClients({ OMNARR_SECRETS_DIR: join(dir, 'secrets') }, () => {})).toBe(0);
    expect(() => readFileSync(join(dir, 'secrets', 'nzbget_control_password'))).toThrow();
  });

  test('a path that cannot be written exits 1, naming the path and no secret', () => {
    writeFileSync(join(dir, 'blocker'), '');
    const env = { OMNARR_SECRETS_DIR: join(dir, 'secrets'), NZBGET_CONFIG: join(dir, 'blocker', 'nzbget.conf') };
    const out: string[] = [];
    expect(runSetupClients(env, (line) => out.push(line))).toBe(1);
    const password = readFileSync(join(dir, 'secrets', 'nzbget_control_password'), 'utf8');
    expect(out.join('\n')).toContain(env.NZBGET_CONFIG);
    expect(out.join('\n')).not.toContain(password);
  });
});
