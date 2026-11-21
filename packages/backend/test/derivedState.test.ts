// `units.derivedState` from real entity rows: a season pack
// moves every Unit it covers, a Unit unmonitored mid-download is skipped,
// and the preparing and ready rules from rows written here.
import { beforeEach, describe, expect, test } from 'vite-plus/test';

import { api } from '../convex/_generated/api';
import { recomputeUnits } from '../convex/lib/derivedState';
import type { FakeWorker } from './fakeWorker';
import { pipelineHarness, release } from './harness';

const h = pipelineHarness();
let w: FakeWorker;

const PACK = release('pack', 'Harbour.Lights.S01.1080p.WEB-DL.AAC2.0.H.264-GRPA', { sizeBytes: 9_000_000_000 });

const season1 = async () => (await h.all('units')).filter((unit) => unit.tmdbSeason === 1).sort((a, b) => a.tmdbEpisode! - b.tmdbEpisode!);
const states = async () => (await season1()).map((unit) => unit.derivedState);

beforeEach(async () => {
  await h.indexer([PACK]);
  await h.subscribe();
  w = await h.worker();
});

describe('a season pack', () => {
  test('moves every Unit it covers through the run, together', async () => {
    expect(await states()).toEqual(Array(6).fill('grabbed'));
    await w.submitAll();
    await h.settle();
    expect(await states()).toEqual(Array(6).fill('downloading'));
    await w.stage(await h.activeDownload(), 'postProcessing');
    expect(await states()).toEqual(Array(6).fill('repairUnpack'));
    await w.completed(await h.activeDownload());
    await h.settle();
    expect(await states()).toEqual(Array(6).fill('importing'));
    await w.importAll();
    await h.settle();
    expect(await states()).toEqual(Array(6).fill('importing'));
    await w.publishAll();
    await h.settle();
    // The fake WEB-DL doesn't fit the default target, so `finish` starts a Rendition per file.
    expect(await states()).toEqual(Array(6).fill('preparing'));
    expect(await h.all('publications')).toHaveLength(6);
  });

  test('a Unit unmonitored mid-download stays in the Grab and is skipped at import', async () => {
    await w.submitAll();
    await h.settle();
    const [, e2] = await season1();
    await h.admin.mutation(api.api.units.setMonitored, { target: { kind: 'units', unitIds: [e2!._id] }, monitored: false });
    expect((await h.all('grabs'))[0]!.state).toBe('downloading');

    await w.completed(await h.activeDownload());
    await h.settle();
    const job = (await h.all('jobs')).find((row) => row.class === 'import')!;
    expect(job.payload?.class === 'import' && job.payload.expectedUnits.map((unit) => unit.episode)).toEqual([1, 3, 4, 5, 6]);
    await w.importAll();
    await h.settle();
    await w.publishAll();
    await h.settle();

    const outcomes = Object.fromEntries((await h.all('grabUnits')).map((row) => [row.unitId, row.outcome]));
    expect(outcomes[e2!._id]).toBe('skipped');
    expect(Object.values(outcomes).filter((outcome) => outcome === 'imported')).toHaveLength(5);
    expect(await states()).toEqual(['preparing', 'notMonitored', 'preparing', 'preparing', 'preparing', 'preparing']);
  });
});

describe('the preparing and ready rules, from rows', () => {
  /** Publishes a file for E1 with this fit, and optionally a pending Rendition of it, or a Publication in another state. */
  async function fileFor(
    fits: boolean,
    pendingRendition = false,
    publication: { state: 'visible' | 'pending'; targetItemRef?: string } = { state: 'visible' },
    kind: 'primary' | 'staged' = 'primary',
  ) {
    await h.admin.mutation(api.api.units.cancelGrab, { grabId: (await h.all('grabs'))[0]!._id });
    await h.settle();
    const [e1] = await season1();
    await h.t.run(async (ctx) => {
      const library = (await ctx.db.query('libraries').first())!;
      const fileId = await ctx.db.insert('files', { path: '/data/library/series/e1.mp4', sizeBytes: 1, inode: '1:1', origin: 'scan', role: 'source' });
      await ctx.db.insert('fileUnits', { fileId, unitId: e1!._id });
      const fileVersionId = await ctx.db.insert('fileVersions', {
        unitId: e1!._id,
        fileId,
        kind,
        playbackProfileId: library.playbackProfileId,
        fits,
      });
      const jobId = (await ctx.db.query('jobs').first())!._id;
      await ctx.db.insert('publications', { unitId: e1!._id, fileVersionId, jobId, generation: 0, target: 'jellyfin', ...publication });
      if (pendingRendition)
        await ctx.db.insert('renditions', {
          sourceFileId: fileId,
          jobId,
          playbackProfileId: library.playbackProfileId,
          steps: ['remux'],
          reason: 'import',
          state: 'pending',
        });
      await recomputeUnits(ctx, [e1!._id]);
    });
    return (await season1())[0]!.derivedState;
  }

  test('7: a fitting primary with a visible Publication is "ready"', async () => {
    expect(await fileFor(true)).toBe('ready');
  });

  test('6: a pending Rendition of its file is "preparing"', async () => {
    expect(await fileFor(false, true)).toBe('preparing');
  });

  test('a re-publish (pending with the earlier targetItemRef) still counts as visible for rules 7 and 8', async () => {
    expect(await fileFor(true, false, { state: 'pending', targetItemRef: 'jf-old' })).toBe('ready');
  });

  test('a first publish (pending, no targetItemRef) is not visible yet', async () => {
    expect(await fileFor(true, false, { state: 'pending' })).not.toBe('ready');
  });

  test('6: a staged version waiting for its Publication is "preparing"', async () => {
    expect(await fileFor(true, false, { state: 'pending' }, 'staged')).toBe('preparing');
  });

  test('a staged version whose re-publish is pending (targetItemRef set) is still "preparing", not "ready"', async () => {
    expect(await fileFor(true, false, { state: 'pending', targetItemRef: 'jf-old' }, 'staged')).toBe('preparing');
  });

  test('a pending re-publish of the primary that does not fit still counts as visible: "not yet in target format"', async () => {
    expect(await fileFor(false, false, { state: 'pending', targetItemRef: 'jf-old' })).toBe('notInTargetFormat');
  });
});

describe('results.published', () => {
  /** A prepared file for E1 as `results.prepared` leaves it: a `staged` version, fits, and a pending Publication with its queued publish job. */
  async function stagedFile(oldTargetItemRef?: string) {
    await h.admin.mutation(api.api.units.cancelGrab, { grabId: (await h.all('grabs'))[0]!._id });
    await h.settle();
    const [e1] = await season1();
    const publicationId = await h.t.run(async (ctx) => {
      const library = (await ctx.db.query('libraries').first())!;
      const fileId = await ctx.db.insert('files', { path: '/data/library/series/e1.mp4', sizeBytes: 1, inode: '1:1', origin: 'prepared', role: 'rendition' });
      await ctx.db.insert('fileUnits', { fileId, unitId: e1!._id });
      const fileVersionId = await ctx.db.insert('fileVersions', {
        unitId: e1!._id,
        fileId,
        kind: 'staged',
        playbackProfileId: library.playbackProfileId,
        fits: true,
      });
      const publicationId = await ctx.db.insert('publications', {
        unitId: e1!._id,
        fileVersionId,
        generation: 0,
        target: 'jellyfin',
        state: 'pending',
        ...(oldTargetItemRef ? { targetItemRef: oldTargetItemRef } : {}),
      });
      const jobId = await ctx.db.insert('jobs', {
        class: 'publish',
        payload: {
          class: 'publish',
          publicationIds: [publicationId],
          workFolderPath: '/data/library/series/Harbour Lights (2021) [tmdbid-900001]',
          items: [{ publicationId, path: '/data/library/series/e1.mp4' }],
          library: { libraryId: library._id, root: library.rootPath, kind: library.kind },
        },
        status: 'queued',
        attempt: 0,
        maxAttempts: 5,
        leaseEpoch: 0,
        idempotencyKey: `${publicationId}:publish:0`,
        protocolVersion: 1,
        cancelRequested: false,
      });
      await ctx.db.patch(publicationId, { jobId });
      await recomputeUnits(ctx, [e1!._id]);
      return publicationId;
    });
    return { e1: e1!, publicationId };
  }

  test('turns the staged version into the primary, writes its targetItemRef, and the Unit is "ready"', async () => {
    const { publicationId } = await stagedFile();
    expect((await season1())[0]!.derivedState).toBe('preparing');

    await w.publishAll();
    expect(await h.get(publicationId)).toMatchObject({ state: 'visible', targetItemRef: `jf-${publicationId}` });
    expect((await h.all('fileVersions')).map((version) => version.kind)).toEqual(['primary']);
    expect((await season1())[0]!.derivedState).toBe('ready');
  });

  test("replaces an earlier item's targetItemRef", async () => {
    const { publicationId } = await stagedFile('jf-old');
    await w.publishAll();
    expect(await h.get(publicationId)).toMatchObject({ state: 'visible', targetItemRef: `jf-${publicationId}` });
  });
});
