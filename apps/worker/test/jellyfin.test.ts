// The Jellyfin adapter against the fake Jellyfin 12.4: setup,
// publish, forget, the password push, and observe.
import { DEFAULT_LIMITS, type JellyfinConnection, type MaintenancePayload, type SetupStep } from '@omnarr/contracts';
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';

import { OMNARR_CSS, omnarrBranding } from '../src/jellyfin/branding.ts';
import { jellyfinClient, type JellyfinClient } from '../src/jellyfin/client.ts';
import { JobFailure } from '../src/runtime/lease.ts';
import { startFakeJellyfin, type FakeJellyfin } from './fakes/jellyfin.ts';

type SetupPayload = Extract<MaintenancePayload, { action: 'setupJellyfin' }>;

const SERIES_LIB = 'lib-series' as never;
const MOVIES_LIB = 'lib-movies' as never;
const PASSWORD = 'pl4nted-admin-password';

let fake: FakeJellyfin;
let connection: JellyfinConnection | null;
let clock: number;
let jellyfin: JellyfinClient;
const signal = new AbortController().signal;

const client = (timeoutMs?: number) =>
  jellyfinClient({
    url: fake.url,
    connection: () => connection,
    sleep: async (ms) => {
      clock += ms;
    },
    now: () => clock,
    ...(timeoutMs ? { timeoutMs } : {}),
  });

beforeEach(async () => {
  fake = await startFakeJellyfin();
  connection = null;
  clock = 0;
  jellyfin = client();
});
afterEach(() => fake.close());

const payload = (extra: Partial<SetupPayload> = {}): SetupPayload => ({
  class: 'maintenance',
  action: 'setupJellyfin',
  mode: 'firstRun',
  admin: { username: 'leon', password: PASSWORD },
  locale: { uiCulture: 'de-DE', metadataCountry: 'DE', metadataLanguage: 'de' },
  libraries: [
    { libraryId: SERIES_LIB, name: 'Series', kind: 'series', rootPath: '/data/library/series' },
    { libraryId: MOVIES_LIB, name: 'Movies', kind: 'movies', rootPath: '/data/library/movies' },
  ],
  remoteAccess: true,
  ...extra,
});

/** Runs setup and records every onStep call. */
async function setup(p = payload()) {
  const steps: string[] = [];
  const result = await jellyfin.setup(p, (step: SetupStep, state) => steps.push(`${step}:${state}`), signal);
  return { result, steps };
}

const calls = () => fake.requests.map((r) => `${r.method} ${r.path}`);

/** Expects a JobFailure with this code and data, and a detail free of the URL, the key and Jellyfin's own text. */
async function failure(promise: Promise<unknown>) {
  const error = await promise.then(
    () => expect.fail('expected a failure'),
    (e: unknown) => e,
  );
  expect(error).toBeInstanceOf(JobFailure);
  const { detail } = error as JobFailure;
  for (const secret of [fake.url, '127.0.0.1', 'pl4nted', ...fake.keys.map((k) => k.AccessToken)]) expect(detail).not.toContain(secret);
  return error as JobFailure;
}

/** A connection as the backend gives it after setup. */
async function readyConnection(): Promise<JellyfinConnection> {
  const { result } = await setup();
  return { state: 'ready', apiKey: result.apiKey!, adminUserId: result.adminUserId, libraries: result.libraries };
}

const SERIES = '/data/library/series/Harbour Lights (2021) [tmdbid-1001]';
const EPISODE = (n: number) => `${SERIES}/Season 01/Harbour Lights (2021) - S01E0${n} - Title [WEBDL-1080p]-GRP.mkv`;
const MOVIE_FOLDER = '/data/library/movies/Quiet Harbour (2020) [tmdbid-2002]';
const MOVIE = `${MOVIE_FOLDER}/Quiet Harbour (2020) [tmdbid-2002] - [WEBDL-1080p]-GRP.mkv`;

const episodes = (...paths: string[]) => ({
  items: paths.map((path, i) => ({ publicationId: `p${i + 1}` as never, path })),
  workFolderPath: SERIES,
  library: { libraryId: SERIES_LIB, root: '/data/library/series', kind: 'series' as const },
});
const movie = () => ({
  items: [{ publicationId: 'p1' as never, path: MOVIE }],
  workFolderPath: MOVIE_FOLDER,
  library: { libraryId: MOVIES_LIB, root: '/data/library/movies', kind: 'movies' as const },
});
const libraryItem = (name: string) => fake.folders.find((f) => f.Name === name)!.ItemId;
const refreshes = () => fake.requests.filter((r) => r.method === 'POST' && r.path.endsWith('/Refresh')).map((r) => r.path.split('/')[2]);
const listings = () => fake.requests.filter((r) => r.method === 'GET' && r.path === '/Items').map((r) => Object.fromEntries(r.query));

describe('publish', () => {
  beforeEach(async () => {
    connection = await readyConnection();
    fake.requests = [];
  });

  test('a known series: finds the series by its folder path, refreshes only that item, and returns the episode', async () => {
    fake.index(EPISODE(1), 'Episode');
    fake.addOnDisk(EPISODE(3), 'Episode');
    const series = fake.items.find((item) => item.Type === 'Series')!;

    const { refs, seriesRefs } = await jellyfin.publish(episodes(EPISODE(3)), signal);
    expect(refs).toEqual({ p1: fake.items.find((item) => item.Path === EPISODE(3))!.Id });
    // The series item, for the Work's "Open in Jellyfin".
    expect(seriesRefs).toEqual({ p1: series.Id });
    expect(refreshes()).toEqual([series.Id]);
    const refresh = fake.requests.find((r) => r.path.endsWith('/Refresh'))!;
    expect(Object.fromEntries(refresh.query)).toEqual({
      Recursive: 'true',
      MetadataRefreshMode: 'Default',
      ImageRefreshMode: 'Default',
      ReplaceAllMetadata: 'false',
      ReplaceAllImages: 'false',
    });
    expect(listings()).toEqual([
      { ParentId: libraryItem('Series'), Recursive: 'true', IncludeItemTypes: 'Series', Fields: 'Path' },
      { ParentId: series.Id, Recursive: 'true', IncludeItemTypes: 'Episode', Fields: 'Path' },
    ]);
  });

  const OTHER_SERIES_EPISODE = '/data/library/series/Quiet Waters (2019) [tmdbid-1002]/Season 01/Quiet Waters (2019) - S01E01 - Pilot [WEBDL-1080p]-GRP.mkv';
  const OTHER_MOVIE = '/data/library/movies/Other Movie (2018) [tmdbid-2001]/Other Movie (2018) [tmdbid-2001] - [WEBDL-1080p]-GRP.mkv';

  test('a new series: refreshes the library item, then repeats the series lookup until the series appears', async () => {
    fake.index(OTHER_SERIES_EPISODE, 'Episode');
    fake.addOnDisk(EPISODE(1), 'Episode', 2);
    const { refs } = await jellyfin.publish(episodes(EPISODE(1)), signal);
    expect(refs.p1).toBe(fake.items.find((item) => item.Path === EPISODE(1))!.Id);
    expect(refreshes()).toEqual([libraryItem('Series')]);
    expect(listings().filter((q) => q.IncludeItemTypes === 'Series').length).toBeGreaterThan(1);
    expect(clock).toBeGreaterThan(0);
  });

  test('a movie: refreshes the Movies library item and lists its movies with their paths', async () => {
    fake.index(OTHER_MOVIE, 'Movie');
    fake.addOnDisk(MOVIE, 'Movie');
    const { refs, seriesRefs } = await jellyfin.publish(movie(), signal);
    expect(refs.p1).toBe(fake.items.find((item) => item.Path === MOVIE)!.Id);
    // A movie's Work item is the movie itself.
    expect(seriesRefs).toEqual({ p1: refs.p1 });
    expect(refreshes()).toEqual([libraryItem('Movies')]);
    // Plain videos too, so a file Jellyfin didn't take for a movie is seen.
    for (const query of listings())
      expect(query).toEqual({ ParentId: libraryItem('Movies'), Recursive: 'true', IncludeItemTypes: 'Movie,Video', Fields: 'Path' });
  });

  // 12.4 never indexes the first content of a library created empty through a library-item refresh (fixtures/jellyfin/README.md).
  test.each([
    ['series', () => episodes(EPISODE(1)), EPISODE(1), 'Episode' as const],
    ['movie', () => movie(), MOVIE, 'Movie' as const],
  ])("a library's first %s: one full /Library/Refresh instead of the library item's", async (_kind, request, path, type) => {
    fake.addOnDisk(path, type);
    const { refs } = await jellyfin.publish(request(), signal);
    expect(refs.p1).toBe(fake.items.find((item) => item.Path === path)!.Id);
    expect(fake.requests.filter((r) => r.method === 'POST').map((r) => r.path)).toEqual(['/Library/Refresh']);
  });

  test('every file of the job is waited for, polling every 2 s', async () => {
    fake.index(EPISODE(1), 'Episode');
    fake.addOnDisk(EPISODE(2), 'Episode', 1);
    fake.addOnDisk(EPISODE(3), 'Episode', 3);
    const { refs } = await jellyfin.publish(episodes(EPISODE(2), EPISODE(3)), signal);
    expect(Object.keys(refs)).toEqual(['p1', 'p2']);
    expect(clock % 2_000).toBe(0);
    expect(clock).toBeGreaterThanOrEqual(2_000);
  });

  test('a file not listed within 2 minutes is jellyfinUnavailable, naming the file and the likely cause', async () => {
    fake.index(EPISODE(1), 'Episode');
    const error = await failure(jellyfin.publish(episodes(EPISODE(4)), signal));
    expect(error.code).toBe('jellyfinUnavailable');
    expect(error.data).toBeUndefined();
    expect(error.detail).toBe(`Jellyfin didn't list ${EPISODE(4)} within 2 minutes; check the folder and file names.`);
    expect(clock).toBeGreaterThanOrEqual(120_000);
    expect(clock).toBeLessThan(124_000);
  });

  describe('what Jellyfin read', () => {
    test("each episode's season and episode as Jellyfin numbered it, from the listing it is found in", async () => {
      fake.index(EPISODE(1), 'Episode');
      fake.addOnDisk(EPISODE(2), 'Episode', 0, { season: 0, episode: 26 });
      const { readings } = await jellyfin.publish(episodes(EPISODE(1), EPISODE(2)), signal);
      expect(readings).toEqual({ p1: { kind: 'episode', season: 1, episode: 1 }, p2: { kind: 'episode', season: 0, episode: 26 } });
    });

    // Recorded in the scan e2e on 12.4: a moved episode was listed with its path before its numbers.
    test('an episode listed before Jellyfin numbered it is waited for', async () => {
      fake.index(EPISODE(1), 'Episode');
      fake.addOnDisk(EPISODE(2), 'Episode', 0, { season: 1, episode: 2, afterPolls: 2 });
      const { readings } = await jellyfin.publish(episodes(EPISODE(2)), signal);
      expect(readings.p1).toEqual({ kind: 'episode', season: 1, episode: 2 });
      expect(clock).toBeGreaterThanOrEqual(2_000);
    });

    test('an episode Jellyfin never numbers is reported without numbers after 2 minutes, not as unavailable', async () => {
      fake.index(EPISODE(1), 'Episode');
      fake.addOnDisk(EPISODE(2), 'Episode', 0, {});
      const { readings } = await jellyfin.publish(episodes(EPISODE(2)), signal);
      expect(readings.p1).toEqual({ kind: 'episode' });
      expect(clock).toBeGreaterThanOrEqual(120_000);
    });

    test('a double episode reads its last episode too', async () => {
      fake.index(EPISODE(1), 'Episode', { season: 1, episode: 1, episodeEnd: 2 });
      const { readings } = await jellyfin.publish(episodes(EPISODE(1)), signal);
      expect(readings.p1).toEqual({ kind: 'episode', season: 1, episode: 1, episodeEnd: 2 });
    });

    test("a file in another folder than the Work's is found under that folder's series, and says so", async () => {
      const elsewhere = '/data/library/series/Holiday Footage 2019/clip_0001.mp4';
      fake.index(EPISODE(1), 'Episode');
      fake.addOnDisk(elsewhere, 'Episode', 0, { episode: 1 });
      const { refs, readings } = await jellyfin.publish(episodes(elsewhere), signal);
      expect(refs.p1).toBe(fake.items.find((item) => item.Path === elsewhere)!.Id);
      expect(readings.p1).toEqual({ kind: 'episode', episode: 1, otherSeries: true });
      // The other folder's series is new, so the library item is refreshed.
      expect(refreshes()).toEqual([libraryItem('Series')]);
    });

    test('a movie is read as a movie; a file Jellyfin lists as a plain video in the Movies library is not', async () => {
      fake.index(OTHER_MOVIE, 'Movie');
      fake.addOnDisk(MOVIE, 'Video');
      const { readings } = await jellyfin.publish(movie(), signal);
      expect(readings.p1).toEqual({ kind: 'other' });
      fake.items = fake.items.filter((item) => item.Path !== MOVIE);
      fake.index(MOVIE, 'Movie');
      expect((await jellyfin.publish(movie(), signal)).readings.p1).toEqual({ kind: 'movie' });
    });
  });

  test('a connection that is not ready fails with jellyfinSetupNeeded and no reason, without calling Jellyfin', async () => {
    for (const state of [null, { state: 'settingUp' as const, libraries: [] }, { ...connection!, state: 'blocked' as const }]) {
      connection = state;
      const error = await failure(jellyfin.publish(episodes(EPISODE(1)), signal));
      expect(error).toMatchObject({ code: 'jellyfinSetupNeeded' });
      expect(error.data).toBeUndefined();
    }
    expect(fake.requests).toEqual([]);
  });

  describe('the error table', () => {
    beforeEach(() => fake.index(EPISODE(1), 'Episode'));

    test('no answer is jellyfinUnavailable', async () => {
      await fake.close();
      const error = await failure(jellyfin.publish(episodes(EPISODE(1)), signal));
      expect(error).toMatchObject({ code: 'jellyfinUnavailable', detail: 'Jellyfin did not answer (GET /Items).' });
      fake = await startFakeJellyfin();
    });

    test('a timeout is jellyfinUnavailable', async () => {
      fake.delayMs = 200;
      jellyfin = client(20);
      const error = await failure(jellyfin.publish(episodes(EPISODE(1)), signal));
      expect(error).toMatchObject({ code: 'jellyfinUnavailable', detail: 'Jellyfin did not answer in time (GET /Items).' });
    });

    test('HTTP 5xx is jellyfinUnavailable with the status', async () => {
      fake.failures.set('POST /Items/:id/Refresh', 503);
      const error = await failure(jellyfin.publish(episodes(EPISODE(1)), signal));
      expect(error).toMatchObject({ code: 'jellyfinUnavailable', detail: 'Jellyfin answered HTTP 503 (POST /Items/<id>/Refresh).' });
    });

    test.each([401, 403])('HTTP %s with the stored key is jellyfinSetupNeeded, keyRejected', async (status) => {
      fake.failures.set('GET /Items', status);
      const error = await failure(jellyfin.publish(episodes(EPISODE(1)), signal));
      expect(error).toMatchObject({ code: 'jellyfinSetupNeeded', data: { reason: 'keyRejected' } });
    });

    test('a revoked key is keyRejected', async () => {
      fake.keys = [];
      const error = await failure(jellyfin.publish(movie(), signal));
      expect(error).toMatchObject({ code: 'jellyfinSetupNeeded', data: { reason: 'keyRejected' } });
    });

    test('HTTP 404 on the library item is jellyfinSetupNeeded, libraryMissing', async () => {
      connection = { ...connection!, libraries: connection!.libraries.map((l) => ({ ...l, itemId: 'f00df00df00df00df00df00df00df00d' })) };
      const error = await failure(jellyfin.publish(movie(), signal));
      expect(error).toMatchObject({ code: 'jellyfinSetupNeeded', data: { reason: 'libraryMissing' } });
    });

    test("12.4's 400 on a listing under an unknown library item is libraryMissing too", async () => {
      connection = { ...connection!, libraries: connection!.libraries.map((l) => ({ ...l, itemId: 'f00df00df00df00df00df00df00df00d' })) };
      const error = await failure(jellyfin.publish(episodes(EPISODE(1)), signal));
      expect(error).toMatchObject({ code: 'jellyfinSetupNeeded', data: { reason: 'libraryMissing' } });
    });

    test('a library the connection lacks is libraryMissing', async () => {
      connection = { ...connection!, libraries: [] };
      const error = await failure(jellyfin.publish(movie(), signal));
      expect(error).toMatchObject({ code: 'jellyfinSetupNeeded', data: { reason: 'libraryMissing' } });
    });

    test('any other status is jellyfinUnavailable with the status', async () => {
      fake.failures.set('GET /Items', 409);
      const error = await failure(jellyfin.publish(episodes(EPISODE(1)), signal));
      expect(error).toMatchObject({ code: 'jellyfinUnavailable', detail: 'Jellyfin answered HTTP 409 (GET /Items).' });
    });
  });

  test('only the MediaBrowser Token header is sent', async () => {
    fake.index(EPISODE(1), 'Episode');
    await jellyfin.publish(episodes(EPISODE(1)), signal);
    for (const request of fake.requests) expect(request.authorization).toBe(`MediaBrowser Token="${connection!.apiKey}"`);
    expect(fake.requests.filter((r) => r.legacyAuth)).toEqual([]);
  });

  test("a cancelled job's call ends with the abort", async () => {
    fake.delayMs = 200;
    const controller = new AbortController();
    const pending = jellyfin.publish(episodes(EPISODE(1)), controller.signal);
    controller.abort('cancelled');
    await expect(pending).rejects.toBe('cancelled');
  });
});

describe('forget', () => {
  test("refreshes the library's item, which drops the deleted folders", async () => {
    connection = await readyConnection();
    fake.requests = [];
    await jellyfin.forget(MOVIES_LIB, [MOVIE_FOLDER], signal);
    expect(refreshes()).toEqual([libraryItem('Movies')]);
  });

  test('a failure is a JobFailure the caller can log', async () => {
    connection = await readyConnection();
    fake.failures.set('POST /Items/:id/Refresh', 500);
    expect((await failure(jellyfin.forget(MOVIES_LIB, [MOVIE_FOLDER], signal))).code).toBe('jellyfinUnavailable');
  });
});

describe('pushPassword', () => {
  test('sends POST /Users/Password?userId=<adminUserId> with { NewPw } and only the MediaBrowser Token header', async () => {
    connection = await readyConnection();
    fake.requests = [];
    await jellyfin.pushPassword('leon', 'pl4nted-new-password', signal);
    const [push] = fake.requests;
    expect(push).toMatchObject({ method: 'POST', path: '/Users/Password', body: { NewPw: 'pl4nted-new-password' } });
    expect(Object.fromEntries(push!.query)).toEqual({ userId: connection.adminUserId });
    expect(push!.authorization).toBe(`MediaBrowser Token="${connection.apiKey}"`);
    expect(fake.admin!.password).toBe('pl4nted-new-password');
  });

  test.each([401, 403])('HTTP %s is a terminal failure: jellyfinPasswordNotPushed', async (status) => {
    connection = await readyConnection();
    fake.failures.set('POST /Users/Password', status);
    expect((await failure(jellyfin.pushPassword('leon', 'pl4nted-new', signal))).code).toBe('jellyfinPasswordNotPushed');
  });

  test('no ready connection is a terminal failure, without calling Jellyfin', async () => {
    connection = { state: 'blocked', libraries: [] };
    expect((await failure(jellyfin.pushPassword('leon', 'pl4nted-new', signal))).code).toBe('jellyfinPasswordNotPushed');
    expect(fake.requests).toEqual([]);
  });

  test('no answer is jellyfinUnavailable, which is retried', async () => {
    connection = await readyConnection();
    await fake.close();
    expect((await failure(jellyfin.pushPassword('leon', 'pl4nted-new', signal))).code).toBe('jellyfinUnavailable');
    fake = await startFakeJellyfin();
  });
});

describe('observe', () => {
  const TABLET = { deviceId: 'spike-tablet-1', deviceName: 'Spike Tablet', client: 'Jellyfin Android' };
  const CHROME = { deviceId: 'chrome-device-1', deviceName: 'Chrome', client: 'Jellyfin Web' };

  beforeEach(async () => {
    connection = await readyConnection();
    fake.requests.length = 0;
  });

  test('makes one call, GET /Sessions?activeWithinSeconds=600, with only the MediaBrowser Token header', async () => {
    await jellyfin.observe(signal);
    expect(fake.requests.map((r) => `${r.method} ${r.path}?${r.query}`)).toEqual(['GET /Sessions?activeWithinSeconds=600']);
    expect(fake.requests[0]!.authorization).toBe(`MediaBrowser Token="${connection!.apiKey}"`);
  });

  test("returns each of the admin's sessions that plays an item, with its method and reasons", async () => {
    const admin = connection!.adminUserId!;
    fake.sessions = [
      { ...TABLET, userId: admin, playing: { itemId: 'item-e1', playMethod: 'DirectPlay' } },
      {
        ...CHROME,
        userId: admin,
        playing: { itemId: 'item-e2', playMethod: 'Transcode', transcodeReasons: ['ContainerNotSupported', 'AudioCodecNotSupported'] },
      },
    ];
    expect(await jellyfin.observe(signal)).toEqual([
      { ...TABLET, itemRef: 'item-e1', method: 'directPlay', reasons: [], rawReasons: [] },
      {
        ...CHROME,
        itemRef: 'item-e2',
        method: 'transcode',
        reasons: ['container', 'audioCodec'],
        rawReasons: ['ContainerNotSupported', 'AudioCodecNotSupported'],
      },
    ]);
  });

  test("leaves out a session that plays nothing and another user's play", async () => {
    fake.sessions = [
      { ...TABLET, userId: connection!.adminUserId! },
      { ...CHROME, userId: 'someone-else', playing: { itemId: 'item-e1', playMethod: 'DirectPlay' } },
    ];
    expect(await jellyfin.observe(signal)).toEqual([]);
  });

  test("the method is the transcode job's, not what the client reported", async () => {
    const admin = connection!.adminUserId!;
    const copied = { video: true, audio: true };
    fake.sessions = [
      // The Android app's fallback after a failed direct play: it still reports DirectPlay while Jellyfin stream-copies.
      { ...TABLET, userId: admin, playing: { itemId: 'item-e1', playMethod: 'DirectPlay', transcodeReasons: ['DirectPlayError'], copied } },
      // Jellyfin's DirectStream converts the audio: a transcode in omnarr's terms.
      { ...CHROME, userId: admin, playing: { itemId: 'item-e2', playMethod: 'DirectStream', transcodeReasons: ['AudioCodecNotSupported'] } },
    ];
    expect(await jellyfin.observe(signal)).toMatchObject([
      { deviceName: 'Spike Tablet', method: 'remux', reasons: ['directPlayFailed'], rawReasons: ['DirectPlayError'] },
      { deviceName: 'Chrome', method: 'transcode', reasons: ['audioCodec'] },
    ]);
  });

  test('a refused key or no answer is a failure the poller can log, free of the URL and the key', async () => {
    fake.failures.set('GET /Sessions', 401);
    expect(await failure(jellyfin.observe(signal))).toMatchObject({ code: 'jellyfinSetupNeeded' });
    fake.failures.set('GET /Sessions', 500);
    expect(await failure(jellyfin.observe(signal))).toMatchObject({ code: 'jellyfinUnavailable', detail: 'Jellyfin answered HTTP 500 (GET /Sessions).' });
  });

  test('a connection that is not ready fails without calling Jellyfin', async () => {
    connection = { state: 'settingUp', libraries: [] };
    expect(await failure(jellyfin.observe(signal))).toMatchObject({ code: 'jellyfinSetupNeeded' });
    expect(fake.requests).toEqual([]);
  });
});

describe('setup', () => {
  test('firstRun against a fresh Jellyfin runs every step in order, each through onStep', async () => {
    const { result, steps } = await setup();
    expect(steps).toEqual(['reachable:done', 'wizard:done', 'apiKey:done', 'libraries:done', 'branding:done', 'testRefresh:done']);
    expect(fake.wizardCompleted).toBe(true);
    expect(fake.admin).toMatchObject({ name: 'leon', password: PASSWORD });
    expect(result).toEqual({
      class: 'maintenance',
      action: 'setupJellyfin',
      serverId: fake.serverId,
      version: '12.4.0',
      adminUserId: fake.admin!.id,
      apiKey: fake.keys[0]!.AccessToken,
      libraries: [
        { libraryId: SERIES_LIB, itemId: fake.folders.find((f) => f.Name === 'Series')!.ItemId },
        { libraryId: MOVIES_LIB, itemId: fake.folders.find((f) => f.Name === 'Movies')!.ItemId },
      ],
      brandingClaim: omnarrBranding(undefined),
      steps: ['reachable', 'wizard', 'apiKey', 'libraries', 'branding', 'testRefresh'].map((step) => ({ step, state: 'done', at: 0 })),
    });
  });

  test('the wizard gets the locale, the admin and remote access; then it is completed', async () => {
    await setup(payload({ remoteAccess: false }));
    const body = (path: string) => fake.requests.find((r) => r.method === 'POST' && r.path === path)?.body;
    expect(body('/Startup/Configuration')).toEqual({ UICulture: 'de-DE', MetadataCountryCode: 'DE', PreferredMetadataLanguage: 'de' });
    expect(body('/Startup/User')).toEqual({ Name: 'leon', Password: PASSWORD });
    expect(body('/Startup/RemoteAccess')).toEqual({ EnableRemoteAccess: false, EnableAutomaticPortMapping: false });
    expect(calls().filter((c) => c.includes('/Startup/'))).toEqual([
      'POST /Startup/Configuration',
      'GET /Startup/User',
      'POST /Startup/User',
      'POST /Startup/RemoteAccess',
      'POST /Startup/Complete',
    ]);
  });

  test('the key is made by the admin\'s sign-in as the app "omnarr", and the sign-in session is logged out', async () => {
    await setup();
    const signIn = fake.requests.find((r) => r.path === '/Users/AuthenticateByName')!;
    expect(signIn.authorization).toMatch(/^MediaBrowser Client="omnarr", Device="omnarr", DeviceId="omnarr-setup", Version="[^"]+"$/);
    expect(fake.requests.find((r) => r.path === '/Auth/Keys' && r.method === 'POST')!.query.get('app')).toBe('omnarr');
    expect(calls()).toContain('POST /Sessions/Logout');
    expect(fake.sessionTokens.size).toBe(0);
  });

  test('libraries are typed, monitor nothing in real time, carry the locale, and offline ones have no fetchers', async () => {
    await setup(payload({ offline: true }));
    const series = fake.folders.find((f) => f.Name === 'Series')!;
    expect(series).toMatchObject({ CollectionType: 'tvshows', Locations: ['/data/library/series'] });
    expect(fake.folders.find((f) => f.Name === 'Movies')).toMatchObject({ CollectionType: 'movies', Locations: ['/data/library/movies'] });
    expect(series.LibraryOptions).toMatchObject({ EnableRealtimeMonitor: false, PreferredMetadataLanguage: 'de', MetadataCountryCode: 'DE' });
    expect(series.LibraryOptions).toMatchObject({
      EnableTrickplayImageExtraction: true,
      ExtractTrickplayImagesDuringLibraryScan: false,
      SaveTrickplayWithMedia: false,
    });
    const types = (series.LibraryOptions.TypeOptions as { Type: string; MetadataFetchers: string[]; ImageFetchers: string[] }[]).map((t) => t.Type);
    expect(types.sort()).toEqual(['Episode', 'Movie', 'Season', 'Series']);
    for (const option of series.LibraryOptions.TypeOptions as { MetadataFetchers: string[]; ImageFetchers: string[] }[])
      expect(option).toMatchObject({ MetadataFetchers: [], ImageFetchers: [] });
    const create = fake.requests.find((r) => r.method === 'POST' && r.path === '/Library/VirtualFolders')!;
    expect(create.query.get('refreshLibrary')).toBe('false');
  });

  test("without offline, the libraries keep Jellyfin's default fetchers", async () => {
    await setup();
    expect(fake.folders[0]!.LibraryOptions).not.toHaveProperty('TypeOptions');
  });

  test('testRefresh refreshes each library item, in firstRun only', async () => {
    await setup();
    const refreshed = fake.requests.filter((r) => r.path.endsWith('/Refresh')).map((r) => r.path.split('/')[2]);
    expect(new Set(refreshed)).toEqual(new Set(fake.folders.map((f) => f.ItemId)));
    expect(refreshed).toHaveLength(2);

    fake.requests = [];
    connection = { state: 'ready', apiKey: fake.keys[0]!.AccessToken, adminUserId: fake.admin!.id, libraries: [] };
    const { steps } = await setup(payload({ mode: 'rerun' }));
    expect(fake.requests.filter((r) => r.path.endsWith('/Refresh'))).toEqual([]);
    expect(steps).toEqual(['reachable:done', 'wizard:done', 'apiKey:done', 'libraries:done', 'branding:done']);
  });

  test('a completed wizard and a working key skip both steps; the result keeps the stored key', async () => {
    connection = await readyConnection();
    fake.requests = [];
    const { result } = await setup(payload({ mode: 'rerun' }));
    expect(calls().filter((c) => c.includes('/Startup/') || c.includes('/Auth/') || c.includes('AuthenticateByName'))).toEqual([]);
    expect(result).not.toHaveProperty('apiKey');
    expect(result.adminUserId).toBe(connection.adminUserId);
  });

  test('a rejected stored key is replaced, and older omnarr keys are deleted', async () => {
    await setup();
    fake.keys.push({ AccessToken: 'other-app-key', AppName: 'other', DateCreated: new Date().toISOString() });
    connection = { state: 'blocked', apiKey: 'a-revoked-key', libraries: [] };
    const { result } = await setup(payload({ mode: 'rerun' }));
    const omnarr = fake.keys.filter((k) => k.AppName === 'omnarr');
    expect(omnarr).toHaveLength(1);
    expect(result.apiKey).toBe(omnarr[0]!.AccessToken);
    expect(fake.keys.some((k) => k.AppName === 'other')).toBe(true);
  });

  test('a failed sign-in is credentialsNeeded, at the apiKey step', async () => {
    fake.wizardCompleted = true;
    fake.admin = { id: 'u1', name: 'leon', password: 'another-password' };
    const error = await failure(setup(payload({ mode: 'rerun' })));
    expect(error).toMatchObject({ code: 'jellyfinSetupNeeded', data: { reason: 'credentialsNeeded', step: 'apiKey' } });
    expect(error.detail).toContain('POST /Users/AuthenticateByName');
  });

  test('a library that is present is not re-created, whatever its name', async () => {
    await setup();
    fake.folders[0]!.Name = 'Renamed by hand';
    connection = { state: 'ready', apiKey: fake.keys[0]!.AccessToken, adminUserId: fake.admin!.id, libraries: [] };
    fake.requests = [];
    const { result } = await setup(payload({ mode: 'rerun' }));
    expect(calls()).not.toContain('POST /Library/VirtualFolders');
    expect(fake.folders).toHaveLength(2);
    expect(result.libraries.map((l) => l.itemId).sort()).toEqual(fake.folders.map((f) => f.ItemId).sort());
  });

  test('a missing library is created again by a re-run', async () => {
    await setup();
    const movies = fake.folders.find((f) => f.Name === 'Movies')!;
    fake.folders = fake.folders.filter((f) => f !== movies);
    connection = { state: 'ready', apiKey: fake.keys[0]!.AccessToken, adminUserId: fake.admin!.id, libraries: [] };
    await setup(payload({ mode: 'rerun' }));
    expect(new Set(fake.folders.map((f) => f.Locations[0]))).toEqual(new Set(['/data/library/movies', '/data/library/series']));
    expect(fake.folders).toHaveLength(2);
  });

  test('a Jellyfin that never answers is jellyfinUnavailable at the reachable step, after 3 minutes of polling every 2 s', async () => {
    await fake.close();
    const error = await failure(setup());
    expect(error).toMatchObject({ code: 'jellyfinUnavailable', data: { reason: 'setupFailed', step: 'reachable' } });
    expect(clock).toBeGreaterThanOrEqual(180_000);
    expect(clock).toBeLessThan(184_000);
    fake = await startFakeJellyfin();
  });

  test("the e2e's lowered jellyfinReachableMs: the reachable step gives up after it", async () => {
    await fake.close();
    jellyfin = jellyfinClient({
      url: fake.url,
      connection: () => connection,
      sleep: async (ms) => {
        clock += ms;
      },
      now: () => clock,
      limits: { ...DEFAULT_LIMITS, jellyfinReachableMs: 5000 },
    });
    const error = await failure(setup());
    expect(error).toMatchObject({ code: 'jellyfinUnavailable', data: { reason: 'setupFailed', step: 'reachable' } });
    expect(clock).toBeGreaterThanOrEqual(5000);
    expect(clock).toBeLessThan(8000);
    jellyfin = client();
    fake = await startFakeJellyfin();
  });

  test('a Jellyfin that answers only later is waited for', async () => {
    fake.failures.set('GET /System/Info/Public', 503);
    let polls = 0;
    const original = jellyfin;
    jellyfin = jellyfinClient({
      url: fake.url,
      connection: () => connection,
      now: () => clock,
      sleep: async (ms) => {
        clock += ms;
        if (++polls === 3) fake.failures.delete('GET /System/Info/Public');
      },
    });
    const { steps } = await setup();
    expect(steps[0]).toBe('reachable:done');
    jellyfin = original;
  });

  test('an HTTP error during a step is jellyfinUnavailable with that step and the status', async () => {
    fake.failures.set('POST /Startup/User', 500);
    const error = await failure(setup());
    expect(error).toMatchObject({ code: 'jellyfinUnavailable', data: { reason: 'setupFailed', step: 'wizard' } });
    expect(error.detail).toBe('Jellyfin answered HTTP 500 (POST /Startup/User).');
  });

  test('only the MediaBrowser authorization header is sent, never a legacy one', async () => {
    connection = await readyConnection();
    await setup(payload({ mode: 'rerun' }));
    expect(fake.requests.filter((r) => r.legacyAuth)).toEqual([]);
    for (const request of fake.requests.filter((r) => r.authorization)) expect(request.authorization).toMatch(/^MediaBrowser /);
  });
});

describe('setup: branding', () => {
  const NO_LINK = 'Sign in with your omnarr username and password. To add movies and series, open omnarr.';
  const OLD_OMNARR = { serverName: 'omnarr-old', loginDisclaimer: 'An earlier omnarr line.', customCss: ':root { --old: 1; }' };
  const USER = { ServerName: 'Living room', LoginDisclaimer: 'Ask Sam for a login.', CustomCss: '.mine {}' };
  const FRESH_LOGIN_PAGE = { SplashscreenEnabled: false };
  const loginPage = () => fake.brandingConfiguration;
  const posts = () => calls().filter((c) => c === 'POST /System/Configuration' || c === 'POST /System/Configuration/branding');
  const rerun = (extra: Partial<SetupPayload>) => setup(payload({ mode: 'rerun', ...extra }));
  const freshJellyfin = () => {
    fake.serverConfiguration.ServerName = '';
    fake.brandingConfiguration = { ...FRESH_LOGIN_PAGE };
  };

  beforeEach(async () => {
    connection = await readyConnection();
    freshJellyfin();
    fake.requests = [];
  });

  test("a fresh Jellyfin gets the server name, the login line and the theme; the splash setting stays Jellyfin's", async () => {
    const { result } = await rerun({});
    expect(fake.serverConfiguration.ServerName).toBe('omnarr');
    expect(loginPage()).toEqual({ ...FRESH_LOGIN_PAGE, LoginDisclaimer: NO_LINK, CustomCss: OMNARR_CSS });
    expect(result.brandingClaim).toEqual(omnarrBranding(undefined));
  });

  test("a field Jellyfin sends as null counts as Jellyfin's default", async () => {
    fake.serverConfiguration.ServerName = null;
    fake.brandingConfiguration = { ...FRESH_LOGIN_PAGE, LoginDisclaimer: null, CustomCss: null };
    await rerun({});
    expect(fake.serverConfiguration.ServerName).toBe('omnarr');
    expect(loginPage()).toEqual({ ...FRESH_LOGIN_PAGE, LoginDisclaimer: NO_LINK, CustomCss: OMNARR_CSS });
  });

  test("the server name is written into Jellyfin's whole configuration, every other field as it was", async () => {
    const recorded = { ...fake.serverConfiguration, ServerName: '' };
    fake.serverConfiguration = recorded;
    await rerun({});
    expect(fake.serverConfiguration).toEqual({ ...recorded, ServerName: 'omnarr' });
  });

  test("the login line links to omnarr's address, escaped for HTML", async () => {
    await rerun({ webUrl: 'https://media.example/omnarr?a=1&b="2"' });
    expect(loginPage().LoginDisclaimer).toBe(
      'Sign in with your omnarr username and password. To add movies and series, open ' +
        '<a href="https://media.example/omnarr?a=1&amp;b=&quot;2&quot;" target="_blank" rel="noopener">omnarr</a>.',
    );
  });

  test('an address that is not http or https gets the line without a link', async () => {
    await rerun({ webUrl: 'javascript:alert(1)' });
    expect(loginPage().LoginDisclaimer).toBe(NO_LINK);
  });

  test("a re-run replaces omnarr's own earlier values", async () => {
    fake.serverConfiguration.ServerName = OLD_OMNARR.serverName;
    fake.brandingConfiguration = { ...FRESH_LOGIN_PAGE, LoginDisclaimer: OLD_OMNARR.loginDisclaimer, CustomCss: OLD_OMNARR.customCss };
    const { result } = await rerun({ brandingClaim: OLD_OMNARR });
    expect(fake.serverConfiguration.ServerName).toBe('omnarr');
    expect(loginPage()).toEqual({ ...FRESH_LOGIN_PAGE, LoginDisclaimer: NO_LINK, CustomCss: OMNARR_CSS });
    expect(result.brandingClaim).toEqual(omnarrBranding(undefined));
  });

  test("a value the user changed in Jellyfin's dashboard stays, for every field, and omnarr drops its claim on it", async () => {
    fake.serverConfiguration.ServerName = USER.ServerName;
    fake.brandingConfiguration = { ...FRESH_LOGIN_PAGE, LoginDisclaimer: USER.LoginDisclaimer, CustomCss: USER.CustomCss };
    const { result } = await rerun({ brandingClaim: OLD_OMNARR });
    expect(posts()).toEqual([]);
    expect(fake.serverConfiguration.ServerName).toBe(USER.ServerName);
    expect(loginPage()).toEqual({ ...FRESH_LOGIN_PAGE, LoginDisclaimer: USER.LoginDisclaimer, CustomCss: USER.CustomCss });
    expect(result.brandingClaim).toEqual({});
  });

  test("the user's login line stays while omnarr's theme is written beside it", async () => {
    fake.brandingConfiguration = { ...FRESH_LOGIN_PAGE, LoginDisclaimer: USER.LoginDisclaimer, CustomCss: OLD_OMNARR.customCss };
    const { result } = await rerun({ brandingClaim: OLD_OMNARR });
    expect(loginPage()).toEqual({ ...FRESH_LOGIN_PAGE, LoginDisclaimer: USER.LoginDisclaimer, CustomCss: OMNARR_CSS });
    expect(result.brandingClaim).toEqual({ serverName: 'omnarr', customCss: OMNARR_CSS });
  });

  test("the user's theme stays while omnarr's login line is written beside it", async () => {
    fake.brandingConfiguration = { ...FRESH_LOGIN_PAGE, LoginDisclaimer: OLD_OMNARR.loginDisclaimer, CustomCss: USER.CustomCss };
    const { result } = await rerun({ brandingClaim: OLD_OMNARR });
    expect(loginPage()).toEqual({ ...FRESH_LOGIN_PAGE, LoginDisclaimer: NO_LINK, CustomCss: USER.CustomCss });
    expect(result.brandingClaim).toEqual({ serverName: 'omnarr', loginDisclaimer: NO_LINK });
  });

  test('a Jellyfin that already shows the branding is not written again', async () => {
    await rerun({});
    fake.requests = [];
    await rerun({ brandingClaim: omnarrBranding(undefined) });
    expect(posts()).toEqual([]);
  });

  test('an install from before the branding gets it, its libraries, users and API key untouched', async () => {
    const before = {
      libraries: structuredClone(fake.folders),
      keys: structuredClone(fake.keys),
      admin: structuredClone(fake.admin),
    };
    const { result } = await rerun({});
    expect(fake.serverConfiguration.ServerName).toBe('omnarr');
    expect(loginPage().CustomCss).toBe(OMNARR_CSS);
    expect(fake.folders).toEqual(before.libraries);
    expect(fake.keys).toEqual(before.keys);
    expect(fake.admin).toEqual(before.admin);
    expect(result).not.toHaveProperty('apiKey');
    expect(calls().filter((c) => c.includes('/Library/VirtualFolders') && c.startsWith('POST'))).toEqual([]);
  });

  test('an HTTP error while branding is jellyfinUnavailable at the branding step', async () => {
    fake.failures.set('POST /System/Configuration/branding', 500);
    const error = await failure(rerun({}));
    expect(error).toMatchObject({ code: 'jellyfinUnavailable', data: { reason: 'setupFailed', step: 'branding' } });
  });
});
