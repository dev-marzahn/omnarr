// The e2e's stack: the shipped compose files with
// e2e/compose.test.yml over them, in a temporary project folder; the real
// setup container and backend hooks; first run through the public functions
// (setup.createAdmin, then Better Auth's sign-in); an admin client on that
// session; the Usenet provider and the torrent settings saved as the
// first-run page saves them. NZBGet and qBittorrent get only their
// control keys from `setup`; the worker's reconciler applies the rest.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, renameSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';

import { limitsFrom, type TestLimitKey } from '@omnarr/contracts';
import { ConvexHttpClient } from 'convex/browser';
import { makeFunctionReference } from 'convex/server';

import { writeFailureDump } from './dump.ts';
import { GENERATED_MEDIA } from './fakes/usenet/catalogue.ts';
import { cachedMediaPath, releaseSlot } from './host.ts';
import { BACKEND_IMAGE, buildImages, PROJECT, WEB_IMAGE, WORKER_IMAGE } from './image.ts';

export { PROJECT, WORKER_IMAGE };

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, '..');
const backendDir = join(root, 'packages/backend');

/**
 * The vpn scenario's two /24s (compose.wireguard.test.yml), per project so two vpn runs can share a
 * Docker host: `near` is the stack's default network, `far` the one behind the test VPN servers.
 * Both in 10.213.0.0/16, an even third octet and the next one, from a hash of the project.
 */
const slot = Array.from({ length: PROJECT.length }, (_, i) => PROJECT.charCodeAt(i)).reduce((hash, code) => (hash * 31 + code) >>> 0, 7) % 127;
export const VPN_NET = { near: `10.213.${2 * slot}`, far: `10.213.${2 * slot + 1}` };
/** The web seed's address behind the tunnel; gluetun's health target, exit-IP lookup and DNS. */
export const FAR_WEBSEED = `${VPN_NET.far}.210`;

/**
 * The timers every scenario lowers on the worker and the backend alike (`OMNARR_TEST_LIMITS`,
 * contracts' TEST_LIMIT_KEYS), so that no test waits on a production timer: an outage is a stopped
 * container, seen within seconds. Production keeps DEFAULT_LIMITS; a scenario can lower more with
 * `up({ limits })`, as the torrent scenarios lower the stall time.
 */
export const E2E_LIMITS = {
  goalGraceMs: 5_000,
  vpnDownAfterMs: 5_000,
  vpnStableMs: 5_000,
  vpnWaitRetryMs: 10_000,
  reconcilerPollMs: 2_000,
  progressPollMs: 1_000,
  progressMs: 1_000,
  // A killed worker's job is free again 15 s after its last beat; the beat keeps the ratio of a third.
  leaseMs: 15_000,
  heartbeatMs: 5_000,
  handshakeRetryMs: 2_000,
  // Above a first start of Jellyfin 12.4, which up() and startJellyfin() wait out before any setup step runs.
  jellyfinReachableMs: 20_000,
  playbackPollMs: 2_000,
  backoffBaseMs: 1_000,
} as const satisfies Partial<Record<TestLimitKey, number>>;
export type E2ELimits = Partial<Record<TestLimitKey, number>>;
/** This stack's `OMNARR_TEST_LIMITS`, as JSON. */
let testLimits = JSON.stringify(E2E_LIMITS);

/** Phase times of the stack's start, for the e2e speed report: to stderr, as the runner hides a passing test's output. */
const timed = <T>(what: string, run: () => T): T => {
  const started = Date.now();
  const result = run();
  const end = () => process.stderr.write(`STACK: ${what} ${((Date.now() - started) / 1000).toFixed(1)} s\n`);
  if (result instanceof Promise) return result.finally(end) as T;
  end();
  return result;
};
/** The NNTP fake's login (compose.test.yml). */
export const NNTP_USER = 'test-nntp-user';
export const NNTP_PASS = 'test-nntp-password';
/** The backup NNTP fake's login (compose.test.yml's `nntp-backup`); the `pipeline` scenario plants the password. */
export const NNTP_BACKUP_USER = 'test-nntp-backup';
export const NNTP_BACKUP_PASS = 'test-nntp-backup-password';
export const NEWZNAB_KEY = 'test-newznab-key';

/**
 * Every value a test can plant and look for later. The admin and setup passwords are random per run;
 * the rest the stack generates itself (`setup`, the backend), and up() reads them back.
 */
export const secrets = {
  adminPassword: `e2e-admin-${randomBytes(8).toString('hex')}`,
  setupPassword: `e2e-setup-${randomBytes(8).toString('hex')}`,
  instanceSecret: '',
  workerToken: '',
  betterAuthSecret: '',
};

/** The deployment `up()` brought up last, for the failure dump. */
let lastEnv: NodeJS.ProcessEnv | undefined;
/** Set by a failed test (failures.ts) or a failed `up()`: `down()` then writes the failure dump first. */
let failed = false;
/** Every `waitFor` timeout of this stack, with its `explain` state, for the failure dump. */
const timeouts: string[] = [];
export const markFailed = (test?: string): void => {
  failed = true;
  if (test) brokenTests.add(test);
};
/** The tests of this file that failed, or were skipped by `after()`: a test that needs one skips too. */
const brokenTests = new Set<string>();

/**
 * Skips the running test when a test it needs failed (or was itself skipped), named by the start of its
 * name, as `after(ctx, 'S01E01 is downloaded')`: it would only wait out its own timeout on state that never came.
 */
export function after(ctx: { task: { name: string }; skip: (note?: string) => never }, ...needs: string[]): void {
  const broken = needs.filter((need) => [...brokenTests].some((name) => name.startsWith(need)));
  if (broken.length === 0) return;
  brokenTests.add(ctx.task.name);
  ctx.skip(`it needs ${broken.join(', ')}, which failed`);
}

/**
 * The compose project's folder, a temporary one as an install folder is: the root files' ./vpn and
 * ./backups land in it. vpn/ is open to all, since the worker writes it as uid 1000, which
 * on Linux isn't the runner's. Made again by each `up()`; `down()` removes it.
 */
let projectDir = '';
function ensureProjectDir(): string {
  if (!projectDir) {
    projectDir = mkdtempSync(join(tmpdir(), 'omnarr-e2e-'));
    mkdirSync(join(projectDir, 'vpn'));
    chmodSync(join(projectDir, 'vpn'), 0o777);
  }
  return projectDir;
}

/** The host ports this stack publishes, on 127.0.0.1; free ones, picked by up(). */
export const ports = { web: 0, convex: 0, convexSite: 0, jellyfin: 0 };
const freePort = () =>
  new Promise<number>((resolve, reject) => {
    const server = createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as { port: number };
      server.close(() => resolve(port));
    });
  });

/**
 * The `.env` values of this stack beyond the ports: what a scenario sets with up({ env })
 * or setEnv(), as a user edits `.env`. An empty value counts as unset.
 */
let dotEnv: Record<string, string> = {};

/** The project images the stack runs: this build's, unless stackUpgrade runs a release's (useRelease). */
export type ProjectImages = { backend: string; worker: string; web: string };
let images: ProjectImages = { backend: BACKEND_IMAGE, worker: WORKER_IMAGE, web: WEB_IMAGE };
/** The folder of the shipped compose files: the checkout's, unless stackUpgrade runs a release's. */
let shippedDir = root;

/**
 * stackUpgrade: the next compose calls run a release's files and images, as a user who
 * replaced the compose files and pulled. Without arguments, this build's again.
 */
export function useRelease(release?: { dir: string; images: ProjectImages }): void {
  images = release?.images ?? { backend: BACKEND_IMAGE, worker: WORKER_IMAGE, web: WEB_IMAGE };
  shippedDir = release?.dir ?? root;
}

const composeEnv = (extra: Record<string, string> = {}): NodeJS.ProcessEnv => ({
  ...process.env,
  E2E_WORKER_IMAGE: images.worker,
  E2E_BACKEND_IMAGE: images.backend,
  E2E_WEB_IMAGE: images.web,
  E2E_FAKES: join(here, 'fakes'),
  E2E_VPN_NEAR: VPN_NET.near,
  E2E_VPN_FAR: VPN_NET.far,
  E2E_TEST_LIMITS: testLimits,
  // The install's settings: on loopback, on free ports, /data a named volume (compose.test.yml).
  OMNARR_BIND_ADDRESS: '127.0.0.1',
  OMNARR_WEB_PORT: String(ports.web),
  OMNARR_CONVEX_PORT: String(ports.convex),
  OMNARR_CONVEX_SITE_PORT: String(ports.convexSite),
  OMNARR_JELLYFIN_PORT: String(ports.jellyfin),
  OMNARR_DATA_DIR: 'e2e-data',
  OMNARR_SETUP_PASSWORD: secrets.setupPassword,
  COMPOSE_FILE: '',
  ...dotEnv,
  ...extra,
});

let limitedFailure = '';

/**
 * The compose files of the stack's layout: `direct` is the root compose.yml with the
 * test override; `wireguard` adds the vpn scenario's WireGuard server and its networks, still in the
 * direct layout; `vpn` adds the root compose.vpn.yml, as `COMPOSE_FILE=compose.yml:compose.vpn.yml`
 * does, after the override so its `!reset`s clear qBittorrent's test network.
 */
export type StackLayout = 'direct' | 'wireguard' | 'vpn';
let stackLayout: StackLayout = 'direct';

const layoutFiles = (layout: StackLayout): string[] =>
  ({
    direct: [join(shippedDir, 'compose.yml'), join(here, 'compose.test.yml')],
    wireguard: [join(shippedDir, 'compose.yml'), join(here, 'compose.test.yml'), join(here, 'compose.wireguard.test.yml')],
    vpn: [
      join(shippedDir, 'compose.yml'),
      join(here, 'compose.test.yml'),
      join(here, 'compose.wireguard.test.yml'),
      join(shippedDir, 'compose.vpn.yml'),
      join(here, 'compose.vpn.test.yml'),
    ],
  })[layout];
const composeFiles = () => ['--project-directory', ensureProjectDir(), ...layoutFiles(stackLayout).flatMap((file) => ['-f', file])];

export function compose(args: string[], profiles = ['test'], input?: string): string {
  // `--wait` alone waits forever on a service that never turns healthy, such as a backend whose hook fails.
  const waitTimeout = args.includes('--wait') && !args.includes('--wait-timeout') ? ['--wait-timeout', '600'] : [];
  const result = spawnSync('docker', ['compose', '-p', PROJECT, ...composeFiles(), ...profiles.flatMap((p) => ['--profile', p]), ...args, ...waitTimeout], {
    env: composeEnv({ E2E_LIMITED_FAILURE: limitedFailure }),
    ...(input === undefined ? {} : { input }),
    encoding: 'utf8',
    // spawnSync's 1 MB default cut CI's backend log off (`docker compose logs` failed, run 44448549101).
    maxBuffer: 256 * 1024 * 1024,
  });
  if (result.status !== 0) throw new Error(`docker compose ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

/**
 * A user's `.env` change: the values take effect at the next compose call, as at the user's
 * next `docker compose up -d`. An empty value unsets one.
 */
export function setEnv(values: Record<string, string>): void {
  dotEnv = { ...dotEnv, ...values };
}

/**
 * One NZBGet JSON-RPC call, made from inside the worker container with the
 * control password setup-clients generated: NZBGet's port isn't
 * published, and the secret never leaves the stack.
 */
export function nzbgetRpc<T>(method: string, params: unknown[] = []): T {
  const script = [
    "const fs = require('node:fs');",
    "const password = fs.readFileSync('/run/omnarr/secrets/nzbget_control_password', 'utf8').trim();",
    "const auth = 'Basic ' + Buffer.from('omnarr:' + password).toString('base64');",
    `fetch('http://nzbget:6789/jsonrpc', { method: 'POST', headers: { authorization: auth, 'content-type': 'application/json' }, body: JSON.stringify({ method: ${JSON.stringify(method)}, params: ${JSON.stringify(params)}, id: 1 }) })`,
    '  .then((r) => r.json()).then((body) => process.stdout.write(JSON.stringify(body.result)));',
  ].join('\n');
  return JSON.parse(compose(['exec', '-T', 'worker', 'node', '-e', script], ['test', 'worker'])) as T;
}

/**
 * One qBittorrent WebUI API call (`GET /api/v2/<path>`), made from inside the
 * worker container after logging in with the control password setup-clients
 * generated. Answers JSON as parsed, anything else as text.
 */
export function qbittorrentApi<T>(path: string): T {
  // In the VPN layout qBittorrent is in gluetun's network namespace.
  const base = stackLayout === 'vpn' ? 'http://gluetun:8080' : 'http://qbittorrent:8080';
  const script = [
    "const fs = require('node:fs');",
    "const password = fs.readFileSync('/run/omnarr/secrets/qbittorrent_control_password', 'utf8').trim();",
    '(async () => {',
    `  const login = await fetch('${base}/api/v2/auth/login', { method: 'POST', body: new URLSearchParams({ username: 'omnarr', password }) });`,
    "  const cookie = (login.headers.get('set-cookie') || '').split(';')[0];",
    `  const res = await fetch('${base}/api/v2/' + ${JSON.stringify(path)}, { headers: { cookie } });`,
    '  process.stdout.write(await res.text());',
    '})();',
  ].join('\n');
  const out = compose(['exec', '-T', 'worker', 'node', '-e', script], ['test', 'worker']);
  try {
    return JSON.parse(out) as T;
  } catch {
    return out as T;
  }
}

/**
 * One call to gluetun from inside the worker container: a control-server route with the API key
 * setup-clients generated, or without it, or the health server. Answers the HTTP
 * status and body.
 */
export function gluetunApi(path: string, { key = true, port = 8000 }: { key?: boolean; port?: number } = {}): { status: number; body: string } {
  const script = [
    "const fs = require('node:fs');",
    `const headers = ${key} ? { 'x-api-key': fs.readFileSync('/run/omnarr/secrets/gluetun_api_key', 'utf8').trim() } : {};`,
    `fetch('http://gluetun:${port}' + ${JSON.stringify(path)}, { headers, signal: AbortSignal.timeout(10000) })`,
    '  .then(async (r) => process.stdout.write(JSON.stringify({ status: r.status, body: await r.text() })))',
    '  .catch((e) => process.stdout.write(JSON.stringify({ status: 0, body: String(e.cause?.code ?? e.name) })));',
  ].join('\n');
  return JSON.parse(compose(['exec', '-T', 'worker', 'node', '-e', script], ['test', 'worker'])) as { status: number; body: string };
}

/** Runs a command in a stack container and answers its output, or throws with it. */
export const exec = (service: string, command: string[], profiles = ['test', 'worker']) => compose(['exec', '-T', service, ...command], profiles);

/** The files in the worker's vpn/ folder, as the host sees them. */
export const vpnFiles = (): string[] =>
  readdirSync(join(ensureProjectDir(), 'vpn'))
    .filter((name) => !name.startsWith('.'))
    .sort();

/** The test WireGuard server's peer config, which linuxserver/wireguard generates at its first start. */
export const wireguardPeerConf = (): Promise<string> =>
  waitFor('the WireGuard peer config', async () => exec('wgserver', ['cat', '/config/peer1/peer1.conf'], ['test']) || undefined, 120_000, 500);

/**
 * Starts the test WireGuard server (again) and lets it forward its peers' traffic only to the web
 * seed's network (e2e/compose.wireguard.test.yml). The rule goes first in FORWARD, before the
 * ACCEPT rules WireGuard's PostUp appends; a new container start needs it again.
 */
export async function startWireguardServer(): Promise<void> {
  compose(['start', 'wgserver']);
  await wireguardPeerConf();
  const rule = ['FORWARD', '-i', 'wg0', '!', '-d', `${VPN_NET.far}.0/24`, '-j', 'DROP'];
  try {
    exec('wgserver', ['iptables', '-C', ...rule], ['test']);
  } catch {
    exec('wgserver', ['iptables', '-I', rule[0]!, '1', ...rule.slice(1)], ['test']);
  }
}
/** The outage: the WireGuard server's container goes down at once. */
export const stopWireguardServer = () => compose(['stop', '--timeout', '0', 'wgserver']);

/** Gluetun v3.41.3's small health check: a minute after each tunnel up, then every minute (internal/healthcheck/checker.go). */
const GLUETUN_CHECK_PERIOD_MS = 60_000;
/** How long before that check the server goes down, for the clocks of Docker's log and this process. */
const CHECK_MARGIN_MS = 4_000;

/**
 * Stops the WireGuard server just before gluetun's next small health check, so that check, which then
 * retries for 120 s before the health server answers 500, is the first one after the outage: gluetun
 * sees a dead WireGuard tunnel only through it, and its periods are constants. Its timer starts as
 * the tunnel comes up, a moment before the exit-IP lookup logs "Public IP address is". Waits up to a
 * minute for that moment, which saves the up to a minute the check would otherwise come later, and
 * makes the time to `down` the same on every run. Answers when the server stopped.
 */
export async function stopWireguardBeforeHealthCheck(): Promise<number> {
  const tunnelUp = compose(['logs', '--no-color', '--timestamps', 'gluetun'], ['test', 'worker'])
    .split('\n')
    .filter((line) => line.includes('Public IP address is'))
    .at(-1);
  const stamp = tunnelUp && /\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d(\.\d+)?Z/.exec(tunnelUp)?.[0];
  if (!stamp) throw new Error("gluetun's log has no exit IP, so its health check can't be timed");
  let check = Date.parse(stamp.replace(/(\.\d{3})\d*/, '$1')) + GLUETUN_CHECK_PERIOD_MS;
  while (check - CHECK_MARGIN_MS < Date.now() + 500) check += GLUETUN_CHECK_PERIOD_MS;
  await sleep(check - CHECK_MARGIN_MS - Date.now());
  stopWireguardServer();
  return Date.now();
}

/** The test OpenVPN server's client config, with `tls-exit` as gluetun's built-in providers have it (e2e/fakes/openvpn/pki.sh). */
export const openvpnClientConf = (): string => exec('ovpnserver', ['cat', '/ovpn/client.ovpn'], ['test']);

const OPENVPN_BLOCK = [
  ['INPUT', '-p', 'udp', '--dport', '1194', '-j', 'DROP'],
  ['OUTPUT', '-p', 'udp', '--sport', '1194', '-j', 'DROP'],
];
/**
 * Makes the test OpenVPN server unreachable both ways, as blocking PIA's servers does, or
 * reachable again. The server keeps running, so OpenVPN's client times out rather than being refused.
 */
export function blockOpenvpnServer(blocked: boolean): void {
  for (const rule of OPENVPN_BLOCK) exec('ovpnserver', ['iptables', blocked ? '-I' : '-D', ...rule], ['test']);
}

/**
 * The user's step after choosing a VPN: COMPOSE_FILE gains compose.vpn.yml and
 * `docker compose up -d` runs. Gluetun starts, and qBittorrent and the worker are recreated: the
 * worker with GLUETUN_URL, qBittorrent in gluetun's network.
 */
export function switchToVpnLayout(): void {
  stackLayout = 'vpn';
  compose(['up', '-d', '--wait'], ['test', 'worker']);
}

/** Whether a path exists under /data, seen from the worker container. */
export const dataPathExists = (path: string): boolean =>
  compose(
    ['exec', '-T', 'worker', 'node', '-e', `process.stdout.write(String(require('node:fs').existsSync(${JSON.stringify(path)})))`],
    ['test', 'worker'],
  ) === 'true';

/** The Convex calls a scenario makes as the admin. */
export type AdminClient = Pick<ConvexHttpClient, 'query' | 'mutation' | 'action'> & {
  /** Signs in again, as after a password change, which ends every other session. */
  signIn: (password: string) => Promise<void>;
};

export type Deployment = {
  url: string;
  /** The backend's HTTP actions (3211), where Better Auth runs. */
  siteUrl: string;
  /** The web app's origin, which Better Auth trusts by its port. */
  webUrl: string;
  /** With the admin key, for `rows()` and the test variables. */
  env: NodeJS.ProcessEnv;
  admin: AdminClient;
  jellyfinUrl: string;
};

/** The platform admin first run creates, whose password the Jellyfin admin shares. */
export const ADMIN = { username: 'admin', password: secrets.adminPassword };

/**
 * What the crossDomain client sends back as `Better-Auth-Cookie`: each cookie's name=value from a
 * `Set-Better-Auth-Cookie` header, for sessions across origins.
 */
export const cookieOf = (setCookie: string | null): string =>
  (setCookie ?? '')
    .split(/,\s*(?=[^;,=\s]+=)/)
    .map((part) => part.split(';')[0]!.trim())
    .filter((pair) => pair && !pair.endsWith('='))
    .join('; ');

/** One Better Auth route on the site URL, as the web app calls it: from its origin, the session in a header. */
export async function authFetch(
  siteUrl: string,
  origin: string,
  path: string,
  init: { body?: object; cookie?: string; method?: string } = {},
): Promise<{ status: number; cookie: string; body: unknown }> {
  const response = await fetch(`${siteUrl}/api/auth${path}`, {
    method: init.method ?? (init.body ? 'POST' : 'GET'),
    headers: { origin, 'better-auth-cookie': init.cookie ?? '', ...(init.body ? { 'content-type': 'application/json' } : {}) },
    ...(init.body ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // Not JSON: kept as text.
  }
  return { status: response.status, cookie: cookieOf(response.headers.get('set-better-auth-cookie')), body };
}

/**
 * A Convex client signed in as the admin through Better Auth: each call carries the
 * Convex JWT `/api/auth/convex/token` gives for the session, fetched again before its 15 minutes run out.
 */
function adminClient(url: string, siteUrl: string, origin: string): AdminClient {
  const client = new ConvexHttpClient(url);
  let cookie = '';
  let tokenAt = 0;
  const fresh = async () => {
    if (Date.now() - tokenAt < 10 * 60_000) return;
    const { status, body } = await authFetch(siteUrl, origin, '/convex/token', { cookie });
    const token = (body as { token?: string } | null)?.token;
    if (status !== 200 || !token) throw new Error(`The admin's Convex token: HTTP ${status}`);
    client.setAuth(token);
    tokenAt = Date.now();
  };
  return {
    query: (async (ref: never, args: never) => (await fresh(), client.query(ref, args))) as ConvexHttpClient['query'],
    mutation: (async (ref: never, args: never) => (await fresh(), client.mutation(ref, args))) as ConvexHttpClient['mutation'],
    action: (async (ref: never, args: never) => (await fresh(), client.action(ref, args))) as ConvexHttpClient['action'],
    signIn: async (password) => {
      const result = await authFetch(siteUrl, origin, '/sign-in/username', { body: { username: ADMIN.username, password } });
      if (result.status !== 200 || !result.cookie) throw new Error(`The admin's sign-in: HTTP ${result.status}`);
      cookie = result.cookie;
      tokenAt = 0;
    },
  };
}

function convex(args: string[], env: NodeJS.ProcessEnv, timeoutMs = 120_000): string {
  // Bounded: the CLI retries a stopped backend forever, and a blocked spawnSync stops vitest's own timeouts.
  const result = spawnSync(join(backendDir, 'node_modules/.bin', args[0]!), args.slice(1), { cwd: backendDir, env, encoding: 'utf8', timeout: timeoutMs });
  if (result.status !== 0) throw new Error(`${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

/**
 * Polls `probe` until it answers a value. A probe that throws is polled again. On timeout, `explain`'s
 * answer (the state the wait was stuck in, say) is added to the error, and so is the probe's last error.
 */
async function waitFor<T>(
  what: string,
  probe: () => Promise<T | undefined>,
  timeoutMs = 120_000,
  everyMs = 1_000,
  explain?: () => Promise<string> | string,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let lastError: unknown;
  for (;;) {
    const value = await probe().catch((error: unknown) => void (lastError = error));
    if (value !== undefined) return value;
    if (Date.now() > deadline) {
      const text = (error: unknown) => (error instanceof Error ? error.message : JSON.stringify(error));
      const state = explain ? await Promise.resolve(explain()).catch((error: unknown) => `(explain failed: ${text(error)})`) : undefined;
      const parts = [`Timed out waiting for ${what}.`, ...(state ? [`State: ${state}`] : []), ...(lastError ? [`Last probe error: ${text(lastError)}`] : [])];
      // Kept for the failure dump too, since a later wait's error can hide this one.
      timeouts.push(parts.join('\n'));
      throw new Error(parts.join('\n'));
    }
    await sleep(everyMs);
  }
}

/** A deployment variable's value, or '' when it isn't set. */
export const deploymentVariable = (env: NodeJS.ProcessEnv, name: string): string => {
  // The last line: while a backend restarts, the CLI prints its reconnect attempts first.
  const out = convex(['convex', 'env', 'get', name], env).trim().split('\n').at(-1)!.trim();
  return out.startsWith('Environment variable') ? '' : out;
};

/** One JSON line per document of a table, as `convex data` prints it. */
export const rows = <T>(env: NodeJS.ProcessEnv, table: string, component?: string, timeoutMs?: number): T[] =>
  jsonLines<T>(
    convex(['convex', 'data', table, '--format', 'jsonLines', '--limit', '10000', ...(component ? ['--component', component] : [])], env, timeoutMs),
  );

/** The documents of `convex data`'s output: only its `{` lines, since while a backend restarts the CLI prints its reconnect attempts first. */
export const jsonLines = <T>(out: string): T[] =>
  out
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.startsWith('{'))
    .map((line) => JSON.parse(line) as T);

export type UpOptions = {
  /** Saved as first run's step 1.5 saves it: the torrents scenario's one-minute goal. */
  torrents?: { seedGoal: { ratio?: number; seedTimeMs?: number } };
  /** The stall time, as `limits: { torrentStallMs }`; kept for the scenarios that name it so. */
  torrentStallMs?: number;
  /** Timers to lower beyond E2E_LIMITS, or to set otherwise, for this stack's worker and backend. */
  limits?: E2ELimits;
  /** `wireguard`: the vpn scenario, which starts in the direct layout with the test WireGuard server. */
  layout?: Exclude<StackLayout, 'vpn'>;
  /** The install's `.env` values beyond the ports (setEnv); `OMNARR_SETUP_PASSWORD: ''` lets setup generate one. */
  env?: Record<string, string>;
  /**
   * `false`: only `docker compose up`, the test variables and the admin key; no admin, so a
   * scenario creates the admin itself (the install scenario).
   */
  firstRun?: boolean;
  /** Runs before the admin is created, so Jellyfin's setup job meets it (the setup outage stops Jellyfin here). */
  beforeAdmin?: () => void;
};

/**
 * The S02E01 release's file (fakes/usenet/catalogue.ts), made once per host with
 * the worker image's ffmpeg, so the host needs none, and kept in the host's
 * cache (host.ts), keyed on the ffmpeg arguments, for every checkout's runs.
 * The checkout gets a hard link, or a copy across file systems, since the
 * fakes mount only e2e/fakes/. It is written under another name and renamed,
 * so an interrupted run leaves no partial file behind. The container runs as
 * the host user, so the file is the user's on Linux too.
 */
function generateMedia(): void {
  const target = join(here, 'fakes/usenet/media', GENERATED_MEDIA.file);
  if (existsSync(target)) return;
  const cached = cachedMediaPath(GENERATED_MEDIA.ffmpegArgs);
  if (!existsSync(cached)) {
    process.stderr.write(`STACK: generating ${basename(cached)} into ${dirname(cached)}\n`);
    ffmpegInto(cached);
  }
  mkdirSync(dirname(target), { recursive: true });
  const partial = `${target}.partial`;
  try {
    linkSync(cached, partial);
  } catch {
    copyFileSync(cached, partial);
  }
  renameSync(partial, target);
}

function ffmpegInto(target: string): void {
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true });
  // Per process, so two checkouts generating at once don't write one file.
  const partial = `${basename(target, '.mkv')}.${process.pid}.partial.mkv`;
  const user = `${process.getuid?.() ?? 1000}:${process.getgid?.() ?? 1000}`;
  execFileSync(
    'docker',
    [
      'run',
      '--rm',
      '--user',
      user,
      '-v',
      `${dir}:/out`,
      '-w',
      '/out',
      '--entrypoint',
      'ffmpeg',
      WORKER_IMAGE,
      '-hide_banner',
      '-loglevel',
      'error',
      '-nostdin',
      '-y',
      ...GENERATED_MEDIA.ffmpegArgs,
      partial,
    ],
    { stdio: 'inherit' },
  );
  renameSync(join(dir, partial), target);
}

/**
 * Builds the three images, brings the shipped stack up without a worker (the
 * backend applies the release and its hooks itself), and drives first run:
 * the admin, the Usenet provider and the torrent settings when asked. The
 * admin's creation enqueues Jellyfin's setup, which runs once a worker starts.
 */
export async function up(options: UpOptions = {}): Promise<Deployment> {
  try {
    return await bringUp(options);
  } catch (error) {
    // A beforeAll failure skips every test, so no test marks it; the dump still has to happen.
    markFailed();
    throw error;
  }
}

async function bringUp(options: UpOptions): Promise<Deployment> {
  const started = Date.now();
  stackLayout = options.layout ?? 'direct';
  testLimits = JSON.stringify({
    ...E2E_LIMITS,
    ...(options.torrentStallMs === undefined ? {} : { torrentStallMs: options.torrentStallMs }),
    ...options.limits,
  });
  // A key tests may not lower, or a value above its default, fails here rather than in the worker's log.
  limitsFrom(testLimits);
  dotEnv = { ...options.env };
  for (const key of ['web', 'convex', 'convexSite', 'jellyfin'] as const) ports[key] = await freePort();
  const built = buildImages();
  if (built > 0) process.stderr.write(`STACK: images ${built.toFixed(1)} s\n`);
  timed('media', generateMedia);
  // `--wait`: the backend is healthy only after its pre-push hook, the release and its post-apply hook.
  timed('compose up', () => compose(['up', '-d', '--wait']));
  if (stackLayout === 'wireguard') await timed('WireGuard server', startWireguardServer);
  const url = `http://127.0.0.1:${ports.convex}`;
  const siteUrl = `http://127.0.0.1:${ports.convexSite}`;
  const webUrl = `http://127.0.0.1:${ports.web}`;
  const jellyfinUrl = `http://127.0.0.1:${ports.jellyfin}`;
  // The admin key, derived inside the backend container, for `rows()` and the test variables only.
  const adminKey = compose(['exec', '-T', 'backend', './generate_admin_key.sh']).trim().split('\n').at(-1)!;
  const env = { ...process.env, CONVEX_SELF_HOSTED_URL: url, CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey, CONVEX_DEPLOYMENT: '', CONVEX_DEPLOY_KEY: '' };
  lastEnv = env;
  readGeneratedSecrets();

  // The test variables: the fakes, offline Jellyfin libraries and the lowered timers. No managed name,
  // so the pre-push hook leaves them on every backend start.
  timed('test variables', () => setTestVariables(env));
  const admin = adminClient(url, siteUrl, webUrl);
  const d: Deployment = { url, siteUrl, webUrl, env, admin, jellyfinUrl };
  if (options.firstRun === false) return d;

  // First run through the public functions, as the first-run page calls them.
  const firstRun = Date.now();
  options.beforeAdmin?.();
  // It started with the stack; setup's reachable step allows only E2E_LIMITS' jellyfinReachableMs.
  if (!options.beforeAdmin) await timed('Jellyfin answering', () => jellyfinAnswers(jellyfinUrl));
  await createAdmin(d);
  // Devices: each library gets its own profile, following Chrome and the Jellyfin Android app.
  await admin.mutation(makeFunctionReference<'mutation'>('api/playback:setupDefaults'), { devices: ['chrome', 'jellyfinAndroid'] });
  // Usenet: the provider is saved; the worker's first pass applies it to NZBGet.
  await admin.mutation(makeFunctionReference<'mutation'>('api/downloadClients:saveUsenet'), {
    input: { host: 'nntp', port: 119, ssl: false, username: NNTP_USER, password: NNTP_PASS, connections: 4 },
  });
  // Torrents: on, with the scenario's goal; the worker's first pass applies it to qBittorrent.
  if (options.torrents)
    await admin.mutation(makeFunctionReference<'mutation'>('api/downloadClients:saveTorrents'), { input: { enabled: true, ...options.torrents } });
  process.stderr.write(`STACK: first run ${((Date.now() - firstRun) / 1000).toFixed(1)} s\n`);
  process.stderr.write(`STACK: up ${((Date.now() - started) / 1000).toFixed(1)} s\n`);
  return d;
}

/** The secrets the stack generated, read back for the planted-secrets checks: `setup`'s two and the backend's own. */
export function readGeneratedSecrets(): void {
  const backendSecret = (name: string) => compose(['exec', '-T', 'backend', 'cat', `/run/omnarr/backend-secrets/${name}`]).trim();
  secrets.workerToken = backendSecret('worker_token');
  secrets.betterAuthSecret = backendSecret('better_auth_secret');
  secrets.instanceSecret = compose(['exec', '-T', 'backend', 'cat', '/convex/data/credentials/instance_secret']).trim();
}

/**
 * After a restore into an empty deployment: the backend has a new instance secret, so a new
 * admin key, and the export held no environment variables, so the test variables are set again.
 */
export function afterRestore(d: Deployment): void {
  d.env.CONVEX_SELF_HOSTED_ADMIN_KEY = compose(['exec', '-T', 'backend', './generate_admin_key.sh']).trim().split('\n').at(-1)!;
  readGeneratedSecrets();
  setTestVariables(d.env);
}

/** The deployment's test variables, in one CLI call. */
function setTestVariables(env: NodeJS.ProcessEnv): void {
  const variables = {
    TMDB_API_URL: 'http://tmdb:8000',
    // The fake serves the image CDN's /t/p/ paths too.
    TMDB_IMAGE_URL: 'http://tmdb:8000',
    // Libraries without metadata or image fetchers, so Jellyfin needs no internet.
    JELLYFIN_OFFLINE_LIBRARIES: '1',
    // Nyaa is the fake, never nyaa.si.
    NYAA_URL: 'http://nyaa:4140',
    // Sonarr's scene mappings are the fake, never services.sonarr.tv.
    SCENE_MAPPINGS_URL: 'http://scenemapping:4150/v1/scenemapping',
    // The backend's lowered timers, the worker's too (E2E_LIMITS).
    OMNARR_TEST_LIMITS: testLimits,
  };
  const file = join(ensureProjectDir(), 'test-variables.env');
  writeFileSync(
    file,
    Object.entries(variables)
      .map(([name, value]) => `${name}='${value}'\n`)
      .join(''),
  );
  convex(['convex', 'env', 'set', '--from-file', file], env);
}

/** The admin account: `setup.createAdmin` with the setup password, then the admin client signs in. */
export async function createAdmin(d: Deployment, setupPassword = secrets.setupPassword): Promise<void> {
  const result = await new ConvexHttpClient(d.url).action(makeFunctionReference<'action'>('api/setup:createAdmin'), {
    setupPassword,
    username: ADMIN.username,
    password: ADMIN.password,
    locale: 'en-US',
  });
  if (!(result as { ok?: boolean }).ok) throw new Error(`setup.createAdmin: ${JSON.stringify(result)}`);
  await d.admin.signIn(ADMIN.password);
}

/** Waits until Jellyfin answers `GET /System/Info/Public`: a first start of 12.4 (an empty /config) runs its migrations first. */
export const jellyfinAnswers = (jellyfinUrl: string) =>
  waitFor('Jellyfin to answer', async () => ((await fetch(`${jellyfinUrl}/System/Info/Public`)).ok ? true : undefined), 180_000, 500);

type JellyfinStatus = { state: string; steps: { step: string; state: string; reason?: string }[]; version?: string };

/** `api.jellyfin.status`, by name: the backend's generated API isn't a dependency of this package. */
export const jellyfinStatus = (d: Deployment): Promise<JellyfinStatus> => d.admin.query(makeFunctionReference<'query'>('api/jellyfin:status'), {});

/**
 * Starts the worker, which runs the Jellyfin setup the admin's creation enqueued, and waits until
 * Jellyfin is ready.
 */
export async function setUpJellyfinThroughProduct(d: Deployment): Promise<JellyfinStatus> {
  startWorker('worker');
  return await waitFor(
    'Jellyfin to be set up',
    async () => {
      const status = await jellyfinStatus(d);
      return status.state === 'ready' ? status : undefined;
    },
    300_000,
    500,
  );
}

/** Stops and starts Jellyfin: the setup outage. */
export const stopJellyfin = () => compose(['stop', 'jellyfin']);
/** Resolves once Jellyfin answers, as its reachable step allows only E2E_LIMITS' jellyfinReachableMs. */
export async function startJellyfin(d: Deployment): Promise<void> {
  compose(['start', 'jellyfin']);
  await jellyfinAnswers(d.jellyfinUrl);
}

/** Signs in to Jellyfin as the admin, as a user's device does; the HTTP status says whether the password works. */
export async function jellyfinSignIn(d: Deployment, password: string): Promise<number> {
  const response = await fetch(`${d.jellyfinUrl}/Users/AuthenticateByName`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'MediaBrowser Client="omnarr-e2e", Device="e2e", DeviceId="omnarr-e2e", Version="1"' },
    body: JSON.stringify({ Username: ADMIN.username, Pw: password }),
  });
  return response.status;
}

/** Starts (or restarts) a worker profile: `worker`, or `worker-old` for the old-worker tests. */
export const startWorker = (profile: 'worker' | 'worker-old') => compose(['up', '-d', profile], ['test', profile]);

/** The second indexer starts answering every request with its API limit (error 500). */
export function limitSecondIndexer(): void {
  limitedFailure = 'limit500';
  compose(['up', '-d', '--wait', 'newznab-limited']);
}
export const stopWorker = (profile: 'worker' | 'worker-old') => compose(['stop', profile], ['test', profile]);
/** The worker dies at once (SIGKILL, as `docker kill`), with no chance to release its jobs. */
export const killWorker = () => compose(['kill', 'worker'], ['test', 'worker']);
/**
 * The supervision pass the backend's cron runs every 30 s (crons.ts), run now: jobs whose lease expired
 * go back to the queue. The e2e calls it once a lease (E2E_LIMITS' leaseMs) is over, instead of waiting
 * for the cron.
 */
export const supervise = (d: Deployment) => convex(['convex', 'run', 'jobs/queue:supervise'], d.env);

/** Runs an internal function with the admin key, as a cron would (the nyaa scenario's RSS fetch and backfill search). */
export const runInternal = (d: Deployment, name: string, args: object = {}): string => convex(['convex', 'run', name, JSON.stringify(args)], d.env);

/** One call to the fake Nyaa's control routes, from inside its container (fakes/nyaa/server.ts). */
export function nyaaFake<T = void>(path: string, method: 'GET' | 'POST' = 'GET'): T {
  const script = `fetch('http://127.0.0.1:4140${path}', { method: '${method}' }).then(async (r) => process.stdout.write(r.status === 200 ? await r.text() : ''))`;
  const out = compose(['exec', '-T', 'nyaa', 'node', '-e', script]);
  return (out ? JSON.parse(out) : undefined) as T;
}

/** One call to the fake definitions server and Star Site's control routes, from inside its container (fakes/sites/server.ts). */
export function sitesFake<T = void>(path: string, method: 'GET' | 'POST' = 'GET'): T {
  const script = `fetch('http://127.0.0.1:4160${path}', { method: '${method}' }).then(async (r) => process.stdout.write(r.status === 200 ? await r.text() : ''))`;
  const out = compose(['exec', '-T', 'sites', 'node', '-e', script]);
  return (out ? JSON.parse(out) : undefined) as T;
}

/** The scene-mapping fake's request log, read from inside its container (fakes/scenemapping/server.ts). */
export function sceneMappingRequests(): { path: string; userAgent?: string }[] {
  const script = `fetch('http://127.0.0.1:4150/_fake/requests').then(async (r) => process.stdout.write(await r.text()))`;
  return JSON.parse(compose(['exec', '-T', 'scenemapping', 'node', '-e', script]));
}

/** The files under a folder of the /data volume, relative to it and sorted, read inside the running worker. */
export const dataFiles = (folder: string): string[] =>
  compose(['exec', '-T', 'worker', 'find', folder, '-type', 'f'], ['test', 'worker'])
    .split('\n')
    .filter(Boolean)
    .map((path) => path.slice(folder.length + 1))
    .sort();

/** The folders right under a folder of the /data volume, read inside the running worker. */
export const dataFolders = (folder: string): string[] =>
  compose(['exec', '-T', 'worker', 'find', folder, '-mindepth', '1', '-maxdepth', '1', '-type', 'd'], ['test', 'worker'])
    .split('\n')
    .filter(Boolean)
    .map((path) => path.slice(folder.length + 1))
    .sort();
export const logs = (service: string) => compose(['logs', '--no-color', service], ['test', 'worker', 'worker-old']);
/** The same, each line with Docker's timestamp: the e2e measures job times from the worker's log. */
export const timestampedLogs = (service: string) => compose(['logs', '--no-color', '--timestamps', service], ['test', 'worker', 'worker-old']);

/** Jellyfin's episodes, by path, read with the key setup stored. */
export async function jellyfinItems(d: Deployment): Promise<{ Id: string; Path?: string; Type: string }[]> {
  const [server] = rows<{ apiKey?: string }>(d.env, 'jellyfinServer');
  const response = await fetch(`${d.jellyfinUrl}/Items?Recursive=true&Fields=Path&IncludeItemTypes=Episode`, {
    headers: { authorization: `MediaBrowser Token="${server?.apiKey}"` },
  });
  return ((await response.json()) as { Items: { Id: string; Path?: string; Type: string }[] }).Items;
}

/** An episode or series as Jellyfin lists it, with the numbers it read from the path. */
export type JellyfinListed = { Id: string; Path?: string; Type: string; ParentIndexNumber?: number; IndexNumber?: number; SeriesId?: string };

/** Jellyfin's series and episodes, with their paths, numbers and series, read with the key setup stored. */
export async function jellyfinSeriesItems(d: Deployment): Promise<{ series: JellyfinListed[]; episodes: JellyfinListed[] }> {
  const [server] = rows<{ apiKey?: string }>(d.env, 'jellyfinServer');
  const list = async (type: string) =>
    (
      (await (
        await fetch(`${d.jellyfinUrl}/Items?Recursive=true&Fields=Path&IncludeItemTypes=${type}`, {
          headers: { authorization: `MediaBrowser Token="${server?.apiKey}"` },
        })
      ).json()) as { Items: JellyfinListed[] }
    ).Items;
  return { series: await list('Series'), episodes: await list('Episode') };
}

/**
 * The planted secrets, which no output may hold: the indexer key, the NNTP password,
 * this run's worker token, admin password and instance secret, Jellyfin's API key and the control
 * secrets setup-clients generated. The last two are read from the stack, and left out when it can't be.
 */
export function plantedSecrets(env: NodeJS.ProcessEnv | undefined = lastEnv, readTimeoutMs?: number): string[] {
  const tryRead = (read: () => string[]): string[] => {
    try {
      return read();
    } catch {
      return [];
    }
  };
  const controlSecrets = tryRead(() =>
    exec('worker', ['sh', '-c', 'for f in /run/omnarr/secrets/*; do cat "$f"; echo; done'])
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length >= 8),
  );
  const jellyfinKey = env
    ? tryRead(() => rows<{ apiKey?: string }>(env, 'jellyfinServer', undefined, readTimeoutMs).flatMap((row) => (row.apiKey ? [row.apiKey] : [])))
    : [];
  const generated = [secrets.workerToken, secrets.instanceSecret].filter(Boolean);
  return [NEWZNAB_KEY, NNTP_PASS, NNTP_BACKUP_PASS, secrets.adminPassword, secrets.setupPassword, ...generated, ...jellyfinKey, ...controlSecrets];
}

/** What the failure dump scrubs: the planted secrets, and the values only the e2e itself holds. */
const dumpSecrets = (env: NodeJS.ProcessEnv | undefined): string[] => [
  ...plantedSecrets(env, DUMP_READ_TIMEOUT_MS),
  ...(secrets.betterAuthSecret ? [secrets.betterAuthSecret] : []),
  'test-tmdb-key',
  ...(env?.CONVEX_SELF_HOSTED_ADMIN_KEY ? [env.CONVEX_SELF_HOSTED_ADMIN_KEY] : []),
];

/** The rows the failure dump keeps. */
const DUMP_TABLES = ['jobs', 'renditions', 'downloads', 'issues', 'grabs'] as const;
/**
 * Each backend read of the failure dump. A live backend answers in about a second; a dead one (the failure the
 * dump is often for) would hold each read to convex()'s 120 s, the afterAll past its hookTimeout, and compose
 * down would never run.
 */
const DUMP_READ_TIMEOUT_MS = 10_000;
/** The pinned NZBGet image (CONTRIBUTING), already pulled by every scenario, whose busybox reads the kernel log. */
const DMESG_IMAGE = 'nzbgetcom/nzbget:v26.3@sha256:f451d98066cbc0c108146420a61a60f7638de50e067738951461e0105eeaa56d';
let dumps = 0;

/**
 * The kernel log, for OOM kills. On a Linux host (CI) the journal keeps the whole run; the ring buffer
 * `dmesg` reads is overwritten by the stack's network messages within minutes, so it is the fallback,
 * from a container, which also reaches Docker Desktop's VM.
 */
function kernelLog(): string {
  const run = (file: string, args: string[]) => {
    const result = spawnSync(file, args, { encoding: 'utf8', timeout: 60_000 });
    return result.status === 0 && result.stdout.trim() ? result.stdout : undefined;
  };
  const journal = ['-k', '-q', '--no-pager', '-o', 'short-monotonic'];
  return (
    run('journalctl', journal) ??
    run('sudo', ['-n', 'journalctl', ...journal]) ??
    run('docker', ['run', '--rm', '--privileged', '--entrypoint', 'dmesg', DMESG_IMAGE]) ??
    '# no kernel log could be read\n'
  );
}

/**
 * The failure dump (dump.ts) into `E2E_ARTIFACT_DIR`, by default e2e/artifacts/<scenario>, which CI
 * uploads when a job fails. A second stack in one scenario (the jellyfin scenario's) gets its own folder.
 */
async function dumpFailure(): Promise<void> {
  const base = process.env.E2E_ARTIFACT_DIR || join(here, 'artifacts', process.env.E2E_SCENARIO || 'e2e');
  const dir = dumps++ === 0 ? base : `${base}-${dumps}`;
  const env = lastEnv;
  let unreachable = '';
  await writeFailureDump({
    dir,
    planted: dumpSecrets(env),
    logs: { worker: () => logs('worker'), backend: () => logs('backend') },
    dmesg: kernelLog,
    rows: (table) => {
      if (!env) throw new Error('the backend never came up');
      // After one failed read the backend is taken as unreachable, so a dead one costs the dump one timeout.
      if (unreachable) throw new Error(unreachable);
      try {
        return rows(env, table, undefined, DUMP_READ_TIMEOUT_MS);
      } catch (error) {
        unreachable = `the backend didn't answer reading ${table} (${(error as Error).message.split('\n')[0]})`;
        throw error;
      }
    },
    tables: DUMP_TABLES,
    timeouts,
  });
  console.log(`e2e: failure dump in ${dir}`);
}

/**
 * Removes the stack and its volumes; nothing in it is kept, so no container gets more than a second to stop.
 * After a failure it first writes the failure dump.
 */
export async function down(): Promise<void> {
  if (failed) await dumpFailure().catch((error: unknown) => console.log(`e2e: no failure dump (${(error as Error).message})`));
  failed = false;
  timeouts.length = 0;
  const started = Date.now();
  spawnSync(
    'docker',
    ['compose', '-p', PROJECT, ...composeFiles(), ...['test', 'worker', 'worker-old'].flatMap((p) => ['--profile', p]), 'down', '-v', '--timeout', '1'],
    {
      env: composeEnv(),
      stdio: 'ignore',
    },
  );
  process.stderr.write(`STACK: down ${((Date.now() - started) / 1000).toFixed(1)} s\n`);
  // `setup` made ./backups root's, so the project folder goes through a container.
  if (projectDir)
    spawnSync(
      'docker',
      ['run', '--rm', '--user', '0:0', '--entrypoint', 'rm', '-v', `${dirname(projectDir)}:/tmpdir`, WORKER_IMAGE, '-rf', `/tmpdir/${basename(projectDir)}`],
      {
        stdio: 'ignore',
      },
    );
  projectDir = '';
  dotEnv = {};
  stackLayout = 'direct';
  useRelease();
  // A kept stack's slot (host.ts), when down() runs outside run.ts, which frees its own at its end.
  if (process.env.E2E_SLOT_HELD !== '1') releaseSlot(PROJECT);
}

/** The names in the install folder's ./backups, which `setup` made root's 0700, read through a container. */
export const backups = (): string[] =>
  execFileSync('docker', ['run', '--rm', '--user', '0:0', '--entrypoint', 'ls', '-v', `${ensureProjectDir()}/backups:/b:ro`, WORKER_IMAGE, '/b'], {
    encoding: 'utf8',
  })
    .split('\n')
    .filter(Boolean)
    .sort();

export { waitFor };
