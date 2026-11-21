// Install and first run on the shipped compose files, in one stack started
// without OMNARR_SETUP_PASSWORD, so `setup` generates one:
//
//   - setup exits 0 and prints the password once; the tree's owners; the
//     backend turns healthy after its hooks; only the backend, Jellyfin and
//     web ports; a second `up` changes no secret and recreates nothing
//   - the generated password from the logs and show-setup-password; a wrong
//     one is refused, five lock createAdmin, the right one creates the
//     admin, then adminExists
//   - first run through the public functions; a new session at `usenet`
//     resumes there; de-DE, the libraries, Jellyfin's setup, the scan, done
//   - an older worker is refused with the expected version and retries
//   - CORS by the web port, then exact with the three URLs set; the web page
//     carries the URLs set at its start; OMNARR_UPDATE_CHECK reaches the
//     deployment; an invalid URL keeps the backend unhealthy
//   - reset-admin-password
//   - the VPN layout: gluetun and qBittorrent recreated together, and
//     qBittorrent answers through gluetun again
import { makeFunctionReference } from 'convex/server';
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test';

import {
  ADMIN,
  authFetch,
  compose,
  type Deployment,
  deploymentVariable,
  down,
  jellyfinAnswers,
  jellyfinSignIn,
  logs,
  NEWZNAB_KEY,
  NNTP_PASS,
  NNTP_USER,
  plantedSecrets,
  ports,
  qbittorrentApi,
  rows,
  setEnv,
  startWorker,
  stopWorker,
  switchToVpnLayout,
  up,
  waitFor,
  wireguardPeerConf,
} from './stack.ts';

// oxlint-disable-next-line typescript/no-explicit-any
type Any = any;
let d: Deployment;
const query = (name: string, args: object = {}): Promise<Any> => d.admin.query(makeFunctionReference<'query'>(name), args);
const mutation = (name: string, args: object): Promise<Any> => d.admin.mutation(makeFunctionReference<'mutation'>(name), args);
const action = (name: string, args: object): Promise<Any> => d.admin.action(makeFunctionReference<'action'>(name), args);
/** setup.createAdmin as any web page could call it: no session. */
const anonymous = async (setupPassword: string, locale = 'de-DE'): Promise<Any> => {
  const { ConvexHttpClient } = await import('convex/browser');
  return new ConvexHttpClient(d.url).action(makeFunctionReference<'action'>('api/setup:createAdmin'), {
    setupPassword,
    username: ADMIN.username,
    password: ADMIN.password,
    locale,
  });
};

type PsRow = { Service: string; ID: string; State: string; Health?: string; ExitCode: number; Publishers?: { PublishedPort: number; TargetPort: number }[] };
const ps = (): PsRow[] =>
  compose(['ps', '-a', '--format', 'json'], ['test', 'worker', 'worker-old'])
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as PsRow);
const LONG_RUNNING = ['backend', 'web', 'nzbget', 'qbittorrent', 'jellyfin'];
const containerIds = () =>
  Object.fromEntries(
    ps()
      .filter((row) => LONG_RUNNING.includes(row.Service))
      .map((row) => [row.Service, row.ID]),
  );
/** A file of the `setup` service's volumes, read in a one-off container as `docker compose run --rm setup` does. */
const setupRun = (command: string[]) => compose(['run', '--rm', '--no-deps', '-T', '--entrypoint', command[0]!, 'setup', ...command.slice(1)]);
const backendSecrets = () => setupRun(['sh', '-c', 'cd /run/omnarr/backend-secrets && for f in *; do echo "$f $(sha256sum < $f)"; done']);
const SETUP_LINE = /\[setup\] Setup password \(needed once, to create the admin account\): (\S+)/g;
const setupPasswords = () => [...logs('setup').matchAll(SETUP_LINE)].map((match) => match[1]!);

/** The CORS answer to a preflight from `origin` on the auth URL: the allowed origin, or null. */
const corsFor = async (origin: string) =>
  // Retried on a network error only: right after a recreate, Docker's port forwarding can reset the first connections.
  (
    await waitFor(
      'the auth URL to answer',
      () =>
        fetch(`${d.siteUrl}/api/auth/sign-in/username`, {
          method: 'OPTIONS',
          headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
        }),
      30_000,
      500,
    )
  ).headers.get('access-control-allow-origin');

beforeAll(async () => {
  // The lockout lowered (setupLockMs), so the lock test waits seconds, not 15 minutes.
  d = await up({ layout: 'wireguard', firstRun: false, env: { OMNARR_SETUP_PASSWORD: '' }, limits: { setupLockMs: 5_000 } });
}, 900_000);
afterAll(() => {
  if (process.env.E2E_KEEP !== '1') return down();
});

describe('a fresh install', () => {
  test('setup exits 0 and prints the generated setup password once', () => {
    expect(ps().find((row) => row.Service === 'setup')).toMatchObject({ State: 'exited', ExitCode: 0 });
    expect(setupPasswords()).toHaveLength(1);
    expect(setupPasswords()[0]).toMatch(/^[A-Za-z0-9_-]{43}$/);
    for (const step of ['checks', 'secrets', 'data', 'setup-clients', 'owners']) expect(logs('setup')).toContain(`[setup] ${step}: ok`);
  });

  test('the /data tree is PUID:PGID with mode 0775', () => {
    const folders = [
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
    const stats = setupRun(['stat', '-c', '%n %u:%g %a', ...folders.map((folder) => `/data/${folder}`)])
      .trim()
      .split('\n');
    expect(stats).toEqual(folders.map((folder) => `/data/${folder} 1000:1000 775`));
  });

  test('./definitions is PUID:PGID with mode 0775, not root as Docker creates it', () => {
    expect(setupRun(['stat', '-c', '%u:%g %a', '/definitions']).trim()).toBe('1000:1000 775');
  });

  test('the backend ran the pre-push hook, the release and the post-apply hook before it reported healthy', () => {
    const log = logs('backend');
    const at = (text: string) => log.indexOf(text);
    expect(at('pre-push hook: done')).toBeGreaterThan(-1);
    expect(at('[omnarr] pre-push: ok')).toBeLessThan(at('pre-push hook: done'));
    expect(at('pre-push hook: done')).toBeLessThan(at('post-apply hook: done'));
    expect(at('post-apply hook: done')).toBeLessThan(at('[convex-release] ready'));
    expect(ps().find((row) => row.Service === 'backend')?.Health).toBe('healthy');
    for (const secret of plantedSecrets(d.env)) expect(log).not.toContain(secret);
  });

  test('a first start on a fresh convex-data volume deploys at the first attempt', () => {
    // convex-release 100.2.0 derived its admin key while the backend generated its INSTANCE_SECRET:
    // BadAdminKey, then an empty credentials file on every restart. 100.2.1 creates the credentials first.
    const log = logs('backend');
    expect(log).not.toContain('BadAdminKey');
    expect(log).not.toContain('deploy failed');
    expect(log.split('[convex-release] ready').length - 1).toBe(1);
    expect(compose(['exec', '-T', 'backend', 'cat', '/convex/data/credentials/instance_secret']).trim()).toMatch(/^[0-9a-f]{64}$/);
  });

  test("only the backend, Jellyfin and web ports are published (the e2e keeps qBittorrent's peer port internal)", () => {
    const published = ps()
      .flatMap((row) => (row.Publishers ?? []).filter((p) => p.PublishedPort > 0).map((p) => `${row.Service}:${p.TargetPort}`))
      .sort();
    expect([...new Set(published)]).toEqual(['backend:3210', 'backend:3211', 'jellyfin:8096', 'web:3000']);
    expect(ports.web).toBeGreaterThan(0);
  });

  test('a second `up` runs setup again, changes no secret, prints no setup password and recreates nothing', () => {
    const ids = containerIds();
    const before = backendSecrets();
    compose(['up', '-d', '--wait']);
    expect(containerIds()).toEqual(ids);
    expect(backendSecrets()).toBe(before);
    expect(logs('setup').split('[setup] checks: ok').length - 1).toBe(2);
    expect(setupPasswords()).toHaveLength(1);
  });
});

describe('the setup password guards admin creation', () => {
  test('show-setup-password prints the same password again', () => {
    expect(compose(['run', '--rm', '--no-deps', '-T', 'setup', 'show-setup-password']).trim()).toBe(setupPasswords()[0]);
  });

  test('a wrong one is refused, five lock createAdmin, then the right one creates the admin, and afterwards adminExists', async () => {
    const [right] = setupPasswords();
    for (let i = 0; i < 5; i++) expect(await anonymous('not-the-setup-password')).toEqual({ error: 'wrongSetupPassword' });
    const locked = await anonymous(right!);
    expect(locked).toMatchObject({ error: 'locked', until: expect.any(Number) });
    expect(rows(d.env, 'user', 'betterAuth')).toEqual([]);
    // setupLockMs is lowered to 5 s for this stack.
    const result = await waitFor('the lock to expire', async () => {
      const answer = await anonymous(right!);
      return answer.error === 'locked' ? undefined : answer;
    });
    expect(result).toEqual({ ok: true });
    expect(await anonymous(right!)).toEqual({ error: 'adminExists' });
    await d.admin.signIn(ADMIN.password);
  });
});

describe('first run to "Setup complete", interrupted once', () => {
  test("the admin's transaction: role admin, de-DE, the libraries with web-1080p, and Jellyfin's setup with de-DE", async () => {
    const [user] = rows<{ username: string; role: string }>(d.env, 'user', 'betterAuth');
    expect(user).toMatchObject({ username: ADMIN.username, role: 'admin' });
    expect(rows<{ language: string }>(d.env, 'metadataSettings')[0]?.language).toBe('de-DE');
    const profile = rows<{ _id: string; shippedKey?: string }>(d.env, 'releaseProfiles').find((row) => row.shippedKey === 'web-1080p')!;
    const libraries = rows<{ kind: string; rootPath: string; defaultReleaseProfileId: string }>(d.env, 'libraries');
    expect(
      libraries
        .map(({ kind, rootPath, defaultReleaseProfileId }) => ({ kind, rootPath, defaultReleaseProfileId }))
        .sort((a, b) => a.kind.localeCompare(b.kind)),
    ).toEqual([
      { kind: 'movies', rootPath: '/data/library/movies', defaultReleaseProfileId: profile._id },
      { kind: 'series', rootPath: '/data/library/series', defaultReleaseProfileId: profile._id },
    ]);
    expect(rows<{ locale: { uiCulture: string } }>(d.env, 'jellyfinServer')[0]?.locale.uiCulture).toBe('de-DE');
    expect(await query('api/setup:state')).toEqual({ adminExists: true, step: 'address' });
  });

  test('the indexer step; a new session opened at `usenet` resumes there', async () => {
    await mutation('api/setup:advance', { step: 'indexer' });
    await action('api/indexers:create', { name: 'Newznab Main', url: 'http://newznab:4120/api', apiKey: NEWZNAB_KEY, priority: 10 });
    await mutation('api/setup:advance', { step: 'usenet' });
    // The tab closes; the admin opens the app again and signs in.
    await d.admin.signIn(ADMIN.password);
    expect(await query('api/setup:state')).toEqual({ adminExists: true, step: 'usenet' });
    expect(await query('api/indexers:list')).toHaveLength(1);
  });

  test('the remaining steps: NZBGet configured, torrents skipped, the worker connected, Jellyfin set up, the scan ends empty, done', async () => {
    await mutation('api/downloadClients:saveUsenet', {
      input: { host: 'nntp', port: 119, ssl: false, username: NNTP_USER, password: NNTP_PASS, connections: 4 },
    });
    await mutation('api/setup:advance', { step: 'torrents' });
    const { torrents } = await query('api/downloadClients:get');
    await mutation('api/downloadClients:saveTorrents', { input: { enabled: false, seedGoal: torrents.seedGoal } });
    await mutation('api/setup:advance', { step: 'devices' });
    await mutation('api/playback:setupDefaults', { devices: ['chrome', 'jellyfinAndroid'] });
    await mutation('api/setup:advance', { step: 'metadata' });
    await mutation('api/setup:advance', { step: 'finish' });

    await jellyfinAnswers(d.jellyfinUrl);
    startWorker('worker');
    const status = await waitFor(
      'the checklist done',
      async () => {
        const current = await query('api/system:status');
        const nzbget = current.clients.find((row: Any) => row.clientKind === 'nzbget');
        return current.worker?.connected && nzbget?.config === 'applied' && current.jellyfin.state === 'ready' ? current : undefined;
      },
      300_000,
      1_000,
    );
    expect(status.jellyfin.steps.map((step: Any) => step.state)).toEqual(['done', 'done', 'done', 'done', 'done']);
    expect((await query('api/downloadClients:get')).torrents.enabled).toBe(false);

    await mutation('api/scan:start', { trigger: 'firstRun' });
    const scan = await waitFor('the first-run scan to end', async () => {
      const current = await query('api/scan:status');
      return current.run && ['ready', 'failed', 'cancelled'].includes(current.run.state) ? current : undefined;
    });
    expect(scan.run.counts.read - scan.run.counts.tracked).toBe(0);
    await mutation('api/setup:advance', { step: 'done' });
    expect(await query('api/setup:state')).toEqual({ adminExists: true, step: 'done' });
    expect(await jellyfinSignIn(d, ADMIN.password)).toBe(200);
  });
});

describe('an older worker', () => {
  test('is refused with the expected version, keeps retrying, and claims nothing', async () => {
    stopWorker('worker');
    startWorker('worker-old');
    await waitFor('two handshakes', async () => ((logs('worker-old').match(/protocol version mismatch/g) ?? []).length >= 2 ? true : undefined), 90_000);
    const status = await query('api/system:status');
    expect(status.banner).toBe('protocolMismatch');
    expect(status.worker).toMatchObject({ workerId: 'worker-old', accepted: false, protocolVersion: 0 });
    expect(
      rows<{ workerId: string; accepted: boolean; capabilities?: unknown }>(d.env, 'workerSessions').find((s) => s.workerId === 'worker-old'),
    ).not.toHaveProperty('capabilities');
    stopWorker('worker-old');
    startWorker('worker');
  });
});

describe('CORS and the .env re-apply', () => {
  const lan = (port: number) => `http://192.168.1.20:${port}`;

  test('without a web URL: any hostname on the web port is trusted, another port is refused', async () => {
    expect(await corsFor(lan(ports.web))).toBe(lan(ports.web));
    expect(await corsFor(`http://omnarr.lan:${ports.web}`)).toBe(`http://omnarr.lan:${ports.web}`);
    expect(await corsFor(lan(ports.web + 1))).toBeNull();
  });

  test('the three URLs and the update switch in .env: the backend is recreated, the origin check is exact, and the page carries the URLs', async () => {
    const before = containerIds();
    setEnv({
      OMNARR_WEB_URL: 'https://omnarr.example.net',
      OMNARR_CONVEX_URL: 'https://api.omnarr.example.net',
      OMNARR_CONVEX_SITE_URL: 'https://auth.omnarr.example.net',
      OMNARR_UPDATE_CHECK: 'off',
    });
    compose(['up', '-d', '--wait']);
    const after = containerIds();
    expect(after.backend).not.toBe(before.backend);
    expect(after.web).not.toBe(before.web);
    expect(after.jellyfin).toBe(before.jellyfin);

    expect(await corsFor('https://omnarr.example.net')).toBe('https://omnarr.example.net');
    expect(await corsFor(lan(ports.web))).toBeNull();
    // The pre-push hook carried the switch and the web URL to the deployment.
    expect(deploymentVariable(d.env, 'UPDATE_CHECK')).toBe('off');
    expect(deploymentVariable(d.env, 'SITE_URL')).toBe('https://omnarr.example.net');
    // The web container read the URLs at its start, the same image as before.
    // `--wait` waits only for its container to run: the Node server may not listen yet.
    const page = await waitFor('the web app to answer', async () => (await fetch(d.webUrl)).text(), 60_000, 500);
    expect(page).toContain('https://api.omnarr.example.net');
    expect(page).toContain('https://auth.omnarr.example.net');
  });

  test('an invalid URL keeps the backend unhealthy, names the variable, and logs no secret; fixing it brings it back', async () => {
    // A web URL with a path: the Convex backend starts (it never sees OMNARR_WEB_URL), and the pre-push hook refuses it.
    // An invalid OMNARR_CONVEX_URL or OMNARR_CONVEX_SITE_URL is refused earlier, by the backend itself, as its origin.
    // Read while the backend answers: the Convex CLI `plantedSecrets` uses retries a stopped backend forever.
    const planted = plantedSecrets(d.env);
    setEnv({ OMNARR_WEB_URL: 'https://omnarr.example.net/app' });
    try {
      compose(['up', '-d', 'backend']);
      const line = await waitFor('the pre-push failure', async () => logs('backend').match(/\[omnarr\] pre-push failed: [^\n]*/)?.[0], 120_000, 1_000);
      expect(line).toBe('[omnarr] pre-push failed: OMNARR_WEB_URL is not an http(s) URL without a path');
      expect(ps().find((row) => row.Service === 'backend')?.Health).not.toBe('healthy');
      for (const secret of planted) expect(logs('backend')).not.toContain(secret);
    } finally {
      setEnv({ OMNARR_WEB_URL: '', OMNARR_CONVEX_URL: '', OMNARR_CONVEX_SITE_URL: '', OMNARR_UPDATE_CHECK: '' });
      compose(['up', '-d', '--wait']);
    }
    expect(await corsFor(lan(ports.web))).toBe(lan(ports.web));
    await d.admin.signIn(ADMIN.password);
    expect(await query('api/setup:state')).toEqual({ adminExists: true, step: 'done' });
  });
});

describe('a forgotten password', () => {
  test('reset-admin-password changes the credential, signs out every session, and pushes the password to Jellyfin', async () => {
    const newPassword = `${ADMIN.password}-reset`;
    const out = compose(['exec', '-T', 'backend', 'reset-admin-password', '--password-stdin'], ['test'], `${newPassword}\n`);
    expect(out.trim()).toBe('Password changed. Sign in again at the web app.');
    expect(out).not.toContain(newPassword);
    expect(rows(d.env, 'session', 'betterAuth')).toEqual([]);
    expect((await authFetch(d.siteUrl, d.webUrl, '/sign-in/username', { body: { username: ADMIN.username, password: ADMIN.password } })).status).toBe(401);
    await d.admin.signIn(newPassword);
    await waitFor('the push to land', async () => ((await jellyfinSignIn(d, newPassword)) === 200 ? true : undefined), 120_000, 1_000);
    ADMIN.password = newPassword;
  });
});

describe('gluetun is recreated', () => {
  const vpnState = async () => (await query('api/system:status')).clients.find((row: Any) => row.clientKind === 'qbittorrent')?.vpn?.state;

  test('with qBittorrent, as the docs say: qBittorrent answers through gluetun again', async () => {
    const { torrents } = await query('api/downloadClients:get');
    await mutation('api/downloadClients:saveTorrents', { input: { enabled: true, seedGoal: torrents.seedGoal } });
    await mutation('api/downloadClients:saveVpn', { input: { kind: 'wireguardFile', wireguardConf: await wireguardPeerConf() } });
    await waitFor('notActive', async () => ((await vpnState()) === 'notActive' ? true : undefined), 120_000, 1_000);
    switchToVpnLayout();
    await waitFor('the VPN up', async () => ((await vpnState()) === 'up' ? true : undefined), 300_000, 1_000);
    expect(qbittorrentApi<string>('app/version')).toMatch(/^v?5\.3\.0/);

    const gluetun = ps().find((row) => row.Service === 'gluetun')!.ID;
    compose(['up', '-d', '--wait', '--force-recreate', 'gluetun', 'qbittorrent'], ['test', 'worker']);
    expect(ps().find((row) => row.Service === 'gluetun')!.ID).not.toBe(gluetun);
    await waitFor(
      'qBittorrent through the new gluetun',
      async () => (/^v?5\.3\.0/.test(String(qbittorrentApi<string>('app/version'))) ? true : undefined),
      120_000,
      1_000,
    );
    await waitFor('the VPN up again', async () => ((await vpnState()) === 'up' ? true : undefined), 300_000, 1_000);
  });
});
