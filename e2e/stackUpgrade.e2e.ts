// An upgrade and a downgrade of the whole stack: the
// previous release's compose files and images with a library in them, then
// this build's, as a user replaces the files and runs `docker compose up -d`.
//
//   upgrade    a fixture build whose migration fails on purpose crash-loops
//              five times and leaves exactly one export, taken before its
//              first try; this build then reuses it, migrates and turns
//              healthy: the data survived, the worker connects, no secret
//              changed;
//   downgrade  the previous release comes back by restore: the export
//              imported into an emptied convex-data, and the library is as
//              it was;
//   /licenses  every project image carries its notices.
//
// The previous release is an older commit built here (releases.ts), or
// with E2E_FROM_VERSION the GitHub release of that version (release.yml).
import { execFileSync } from 'node:child_process';

import { makeFunctionReference } from 'convex/server';
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test';

import { failingBackend, fromRelease, type Release, toRelease } from './releases.ts';
import {
  ADMIN,
  afterRestore,
  backups,
  compose,
  deploymentVariable,
  down,
  logs,
  NEWZNAB_KEY,
  PROJECT,
  readGeneratedSecrets,
  rows,
  secrets,
  setEnv,
  setUpJellyfinThroughProduct,
  up,
  useRelease,
  waitFor,
  type Deployment,
} from './stack.ts';

// oxlint-disable-next-line typescript/no-explicit-any
type Any = any;
const query = (name: string, args: object = {}): Promise<Any> => d.admin.query(makeFunctionReference<'query'>(name), args);
const mutation = (name: string, args: object): Promise<Any> => d.admin.mutation(makeFunctionReference<'mutation'>(name), args);
const action = (name: string, args: object): Promise<Any> => d.admin.action(makeFunctionReference<'action'>(name), args);

let d: Deployment;
let from: Release;
let to: Release;
let failing: string;
let workId: string;
let e1: string;
/** The export the upgrade takes, and the downgrade restores. */
let exported: string;
/** The secrets the stack generated on the previous release. */
let before: Pick<typeof secrets, 'workerToken' | 'betterAuthSecret' | 'instanceSecret'>;

const unitE1 = async () => (await query('api/library:detail', { workId })).units.find((row: Any) => row.tmdbSeason === 1 && row.tmdbEpisode === 1);
const volume = (name: string) => `${PROJECT}_${name}`;
const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8' }).trim();

beforeAll(async () => {
  from = await fromRelease();
  to = toRelease();
  failing = failingBackend(to);
  useRelease(from);
  d = await up();
  // A library on the previous release: an indexer, a subscription, and S01E01 downloaded, imported and in Jellyfin.
  await action('api/indexers:create', { name: 'Newznab Main', url: 'http://newznab:4120/api', apiKey: NEWZNAB_KEY, priority: 10 });
  const { library } = await query('api/library:list', { kind: 'series' });
  ({ workId } = await action('api/library:subscribe', {
    tmdbId: '900001',
    kind: 'series',
    libraryId: library.libraryId,
    releaseProfileId: library.defaultReleaseProfileId,
    seasons: [1],
  }));
  await setUpJellyfinThroughProduct(d);
  const ready = await waitFor(
    'S01E01 to be ready on the previous release',
    async () => ((await unitE1())?.state === 'ready' ? await unitE1() : undefined),
    300_000,
  );
  e1 = ready.unitId;
  before = { workerToken: secrets.workerToken, betterAuthSecret: secrets.betterAuthSecret, instanceSecret: secrets.instanceSecret };
}, 1_800_000);
afterAll(async () => {
  if (process.env.E2E_KEEP === '1') return;
  await down();
  execFileSync('docker', ['volume', 'rm', '-f', volume('convex-data-before-restore')], { stdio: 'ignore' });
});

describe('an upgrade with a migration', () => {
  test('a release whose migration fails crash-loops five times and leaves exactly one export, taken before its first try', async () => {
    expect(backups()).toEqual([]);
    useRelease({ dir: to.dir, images: { ...to.images, backend: failing } });
    // Only the backend: the worker and the web app wait for a healthy one.
    compose(['up', '-d', '--no-deps', 'backend']);
    const container = compose(['ps', '-a', '-q', 'backend']).trim();
    await waitFor('five restarts', async () => (Number(docker(['inspect', '-f', '{{.RestartCount}}', container])) >= 5 ? true : undefined), 600_000, 2_000);
    expect(logs('backend')).toContain('[convex-release] deploy failed');
    const files = backups();
    expect(files).toEqual([expect.stringMatching(new RegExp(`^\\d{8}-\\d{6}-${from.version}-to-${to.version}\\.zip$`))]);
    exported = files[0]!;
    expect(deploymentVariable(d.env, 'CONVEX_RELEASE_VERSION')).toBe(from.version);
  });

  test('this release reuses that export, migrates and turns healthy, and the worker connects with the matching version', async () => {
    useRelease(to);
    compose(['up', '-d', '--wait'], ['test', 'worker']);
    expect(backups()).toEqual([exported]);
    expect(deploymentVariable(d.env, 'CONVEX_RELEASE_VERSION')).toBe(to.version);
    // An apply that succeeded clears the recorded backup.
    expect(deploymentVariable(d.env, 'CONVEX_RELEASE_BACKUP')).toBe('');
    const status = await waitFor('the worker to connect', async () => {
      const s = await query('api/system:status');
      return s.worker?.connected && s.worker.accepted ? s : undefined;
    });
    expect(status.release.version).toBe(to.version);
    expect(status.banner).toBeUndefined();
  });

  test('the data survived, the migration ran, and no secret changed', async () => {
    expect(await unitE1()).toMatchObject({ unitId: e1, state: 'ready' });
    // 0004_grab_kind: every Grab from before upgrades is an initial one.
    expect(rows<{ kind?: string }>(d.env, 'grabs').map((grab) => grab.kind)).toEqual(expect.arrayContaining(['initial']));
    expect(rows<{ kind?: string }>(d.env, 'grabs').every((grab) => grab.kind !== undefined)).toBe(true);
    readGeneratedSecrets();
    expect({ workerToken: secrets.workerToken, betterAuthSecret: secrets.betterAuthSecret, instanceSecret: secrets.instanceSecret }).toEqual(before);
  });
});

describe('a downgrade by restore', () => {
  test('the previous release imports the export into an emptied convex-data, and the library is as it was before the upgrade', async () => {
    // After the backup: S01E01 unmonitored, which the restore undoes.
    await mutation('api/units:setMonitored', { target: { kind: 'units', unitIds: [e1] }, monitored: false });
    expect((await unitE1()).monitored).toBe(false);

    // Restoring Convex from an export: down, copy convex-data aside, empty it, the previous files, the snapshot line.
    compose(['down', '--timeout', '5'], ['test', 'worker']);
    docker(['volume', 'create', volume('convex-data-before-restore')]);
    docker([
      'run',
      '--rm',
      '--user',
      '0:0',
      '--entrypoint',
      'cp',
      '-v',
      `${volume('convex-data')}:/from:ro`,
      '-v',
      `${volume('convex-data-before-restore')}:/to`,
      to.images.worker,
      '-a',
      '/from/.',
      '/to/',
    ]);
    docker(['volume', 'rm', volume('convex-data')]);
    useRelease(from);
    setEnv({ CONVEX_RELEASE_SNAPSHOT: `/backups/${exported}` });
    compose(['up', '-d', '--wait'], ['test', 'worker']);
    setEnv({ CONVEX_RELEASE_SNAPSHOT: '' });
    afterRestore(d);

    expect(deploymentVariable(d.env, 'CONVEX_RELEASE_VERSION')).toBe(from.version);
    // The accounts came back with the export: the admin signs in with the same password.
    await d.admin.signIn(ADMIN.password);
    expect(await unitE1()).toMatchObject({ unitId: e1, state: 'ready', monitored: true });
    // The data from before the migration: the previous release's Grabs have no kind.
    expect(rows<{ kind?: string }>(d.env, 'grabs').every((grab) => grab.kind === undefined)).toBe(true);
    // The kept copy is still there for the user to remove.
    expect(docker(['volume', 'ls', '-q', '--filter', `name=${volume('convex-data-before-restore')}`])).toBe(volume('convex-data-before-restore'));
  });

  test('a later start without the snapshot line keeps the data: a snapshot is imported only into an empty deployment', async () => {
    compose(['up', '-d', '--wait', '--force-recreate', 'backend']);
    expect(await unitE1()).toMatchObject({ unitId: e1, monitored: true });
  });
});

test('every project image carries /licenses', () => {
  const list = (image: string) => docker(['run', '--rm', '--entrypoint', 'ls', image, '/licenses']).split('\n').sort();
  expect(list(to.images.backend)).toEqual(['LICENSE', 'THIRD_PARTY_NOTICES.md']);
  expect(list(to.images.web)).toEqual(['LICENSE', 'THIRD_PARTY_NOTICES.md']);
  expect(list(to.images.worker)).toEqual(['LICENSE', 'THIRD_PARTY_NOTICES.md', 'ffmpeg-configure.txt', 'packages.txt']);
  const configure = docker(['run', '--rm', '--entrypoint', 'cat', to.images.worker, '/licenses/ffmpeg-configure.txt']);
  expect(configure).toContain('--enable-gpl');
  expect(configure).not.toContain('--enable-nonfree');
});
