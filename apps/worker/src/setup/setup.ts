// The setup container: the worker image's `setup` command, run
// as root before every other service on every `docker compose up`. In order:
//
//   1. checks       PUID and PGID, and every mount in `MOUNTS`
//   2. secrets      backend-secrets' better_auth_secret, worker_token and (unless
//                   OMNARR_SETUP_PASSWORD is set) setup_password; worker_token
//                   copied to the worker's secrets volume. Each generated once.
//   3. data         the /data tree's folders and the /definitions folder,
//                   owned by PUID:PGID, mode 0775; never what is in them
//   4. clients      setup-clients, unchanged
//   5. owners       PUID:PGID for the worker's secrets and the clients' volumes;
//                   backend-secrets (0600) and ./backups (0700) stay root's
//
// Each step logs `[setup] <step>: ok` or `[setup] <step> failed: <what>`, and
// the first failure stops it. A line names a file, a variable or a rule, never
// a value, except the setup password printed once, on the run that generates it.
import { chmodSync, chownSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { ensureSecret, runSetupClients } from './clients.ts';

/** The setup service's mounts. */
export type Mounts = {
  backendSecrets: string;
  secrets: string;
  nzbgetConfig: string;
  qbittorrentConfig: string;
  gluetunAuth: string;
  jellyfinConfig: string;
  jellyfinCache: string;
  data: string;
  vpn: string;
  backups: string;
  definitions: string;
};

export const MOUNTS: Mounts = {
  backendSecrets: '/run/omnarr/backend-secrets',
  secrets: '/run/omnarr/secrets',
  nzbgetConfig: '/nzbget-config',
  qbittorrentConfig: '/qbittorrent-config',
  gluetunAuth: '/gluetun-auth',
  jellyfinConfig: '/jellyfin-config',
  jellyfinCache: '/jellyfin-cache',
  data: '/data',
  vpn: '/vpn',
  backups: '/backups',
  definitions: '/definitions',
};

/**
 * The /data tree's folders, parents first: the worker's write check writes into downloads/ and
 * originals/ themselves, so a parent `mkdir -p` left root's would make them unwritable.
 */
export const DATA_FOLDERS = [
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
];

type Chown = (path: string, uid: number, gid: number) => void;
export type SetupOptions = { mounts?: Mounts; chown?: Chown; log: (line: string) => void };

/** A path and, below a folder, everything in it. */
function walk(path: string): string[] {
  if (!statSync(path).isDirectory()) return [path];
  return [path, ...readdirSync(path).flatMap((name) => walk(join(path, name)))];
}

const wholeAboveZero = (text: string | undefined) => text !== undefined && /^\d+$/.test(text) && Number(text) > 0;

export function runSetup(env: NodeJS.ProcessEnv, { mounts = MOUNTS, chown = chownSync, log }: SetupOptions): number {
  let step = 'checks';
  const fail = (what: string) => {
    log(`[setup] ${step} failed: ${what}`);
    return 1;
  };
  // 1. Checks, before any write.
  const ids = { PUID: env.PUID || '1000', PGID: env.PGID || '1000' };
  for (const [name, value] of Object.entries(ids)) if (!wholeAboveZero(value)) return fail(`${name} is not a whole number above 0`);
  for (const path of Object.values(mounts)) if (!existsSync(path)) return fail(`${path} is not mounted`);
  if (!statSync(mounts.data).isDirectory()) return fail(`${mounts.data} (OMNARR_DATA_DIR) is not a folder`);
  const uid = Number(ids.PUID);
  const gid = Number(ids.PGID);
  log('[setup] checks: ok');

  let path = '';
  try {
    // 2. Secrets.
    step = 'secrets';
    path = mounts.backendSecrets;
    ensureSecret(mounts.backendSecrets, 'better_auth_secret');
    const workerToken = ensureSecret(mounts.backendSecrets, 'worker_token');
    const setupPassword = env.OMNARR_SETUP_PASSWORD ? undefined : ensureSecret(mounts.backendSecrets, 'setup_password');
    path = join(mounts.secrets, 'worker_token');
    const copy = join(mounts.secrets, 'worker_token');
    if (!existsSync(copy) || readFileSync(copy, 'utf8') !== workerToken.value) {
      copyFileSync(join(mounts.backendSecrets, 'worker_token'), copy);
      chmodSync(copy, 0o600);
    }
    log('[setup] secrets: ok');
    if (setupPassword?.generated) log(`[setup] Setup password (needed once, to create the admin account): ${setupPassword.value}`);

    // 3. The /data tree and ./definitions, which Docker creates as root's: the folders, never their contents.
    step = 'data';
    for (path of [...DATA_FOLDERS.map((folder) => join(mounts.data, folder)), mounts.definitions]) {
      mkdirSync(path, { recursive: true });
      chown(path, uid, gid);
      chmodSync(path, 0o775);
    }
    log('[setup] data: ok');

    // 4. The clients' control keys.
    step = 'setup-clients';
    path = '';
    if (runSetupClients(env, (line) => log(`[setup] ${line}`)) !== 0) return fail('see the line above');
    log('[setup] setup-clients: ok');

    // 5. Owners, after step 4 so they cover what it wrote.
    step = 'owners';
    for (const dir of [mounts.nzbgetConfig, mounts.qbittorrentConfig, mounts.jellyfinConfig, mounts.jellyfinCache, mounts.vpn]) {
      path = dir;
      for (const entry of walk(dir)) chown(entry, uid, gid);
    }
    for (const name of readdirSync(mounts.secrets)) chown((path = join(mounts.secrets, name)), uid, gid);
    path = mounts.backendSecrets;
    chown(mounts.backendSecrets, 0, 0);
    chmodSync(mounts.backendSecrets, 0o700);
    for (const name of readdirSync(mounts.backendSecrets)) {
      chown((path = join(mounts.backendSecrets, name)), 0, 0);
      chmodSync(path, 0o600);
    }
    path = mounts.backups;
    chown(mounts.backups, 0, 0);
    chmodSync(mounts.backups, 0o700);
    log('[setup] owners: ok');
    return 0;
  } catch (error) {
    const code = (error as { code?: string }).code;
    return fail(`${path || step}${code ? ` (${code})` : ''}`);
  }
}

/** `docker compose run --rm setup show-setup-password`: the generated password again, for when the logs are gone. */
export function showSetupPassword(env: NodeJS.ProcessEnv, mounts: Mounts, log: (line: string) => void): number {
  if (env.OMNARR_SETUP_PASSWORD) {
    log('OMNARR_SETUP_PASSWORD is set in .env: the setup password is that value.');
    return 0;
  }
  try {
    log(readFileSync(join(mounts.backendSecrets, 'setup_password'), 'utf8').trim());
    return 0;
  } catch {
    log(`No setup password in ${mounts.backendSecrets}. Run docker compose up -d first.`);
    return 1;
  }
}
