// The qBittorrent adapter (WebUI API v2) behind the
// DownloadClient port. A cookie session from `auth/login`, renewed on a 403.
// Torrents are named by their info hash and tagged `omnarr-<grabId>`; only
// this adapter adds and strips the prefix. The per-torrent limits of a
// Download's seeding goal go on at add, so qBittorrent enforces the goal while
// the worker is offline. Every failure is a JobFailure with
// platform-written text naming qBittorrent and the endpoint, never the URL,
// the password or qBittorrent's own text; a tracker's URL never leaves here,
// only its message and host.
import type { ClientStatus, DesiredClientConfig, FailureCode } from '@omnarr/contracts';

import { errorFailureCode, qbittorrentState } from '../failures.ts';
import { JobFailure } from '../runtime/lease.ts';
import type { ClientItem, ClientRuntimeReading, DownloadClient, FetchedRelease, SubmitOptions } from './downloadClient.ts';

export type QbittorrentOptions = {
  url: string;
  username: string;
  password: string;
  /**
   * The port qBittorrent listens on: `QBITTORRENT_PEER_PORT`, the
   * published one, in the direct layout; under the VPN, the one the VPN
   * monitor last set.
   */
  listenPort: number | (() => number);
  /** The worker's free bytes under downloads/, to tell a full disk in the `error` state. */
  freeBytes: () => Promise<number>;
  timeoutMs?: number;
  /** How long `submit` waits for a new torrent to be listed (10 s). */
  addWaitMs?: number;
  addPollMs?: number;
  /** How often an incomplete torrent's trackers are read (5 minutes). */
  trackerPollMs?: number;
  now?: () => number;
};

export type QbittorrentClient = DownloadClient & {
  refreshTorrent: NonNullable<DownloadClient['refreshTorrent']>;
  /** For the VPN monitor: sets `listen_port` without a restart. */
  setListenPort(port: number, signal: AbortSignal): Promise<void>;
};

/** One entry of `torrents/info`, as 5.3.0 lists it (fixtures README). */
export type QbtTorrent = {
  hash: string;
  name: string;
  state: string;
  progress: number;
  downloaded: number;
  /** The selected files' size, the bytes of them done, and the download rate in bytes per second. */
  total_size?: number;
  completed?: number;
  dlspeed?: number;
  ratio: number;
  seeding_time: number;
  /** The bytes uploaded over the torrent's life, for seeding progress. */
  uploaded?: number;
  completion_on?: number;
  category: string;
  tags: string;
  content_path: string;
  /** The torrent's top folder; empty before its metadata. */
  root_path?: string;
  /** `null` until the metadata arrives. */
  private?: boolean | null;
};

type QbtTracker = { url: string; status: number; msg: string };

const TAG_PREFIX = 'omnarr-';
/** The tag `refreshTorrent` adds and removes at once. */
const REFRESH_TAG = 'goal-check';
const CATEGORIES = ['platform-series', 'platform-movies'] as const;
const ROOT = '/data/downloads/torrents';
const DEFAULT_TIMEOUT_MS = 30_000;

/** The interface qBittorrent binds to whenever a VPN is chosen; gluetun's tunnel has that name (VPN_INTERFACE). */
const VPN_INTERFACE = 'tun0';

/** The preferences the platform owns; `listen_port` and `current_network_interface` are added per apply. */
const OWNED_PREFERENCES = {
  save_path: ROOT,
  temp_path_enabled: false,
  auto_tmm_enabled: true,
  torrent_content_layout: 'Subfolder',
  random_port: false,
  upnp: false,
  max_ratio_enabled: false,
  max_seeding_time_enabled: false,
  max_inactive_seeding_time_enabled: false,
  max_ratio_act: 0,
  queueing_enabled: false,
  bypass_local_auth: false,
  bypass_auth_subnet_whitelist_enabled: false,
  web_ui_upnp: false,
  add_trackers_enabled: false,
  auto_delete_mode: 0,
  add_stopped_enabled: false,
} as const;

/** The per-torrent limits of a goal: −1 for an unset dimension, minutes rounded up. */
function limitsOf(goal: SubmitOptions['seedGoal']): Record<string, string> {
  return {
    ratioLimit: goal?.ratio === undefined ? '-1' : String(goal.ratio),
    seedingTimeLimit: goal?.seedTimeMs === undefined ? '-1' : String(Math.ceil(goal.seedTimeMs / 60_000)),
    inactiveSeedingTimeLimit: '-1',
  };
}

/** The Grab IDs among a torrent's tags. */
const grabTags = (tags: string) =>
  tags
    .split(',')
    .map((tag) => tag.trim())
    .filter((tag) => tag.startsWith(TAG_PREFIX))
    .map((tag) => tag.slice(TAG_PREFIX.length));

/**
 * A folder for import. Under the Subfolder layout `root_path` is the
 * torrent's folder, while a single-file torrent's `content_path` is the file
 * inside it (5.3.0-2 recordings); without a root, the file's parent.
 */
function contentFolder(torrent: QbtTorrent): string {
  if (torrent.root_path) return torrent.root_path;
  const path = torrent.content_path;
  return torrent.progress >= 1 && /\.[A-Za-z0-9]{2,4}$/.test(path) ? path.slice(0, path.lastIndexOf('/')) : path;
}

const hostOf = (url: string) => {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
};

export function qbittorrentClient(options: QbittorrentOptions): QbittorrentClient {
  const base = `${options.url.replace(/\/+$/, '')}/api/v2/`;
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const now = options.now ?? Date.now;
  const trackerPollMs = options.trackerPollMs ?? 5 * 60_000;
  let cookie: string | undefined;
  /** Per incomplete torrent: its last tracker reading and when it was taken. */
  const trackerReadings = new Map<string, { at: number; message?: string; host?: string }>();

  async function call(
    path: string,
    init: { method: 'GET' | 'POST'; body?: URLSearchParams | FormData; query?: Record<string, string> },
    signal: AbortSignal,
  ): Promise<Response> {
    const where = `(${init.method} /api/v2/${path})`;
    const url = `${base}${path}${init.query ? `?${new URLSearchParams(init.query)}` : ''}`;
    try {
      return await fetch(url, {
        method: init.method,
        headers: cookie ? { cookie } : {},
        ...(init.body ? { body: init.body } : {}),
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      throw new JobFailure(
        errorFailureCode(error) ?? 'clientUnreachable',
        timedOut ? `qBittorrent did not answer in time ${where}.` : `qBittorrent did not answer ${where}.`,
      );
    }
  }

  async function login(signal: AbortSignal): Promise<void> {
    const response = await call(
      'auth/login',
      { method: 'POST', body: new URLSearchParams({ username: options.username, password: options.password }) },
      signal,
    );
    await response.body?.cancel();
    // 5.3 answers 204 with a `QBT_SID_<port>` cookie, and 401 to a wrong login (5.3.0-2 recordings).
    const session = response.headers.get('set-cookie')?.split(';')[0];
    // The control login is generated, so a refusal means setup and qBittorrent disagree; `docker compose down` and `up` rewrite it.
    if (!response.ok || !session) throw new JobFailure('clientUnreachable', 'qBittorrent rejected the control username or password (POST /api/v2/auth/login).');
    cookie = session;
  }

  /** One API call with the session, logging in first or again after a 403. Non-2xx statuses are left to the caller. */
  async function api(
    path: string,
    init: { method: 'GET' | 'POST'; body?: () => URLSearchParams | FormData; query?: Record<string, string> },
    signal: AbortSignal,
  ): Promise<Response> {
    if (!cookie) await login(signal);
    let response = await call(path, { method: init.method, ...(init.body ? { body: init.body() } : {}), ...(init.query ? { query: init.query } : {}) }, signal);
    if (response.status === 403) {
      await response.body?.cancel();
      cookie = undefined;
      await login(signal);
      response = await call(path, { method: init.method, ...(init.body ? { body: init.body() } : {}), ...(init.query ? { query: init.query } : {}) }, signal);
    }
    return response;
  }

  const failure = (path: string, method: string, status: number, code: FailureCode = 'clientUnreachable') =>
    new JobFailure(code, `qBittorrent answered HTTP ${status} (${method} /api/v2/${path}).`);

  async function json<T>(path: string, query: Record<string, string>, signal: AbortSignal): Promise<T> {
    const response = await api(path, { method: 'GET', query }, signal);
    if (!response.ok) throw failure(path, 'GET', response.status);
    return (await response.json()) as T;
  }

  async function post(path: string, form: Record<string, string>, signal: AbortSignal): Promise<Response> {
    const response = await api(path, { method: 'POST', body: () => new URLSearchParams(form) }, signal);
    await response.body?.cancel();
    return response;
  }

  const info = (query: Record<string, string>, signal: AbortSignal) => json<QbtTorrent[]>('torrents/info', query, signal);

  /** The first not-working tracker's message and host, read at most every `trackerPollMs`. */
  async function trackerOf(hash: string, signal: AbortSignal): Promise<{ message?: string; host?: string }> {
    const last = trackerReadings.get(hash);
    if (last && now() - last.at < trackerPollMs) return last;
    const trackers = await json<QbtTracker[]>('torrents/trackers', { hash }, signal).catch(() => [] as QbtTracker[]);
    // Status 4 is "not working"; the DHT, PeX and LSD pseudo-trackers have no host.
    const broken = trackers.find((tracker) => tracker.status === 4 && hostOf(tracker.url));
    const reading = { at: now(), ...(broken?.msg ? { message: broken.msg } : {}), ...(broken ? { host: hostOf(broken.url)! } : {}) };
    trackerReadings.set(hash, reading);
    return reading;
  }

  function itemOf(torrent: QbtTorrent, freeBytes: number, tracker: { message?: string; host?: string } = {}): ClientItem {
    const mapped = qbittorrentState(torrent, freeBytes);
    const status: ClientStatus = {
      stage: torrent.state,
      progress: torrent.progress,
      ...(torrent.completed !== undefined ? { doneBytes: torrent.completed } : {}),
      ...(torrent.total_size !== undefined ? { totalBytes: torrent.total_size } : {}),
      ...(torrent.dlspeed !== undefined ? { bytesPerSec: torrent.dlspeed } : {}),
      ...(tracker.message ? { message: tracker.message } : {}),
      raw: { state: torrent.state, ...(tracker.host ? { trackerHost: tracker.host } : {}) },
    };
    return {
      clientRef: torrent.hash,
      correlationTags: grabTags(torrent.tags),
      stage: mapped.stage,
      status,
      name: torrent.name,
      downloadedBytes: torrent.downloaded,
      ratio: torrent.ratio,
      seedingTimeMs: torrent.seeding_time * 1000,
      ...(torrent.uploaded !== undefined ? { uploadedBytes: torrent.uploaded } : {}),
      // Unix seconds, −1 until it completes.
      ...(torrent.completion_on !== undefined && torrent.completion_on > 0 ? { completedAt: torrent.completion_on * 1000 } : {}),
      ...(mapped.stage === 'completed' ? { contentPath: contentFolder(torrent) } : {}),
      ...(typeof torrent.private === 'boolean' ? { isPrivate: torrent.private } : {}),
      ...(mapped.failureCode ? { failureCode: mapped.failureCode } : {}),
      ...(mapped.problem ? { problem: mapped.problem } : {}),
      ...(mapped.checking ? { checking: true } : {}),
      ...(mapped.stopped ? { stopped: true } : {}),
      ...(mapped.unchanged ? { unchanged: true } : {}),
    };
  }

  /** Polls `torrents/info?hashes=` until the new torrent is listed, for up to `addWaitMs`. */
  async function waitListed(hash: string, signal: AbortSignal): Promise<boolean> {
    const deadline = Date.now() + (options.addWaitMs ?? 10_000);
    for (;;) {
      if ((await info({ hashes: hash }, signal)).length > 0) return true;
      if (Date.now() >= deadline) return false;
      await new Promise((resolve) => setTimeout(resolve, options.addPollMs ?? 250));
    }
  }

  return {
    kind: 'qbittorrent',

    async findByTag(correlationTag, signal) {
      const [torrent] = await info({ tag: `${TAG_PREFIX}${correlationTag}` }, signal);
      return torrent ? itemOf(torrent, Number.POSITIVE_INFINITY) : null;
    },

    async submit(release: FetchedRelease, { correlationTag, category, seedGoal }, signal) {
      if (release.kind === 'nzb') throw new JobFailure('pipelineError', 'qBittorrent takes torrents only.');
      const hash = release.infoHash;
      const tag = `${TAG_PREFIX}${correlationTag}`;
      // A release that is still seeding, picked again: same hash, same tracker minimum, so only the tag is added.
      const tagExisting = async () => {
        const added = await post('torrents/addTags', { hashes: hash, tags: tag }, signal);
        if (!added.ok) throw failure('torrents/addTags', 'POST', added.status);
        return { clientRef: hash };
      };
      if ((await info({ hashes: hash }, signal)).length > 0) return await tagExisting();
      const response = await api(
        'torrents/add',
        {
          method: 'POST',
          body: () => {
            const form = new FormData();
            if (release.kind === 'torrentFile')
              form.append('torrents', new Blob([new Uint8Array(release.bytes)], { type: 'application/x-bittorrent' }), `${hash}.torrent`);
            else form.append('urls', release.uri);
            form.append('category', category);
            form.append('tags', tag);
            for (const [key, value] of Object.entries(limitsOf(seedGoal))) form.append(key, value);
            // 5.3 reads `stopped` and ignores `paused` (5.3.0-2 recordings).
            form.append('stopped', 'false');
            return form;
          },
        },
        signal,
      );
      await response.body?.cancel();
      // 415: not a torrent qBittorrent can read. 409: the hash is there already (another Grab added it since the look-up).
      if (response.status === 415) throw new JobFailure('releaseFileInvalid', 'qBittorrent could not read the torrent (POST /api/v2/torrents/add).');
      if (response.status === 409) return await tagExisting();
      if (!response.ok) throw failure('torrents/add', 'POST', response.status);
      if (!(await waitListed(hash, signal)))
        throw new JobFailure('clientUnreachable', 'qBittorrent did not list the added torrent in time (GET /api/v2/torrents/info).');
      return { clientRef: hash };
    },

    async list(signal) {
      const freeBytes = await options.freeBytes().catch(() => Number.POSITIVE_INFINITY);
      const items: ClientItem[] = [];
      const seen = new Set<string>();
      for (const category of CATEGORIES)
        for (const torrent of await info({ category }, signal)) {
          seen.add(torrent.hash);
          const incomplete = torrent.progress < 1 && qbittorrentState(torrent, freeBytes).stage !== 'completed';
          items.push(itemOf(torrent, freeBytes, incomplete ? await trackerOf(torrent.hash, signal) : {}));
        }
      for (const hash of trackerReadings.keys()) if (!seen.has(hash)) trackerReadings.delete(hash);
      return items;
    },

    async remove(clientRef, correlationTag, deleteData, signal) {
      const [torrent] = await info({ hashes: clientRef }, signal);
      if (!torrent) return { removed: true };
      if (correlationTag !== undefined) {
        const removed = await post('torrents/removeTags', { hashes: clientRef, tags: `${TAG_PREFIX}${correlationTag}` }, signal);
        if (!removed.ok) throw failure('torrents/removeTags', 'POST', removed.status);
        // A torrent another Grab still holds stays.
        if (grabTags(torrent.tags).some((tag) => tag !== correlationTag)) return { removed: false };
      }
      const deleted = await post('torrents/delete', { hashes: clientRef, deleteFiles: String(deleteData) }, signal);
      if (!deleted.ok) throw failure('torrents/delete', 'POST', deleted.status);
      return { removed: true };
    },

    async applyConfig(desired: DesiredClientConfig, signal) {
      const current = await json<Record<string, unknown>>('app/preferences', {}, signal);
      // Bound to tun0 while a VPN is chosen: in the base layout there is no tun0, so qBittorrent moves no traffic (fail closed).
      const wanted: Record<string, unknown> = {
        ...OWNED_PREFERENCES,
        current_network_interface: desired.qbittorrent?.vpn ? VPN_INTERFACE : '',
        listen_port: typeof options.listenPort === 'function' ? options.listenPort() : options.listenPort,
      };
      const changes = Object.fromEntries(Object.entries(wanted).filter(([key, value]) => current[key] !== value));
      let changed = false;
      if (Object.keys(changes).length > 0) {
        const set = await post('app/setPreferences', { json: JSON.stringify(changes) }, signal);
        if (!set.ok) throw failure('app/setPreferences', 'POST', set.status);
        changed = true;
      }
      const categories = await json<Record<string, { savePath: string }>>('torrents/categories', {}, signal);
      for (const category of CATEGORIES) {
        const savePath = `${ROOT}/${category}`;
        if (categories[category]?.savePath === savePath) continue;
        const path = categories[category] ? 'torrents/editCategory' : 'torrents/createCategory';
        const response = await post(path, { category, savePath }, signal);
        if (!response.ok) throw failure(path, 'POST', response.status);
        changed = true;
      }
      const version = await (await api('app/version', { method: 'GET' }, signal)).text();
      return { applied: true, changed, clientVersion: version.trim() };
    },

    async status(signal): Promise<ClientRuntimeReading> {
      try {
        const version = await api('app/version', { method: 'GET' }, signal);
        if (!version.ok) return { reachable: false };
        const transfer = await json<{ connection_status?: string }>('transfer/info', {}, signal);
        const connection = transfer.connection_status;
        return {
          reachable: true,
          version: (await version.text()).trim(),
          ...(connection === 'connected' || connection === 'firewalled' || connection === 'disconnected' ? { connectionStatus: connection } : {}),
        };
      } catch {
        return { reachable: false };
      }
    },

    /**
     * 5.3.0 refreshes an idle torrent, and applies its seed time limit, only on a real change to it:
     * re-sending the same share limits, a reannounce or re-adding a tag it has do nothing. Adding and
     * removing a tag does. The tag has no `omnarr-` prefix, so a list between
     * the two calls never reads it as a Grab's.
     */
    async refreshTorrent(clientRef, signal) {
      for (const path of ['torrents/addTags', 'torrents/removeTags']) {
        const response = await post(path, { hashes: clientRef, tags: REFRESH_TAG }, signal);
        if (!response.ok) throw failure(path, 'POST', response.status);
      }
    },

    async setListenPort(port, signal) {
      const set = await post('app/setPreferences', { json: JSON.stringify({ listen_port: port }) }, signal);
      if (!set.ok) throw failure('app/setPreferences', 'POST', set.status);
    },
  };
}
