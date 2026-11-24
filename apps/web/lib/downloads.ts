// Settings › Downloads' wording and the passing-test
// rule the UI enforces. Texts name the provider, never a client's address or
// port. Kept in .ts so the type checker sees it.
import type {
  ConnectionStatus,
  DownloadClientsDetail,
  ProviderTest,
  PortState,
  SeedGoal,
  SeedingProgress,
  UnitDownload,
  UsenetLimit,
  UsenetUsageDetail,
  VpnKind,
  VpnRuntime,
  VpnSettingsInput,
  VpnState,
  WorkSummary,
} from '@omnarr/contracts';
import { usagePeriod } from '@omnarr/contracts';

import { failureText } from './timeline';

// ---- Download progress ----

const CLIENT_OF = { usenet: 'NZBGet', torrent: 'qBittorrent' } as const;
const STAGE_OF = { queued: 'Queued', downloading: 'Downloading', postProcessing: 'Repair / unpack' } as const;

/** "0.9 of 2.1 GB", in the total's unit: GB with one decimal from 1 GB, whole MB from 1 MB, whole KB below. */
function sizeOf(done: number | undefined, total: number): string {
  const [divisor, name, digits] = total >= 1e9 ? [1e9, 'GB', 1] : total >= 1e6 ? [1e6, 'MB', 0] : [1e3, 'KB', 0];
  const unit = (bytes: number) => (bytes / divisor).toFixed(digits);
  return done === undefined ? `${unit(total)} ${name}` : `${unit(done)} of ${unit(total)} ${name}`;
}

/** "18.2 MB/s", "850 KB/s". */
export const speedOf = (bytesPerSec: number): string =>
  bytesPerSec >= 1e6 ? `${(bytesPerSec / 1e6).toFixed(1)} MB/s` : `${Math.round(bytesPerSec / 1000)} KB/s`;

/** "40 s left", "2 min left", "2 h 10 min left". */
function timeLeft(seconds: number): string {
  if (seconds < 60) return `${Math.round(seconds)} s left`;
  if (seconds < 3600) return `${Math.round(seconds / 60)} min left`;
  return `${Math.floor(seconds / 3600)} h ${Math.round((seconds % 3600) / 60)} min left`;
}

/**
 * DownloadProgress's text: the stage, the percent, and one line with the
 * size, the speed and the time left, (total − done) / speed. Missing bytes or
 * speed leave their parts out. Before the client's first report it waits for
 * the client; repair and unpack have no percent.
 */
export function downloadLine(download: UnitDownload): { stage: string; percent?: number; line: string } {
  const stage = STAGE_OF[download.stage];
  const client = CLIENT_OF[download.protocol];
  if (download.stage === 'postProcessing') return { stage, line: `${client} is checking and unpacking the files` };
  if (download.fraction === undefined) return { stage, line: `Waiting for ${client}…` };
  const percent = Math.round(download.fraction * 100);
  const { doneBytes, totalBytes, bytesPerSec } = download;
  if (download.stage === 'queued') return { stage, percent, line: [`Queued in ${client}`, ...(totalBytes ? [sizeOf(undefined, totalBytes)] : [])].join(' · ') };
  const parts = [
    ...(download.protocol === 'torrent' ? ['Torrent'] : []),
    ...(doneBytes !== undefined && totalBytes ? [sizeOf(doneBytes, totalBytes)] : []),
    ...(bytesPerSec !== undefined ? [speedOf(bytesPerSec)] : []),
    ...(bytesPerSec && doneBytes !== undefined && totalBytes ? [timeLeft(Math.max(0, totalBytes - doneBytes) / bytesPerSec)] : []),
  ];
  // "Torrent" alone says nothing.
  return { stage, percent, line: parts.length === 1 && parts[0] === 'Torrent' ? '' : parts.join(' · ') };
}

// ---- Seeding progress ----

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;

/** "3 of 14 days", "5 of 12 h", "0 of 1 min" in the goal's unit; "3 days" without a time goal. Whole units, rounded down. */
function seedTimeOf(ms: number, goalMs: number | undefined): string {
  const scale = goalMs ?? ms;
  const [divisor, unit] = scale >= DAY_MS ? [DAY_MS, 'days'] : scale >= HOUR_MS ? [HOUR_MS, 'h'] : [MINUTE_MS, 'min'];
  const count = Math.floor(ms / divisor);
  if (goalMs === undefined) return `${count} ${unit === 'days' && count === 1 ? 'day' : unit}`;
  return `${count} of ${Math.floor(goalMs / divisor)} ${unit}`;
}

/**
 * DownloadProgress's text for a torrent seeding to its goal: "ratio 0.8 of
 * 2.0 · 3 of 14 days · 1.2 GB uploaded", the percent towards the closer goal.
 * Before qBittorrent's first reading it waits for it.
 */
export function seedingLine(seeding: SeedingProgress): { stage: string; percent?: number; line: string } {
  const { ratio, seedTimeMs, uploadedBytes, goal, fraction } = seeding;
  if (ratio === undefined && seedTimeMs === undefined) return { stage: 'Seeding', line: 'Waiting for qBittorrent…' };
  const parts = [
    ...(ratio !== undefined ? [goal?.ratio !== undefined ? `ratio ${ratio.toFixed(1)} of ${goal.ratio.toFixed(1)}` : `ratio ${ratio.toFixed(1)}`] : []),
    ...(seedTimeMs !== undefined ? [seedTimeOf(seedTimeMs, goal?.seedTimeMs)] : []),
    ...(uploadedBytes !== undefined ? [`${sizeOf(undefined, uploadedBytes)} uploaded`] : []),
  ];
  return { stage: 'Seeding', ...(fraction !== undefined ? { percent: Math.round(fraction * 100) } : {}), line: parts.join(' · ') };
}

/** The Work's Files tab: "Seeding 40%" on a file whose torrent still seeds. */
export const seedingBadge = (seeding: Pick<SeedingProgress, 'fraction'>): string =>
  seeding.fraction === undefined ? 'Seeding' : `Seeding ${Math.round(seeding.fraction * 100)}%`;

/**
 * The library's seeding marker: "Seeding" for one
 * torrent, "3 seeding" for several, with its tooltip; nothing for none.
 */
export function seedingMarker(seeding: WorkSummary['seeding']): { label: string; title: string } | undefined {
  if (!seeding?.count) return undefined;
  return seeding.count === 1
    ? { label: 'Seeding', title: 'A torrent is seeding to its goal' }
    : { label: `${seeding.count} seeding`, title: `${seeding.count} torrents are seeding to their goals` };
}

/** The Torrents card: "Seeding 3 torrents · 4.2 GB uploaded"; nothing while none seeds. */
export function seedingSummary(seeding: Torrents['seeding']): string | undefined {
  if (!seeding?.count) return undefined;
  return `Seeding ${seeding.count} ${seeding.count === 1 ? 'torrent' : 'torrents'} · ${sizeOf(undefined, seeding.uploadedBytes)} uploaded`;
}

/** A Work's running Downloads on its poster, list row and hero: "2 downloading · 43% · 31.0 MB/s", badge "2 · 43%". */
export function activeDownloadsLine(active: WorkSummary['activeDownloads']): { line: string; badge: string } | undefined {
  if (!active) return undefined;
  const percent = active.fraction === undefined ? undefined : `${Math.round(active.fraction * 100)}%`;
  const head = active.count === 1 ? 'Downloading' : `${active.count} downloading`;
  return {
    line: [head, ...(percent ? [percent] : []), ...(percent && active.bytesPerSec !== undefined ? [speedOf(active.bytesPerSec)] : [])].join(' · '),
    badge: active.count === 1 ? (percent ?? '…') : [String(active.count), ...(percent ? [percent] : [])].join(' · '),
  };
}

export type Notice = { color: 'success' | 'error' | 'neutral'; title: string; description?: string };

const provider = (test: Pick<ProviderTest, 'host' | 'port' | 'ssl'>) => `${test.host}:${test.port} ${test.ssl ? 'over SSL' : 'without SSL'}`;

export function providerTestText(test: ProviderTest, workerConnected: boolean): Notice {
  switch (test.outcome) {
    case 'ok':
      return { color: 'success', title: `Logged in to ${provider(test)}.` };
    case 'authRejected':
      return {
        color: 'error',
        title: 'The provider rejected the login.',
        description: `${provider(test)} answered, but refused this username and password. Check them.`,
      };
    case 'failed':
      return { color: 'error', title: `Couldn't reach ${provider(test)}.`, description: 'Check the host, the port and the SSL switch.' };
    case 'pending':
      return workerConnected
        ? { color: 'neutral', title: `Testing the login to ${provider(test)}…` }
        : { color: 'neutral', title: 'Waiting for the worker', description: `The test of ${provider(test)} starts when the worker connects.` };
  }
}

export function testOfServer(
  test: ProviderTest | undefined,
  backupId: string | undefined,
  testOnOpen: ProviderTest['jobId'] | undefined,
): ProviderTest | undefined {
  return test && test.backupId === backupId && test.jobId !== testOnOpen ? test : undefined;
}

/** "15 Dec": a period boundary, a UTC day as the worker counts it. */
const resetDate = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', timeZone: 'UTC' });
const gb = (bytes: number) => String(Math.round(bytes / 1e8) / 10);

/**
 * A server's monthly limit on the card: what the
 * period used and when it resets, or that the worker paused the server until then.
 */
export function usageText(limit: UsenetLimit | undefined, usage: UsenetUsageDetail | undefined, now: number): string | undefined {
  if (!limit) return undefined;
  const next = resetDate.format(usagePeriod(limit.resetDay, now).next);
  if (!usage) return `Limit ${limit.monthlyLimitGb} GB a month, resets ${next}`;
  if (usage.limitReached) return `Limit reached, paused until ${next}`;
  return `Used ${gb(usage.usedBytes)} of ${limit.monthlyLimitGb} GB, resets ${next}`;
}

/** The login fields the card stores for a server; the limit and the priority aren't part of the login. */
export type StoredLogin = Pick<ProviderValues, 'host' | 'port' | 'ssl' | 'username' | 'connections'>;

export function needsLoginTest(form: ProviderValues, stored: StoredLogin | undefined): boolean {
  if (!stored || form.password !== '') return true;
  return (['host', 'port', 'ssl', 'username', 'connections'] as const).some((field) => form[field] !== stored[field]);
}

/** What the provider form holds; a blank password means the stored one. */
export type ProviderValues = { host: string; port: number; ssl: boolean; username: string; password: string; connections: number };

export type SaveInFlight = { values: ProviderValues; testBefore: ProviderTest['jobId'] | undefined; backupId: string | undefined };
export type SaveStep = 'waitForTest' | 'save' | 'loginFailed' | 'formChanged' | 'testReplaced';

export const SAVE_CANCELLED_TEXT = {
  formChanged: 'The form changed during the login test. Save again.',
  testReplaced: 'Another login test replaced this one. Save again.',
} as const;

export function saveStepAfterTest(inFlight: SaveInFlight, form: ProviderValues, rowTest: ProviderTest | undefined): SaveStep {
  const fields = Object.keys(form) as (keyof ProviderValues)[];
  if (fields.some((field) => inFlight.values[field] !== form[field])) return 'formChanged';
  if (!rowTest || rowTest.jobId === inFlight.testBefore) return 'waitForTest';
  if (rowTest.backupId !== inFlight.backupId) return 'testReplaced';
  if (rowTest.outcome === 'pending') return 'waitForTest';
  const testedThisForm = rowTest.host === form.host && rowTest.port === form.port && rowTest.ssl === form.ssl;
  return rowTest.outcome === 'ok' && testedThisForm ? 'save' : 'loginFailed';
}

type Usenet = DownloadClientsDetail['usenet'];

/** "just now", "2 min ago", "3 h ago" or "3 days ago", rounded down. */
function ago(at: number, now: number): string {
  const minutes = Math.floor((now - at) / 60_000);
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return `${days} ${days === 1 ? 'day' : 'days'} ago`;
}

type Applied = Pick<Usenet, 'config' | 'appliedAt' | 'applyFailure'>;

/** "Applied 2 min ago", "Not applied yet" or "Not applied: <client> unreachable". */
function appliedText(client: 'NZBGet' | 'qBittorrent', state: Applied, now: number): string {
  if (state.config === 'pending') return 'Not applied yet';
  if (state.config === 'failed')
    return `Not applied: ${!state.applyFailure || state.applyFailure === 'clientUnreachable' ? `${client} unreachable` : failureText(state.applyFailure)}`;
  return `Applied ${ago(state.appliedAt ?? now, now)}`;
}

/** The provider card's applied-state line. */
export function configStateText(usenet: Pick<Usenet, 'enabled' | 'config' | 'appliedAt' | 'applyFailure'>, now: number): string {
  // A disabled NZBGet row means no provider was saved yet (a Test login creates the row); NZBGet has no "off".
  if (!usenet.enabled) return 'Not set up: no provider saved yet';
  return appliedText('NZBGet', usenet, now);
}

// ---- The Torrents card ----

type Torrents = DownloadClientsDetail['torrents'];

/** The Torrents card's applied-state line. Before the first save there is no row, and the worker runs qBittorrent with the default goal. */
export function torrentsConfigStateText(torrents: Pick<Torrents, 'configVersion' | 'config' | 'appliedAt' | 'applyFailure'>, now: number): string {
  if (torrents.configVersion === 0) return 'Not saved yet: the default goal applies';
  return appliedText('qBittorrent', torrents, now);
}

const DAY_MS = 86_400_000;

/** The goal's fields; an empty one (`null`) is no limit on that dimension. */
export type SeedGoalValues = { ratio: number | null; days: number | null };

/** The form's goal, or why it can't be saved: at least one of the two, each above 0. */
export function seedGoalFromValues(values: SeedGoalValues): { goal: SeedGoal } | { error: string } {
  const { ratio, days } = values;
  if (ratio === null && days === null) return { error: 'Set a ratio, a number of days, or both.' };
  if (ratio !== null && !(ratio > 0)) return { error: 'The ratio must be above 0.' };
  if (days !== null && !(Math.round(days * DAY_MS) > 0)) return { error: 'The number of days must be above 0.' };
  return { goal: { ...(ratio === null ? {} : { ratio }), ...(days === null ? {} : { seedTimeMs: Math.round(days * DAY_MS) }) } };
}

/** A stored goal as the form's fields. */
export const seedGoalValues = (goal: SeedGoal): SeedGoalValues => ({
  ratio: goal.ratio ?? null,
  days: goal.seedTimeMs === undefined ? null : goal.seedTimeMs / DAY_MS,
});

/** Who forwards the port under the VPN: the provider's name, or "your VPN" for a config file. */
export const forwarderName = (kind: VpnKind | undefined): string => (kind === 'pia' ? 'PIA' : kind === 'protonvpn' ? 'ProtonVPN' : 'your VPN');

/**
 * The port peers use through a VPN that is up: the worker's `status.peerPort`, which in the VPN layout is the
 * forwarded or static port while up, and absent otherwise.
 */
export const vpnPeerPort = (vpn: Pick<VpnRuntime, 'state'>, peerPort: number | undefined): number | undefined => (vpn.state === 'up' ? peerPort : undefined);

/**
 * The peer port is read-only. Without a VPN it is `OMNARR_PEER_PORT`,
 * as the worker reports it, with the router hint. Through a VPN it is the
 * port peers use, the VPN's forwarded one, and `OMNARR_PEER_PORT` isn't
 * shown.
 */
export function peerPortText(peerPort: number | undefined, vpn?: Pick<VpnRuntime, 'state' | 'port'>, kind?: VpnKind): { value: string; hint?: string } {
  if (vpn && vpn.state !== 'off') {
    const port = vpnPeerPort(vpn, peerPort);
    if (port !== undefined) return { value: String(port), hint: `Forwarded by ${forwarderName(kind)}. Peers connect on this port through the VPN.` };
    if (vpn.state === 'up') return { value: 'No forwarded port', hint: portStateText(vpn.port) };
    return { value: 'Through the VPN', hint: 'Shown once the VPN is up.' };
  }
  return peerPort === undefined ? { value: 'Not reported yet' } : { value: String(peerPort), hint: 'Forward this port on your router.' };
}

export type ConnectionText = { color: 'success' | 'warning' | 'error' | 'neutral'; label: string; description?: string };

const notConfirmedYet = (description: string): ConnectionText => ({ color: 'neutral', label: 'Not confirmed yet', description });

const untilAPeerConnectsIn = (fix: string): ConnectionText =>
  notConfirmedYet(`No peer has connected in yet. qBittorrent confirms the port once one does. If this stays while torrents are active, ${fix}`);

function firewalledText(peerPort: number | undefined, vpn: Pick<VpnRuntime, 'state' | 'port'> | undefined, kind: VpnKind | undefined): ConnectionText {
  if (!vpn || vpn.state === 'off') return untilAPeerConnectsIn('forward the peer port on your router.');
  const port = vpnPeerPort(vpn, peerPort);
  if (port !== undefined) return untilAPeerConnectsIn(`check that ${forwarderName(kind)} forwards port ${port}.`);
  if (vpn.state !== 'up') return notConfirmedYet('Peers can connect in once the VPN is up.');
  if (vpn.port.kind === 'none')
    return {
      color: 'neutral',
      label: 'No incoming peers',
      description: "Your VPN doesn't forward a port, so peers can't connect in. Torrents work, with fewer peers.",
    };
  return notConfirmedYet('Waiting for the VPN to forward a port.');
}

export function connectionStatusText(
  status: ConnectionStatus | undefined,
  peerPort?: number,
  vpn?: Pick<VpnRuntime, 'state' | 'port'>,
  kind?: VpnKind,
): ConnectionText {
  switch (status) {
    case 'connected':
      return { color: 'success', label: 'Connected', description: 'Peers can connect to you.' };
    case 'firewalled':
      return firewalledText(peerPort, vpn, kind);
    case 'disconnected':
      return { color: 'error', label: 'Disconnected', description: 'qBittorrent has no network connection.' };
    case undefined:
      return { color: 'neutral', label: 'Not reported yet' };
  }
}

export function nzbgetConnectionText(reachable: boolean | undefined, workerConnected: boolean): ConnectionText {
  if (!workerConnected) return { color: 'neutral', label: 'Not checked', description: 'Checked once the worker connects.' };
  if (reachable === undefined) return { color: 'neutral', label: 'Not reported yet' };
  return reachable ? { color: 'success', label: 'NZBGet answers' } : { color: 'error', label: 'Unreachable', description: "The worker can't reach NZBGet." };
}

/** The switch stops new torrent Grabs only. */
export const TORRENTS_OFF_TEXT = 'Turning torrents off stops new torrent grabs. Torrents already seeding keep seeding until their goals are met.';
export const GOAL_CHANGE_TEXT = 'A changed goal applies to new torrents only.';

// ---- The VPN card ----

export type VpnStateText = { color: 'success' | 'warning' | 'error' | 'neutral'; label: string; description: string };

const VPN_STATES: Record<VpnState, VpnStateText> = {
  off: { color: 'neutral', label: 'No VPN', description: 'Torrents connect directly, without a VPN.' },
  notActive: {
    color: 'warning',
    label: 'Not active',
    description: "A VPN is chosen, but the VPN layout isn't in use yet. Torrents wait, and move no traffic, until it is.",
  },
  connecting: { color: 'neutral', label: 'Connecting', description: 'Torrents wait until the VPN is up.' },
  up: { color: 'success', label: 'Up', description: 'Torrent traffic goes only through the VPN.' },
  down: { color: 'error', label: 'Down', description: 'The tunnel is down. Torrents wait, and no torrent traffic leaves without it.' },
};

/** The VPN state, for the card and the System page. */
export const vpnStateText = (state: VpnState): VpnStateText => VPN_STATES[state];

/** The forwarded port's state, evaluated only while the VPN is up. None of them is an error. */
export function portStateText(port: PortState): string {
  if ((port.kind === 'forwarded' || port.kind === 'static') && port.port !== undefined) return `Peers can connect on port ${port.port} through the VPN.`;
  if (port.kind === 'none') return "Your VPN doesn't forward a port. Torrents work, with fewer peers.";
  return 'Waiting for the VPN to forward a port.';
}

/** A text with its commands in backticks; the page shows them as code. */
export type Note = { title: string; description: string };

const COMPOSE_LINE = '`COMPOSE_FILE=compose.yml:compose.vpn.yml`';

/** The steps that switch the deployment's layout; the platform can't edit `.env`. */
export const SWITCH_TO_VPN_STEP = `Add ${COMPOSE_LINE} to \`.env\`, then run \`docker compose up -d\`.`;
export const SWITCH_BACK_STEP = `Remove ${COMPOSE_LINE} from \`.env\`, then run \`docker compose up -d\`.`;

/** The worker runs with `GLUETUN_URL`: only the VPN layout gets past `notActive`. */
const inVpnLayout = (runtime: Pick<VpnRuntime, 'state' | 'layoutWithoutChoice'> | undefined): boolean =>
  runtime !== undefined && (runtime.layoutWithoutChoice || runtime.state === 'connecting' || runtime.state === 'up' || runtime.state === 'down');

/**
 * The note after a VPN save, from the choice saved and the runtime
 * seen when it was saved. Gluetun reads its files only when it starts, so a
 * change in the VPN layout needs `docker compose up -d`; a change of layout
 * needs the `.env` step first. No VPN in the direct layout needs nothing: the
 * worker applies it through qBittorrent's API. Before the worker has
 * reported, the layout is taken to be the default, direct one.
 */
export function vpnApplyNote(chosen: boolean, runtime: Pick<VpnRuntime, 'state' | 'layoutWithoutChoice'> | undefined): Note | undefined {
  const vpnLayout = inVpnLayout(runtime);
  if (chosen && !vpnLayout) return { title: 'Switch to the VPN layout', description: `${SWITCH_TO_VPN_STEP} Until then, torrents wait.` };
  if (chosen) return { title: 'Apply with `docker compose up -d`', description: 'The VPN container reads its settings only when it starts.' };
  if (vpnLayout) return { title: 'Switch back to the direct layout', description: `${SWITCH_BACK_STEP} Until then, torrents still go through the VPN.` };
  return undefined;
}

/** A text split at its backticks, for showing the commands as code. */
export const codeParts = (text: string): ({ text: string } | { code: string })[] =>
  text
    .split('`')
    .map((part, i) => (i % 2 === 1 ? { code: part } : { text: part }))
    .filter((part) => ('code' in part ? true : part.text !== ''));

/** The card's four choices, in its order. */
export const VPN_KINDS: { value: VpnKind; label: string }[] = [
  { value: 'wireguardFile', label: 'WireGuard config file' },
  { value: 'openvpnFile', label: 'OpenVPN config file' },
  { value: 'protonvpn', label: 'ProtonVPN' },
  { value: 'pia', label: 'PIA' },
];

type Field = { label: string; hint: string };

/**
 * What a kind asks for, with each field's label and hint. A field that is
 * absent isn't shown. `countries` is `serverCountries`; for PIA it holds
 * regions, since PIA's servers have no country.
 */
export type VpnFields = {
  /** The config file, pasted or uploaded; `accept` is the file picker's filter. */
  config?: Field & { accept: string };
  privateKey?: Field;
  credentials?: { hint: string };
  countries?: Field;
  staticPort: Field;
};

const STATIC_PORT: Field = { label: 'Static forwarded port', hint: 'Optional. Only for a provider that gives you a fixed forwarded port.' };

const VPN_FIELDS: Record<VpnKind, VpnFields> = {
  wireguardFile: {
    config: {
      label: 'WireGuard config file',
      hint: "Your provider's WireGuard file (such as wg0.conf). Its Endpoint must be an IP address, not a hostname.",
      accept: '.conf,text/plain',
    },
    staticPort: STATIC_PORT,
  },
  openvpnFile: {
    config: { label: 'OpenVPN config file', hint: "Your provider's OpenVPN file (.ovpn).", accept: '.ovpn,.conf,text/plain' },
    credentials: { hint: 'The OpenVPN username and password your provider gives you.' },
    staticPort: STATIC_PORT,
  },
  protonvpn: {
    privateKey: {
      label: 'WireGuard private key',
      hint: 'In your Proton account, create a WireGuard configuration with "NAT-PMP (Port Forwarding)" turned on, and paste its PrivateKey.',
    },
    countries: { label: 'Countries', hint: 'Comma separated, such as "Netherlands, Switzerland". Leave empty for any country.' },
    staticPort: STATIC_PORT,
  },
  pia: {
    credentials: { hint: 'Your PIA username and password. PIA connects over OpenVPN.' },
    countries: { label: 'Regions', hint: 'PIA regions, comma separated, such as "DE Berlin, Netherlands". Leave empty for any region.' },
    staticPort: STATIC_PORT,
  },
};

export const vpnFields = (kind: VpnKind): VpnFields => VPN_FIELDS[kind];

/** What the VPN form holds. The secret fields start blank; a blank one means the stored value. */
export type VpnFormValues = {
  useVpn: boolean;
  kind: VpnKind;
  /** The config file's text, for either file kind. */
  config: string;
  username: string;
  password: string;
  privateKey: string;
  /** Comma separated; regions for PIA. */
  countries: string;
  staticPort: number | null;
};

type Vpn = DownloadClientsDetail['vpn'];

/** The saved choice as the form's fields; the secrets are never sent to the page, so they start blank. */
export const vpnFormValues = (vpn: Pick<Vpn, 'kind' | 'serverCountries' | 'staticForwardedPort'>): VpnFormValues => ({
  useVpn: vpn.kind !== undefined,
  kind: vpn.kind ?? 'wireguardFile',
  config: '',
  username: '',
  password: '',
  privateKey: '',
  countries: (vpn.serverCountries ?? []).join(', '),
  staticPort: vpn.staticForwardedPort ?? null,
});

/**
 * Which secret fields show "Stored" for `kind`: only the saved kind's, since
 * a choice of another kind keeps nothing. `config` is the config file or
 * ProtonVPN's private key, `credentials` the username and password.
 */
export const vpnStoredSecrets = (vpn: Pick<Vpn, 'kind' | 'hasVpnConfig' | 'hasVpnCredentials'>, kind: VpnKind) => ({
  config: vpn.kind === kind && vpn.hasVpnConfig,
  credentials: vpn.kind === kind && vpn.hasVpnCredentials,
});

/** A refused `saveVpn` carries the reason for the form (`invalidVpn`); anything else says to try again. */
export function vpnSaveErrorText(error: unknown): string {
  const data = (error as { data?: { code?: unknown; message?: unknown } } | null)?.data;
  if (data?.code === 'invalidVpn' && typeof data.message === 'string') return data.message;
  return "The VPN settings couldn't be saved. Try again.";
}

/** Each secret only when typed, so a blank field keeps the stored one. */
const typed = <K extends string>(key: K, value: string): Partial<Record<K, string>> =>
  (value.trim() === '' ? {} : { [key]: value }) as Partial<Record<K, string>>;

/** `saveVpn`'s input (`null` is "No VPN"), or why the form can't be saved. The server checks the rest. */
export function vpnSaveInput(values: VpnFormValues): { input: VpnSettingsInput | null } | { error: string } {
  if (!values.useVpn) return { input: null };
  const port = values.staticPort;
  if (port !== null && !(Number.isInteger(port) && port >= 1 && port <= 65_535))
    return { error: 'The static forwarded port must be a whole number from 1 to 65535.' };
  const staticForwardedPort = port === null ? {} : { staticForwardedPort: port };
  const countries = values.countries
    .split(',')
    .map((country) => country.trim())
    .filter(Boolean);
  const serverCountries = countries.length ? { serverCountries: countries } : {};
  const login = { ...typed('username', values.username.trim()), ...typed('password', values.password) };
  switch (values.kind) {
    case 'wireguardFile':
      return { input: { kind: 'wireguardFile', ...typed('wireguardConf', values.config), ...staticForwardedPort } };
    case 'openvpnFile':
      return { input: { kind: 'openvpnFile', ...typed('openvpnConf', values.config), ...login, ...staticForwardedPort } };
    case 'protonvpn':
      return { input: { kind: 'protonvpn', ...typed('wireguardPrivateKey', values.privateKey.trim()), ...serverCountries, ...staticForwardedPort } };
    case 'pia':
      return { input: { kind: 'pia', ...login, ...serverCountries, ...staticForwardedPort } };
  }
}
