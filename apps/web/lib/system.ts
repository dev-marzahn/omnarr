// The worker banner and the System page's wording, from `system.status`.
// Kept in .ts so the type checker sees it.
import {
  type ClientStatusRow,
  type JellyfinSetupReason,
  type JellyfinStatus,
  type LibrarySize,
  type NewerRelease,
  type RerunSetupResponse,
  type SetupStep,
  type SetupStepState,
  STORAGE_AREAS,
  type StorageArea,
  type StorageStatus,
  type SystemStatus,
  type VpnKind,
  type VpnRuntime,
} from '@omnarr/contracts';

import { forwarderName, portStateText, SWITCH_BACK_STEP, SWITCH_TO_VPN_STEP, vpnPeerPort, vpnStateText } from './downloads';

export type Banner = { color: 'error'; title: string; description: string };

const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });

/** The one banner every page shows: a version mismatch wins over offline. */
export function bannerOf(status: SystemStatus): Banner | undefined {
  const worker = status.worker;
  if (status.banner === 'protocolMismatch')
    return {
      color: 'error',
      title: worker ? `Worker runs protocol v${worker.protocolVersion}; this release needs v${worker.expectedVersion}.` : "The worker's version doesn't match.",
      description: 'Update the worker image to the same release tag. The worker takes no jobs until then and tries again every 60 s.',
    };
  if (status.banner === 'workerOffline')
    return {
      color: 'error',
      title: worker ? `Worker offline since ${time.format(worker.lastSeenAt)}.` : 'No worker has connected yet.',
      description: 'Download tracking, imports and preparation are paused.',
    };
  return undefined;
}

/** The sidebar's worker line. */
export function workerLine(worker: SystemStatus['worker']): string {
  if (!worker) return 'No worker yet';
  if (!worker.accepted) return `Worker v${worker.protocolVersion} · needs v${worker.expectedVersion}`;
  return worker.connected ? `Worker online · v${worker.protocolVersion}` : 'Worker offline';
}

/**
 * The video codecs the platform encodes to, each with its ffmpeg software
 * encoders and the prefix of its hardware ones (`h264_nvenc`, `hevc_vaapi`…).
 */
const VIDEO_CODECS = [
  { codec: 'H.264', software: ['libx264', 'libx264rgb', 'libopenh264'], hardwarePrefix: 'h264_' },
  { codec: 'HEVC', software: ['libx265', 'libkvazaar'], hardwarePrefix: 'hevc_' },
  { codec: 'AV1', software: ['libsvtav1', 'libaom-av1', 'librav1e'], hardwarePrefix: 'av1_' },
] as const;

export type VideoEncoders = { codec: string; software: string[]; hardware: string[] };

/** The worker's H.264, HEVC and AV1 encoders, by codec, for the System page; the rest stay behind "Show all". */
export function videoEncoders(encoders: readonly string[]): VideoEncoders[] {
  const sorted = [...encoders].sort();
  return VIDEO_CODECS.map(({ codec, software, hardwarePrefix }) => ({
    codec,
    software: sorted.filter((name) => (software as readonly string[]).includes(name)),
    hardware: sorted.filter((name) => name.startsWith(hardwarePrefix)),
  }));
}

// ---- Jellyfin ----

const JELLYFIN_STATE: Record<JellyfinStatus['state'], string> = {
  notSetUp: 'Not set up',
  settingUp: 'Setting up',
  ready: 'Ready',
  blocked: 'Needs setup',
};

export const jellyfinStateLabel = (state: JellyfinStatus['state']): string => JELLYFIN_STATE[state];

const DEVELOPMENT_VERSION = '0.0.0-dev';

export type UpdateCheckLine = { text: string; icon: string; tone: 'muted' | 'warning' | 'primary'; url?: string };

const checkTime = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

const newerReleaseLine = (newer: NewerRelease): UpdateCheckLine => ({
  text: `omnarr ${newer.latest} is available`,
  icon: 'i-lucide-arrow-up-circle',
  tone: 'primary',
  url: newer.releaseUrl,
});

export function updateCheckLines(release: SystemStatus['release']): UpdateCheckLine[] {
  const check = release.check;
  switch (check.state) {
    case 'off':
      return [{ text: 'Update check is off', icon: 'i-lucide-bell-off', tone: 'muted' }];
    case 'notYet':
      return [{ text: "Update check hasn't run yet", icon: 'i-lucide-clock', tone: 'muted' }];
    case 'upToDate':
      return [
        {
          text:
            release.version === DEVELOPMENT_VERSION
              ? `Checked for releases ${checkTime.format(check.checkedAt)}`
              : `Up to date · checked ${checkTime.format(check.checkedAt)}`,
          icon: 'i-lucide-circle-check',
          tone: 'muted',
        },
      ];
    case 'available':
      return [newerReleaseLine(check.newer)];
    case 'failed':
      return [
        ...(check.knownNewer ? [newerReleaseLine(check.knownNewer)] : []),
        {
          text: `Update check failed ${checkTime.format(check.failedAt)}${check.lastCheckedAt === undefined ? '' : ` · last answered ${checkTime.format(check.lastCheckedAt)}`}`,
          icon: 'i-lucide-triangle-alert',
          tone: 'warning',
        },
      ];
  }
}

/** "Jellyfin 12.4.0", with a warning when it isn't the release omnarr pins. */
export function jellyfinVersionLine(status: JellyfinStatus): string | undefined {
  if (!status.version) return undefined;
  return status.pinned ? `Jellyfin ${status.version}` : `Jellyfin ${status.version} · not the pinned release`;
}

export const jellyfinLibrariesLine = (status: JellyfinStatus): string =>
  status.libraries.length ? `Libraries: ${status.libraries.join(', ')}` : 'No libraries yet';

const STEP_LABEL: Record<SetupStep, string> = {
  reachable: 'Jellyfin answers',
  wizard: 'Startup wizard',
  apiKey: 'API key',
  libraries: 'Libraries',
  branding: 'Server name and look',
  testRefresh: 'First library scan',
};

const REASON_TEXT: Record<JellyfinSetupReason, string> = {
  setupFailed: "Jellyfin didn't answer. Check that its container runs, then re-run.",
  credentialsNeeded: "Jellyfin refused the password. Remove Jellyfin's config volume and re-run.",
  keyRejected: "Jellyfin refused the platform's API key. Re-run to make a new one.",
  libraryMissing: 'A library is missing in Jellyfin. Re-run to create it.',
};

/** The setup checklist's rows, in run order. */
export const setupStepRows = (steps: SetupStepState[]) =>
  steps.map(({ step, state, reason }) => ({ label: STEP_LABEL[step], state, ...(reason ? { reason: REASON_TEXT[reason] } : {}) }));

/** The re-run dialog. */
export const RERUN_PROMPT = 'Enter your platform password to set up Jellyfin again.';

export function rerunErrorText(error: Extract<RerunSetupResponse, { error: unknown }>['error']): string {
  return error === 'wrongPassword' ? 'Wrong password' : 'Setup is already running';
}

export type ClientStatus = {
  name: string;
  /** Under the name: "v26.3". */
  version?: string;
  badge: { label: string; color: 'success' | 'warning' | 'error' | 'neutral' };
  line: string;
  /** qBittorrent's seeding problems and a firewalled connection's forwarding hint, shown as warnings. */
  warnings?: string[];
  /** qBittorrent's VPN line, once the worker has reported its VPN state. */
  vpn?: VpnLine;
};

export type VpnLine = { badge: ClientStatus['badge']; line: string; step?: string };

const CLIENT_NAMES: Record<ClientStatusRow['clientKind'], string> = { nzbget: 'NZBGet', qbittorrent: 'qBittorrent' };

/**
 * The port part of qBittorrent's line: the port peers use. Through
 * a VPN that is up, its forwarded port and who forwards it, or "no forwarded
 * port"; through one that isn't up, nothing, since torrents wait. Without a
 * VPN, `OMNARR_PEER_PORT`.
 */
function portPart(row: ClientStatusRow, vpnKind: VpnKind | undefined): string | undefined {
  if (row.vpn && row.vpn.state !== 'off') {
    const port = vpnPeerPort(row.vpn, row.peerPort);
    if (port !== undefined) return `peers connect on ${port}, forwarded by ${forwarderName(vpnKind)}`;
    return row.vpn.state === 'up' ? 'no forwarded port' : undefined;
  }
  return row.peerPort !== undefined ? `peer port ${row.peerPort}` : undefined;
}

/**
 * A download client's row on the System page: the version under
 * the name, the badge with its config state, and one line. It never shows the
 * client's address or a port, except the port peers use.
 * `vpnKind` names who forwards that port through a VPN.
 */
export function clientStatus(row: ClientStatusRow, vpnKind?: VpnKind): ClientStatus {
  const throughVpn = row.vpn !== undefined && row.vpn.state !== 'off';
  const port = portPart(row, vpnKind);
  const parts = [
    `${row.activeDownloads} active ${row.activeDownloads === 1 ? 'download' : 'downloads'}`,
    ...(row.seedingCount !== undefined ? [`${row.seedingCount} seeding`] : []),
    ...(row.connectionStatus ? [row.connectionStatus] : []),
    ...(port ? [port] : []),
  ];
  const problems = row.seedingProblemCount ?? 0;
  const warnings = [
    ...(problems > 0 ? [`${problems} seeding ${problems === 1 ? 'problem' : 'problems'}`] : []),
    // The router hint is for the published port only; through a VPN, the router plays no part.
    ...(row.connectionStatus === 'firewalled' && !throughVpn
      ? [`Peers can't connect to you. Forward ${row.peerPort !== undefined ? `port ${row.peerPort}` : 'the peer port'} on your router.`]
      : []),
  ];
  return {
    name: CLIENT_NAMES[row.clientKind],
    // qBittorrent reports "v5.3.0", NZBGet "26.3".
    ...(row.clientVersion ? { version: `v${row.clientVersion.replace(/^v/i, '')}` } : {}),
    badge: clientBadge(row),
    line: parts.join(' · '),
    ...(warnings.length ? { warnings } : {}),
    ...(row.vpn ? { vpn: vpnLine(row.vpn) } : {}),
  };
}

/**
 * qBittorrent's VPN line, on the System page and the VPN card: the state, and while it is up, the exit IP
 * (display only) and the port state. `step` is the `.env` step the layout
 * needs, with its commands in backticks.
 */
export function vpnLine(vpn: Pick<VpnRuntime, 'state' | 'layoutWithoutChoice' | 'publicIp' | 'port'>): VpnLine {
  const state = vpnStateText(vpn.state);
  const line = vpn.state === 'up' ? [...(vpn.publicIp ? [`Exit IP ${vpn.publicIp}`] : []), portStateText(vpn.port)].join(' · ') : state.description;
  const step = vpn.layoutWithoutChoice
    ? `No VPN is chosen, but the VPN layout still runs, so torrents go through it. ${SWITCH_BACK_STEP}`
    : vpn.state === 'notActive'
      ? SWITCH_TO_VPN_STEP
      : undefined;
  return { badge: { label: state.label, color: state.color }, line, ...(step ? { step } : {}) };
}

function clientBadge(row: ClientStatusRow): ClientStatus['badge'] {
  // A disabled NZBGet row means no provider was saved yet, never a provider that is off.
  if (!row.enabled) return { label: row.clientKind === 'nzbget' ? 'Not set up' : 'Torrents off', color: 'neutral' };
  if (!row.reachable) return { label: 'Unreachable', color: 'error' };
  if (row.config === 'failed') return { label: 'Config not applied', color: 'error' };
  if (row.config === 'pending') return { label: 'Applying config', color: 'warning' };
  return { label: 'Running', color: 'success' };
}

// ---- Storage ----

const AREA_LABEL: Record<StorageArea, string> = {
  downloads: 'downloads',
  staging: 'staging',
  originals: 'originals',
  series: 'library/series',
  movies: 'library/movies',
};

export type StorageRow = { area: StorageArea; label: string; free: string; writable: boolean };

/** The free-space card: one row per /data area, in the tree's order. */
export const storageRows = (storage: StorageStatus): StorageRow[] =>
  STORAGE_AREAS.map((area) => ({
    area,
    label: AREA_LABEL[area],
    free: `${formatBytes(storage.areas[area].freeBytes)} free`,
    writable: storage.areas[area].writable,
  }));

export type StorageGroup = { label: string; free: string; writable: boolean };

/**
 * System's free-space rows: one per filesystem, in the tree's order, its
 * areas named together ("downloads, staging, originals, library"). An area
 * that isn't writable gets its own row.
 */
export function storageGroups(storage: StorageStatus): StorageGroup[] {
  const groups: { key: string; areas: StorageArea[] }[] = [];
  for (const area of STORAGE_AREAS) {
    const { device, writable } = storage.areas[area];
    const key = writable ? device : `${device}:${area}`;
    const group = groups.find((entry) => entry.key === key);
    if (group) group.areas.push(area);
    else groups.push({ key, areas: [area] });
  }
  return groups.map(({ areas }) => {
    const both = areas.includes('series') && areas.includes('movies');
    const labels = areas.filter((area) => !(both && area === 'movies')).map((area) => (both && area === 'series' ? 'library' : AREA_LABEL[area]));
    const first = storage.areas[areas[0]!];
    return { label: labels.join(', '), free: `${formatBytes(first.freeBytes)} free`, writable: first.writable };
  });
}

/**
 * The free-space card's muted lines, on one filesystem: the areas share
 * free space, and a torrent's download stays until its seeding goal, so a
 * file prepared before then holds space twice. Downloads on another
 * filesystem have their own warning instead.
 */
export function storageNotes(storage: StorageStatus): string[] {
  if (!storage.librarySameDevice || !storage.downloadsSameDevice) return [];
  return [
    'These areas share one filesystem and its free space.',
    'Preparing a file while its torrent is still seeding takes double space until the seeding goal is met.',
  ];
}

export type LibrarySizeRow = { label: string; size: string; part: boolean };
export type LibrarySizeView = { rows: LibrarySizeRow[]; note: string };

/**
 * The free-space card's "Library" rows from `system.librarySize`: the total,
 * then Series and Movies under it, and one muted line with when it was
 * measured and what isn't counted. While the read runs, or after it fails,
 * one line in their place; the free-space rows above don't wait on it.
 */
export function librarySizeView(size: LibrarySize | undefined, failed = false): LibrarySizeView {
  if (failed) return { rows: [], note: "Couldn't measure the library's size. Open System again to retry." };
  if (!size) return { rows: [{ label: 'Library', size: 'measuring…', part: false }], note: '' };
  return {
    rows: [
      { label: 'Library', size: `${formatBytes(size.totalBytes)} used`, part: false },
      { label: 'Series', size: formatBytes(size.seriesBytes), part: true },
      { label: 'Movies', size: formatBytes(size.moviesBytes), part: true },
    ],
    note: `Measured ${time.format(size.measuredAt)}. Counts only the files omnarr tracks.`,
  };
}

/** "a", "a and b", "a, b and c". */
const listOf = (items: readonly string[]): string => (items.length < 2 ? (items[0] ?? '') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const capitalised = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);

/** The areas imports and preparation rename between: they must share staging's filesystem. */
const ONE_DEVICE_AREAS: readonly StorageArea[] = ['originals', 'series', 'movies'];

/**
 * The `storageUnavailable` Issue's text: which areas aren't writable,
 * which aren't on staging's filesystem, and what to do. Undefined when the
 * storage is fine.
 */
export function storageUnavailableText(storage: StorageStatus): string | undefined {
  const sentences: string[] = [];
  const unwritable = STORAGE_AREAS.filter((area) => !storage.areas[area].writable).map((area) => AREA_LABEL[area]);
  if (unwritable.length) sentences.push(`${capitalised(listOf(unwritable))} ${unwritable.length === 1 ? "isn't" : "aren't"} writable.`);
  if (!storage.librarySameDevice) {
    const elsewhere = ONE_DEVICE_AREAS.filter((area) => storage.areas[area].device !== storage.areas.staging.device).map((area) => AREA_LABEL[area]);
    if (elsewhere.length) sentences.push(`${capitalised(listOf(elsewhere))} ${elsewhere.length === 1 ? 'is' : 'are'} on another filesystem than staging.`);
    else sentences.push("Staging, originals and the libraries aren't on one filesystem.");
  }
  if (!sentences.length) return undefined;
  return [...sentences, 'Put the library, staging and originals on the /data volume, and check the owner set in the compose file.'].join(' ');
}

export type StorageWarning = { color: 'warning' | 'error'; title: string; description: string };

/** The card's warnings: downloads on another filesystem is only a line here, never an Issue. */
export function storageWarnings(storage: StorageStatus): StorageWarning[] {
  const warnings: StorageWarning[] = [];
  const unavailable = storageUnavailableText(storage);
  if (unavailable) warnings.push({ color: 'error', title: 'Storage unavailable', description: unavailable });
  if (!storage.downloadsSameDevice)
    warnings.push({
      color: 'warning',
      title: 'Downloads and library are on different filesystems: imports copy files',
      description: 'A seeding torrent takes double space until its download is removed.',
    });
  return warnings;
}

const bundleBuilt = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const bundleKept = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short' });

/** The latest support bundle's line on System (kept 14 days). */
export function supportBundleLine(bundle: SystemStatus['supportBundle']): string | undefined {
  return bundle ? `Built ${bundleBuilt.format(bundle.builtAt)}, kept until ${bundleKept.format(bundle.expiresAt)}` : undefined;
}

const UNITS = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];

/** Decimal units, one decimal from KB up: "3.2 TB". */
export function formatBytes(bytes: number): string {
  let value = bytes;
  let unit = 0;
  while (value >= 1000 && unit < UNITS.length - 1) {
    value /= 1000;
    unit++;
  }
  return unit === 0 ? `${value} B` : `${value.toFixed(1)} ${UNITS[unit]}`;
}
