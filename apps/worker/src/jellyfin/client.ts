// The Jellyfin adapter: the PlaybackTarget calls, plus
// the setup and the password push only the worker makes. It talks to
// Jellyfin 12.4 with `Authorization: MediaBrowser …` only, since 12.x rejects
// the legacy headers. The API key comes from the backend's
// connection, read on every call.
import {
  type ActivePlay,
  DEFAULT_LIMITS,
  type JellyfinConnection,
  type JobResult,
  type Limits,
  type MaintenancePayload,
  type SetupStep,
  type SetupStepState,
  type TargetReading,
} from '@omnarr/contracts';

import { JobFailure } from '../runtime/lease.ts';
import type { PlaybackTarget } from '../targets/playbackTarget.ts';
import { playMethod, transcodeReasons } from './reasons.ts';

export type SetupPayload = Extract<MaintenancePayload, { action: 'setupJellyfin' }>;
export type SetupResult = Extract<JobResult, { class: 'maintenance'; action: 'setupJellyfin' }>;

export type JellyfinOptions = {
  /** The compose service address, `http://jellyfin:8096`. */
  url: string;
  /** The worker session's latest `jellyfin.setup.connection` value. */
  connection: () => JellyfinConnection | null;
  /** Per call; 30 s by default. */
  timeoutMs?: number;
  /** Injectable for the tests, as the clock below. */
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
  /** The platform's version, in the setup sign-in's `Version`. */
  platformVersion?: string;
  /** `jellyfinReachableMs`, `publishWaitMs` and `publishPollMs`; the e2e lowers the first (`OMNARR_TEST_LIMITS`). */
  limits?: Limits;
};

export interface JellyfinClient extends PlaybackTarget {
  /** `maintenance.setupJellyfin`: each step looks at Jellyfin before it acts, and reports through `onStep`. */
  setup(payload: SetupPayload, onStep: (step: SetupStep, state: 'done') => void, signal: AbortSignal): Promise<SetupResult>;
  /** `maintenance.pushJellyfinPassword`. */
  pushPassword(username: string, newPassword: string, signal: AbortSignal): Promise<void>;
}

const DEFAULT_TIMEOUT_MS = 30_000;

export const abortableSleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => {
      clearTimeout(timer);
      reject(signal.reason);
    });
  });

type Method = 'GET' | 'POST' | 'DELETE';

/** How one call's failure is classed; the caller adds the setup step or the publish reason. */
class CallError extends Error {
  public constructor(
    public readonly status: number | undefined,
    public readonly detail: string,
  ) {
    super(detail);
  }
}

export function jellyfinClient(options: JellyfinOptions): JellyfinClient {
  const base = options.url.replace(/\/+$/, '');
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const sleep = options.sleep ?? abortableSleep;
  const now = options.now ?? Date.now;
  const limits = options.limits ?? DEFAULT_LIMITS;
  const setupClient = `MediaBrowser Client="omnarr", Device="omnarr", DeviceId="omnarr-setup", Version="${options.platformVersion ?? '0'}"`;
  const tokenAuth = (token: string) => `MediaBrowser Token="${token}"`;

  /**
   * One call. A failure is a CallError whose detail names Jellyfin, the method
   * and the endpoint path, never the URL, a key or Jellyfin's own text. A
   * cancelled job's abort passes through.
   */
  async function call(
    method: Method,
    path: string,
    { query, authorization, body, signal }: { query?: Record<string, string>; authorization?: string; body?: unknown; signal: AbortSignal },
  ): Promise<Response> {
    const where = `(${method} ${path.replace(/\/[0-9a-f]{32}(?=\/|$)/g, '/<id>')})`;
    let response: Response;
    try {
      response = await fetch(`${base}${path}${query ? `?${new URLSearchParams(query)}` : ''}`, {
        method,
        headers: { ...(authorization ? { Authorization: authorization } : {}), ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}) },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.any([signal, AbortSignal.timeout(timeoutMs)]),
      });
    } catch (error) {
      if (signal.aborted) throw error;
      const timedOut = error instanceof Error && error.name === 'TimeoutError';
      throw new CallError(undefined, timedOut ? `Jellyfin did not answer in time ${where}.` : `Jellyfin did not answer ${where}.`);
    }
    if (response.status === 401 || response.status === 403) throw new CallError(response.status, `Jellyfin refused the credentials ${where}.`);
    if (!response.ok) throw new CallError(response.status, `Jellyfin answered HTTP ${response.status} ${where}.`);
    return response;
  }

  const readJson = async <T>(response: Response, where: string): Promise<T> =>
    (await response.json().catch(() => {
      throw new CallError(response.status, `Jellyfin sent an answer that is not JSON (${where}).`);
    })) as T;

  // ---- setup ----

  /** A setup step's failure: retried as `jellyfinUnavailable` (reason `setupFailed` once attempts run out). */
  const setupFailure = (step: SetupStep, error: unknown): never => {
    if (error instanceof JobFailure) throw error;
    if (error instanceof CallError) throw new JobFailure('jellyfinUnavailable', error.detail, { reason: 'setupFailed', step });
    throw error;
  };

  /** `GET /System/Info/Public` every 2 s for up to 3 minutes: a first start of 12.x runs migrations. */
  async function reachable(signal: AbortSignal): Promise<{ Id: string; Version: string; StartupWizardCompleted: boolean }> {
    const deadline = now() + limits.jellyfinReachableMs;
    for (;;) {
      try {
        const response = await call('GET', '/System/Info/Public', { signal });
        return await readJson(response, 'GET /System/Info/Public');
      } catch (error) {
        if (!(error instanceof CallError) || now() >= deadline) setupFailure('reachable', error);
      }
      await sleep(limits.publishPollMs, signal);
    }
  }

  async function wizard(payload: SetupPayload, signal: AbortSignal): Promise<void> {
    const { locale, admin } = payload;
    await call('POST', '/Startup/Configuration', {
      body: { UICulture: locale.uiCulture, MetadataCountryCode: locale.metadataCountry, PreferredMetadataLanguage: locale.metadataLanguage },
      signal,
    });
    // The wizard creates its user on the first read.
    await call('GET', '/Startup/User', { signal });
    await call('POST', '/Startup/User', { body: { Name: admin.username, Password: admin.password }, signal });
    await call('POST', '/Startup/RemoteAccess', { body: { EnableRemoteAccess: payload.remoteAccess, EnableAutomaticPortMapping: false }, signal });
    await call('POST', '/Startup/Complete', { signal });
  }

  /** Keeps the stored key if it works; otherwise signs in once, makes a key, keeps only the newest `omnarr` key, and logs out. */
  async function apiKey(payload: SetupPayload, signal: AbortSignal): Promise<{ apiKey: string; adminUserId: string; created: boolean }> {
    const stored = options.connection();
    if (stored?.apiKey && stored.adminUserId) {
      const works = await call('GET', '/System/Info', { authorization: tokenAuth(stored.apiKey), signal }).then(
        () => true,
        (error: unknown) => {
          if (error instanceof CallError && (error.status === 401 || error.status === 403)) return false;
          throw error;
        },
      );
      if (works) return { apiKey: stored.apiKey, adminUserId: stored.adminUserId, created: false };
    }
    let session: { AccessToken: string; User: { Id: string } };
    try {
      const response = await call('POST', '/Users/AuthenticateByName', {
        authorization: setupClient,
        body: { Username: payload.admin.username, Pw: payload.admin.password },
        signal,
      });
      session = await readJson(response, 'POST /Users/AuthenticateByName');
    } catch (error) {
      if (error instanceof CallError && error.status === 401)
        throw new JobFailure('jellyfinSetupNeeded', "Jellyfin refused the platform admin's password (POST /Users/AuthenticateByName).", {
          reason: 'credentialsNeeded',
          step: 'apiKey',
        });
      throw error;
    }
    const authorization = `${setupClient}, Token="${session.AccessToken}"`;
    await call('POST', '/Auth/Keys', { query: { app: 'omnarr' }, authorization, signal });
    const { Items } = await readJson<{ Items: { AccessToken: string; AppName: string; DateCreated: string }[] }>(
      await call('GET', '/Auth/Keys', { authorization, signal }),
      'GET /Auth/Keys',
    );
    const ours = Items.filter((key) => key.AppName === 'omnarr').sort((a, b) => Date.parse(a.DateCreated) - Date.parse(b.DateCreated));
    const newest = ours.at(-1);
    if (!newest) throw new CallError(200, 'Jellyfin listed no omnarr key after making one (GET /Auth/Keys).');
    for (const older of ours.slice(0, -1)) await call('DELETE', `/Auth/Keys/${older.AccessToken}`, { authorization, signal });
    await call('POST', '/Sessions/Logout', { authorization, signal });
    return { apiKey: newest.AccessToken, adminUserId: session.User.Id, created: true };
  }

  type VirtualFolder = { ItemId: string; Locations: string[] };

  const libraryOptions = (payload: SetupPayload) => ({
    LibraryOptions: {
      // The platform tells Jellyfin about every change it makes.
      EnableRealtimeMonitor: false,
      PreferredMetadataLanguage: payload.locale.metadataLanguage,
      MetadataCountryCode: payload.locale.metadataCountry,
      ...(payload.offline
        ? {
            MetadataSavers: [],
            TypeOptions: ['Series', 'Season', 'Episode', 'Movie'].map((Type) => ({ Type, MetadataFetchers: [], ImageFetchers: [] })),
          }
        : {}),
    },
  });

  /** A library is present when a folder's `Locations` holds its root; a present one is never renamed. A missing one is created. */
  async function libraries(payload: SetupPayload, key: string, signal: AbortSignal): Promise<SetupResult['libraries']> {
    const authorization = tokenAuth(key);
    const list = async () => readJson<VirtualFolder[]>(await call('GET', '/Library/VirtualFolders', { authorization, signal }), 'GET /Library/VirtualFolders');
    let folders = await list();
    const result: SetupResult['libraries'] = [];
    for (const library of payload.libraries) {
      let folder = folders.find((f) => f.Locations.includes(library.rootPath));
      if (!folder) {
        await call('POST', '/Library/VirtualFolders', {
          query: { name: library.name, collectionType: library.kind === 'series' ? 'tvshows' : 'movies', paths: library.rootPath, refreshLibrary: 'false' },
          authorization,
          body: libraryOptions(payload),
          signal,
        });
        folders = await list();
        folder = folders.find((f) => f.Locations.includes(library.rootPath));
        if (!folder) throw new CallError(200, `Jellyfin listed no library on ${library.rootPath} after creating it (GET /Library/VirtualFolders).`);
      }
      result.push({ libraryId: library.libraryId, itemId: folder.ItemId });
    }
    return result;
  }

  const refreshItem = (itemId: string, authorization: string, signal: AbortSignal) =>
    call('POST', `/Items/${itemId}/Refresh`, {
      query: { Recursive: 'true', MetadataRefreshMode: 'Default', ImageRefreshMode: 'Default', ReplaceAllMetadata: 'false', ReplaceAllImages: 'false' },
      authorization,
      signal,
    });

  async function setup(payload: SetupPayload, onStep: (step: SetupStep, state: 'done') => void, signal: AbortSignal): Promise<SetupResult> {
    const steps: SetupStepState[] = [];
    const run = async <T>(step: SetupStep, work: () => Promise<T>): Promise<T> => {
      const value = await work().catch((error: unknown) => setupFailure(step, error));
      steps.push({ step, state: 'done', at: now() });
      onStep(step, 'done');
      return value;
    };
    const info = await run('reachable', () => reachable(signal));
    await run('wizard', async () => {
      if (!info.StartupWizardCompleted) await wizard(payload, signal);
    });
    const key = await run('apiKey', () => apiKey(payload, signal));
    const items = await run('libraries', () => libraries(payload, key.apiKey, signal));
    if (payload.mode === 'firstRun')
      await run('testRefresh', async () => {
        for (const { itemId } of items) await refreshItem(itemId, tokenAuth(key.apiKey), signal);
      });
    return {
      class: 'maintenance',
      action: 'setupJellyfin',
      serverId: info.Id,
      version: info.Version,
      adminUserId: key.adminUserId,
      ...(key.created ? { apiKey: key.apiKey } : {}),
      libraries: items,
      steps,
    };
  }

  // ---- publish and forget ----

  /** The ready connection's key, or `jellyfinSetupNeeded` with no reason: the job waits for setup without calling Jellyfin. */
  function readyKey(): { authorization: string; connection: JellyfinConnection } {
    const connection = options.connection();
    if (connection?.state !== 'ready' || !connection.apiKey) throw new JobFailure('jellyfinSetupNeeded', "Jellyfin isn't set up yet.");
    return { authorization: tokenAuth(connection.apiKey), connection };
  }

  /** Jellyfin's errors as failures. `onLibrary` marks a call that names the library item, where 12.4's 404 (refresh) or 400 (listing) means it is gone. */
  const publishFailure = (error: unknown, onLibrary = false): never => {
    if (!(error instanceof CallError)) throw error;
    if (error.status === 401 || error.status === 403) throw new JobFailure('jellyfinSetupNeeded', error.detail, { reason: 'keyRejected' });
    if (onLibrary && (error.status === 404 || error.status === 400)) throw new JobFailure('jellyfinSetupNeeded', error.detail, { reason: 'libraryMissing' });
    throw new JobFailure('jellyfinUnavailable', error.detail);
  };

  function libraryItemOf(connection: JellyfinConnection, libraryId: string): string {
    const item = connection.libraries.find((library) => library.libraryId === libraryId)?.itemId;
    if (!item) throw new JobFailure('jellyfinSetupNeeded', 'Jellyfin has no library item for this library; re-run the setup.', { reason: 'libraryMissing' });
    return item;
  }

  /** An item as 12.4 lists it; an episode carries its numbers without being asked (fixtures/jellyfin/items-episodes.json). */
  type Listed = { Id: string; Path?: string; Type?: string; SeriesId?: string; ParentIndexNumber?: number; IndexNumber?: number; IndexNumberEnd?: number };
  async function list(
    parentId: string,
    type: 'Series' | 'Episode' | 'Movie,Video',
    authorization: string,
    signal: AbortSignal,
    onLibrary: boolean,
  ): Promise<Listed[]> {
    try {
      const response = await call('GET', '/Items', {
        query: { ParentId: parentId, Recursive: 'true', IncludeItemTypes: type, Fields: 'Path' },
        authorization,
        signal,
      });
      return (await readJson<{ Items?: Listed[] }>(response, 'GET /Items')).Items ?? [];
    } catch (error) {
      return publishFailure(error, onLibrary);
    }
  }

  const refresh = (itemId: string, authorization: string, signal: AbortSignal, onLibrary: boolean) =>
    refreshItem(itemId, authorization, signal).catch((error: unknown) => publishFailure(error, onLibrary));

  /** The series folder a file under a series root is in: the root's child that holds it. */
  const seriesFolderOf = (root: string, path: string): string => `${root}/${path.slice(root.length + 1).split('/')[0]}`;

  /** What Jellyfin made of a file: its type, and for an episode its numbers and whether its series is the Work folder's. */
  const readingOf = (item: Listed, otherSeries: boolean): TargetReading => {
    if (item.Type === 'Movie') return { kind: 'movie' };
    if (item.Type !== 'Episode') return { kind: 'other' };
    return {
      kind: 'episode',
      ...(item.ParentIndexNumber == null ? {} : { season: item.ParentIndexNumber }),
      ...(item.IndexNumber == null ? {} : { episode: item.IndexNumber }),
      ...(item.IndexNumberEnd == null ? {} : { episodeEnd: item.IndexNumberEnd }),
      ...(otherSeries ? { otherSeries: true as const } : {}),
    };
  };

  const publish: PlaybackTarget['publish'] = async ({ items, workFolderPath, library }, signal) => {
    const { authorization, connection } = readyKey();
    const libraryItem = libraryItemOf(connection, library.libraryId);
    const movies = library.kind === 'movies';
    // Each episode is looked for under its own folder's series, normally the Work folder's.
    // Movies are listed with plain videos, so a file Jellyfin didn't take for a movie is seen.
    const folders = movies ? [] : [...new Set(items.map((item) => seriesFolderOf(library.root, item.path)))];
    const seriesIds = new Map<string, string>();
    const findSeries = (listed: Listed[]) => {
      for (const folder of folders) {
        const id = listed.find((series) => series.Path === folder)?.Id;
        if (id) seriesIds.set(folder, id);
      }
    };
    // A known series is refreshed alone; a new series and every movie need the library item.
    // 12.4's library-item refresh never indexes the first content of a library created empty, so a library
    // that lists nothing yet gets one /Library/Refresh (fixtures/jellyfin/README.md).
    const present = await list(libraryItem, movies ? 'Movie,Video' : 'Series', authorization, signal, true);
    findSeries(present);
    if (!movies && seriesIds.size === folders.length) for (const id of new Set(seriesIds.values())) await refresh(id, authorization, signal, false);
    else if (present.length === 0) await call('POST', '/Library/Refresh', { authorization, signal }).catch((error: unknown) => publishFailure(error));
    else await refresh(libraryItem, authorization, signal, true);

    const refs: Record<string, string> = {};
    const readings: Record<string, TargetReading> = {};
    const seriesRefs: Record<string, string> = {};
    const deadline = now() + limits.publishWaitMs;
    for (;;) {
      const listed: { item: Listed; folder?: string }[] = [];
      if (movies) listed.push(...(await list(libraryItem, 'Movie,Video', authorization, signal, true)).map((item) => ({ item })));
      else {
        if (seriesIds.size < folders.length) findSeries(await list(libraryItem, 'Series', authorization, signal, true));
        for (const [folder, id] of seriesIds) listed.push(...(await list(id, 'Episode', authorization, signal, false)).map((item) => ({ item, folder })));
      }
      // 12.4 can list a new episode before it has numbered it (recorded in the scan e2e), so one without
      // an episode number is waited for too; at the deadline it is reported as Jellyfin has it.
      const unsettled: string[] = [];
      for (const { publicationId, path } of items) {
        const found = listed.find(({ item }) => item.Path === path);
        if (!found) continue;
        refs[publicationId] = found.item.Id;
        readings[publicationId] = readingOf(found.item, found.folder !== undefined && found.folder !== workFolderPath);
        // The series the episode is filed under (12.4 lists SeriesId with every episode), or the movie itself.
        const seriesRef = movies ? found.item.Id : (found.item.SeriesId ?? (found.folder ? seriesIds.get(found.folder) : undefined));
        if (seriesRef) seriesRefs[publicationId] = seriesRef;
        if (found.item.Type === 'Episode' && found.item.IndexNumber == null) unsettled.push(publicationId);
      }
      const missing = items.find((item) => !(item.publicationId in refs));
      if (!missing && (unsettled.length === 0 || now() >= deadline)) return { refs, readings, seriesRefs };
      // The usual cause is a name Jellyfin doesn't match, so the detail says so.
      if (missing && now() >= deadline)
        throw new JobFailure('jellyfinUnavailable', `Jellyfin didn't list ${missing.path} within 2 minutes; check the folder and file names.`);
      await sleep(limits.publishPollMs, signal);
    }
  };

  /** A library refresh drops the deleted series or movie; Jellyfin's scheduled scan catches what it misses. */
  const forget: PlaybackTarget['forget'] = async (libraryId, _folders, signal) => {
    const { authorization, connection } = readyKey();
    await refresh(libraryItemOf(connection, libraryId), authorization, signal, true);
  };

  // ---- plays ----

  type Session = {
    UserId?: string;
    DeviceId: string;
    DeviceName: string;
    Client: string;
    NowPlayingItem?: { Id: string };
    PlayState?: { PlayMethod?: string };
    TranscodingInfo?: { TranscodeReasons?: string[] };
  };

  /** One `GET /Sessions`: the admin's sessions that play an item, with the method the client reported. */
  const observe: PlaybackTarget['observe'] = async (signal) => {
    const { authorization, connection } = readyKey();
    let sessions: Session[];
    try {
      sessions = await readJson<Session[]>(await call('GET', '/Sessions', { query: { activeWithinSeconds: '600' }, authorization, signal }), 'GET /Sessions');
    } catch (error) {
      return publishFailure(error);
    }
    const plays: ActivePlay[] = [];
    for (const session of sessions) {
      const method = playMethod(session.PlayState?.PlayMethod);
      if (session.UserId !== connection.adminUserId || !session.NowPlayingItem || !method) continue;
      plays.push({
        deviceId: session.DeviceId,
        deviceName: session.DeviceName,
        client: session.Client,
        itemRef: session.NowPlayingItem.Id,
        method,
        ...transcodeReasons(session.TranscodingInfo?.TranscodeReasons),
      });
    }
    return plays;
  };

  // ---- the password push ----

  /**
   * `POST /Users/Password?userId=<adminUserId>` with `{ NewPw }` and the key:
   * Jellyfin needs no current password with it. No ready connection, or a
   * refused key, ends the push: it can't land (`jellyfinPasswordNotPushed`).
   */
  async function pushPassword(_username: string, newPassword: string, signal: AbortSignal): Promise<void> {
    const connection = options.connection();
    if (connection?.state !== 'ready' || !connection.apiKey || !connection.adminUserId)
      throw new JobFailure('jellyfinPasswordNotPushed', "Jellyfin isn't set up, so the new password can't reach it.");
    try {
      await call('POST', '/Users/Password', {
        query: { userId: connection.adminUserId },
        authorization: tokenAuth(connection.apiKey),
        body: { NewPw: newPassword },
        signal,
      });
    } catch (error) {
      if (!(error instanceof CallError)) throw error;
      if (error.status === 401 || error.status === 403) throw new JobFailure('jellyfinPasswordNotPushed', error.detail);
      throw new JobFailure('jellyfinUnavailable', error.detail);
    }
  }

  return {
    setup,
    publish,
    forget,
    observe,
    pushPassword,
    readWatchState() {
      throw new Error('Reading Jellyfin watch state is a v2 step.');
    },
  };
}
