// The maintenance handler: removing a download with
// its folder, the provider login test, and the staging clean-up.
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LeasedJob, MaintenancePayload, ProbeSummary } from '@omnarr/contracts';
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';

import type { NzbgetClient, UsenetLogin } from '../src/clients/nzbget.ts';
import { dataLayout, type DataLayout } from '../src/fs/layout.ts';
import type { JellyfinClient } from '../src/jellyfin/client.ts';
import { maintenanceHandler, type MaintenanceDeps } from '../src/jobs/maintenance.ts';
import { ClientRuntimeStore } from '../src/runtime/clientRuntime.ts';
import { JobFailure } from '../src/runtime/lease.ts';
import { FakeBackend } from './fakeBackend.ts';
import { FakeDownloadClient } from './fakeDownloadClient.ts';

let root: string;
let layout: DataLayout;
let client: FakeDownloadClient;
let runtime: ClientRuntimeStore;
let tested: UsenetLogin[];
let testAnswer: 'ok' | 'authRejected' | 'failed';

/** The fake client with NZBGet's provider test. */
const nzbget = (): NzbgetClient =>
  Object.assign(client, {
    testServer: async (login: UsenetLogin) => {
      tested.push(login);
      return testAnswer;
    },
  }) as unknown as NzbgetClient;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'omnarr-maintenance-'));
  layout = dataLayout(root);
  client = new FakeDownloadClient();
  runtime = new ClientRuntimeStore();
  tested = [];
  testAnswer = 'ok';
});
afterEach(() => rm(root, { recursive: true, force: true }));

/** The scan's deps, for the actions that don't scan: a probe here would be a bug. */
const scanDeps = () => ({
  backend: new FakeBackend(),
  probe: async (): Promise<ProbeSummary> => {
    throw new Error('Only scanLibrary probes.');
  },
});

const run = (payload: MaintenancePayload, deps: Partial<MaintenanceDeps> = {}) =>
  maintenanceHandler({ layout, clients: { nzbget: client }, nzbget: nzbget(), runtime, ...scanDeps(), ...deps })(
    { jobId: 'j' as never, class: 'maintenance', leaseEpoch: 1, payload } as LeasedJob,
    { signal: new AbortController().signal, progress: () => {} },
  );

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
const folder = async (path: string) => {
  await mkdir(path, { recursive: true });
  await writeFile(join(path, 'E1.mkv'), 'x');
};

describe('removeDownload', () => {
  test('removes the item from its client', async () => {
    const clientRef = client.add('grab1');
    expect(await run({ class: 'maintenance', action: 'removeDownload', clientKind: 'nzbget', clientRef, deleteData: true })).toEqual({
      class: 'maintenance',
      action: 'removeDownload',
      removed: true,
    });
    expect(client.items).toEqual([]);
  });

  test('waits for an apply that holds the client lock', async () => {
    const clientRef = client.add('grab1');
    const events: string[] = [];
    let release!: () => void;
    const applying = runtime.withClientLock('nzbget', () => new Promise<void>((resolve) => (release = resolve)).then(() => void events.push('applied')));
    const removing = run({ class: 'maintenance', action: 'removeDownload', clientKind: 'nzbget', clientRef, deleteData: true }).then(() =>
      events.push('removed'),
    );
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(client.calls).not.toContain('remove');
    release();
    await Promise.all([applying, removing]);
    expect(events).toEqual(['applied', 'removed']);
  });

  describe("a Usenet download's folder goes too, only under downloads/usenet/", () => {
    const remove = (clientKind: 'nzbget' | 'qbittorrent', contentPath: string) =>
      run({ class: 'maintenance', action: 'removeDownload', clientKind, clientRef: '1', deleteData: true, contentPath });

    test('a completed download folder under downloads/usenet/ goes, with the client item', async () => {
      const path = join(layout.usenetDownloads, 'completed', 'platform-series', 'grab1');
      await folder(path);
      client.add('grab1');
      expect(await remove('nzbget', '/data/downloads/usenet/completed/platform-series/grab1')).toMatchObject({ removed: true });
      expect(await exists(path)).toBe(false);
      expect(client.items).toEqual([]);
    });

    test.each([
      ['the library', '/data/library/series/Harbour Lights (2021)'],
      ['a path that climbs out of downloads/usenet/', '/data/downloads/usenet/../../library/series/Harbour Lights (2021)'],
      ['downloads/usenet/ itself', '/data/downloads/usenet'],
      ["the torrents' folder, beside usenet/", '/data/downloads/torrents/grab1'],
    ])('a path outside downloads/usenet/ is refused: %s', async (_name, contentPath) => {
      const library = join(layout.library, 'series', 'Harbour Lights (2021)');
      const torrent = join(layout.torrentDownloads, 'grab1');
      await folder(library);
      await folder(torrent);
      await mkdir(layout.usenetDownloads, { recursive: true });
      await remove('nzbget', contentPath);
      expect(await exists(join(library, 'E1.mkv'))).toBe(true);
      expect(await exists(join(torrent, 'E1.mkv'))).toBe(true);
      expect(await exists(layout.usenetDownloads)).toBe(true);
    });

    test('a symlink under downloads/usenet/ that points outside it is refused', async () => {
      const library = join(layout.library, 'keep');
      await folder(library);
      await mkdir(layout.usenetDownloads, { recursive: true });
      await symlink(library, join(layout.usenetDownloads, 'link'));
      await remove('nzbget', '/data/downloads/usenet/link');
      expect(await exists(join(library, 'E1.mkv'))).toBe(true);
    });

    test("a torrent's files are never deleted by path: qBittorrent deletes its own", async () => {
      const path = join(layout.torrentDownloads, 'grab1');
      await folder(path);
      const torrents = new FakeDownloadClient('qbittorrent');
      await run(
        {
          class: 'maintenance',
          action: 'removeDownload',
          clientKind: 'qbittorrent',
          clientRef: '1',
          deleteData: true,
          contentPath: '/data/downloads/torrents/grab1',
        },
        { clients: { qbittorrent: torrents } },
      );
      expect(await exists(path)).toBe(true);
    });
  });
});

describe('testUsenetServer', () => {
  const login = { host: 'news.example', port: 563, ssl: true, username: 'reader', password: 'planted-provider' };

  test.each(['ok', 'authRejected', 'failed'] as const)("NZBGet's answer %s is the job's outcome", async (outcome) => {
    testAnswer = outcome;
    expect(await run({ class: 'maintenance', action: 'testUsenetServer', ...login })).toEqual({ class: 'maintenance', action: 'testUsenetServer', outcome });
    expect(tested).toEqual([login]);
  });

  test('without NZBGet the job fails as clientUnreachable, so it retries and then writes failed', async () => {
    await expect(run({ class: 'maintenance', action: 'testUsenetServer', ...login }, { nzbget: undefined })).rejects.toMatchObject({
      code: 'clientUnreachable',
    });
  });
});

test('cleanStaging removes staging folders, and nothing outside staging/', async () => {
  const staged = join(layout.staging, 'job1');
  const outside = join(layout.library, 'keep.mkv');
  await mkdir(staged, { recursive: true });
  await mkdir(layout.library, { recursive: true });
  await writeFile(join(staged, 'part.mkv'), 'x');
  await writeFile(outside, 'x');
  expect(await run({ class: 'maintenance', action: 'cleanStaging', paths: ['/data/staging/job1', '/data/library/keep.mkv'] })).toEqual({
    class: 'maintenance',
    action: 'cleanStaging',
    removedPaths: ['/data/staging/job1'],
  });
  await expect(stat(staged)).rejects.toThrow();
  expect((await stat(outside)).isFile()).toBe(true);
});

test('cleanStaging leaves staging/held/ alone', async () => {
  const held = join(layout.held, 'job2');
  await mkdir(held, { recursive: true });
  await writeFile(join(held, '1.mkv'), 'x');
  expect(await run({ class: 'maintenance', action: 'cleanStaging', paths: ['/data/staging/held', '/data/staging/held/job2'] })).toEqual({
    class: 'maintenance',
    action: 'cleanStaging',
    removedPaths: [],
  });
  expect((await stat(join(held, '1.mkv'))).isFile()).toBe(true);
});

test("a support bundle in a worker set up without the bundle's part fails the job without touching anything", async () => {
  await expect(run({ class: 'maintenance', action: 'buildSupportBundle' })).rejects.toMatchObject({ code: 'pipelineError' });
});

describe("the playback target's actions", () => {
  const setupPayload: MaintenancePayload = {
    class: 'maintenance',
    action: 'setupJellyfin',
    mode: 'firstRun',
    admin: { username: 'leon', password: 'pl4nted' },
    locale: { uiCulture: 'en-US', metadataCountry: 'US', metadataLanguage: 'en' },
    libraries: [],
    remoteAccess: true,
  };
  const setupResult = {
    class: 'maintenance' as const,
    action: 'setupJellyfin' as const,
    serverId: 's',
    version: '12.4.0',
    adminUserId: 'u',
    libraries: [],
    steps: [{ step: 'reachable' as const, state: 'done' as const, at: 1 }],
  };

  function jellyfin(overrides: Partial<JellyfinClient> = {}) {
    const calls: string[] = [];
    const jellyfinClient: JellyfinClient = {
      setup: async (_payload, onStep) => {
        onStep('reachable', 'done');
        onStep('wizard', 'done');
        return setupResult;
      },
      pushPassword: async (username, newPassword) => void calls.push(`push ${username} ${newPassword}`),
      publish: async () => ({ refs: {}, readings: {} }),
      forget: async (libraryId, folders) => void calls.push(`forget ${libraryId} ${folders.join(',')}`),
      observe: async () => [],
      readWatchState: async () => [],
      ...overrides,
    };
    return { client: jellyfinClient, calls };
  }

  const runWith = (deps: Partial<MaintenanceDeps>, payload: MaintenancePayload, progress: (f: number, d?: string) => void = () => {}) =>
    maintenanceHandler({ layout, clients: {}, runtime, ...scanDeps(), ...deps })(
      { jobId: 'j' as never, class: 'maintenance', leaseEpoch: 1, payload } as LeasedJob,
      {
        signal: new AbortController().signal,
        progress,
      },
    );

  test('setupJellyfin runs the setup and reports each step through job.progress as <step>:<state>', async () => {
    const { client: jf } = jellyfin();
    const progress: (string | undefined)[] = [];
    expect(await runWith({ jellyfin: jf }, setupPayload, (_f, detail) => progress.push(detail))).toEqual(setupResult);
    expect(progress).toEqual(['reachable:done', 'wizard:done']);
  });

  test("setupJellyfin passes the setup's failure on with its reason", async () => {
    const { client: jf } = jellyfin({
      setup: async () => {
        throw new JobFailure('jellyfinSetupNeeded', 'refused', { reason: 'credentialsNeeded', step: 'apiKey' });
      },
    });
    await expect(runWith({ jellyfin: jf }, setupPayload)).rejects.toMatchObject({ code: 'jellyfinSetupNeeded', data: { reason: 'credentialsNeeded' } });
  });

  test('pushJellyfinPassword pushes the new password', async () => {
    const { client: jf, calls } = jellyfin();
    const result = await runWith({ jellyfin: jf }, { class: 'maintenance', action: 'pushJellyfinPassword', username: 'leon', newPassword: 'p3' });
    expect(result).toEqual({ class: 'maintenance', action: 'pushJellyfinPassword', pushed: true });
    expect(calls).toEqual(['push leon p3']);
  });

  test('deleteLibraryFiles asks the target to forget the folders after deleting them', async () => {
    const { client: jf, calls } = jellyfin();
    const movie = join(layout.library, 'movies', 'Quiet Harbour (2020)');
    await mkdir(movie, { recursive: true });
    await writeFile(join(movie, 'm.mkv'), 'x');
    const result = await runWith(
      { target: jf },
      {
        class: 'maintenance',
        action: 'deleteLibraryFiles',
        paths: ['/data/library/movies/Quiet Harbour (2020)'],
        libraryId: 'lib-movies' as never,
        folders: ['/data/library/movies/Quiet Harbour (2020)'],
      },
    );
    expect(result).toEqual({ class: 'maintenance', action: 'deleteLibraryFiles', removedPaths: ['/data/library/movies/Quiet Harbour (2020)'] });
    expect(calls).toEqual(['forget lib-movies /data/library/movies/Quiet Harbour (2020)']);
  });

  test("deleteLibraryFiles also removes an upgrade's old original under originals/ and a held upgrade file, but nothing else outside the library", async () => {
    const { client: jf } = jellyfin();
    const original = join(layout.originals, 'series', 'Show', 'old.mkv');
    const held = join(layout.held, 'import1');
    const download = join(layout.usenetDownloads, 'keep.mkv');
    for (const path of [original, join(held, '1.mkv'), download]) {
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, 'x');
    }
    const result = await runWith(
      { target: jf },
      {
        class: 'maintenance',
        action: 'deleteLibraryFiles',
        paths: ['/data/originals/series/Show/old.mkv', '/data/staging/held/import1', '/data/downloads/usenet/keep.mkv'],
        libraryId: 'lib-series' as never,
        folders: [],
      },
    );
    expect(result).toMatchObject({ removedPaths: ['/data/originals/series/Show/old.mkv', '/data/staging/held/import1'] });
    expect(await stat(download).then(() => true)).toBe(true);
  });

  test('deleteLibraryFiles for a deleted Work removes its kept originals and the folders it emptied, never a root or a folder still holding anything', async () => {
    const { client: jf } = jellyfin();
    const work = join(layout.series, 'Show (2019)');
    const kept = join(layout.originals, 'series', 'Show (2019)', 'Season 01', 'E1.mkv');
    const other = join(layout.series, 'Other (2020)', 'E1.mkv');
    for (const path of [join(work, 'Season 01', 'E1.mkv'), join(work, 'Season 01', 'E1.en.srt'), join(work, 'Season 02', 'E1.mkv'), kept, other]) {
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, 'x');
    }
    // A file the backend doesn't track keeps Season 02, and so the Work folder.
    await writeFile(join(work, 'Season 02', 'notes.txt'), 'x');
    const result = await runWith(
      { target: jf },
      {
        class: 'maintenance',
        action: 'deleteLibraryFiles',
        paths: [
          '/data/library/series/Show (2019)/Season 01/E1.mkv',
          '/data/library/series/Show (2019)/Season 01/E1.en.srt',
          '/data/library/series/Show (2019)/Season 02/E1.mkv',
        ],
        libraryId: 'lib-series' as never,
        folders: ['/data/library/series/Show (2019)'],
        originalsFolder: '/data/originals/series/Show (2019)',
      },
    );
    expect(result).toMatchObject({ removedPaths: expect.arrayContaining(['/data/library/series/Show (2019)/Season 01/E1.mkv']) });
    expect(await exists(join(work, 'Season 01'))).toBe(false);
    expect(await exists(join(work, 'Season 02', 'notes.txt'))).toBe(true);
    expect(await exists(join(layout.originals, 'series', 'Show (2019)'))).toBe(false);
    for (const root of [layout.series, layout.library, join(layout.originals, 'series'), layout.originals]) expect(await exists(root)).toBe(true);
    expect(await exists(other)).toBe(true);
  });

  test('deleteLibraryFiles empties a Work folder up to its library root, and leaves an originalsFolder that names a root or lies outside originals/', async () => {
    const { client: jf } = jellyfin();
    const movie = join(layout.movies, 'Quiet Harbour (2020)', 'm.mkv');
    const keptElsewhere = join(layout.originals, 'movies', 'Other (2021)', 'o.mkv');
    for (const path of [movie, keptElsewhere]) {
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, 'x');
    }
    for (const originalsFolder of ['/data/originals/movies', '/data/originals', '/data/library/movies'])
      await runWith(
        { target: jf },
        { class: 'maintenance', action: 'deleteLibraryFiles', paths: [], libraryId: 'lib-movies' as never, folders: [], originalsFolder },
      );
    expect(await exists(keptElsewhere)).toBe(true);
    await runWith(
      { target: jf },
      {
        class: 'maintenance',
        action: 'deleteLibraryFiles',
        paths: ['/data/library/movies/Quiet Harbour (2020)/m.mkv'],
        libraryId: 'lib-movies' as never,
        folders: [],
      },
    );
    expect(await exists(join(layout.movies, 'Quiet Harbour (2020)'))).toBe(false);
    expect(await exists(layout.movies)).toBe(true);
  });

  test('deleteLibraryFiles removes nothing for an originalsFolder that climbs out with `..` or is empty', async () => {
    const { client: jf } = jellyfin();
    const libraryFile = join(layout.movies, 'Quiet Harbour (2020)', 'm.mkv');
    const kept = join(layout.originals, 'series', 'Show (2019)', 'E1.mkv');
    for (const path of [libraryFile, kept]) {
      await mkdir(join(path, '..'), { recursive: true });
      await writeFile(path, 'x');
    }
    for (const originalsFolder of ['/data/originals/series/../../library/movies', '/data/originals/series/Show (2019)/../..', '/data/originals/series/..', ''])
      await runWith(
        { target: jf },
        { class: 'maintenance', action: 'deleteLibraryFiles', paths: [], libraryId: 'lib-movies' as never, folders: [], originalsFolder },
      );
    expect(await exists(libraryFile)).toBe(true);
    expect(await exists(kept)).toBe(true);
  });

  test('a forget that fails is logged, and the deletion still completes', async () => {
    const logs: string[] = [];
    const { client: jf } = jellyfin({
      forget: async () => {
        throw new JobFailure('jellyfinUnavailable', 'Jellyfin did not answer (POST /Items/<id>/Refresh).');
      },
    });
    const result = await runWith(
      { target: jf, log: (m) => logs.push(m) },
      { class: 'maintenance', action: 'deleteLibraryFiles', paths: [], libraryId: 'lib-movies' as never, folders: ['/data/library/movies/X'] },
    );
    expect(result).toMatchObject({ action: 'deleteLibraryFiles' });
    expect(logs).toEqual(['forget after deleteLibraryFiles failed: jellyfinUnavailable']);
  });

  test('without Jellyfin configured, its actions fail without touching anything', async () => {
    await expect(runWith({}, setupPayload)).rejects.toMatchObject({ code: 'pipelineError' });
  });
});

describe('scanLibrary', () => {
  test('walks the roots, records the untracked videos with their probes, and returns how many it found and how many are untracked', async () => {
    const backend = new FakeBackend();
    await folder(join(layout.series, 'Show (2019)'));
    await folder(join(layout.series, 'Tracked (2018)'));
    backend.trackedPaths.add('/data/library/series/Tracked (2018)/E1.mkv');
    const probe: ProbeSummary = { container: 'matroska', durationMs: 1000, streams: [] };
    const job = backend.lease({
      class: 'maintenance',
      action: 'scanLibrary',
      scanRunId: 'run1' as never,
      roots: [
        { libraryId: 'series' as never, path: '/data/library/series' },
        { libraryId: 'movies' as never, path: '/data/library/movies' },
      ],
      ignores: [],
    });

    const result = await maintenanceHandler({ layout, clients: {}, runtime, backend, probe: async () => probe })(job, {
      signal: new AbortController().signal,
      progress: () => {},
    });
    expect(result).toEqual({ class: 'maintenance', action: 'scanLibrary', found: 2, untracked: 1 });
    expect(backend.scanProbes.flat()).toEqual([expect.objectContaining({ path: '/data/library/series/Show (2019)/E1.mkv', probe })]);
  });
});
