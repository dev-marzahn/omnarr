// Torrents after their download: the goal a Grab's torrent
// gets, the completed torrent the reconciler keeps watching, the goal met
// while the worker is offline, `seedingDone` and `seedingLost`, and the leave
// table row by row.
import type { FakeItem } from '@omnarr/e2e/fakes/newznab';
import { beforeEach, describe, expect, test, vi } from 'vite-plus/test';

import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import type { FakeWorker } from './fakeWorker';
import { pipelineHarness, release } from './harness';

const DAY = 86_400_000;
const HASH = 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a';
/** A private tracker's E1 with a 72-hour minimum and no minimum ratio. */
const E1_TORRENT: FakeItem = release('t1', 'Harbour.Lights.S01E01.1080p.WEB-DL.AAC2.0.H.264-GRPB', {
  torrent: { infoHash: HASH, seeders: 8, minimumSeedTimeSec: 72 * 3600, file: new Uint8Array([1]) },
});
const E1_NEXT: FakeItem = release('t2', 'Harbour.Lights.S01E01.1080p.BluRay.AAC2.0.H.264-GRPC', {
  torrent: { infoHash: 'ab'.repeat(20), seeders: 3, file: new Uint8Array([1]) },
});

const h = pipelineHarness();
let w: FakeWorker;
let workId: Id<'works'>;

beforeEach(async () => {
  await h.tracker([E1_TORRENT, E1_NEXT]);
  workId = await h.subscribe();
  w = await h.worker();
});

const grabOf = async (n = 0) => (await h.all('grabs'))[n]!;
const downloadOf = async (n = 0) => (await h.all('downloads'))[n]!;
const removals = async () =>
  (await h.all('jobs')).filter((job) => job.class === 'maintenance' && job.payload?.class === 'maintenance' && job.payload.action === 'removeDownload');

/** Submits the first Grab's torrent and reports it completed with qBittorrent's private flag. */
async function downloaded(options: { private: boolean } = { private: true }): Promise<Id<'downloads'>> {
  await w.submitAll();
  await h.settle();
  const downloadId = await h.activeDownload();
  await w.torrentCompleted(downloadId, options);
  await h.settle();
  return downloadId;
}

/** Imports and publishes the first Grab: it ends done. */
async function done(): Promise<void> {
  await w.importAll();
  await h.settle();
  await w.publishAll();
  await h.settle();
}

/** The worker removes the torrent the backend asked it to. */
async function removeAsked(): Promise<void> {
  for (const job of await w.claim('maintenance')) await w.complete(job, { class: 'maintenance', action: 'removeDownload', removed: true });
  await h.settle();
}

describe('the goal', () => {
  test('a time-only tracker minimum gives the Download and the submit 14 days, no ratio', async () => {
    const submit = (await h.all('jobs')).find((job) => job.class === 'download.submit')!;
    expect(submit.payload).toMatchObject({ seedGoal: { seedTimeMs: 14 * DAY }, source: { kind: 'torrentUrl' } });
    expect((await downloadOf()).seedGoal).toEqual({ seedTimeMs: 14 * DAY });
  });

  test('a release without a tracker minimum gets the user’s saved goal as it is', async () => {
    await h.admin.mutation(api.api.downloadClients.saveTorrents, { input: { enabled: true, seedGoal: { ratio: 1, seedTimeMs: 30 * DAY } } });
    // E1's .torrent link is dead: next-best grabs the release without a minimum.
    const [job] = await w.claim('download.submit');
    await w.fail(job!, 'releaseFileInvalid', 'tracker.fake answered HTTP 404 (GET /dl).');
    await h.settle();
    expect((await downloadOf(1)).seedGoal).toEqual({ ratio: 1, seedTimeMs: 30 * DAY });
  });
});

describe('a completed torrent is watched', () => {
  test('after import the Grab is done, the Download stays completed and the reconciler still watches it, with its goal', async () => {
    const downloadId = await downloaded();
    await done();
    expect((await grabOf()).state).toBe('done');
    expect(await downloadOf()).toMatchObject({ state: 'completed', private: true });
    expect(await removals()).toEqual([]);
    expect(await w.watched()).toEqual([
      expect.objectContaining({
        downloadId,
        clientKind: 'qbittorrent',
        state: 'completed',
        seedGoal: { seedTimeMs: 14 * DAY },
        correlationTag: (await grabOf())._id,
      }),
    ]);
  });
});

describe('the goal is met while the worker is offline', () => {
  test('the returning worker reports seedingDone: the torrent and its folder are removed, the event names ratio and time', async () => {
    const downloadId = await downloaded();
    await done();
    const before = await h.unit(workId, 1, 1);
    // Three weeks without a worker: nothing the backend does needs one.
    vi.advanceTimersByTime(21 * DAY);
    await h.settle();
    const back = await h.worker('w2');
    await back.seedingDone(downloadId, { ratio: 3.1, seedTimeMs: 14 * DAY });
    await h.settle();

    expect((await downloadOf()).seedingDoneAt).toEqual(expect.any(Number));
    const [removal] = await removals();
    expect(removal).toMatchObject({
      idempotencyKey: `removeDownload:${downloadId}`,
      payload: {
        action: 'removeDownload',
        downloadId,
        clientKind: 'qbittorrent',
        clientRef: expect.any(String),
        deleteData: true,
        correlationTag: (await grabOf())._id,
      },
    });
    expect(removal!.payload).not.toHaveProperty('contentPath');
    const grabId = (await grabOf())._id;
    const events = (await h.all('events')).filter((event) => event.grabId === grabId).map((event) => event.message);
    expect(events).toContain('Seeding goal met: ratio 3.1, 14 days');

    // A repeated report is harmless: the key makes it one job.
    await back.seedingDone(downloadId, { ratio: 3.1, seedTimeMs: 14 * DAY });
    await h.settle();
    expect(await removals()).toHaveLength(1);

    for (const job of await back.claim('maintenance')) await back.complete(job, { class: 'maintenance', action: 'removeDownload', removed: true });
    await h.settle();
    expect((await downloadOf()).state).toBe('removed');
    expect(await back.watched()).toEqual([]);
    // The library file is a hardlink of its own: nothing in the library changes.
    expect((await h.unit(workId, 1, 1)).derivedState).toBe(before.derivedState);
    expect((await h.all('files')).map((file) => file.path)).toHaveLength(1);
  });
});

describe('seedingDone and seedingLost', () => {
  test('seedingDone is ignored while the Grab is importing, and acts once it is done', async () => {
    const downloadId = await downloaded();
    expect((await grabOf()).state).toBe('importing');
    await w.seedingDone(downloadId, { ratio: 2, seedTimeMs: DAY });
    await h.settle();
    expect(await removals()).toEqual([]);
    expect((await downloadOf()).seedingDoneAt).toBeUndefined();

    await done();
    await w.seedingDone(downloadId, { ratio: 2, seedTimeMs: DAY });
    await h.settle();
    expect(await removals()).toHaveLength(1);
  });

  test('seedingLost removes the torrent without its data, with its own event, and no unit-scope Issue', async () => {
    const downloadId = await downloaded();
    await done();
    await w.seedingLost(downloadId);
    await h.settle();
    const [removal] = await removals();
    expect(removal!.payload).toMatchObject({ action: 'removeDownload', downloadId, deleteData: false });
    const messages = (await h.all('events')).map((event) => event.message);
    expect(messages).toContain('Seeding stopped: files missing');
    expect(await h.all('issues')).toEqual([]);
    await removeAsked();
    expect((await downloadOf()).state).toBe('removed');
  });

  test('other outcomes on a completed Download are ignored', async () => {
    const downloadId = await downloaded();
    await done();
    await w.failed(downloadId, 'unknownClientFailure');
    await h.settle();
    expect(await downloadOf()).toMatchObject({ state: 'completed' });
    expect(await h.all('issues')).toEqual([]);
  });

  test('a seeding problem the reconciler reports is kept on the client row for the System page', async () => {
    const downloadId = await downloaded();
    await h.admin.mutation(api.api.downloadClients.saveTorrents, { input: { enabled: true, seedGoal: { ratio: 2 } } });
    await w.reportClients([{ kind: 'qbittorrent', reachable: true, seedingProblems: [{ downloadId, state: 'missingFiles', since: 5 }] }]);
    const status = async () => (await h.all('downloadClients')).find((row) => row.kind === 'qbittorrent')!.status;
    expect((await status())?.seedingProblems).toEqual([{ downloadId, state: 'missingFiles', since: 5 }]);
    const row = async () => (await h.admin.query(api.api.system.status, {})).clients.find((client) => client.clientKind === 'qbittorrent');
    expect(await row()).toMatchObject({ seedingCount: 1, seedingProblemCount: 1, activeDownloads: 0 });
    await w.reportClients([{ kind: 'qbittorrent', reachable: true }]);
    expect((await status())?.seedingProblems).toBeUndefined();
    expect(await row()).toMatchObject({ seedingCount: 1, seedingProblemCount: 0 });
  });
});

describe('seeding progress', () => {
  const SEED = { ratio: 0.8, seedTimeMs: 3 * DAY, uploadedBytes: 1_200_000_000 };
  const timeline = async () => h.admin.query(api.api.units.timeline, { unitId: (await h.unit(workId, 1, 1))._id });

  test("a seeding torrent's ratio, seed time and uploaded bytes reach the item's timeline with its goal and the closer goal's fraction", async () => {
    const downloadId = await downloaded();
    await done();
    await w.seeding(downloadId, SEED);
    expect((await timeline())!.seeding).toEqual({ ...SEED, goal: { seedTimeMs: 14 * DAY }, fraction: 3 / 14, releaseTitle: E1_TORRENT.title });
  });

  test("the library list counts a Work's seeding torrents, and drops the count once the goal is met", async () => {
    const seeding = async () => (await h.admin.query(api.api.library.list, { kind: 'series' })).works.find((work) => work.workId === workId)!.seeding;
    expect(await seeding()).toBeUndefined();
    const downloadId = await downloaded();
    expect(await seeding()).toEqual({ count: 1 });
    await done();
    await w.seeding(downloadId, SEED);
    expect(await seeding()).toEqual({ count: 1 });
    await w.seedingDone(downloadId, { ratio: 2, seedTimeMs: 14 * DAY });
    await h.settle();
    expect(await seeding()).toBeUndefined();
  });

  test('while importing it already seeds; once the goal is met it no longer shows, and a late report changes nothing', async () => {
    const downloadId = await downloaded();
    await w.seeding(downloadId, SEED);
    expect((await timeline())!.seeding).toMatchObject({ ratio: 0.8 });
    await done();
    await w.seedingDone(downloadId, { ratio: 2, seedTimeMs: 14 * DAY });
    await h.settle();
    await w.seeding(downloadId, { ...SEED, ratio: 1.9 });
    expect((await timeline())!.seeding).toBeUndefined();
    expect((await downloadOf()).clientStatus?.ratio).toBeUndefined();
  });

  test("the Work's Files tab marks the file a seeding torrent's Grab imported, with its fraction", async () => {
    const downloadId = await downloaded();
    await done();
    await w.seeding(downloadId, SEED);
    const rows = await h.admin.query(api.api.library.files, { workId });
    expect(rows.find((row) => row.tmdbEpisode === 1)).toMatchObject({ seeding: { fraction: 3 / 14 } });
    expect(rows.filter((row) => row.tmdbEpisode !== 1).every((row) => row.seeding === undefined)).toBe(true);
  });

  test("Settings › Downloads counts the torrents still seeding and what they uploaded; one past its goal doesn't count", async () => {
    const downloadId = await downloaded();
    await done();
    await w.seeding(downloadId, SEED);
    const torrents = async () => (await h.admin.query(api.api.downloadClients.get, {})).torrents;
    expect((await torrents()).seeding).toEqual({ count: 1, uploadedBytes: 1_200_000_000 });
    await w.seedingDone(downloadId, { ratio: 2, seedTimeMs: 14 * DAY });
    await h.settle();
    expect((await torrents()).seeding).toEqual({ count: 0, uploadedBytes: 0 });
  });

  test('before the first seeding report, a completed torrent shows as seeding without numbers', async () => {
    await downloaded();
    await done();
    expect((await timeline())!.seeding).toEqual({ goal: { seedTimeMs: 14 * DAY }, releaseTitle: E1_TORRENT.title });
  });
});

describe('the leave table', () => {
  /** The first Grab's import fails as a bad release: the run fails after its torrent completed. */
  async function failImport(): Promise<void> {
    const [job] = await w.claim('import');
    await w.fail(job!, 'fakeOrWrongContent', 'not a video');
    await h.settle();
  }

  test('completed, done: seeds to its goal (no removal at the end of the run)', async () => {
    await downloaded({ private: false });
    await done();
    expect(await removals()).toEqual([]);
    expect((await downloadOf()).state).toBe('completed');
  });

  test('completed, failed, private: seeds to its goal like a done one, then seedingDone removes it', async () => {
    const downloadId = await downloaded({ private: true });
    await failImport();
    expect((await grabOf()).state).toBe('failed');
    expect(await removals()).toEqual([]);
    expect(await w.watched()).toEqual(expect.arrayContaining([expect.objectContaining({ downloadId, state: 'completed' })]));
    await w.seedingDone(downloadId, { ratio: 1, seedTimeMs: 14 * DAY });
    await h.settle();
    expect(await removals()).toHaveLength(1);
  });

  test('completed, cancelled, private: seeds to its goal', async () => {
    await downloaded({ private: true });
    await h.admin.mutation(api.api.units.cancelGrab, { grabId: (await grabOf())._id });
    await h.settle();
    expect((await grabOf()).state).toBe('cancelled');
    expect(await removals()).toEqual([]);
  });

  test('completed, failed, public: removed with its data when the Grab ends', async () => {
    const downloadId = await downloaded({ private: false });
    await failImport();
    expect((await removals()).map((job) => job.payload)).toEqual([
      expect.objectContaining({ action: 'removeDownload', downloadId, deleteData: true, correlationTag: (await grabOf())._id }),
    ]);
  });

  test('completed, cancelled, public: removed with its data when the Grab ends', async () => {
    await downloaded({ private: false });
    await h.admin.mutation(api.api.units.cancelGrab, { grabId: (await grabOf())._id });
    await h.settle();
    expect(await removals()).toHaveLength(1);
  });

  test('not completed, cancelled: removed with its data', async () => {
    await w.submitAll();
    await h.settle();
    await h.admin.mutation(api.api.units.cancelGrab, { grabId: (await grabOf())._id });
    await h.settle();
    expect((await removals()).map((job) => job.payload)).toEqual([expect.objectContaining({ deleteData: true, correlationTag: (await grabOf())._id })]);
  });

  test('not completed, failed: removed with its data', async () => {
    await w.submitAll();
    await h.settle();
    await w.failed(await h.activeDownload(), undefined, 'stalledDL');
    await h.settle();
    expect((await grabOf()).state).toBe('failed');
    expect((await removals()).map((job) => job.payload)).toEqual([expect.objectContaining({ deleteData: true, correlationTag: (await grabOf())._id })]);
  });
});

describe('a torrent two Grabs share', () => {
  test('each Download keeps its own tag: the first Grab’s removal leaves the second one watched', async () => {
    const first = await downloaded({ private: false });
    await done();
    // The same release picked again for a Grab of another Unit: the worker adds a tag and returns the same hash.
    const second = await h.t.run(async (ctx) => {
      const download = (await ctx.db.get(first))!;
      const grabId = await ctx.db.insert('grabs', {
        candidateId: (await ctx.db.get(download.grabId))!.candidateId,
        protocol: 'torrent',
        state: 'done',
        cancelRequested: false,
      });
      return ctx.db.insert('downloads', {
        grabId,
        clientKind: 'qbittorrent',
        clientRef: download.clientRef!,
        correlationTag: grabId,
        state: 'completed',
        clientStage: 'downloading',
      });
    });
    await w.seedingDone(first, { ratio: 2, seedTimeMs: DAY });
    await h.settle();
    await removeAsked();
    expect((await h.get(first))!.state).toBe('removed');
    expect((await w.watched()).map((row) => row.downloadId)).toEqual([second]);
  });
});

describe('deleteWork and a seeding torrent', () => {
  test('the Work goes, but its seeding torrent keeps its Grab and Download until the goal is met and the torrent removed', async () => {
    const downloadId = await downloaded();
    await done();
    await h.admin.mutation(api.api.library.deleteWork, { workId, deleteFiles: false });
    await h.settle();

    expect(await h.all('works')).toEqual([]);
    expect(await h.all('units')).toEqual([]);
    expect(await h.all('grabs')).toHaveLength(1);
    expect((await w.watched()).map((row) => row.downloadId)).toEqual([downloadId]);

    await w.seedingDone(downloadId, { ratio: 2, seedTimeMs: 14 * DAY });
    await h.settle();
    await removeAsked();
    expect((await downloadOf()).state).toBe('removed');
    expect(await w.watched()).toEqual([]);
  });

  test('the readers tolerate the missing Work: system.status still counts the torrent, units.timeline answers null', async () => {
    await downloaded();
    await done();
    const unitId = (await h.unit(workId, 1, 1))._id;
    await h.admin.mutation(api.api.library.deleteWork, { workId, deleteFiles: false });
    await h.settle();

    const torrents = (await h.admin.query(api.api.system.status, {})).clients.find((client) => client.clientKind === 'qbittorrent');
    expect(torrents).toMatchObject({ seedingCount: 1, activeDownloads: 0 });
    expect(await h.admin.query(api.api.units.timeline, { unitId })).toBeNull();
  });

  test('units.timeline answers null for a Unit whose Work is already gone (a purge between its steps)', async () => {
    await downloaded();
    const unitId = (await h.unit(workId, 1, 1))._id;
    await h.t.run((ctx) => ctx.db.delete(workId));
    expect(await h.admin.query(api.api.units.timeline, { unitId })).toBeNull();
  });
});
