// Renames after a title change. These tests call
// `unitsRetitled` directly; the metadata sync calling it is tested in
// `metadata/sync.test.ts`.
import type { Sidecar } from '@omnarr/contracts';
import { beforeEach, describe, expect, test } from 'vite-plus/test';

import { api } from '../convex/_generated/api';
import type { Doc, Id } from '../convex/_generated/dataModel';
import { recomputeUnits } from '../convex/lib/derivedState';
import { unitsRetitled } from '../convex/library/naming';
import { start } from '../convex/pipeline/preparation';
import { prepareWorker, SEASON_1, seedFile, seedShow, seedUnit, WEBDL_PATH } from './fakePrepare';
import { seedLibraries, setup, worker, type Backend, type Libraries } from './setup';

let t: Backend;
let libraries: Libraries;
let workId: Id<'works'>;
let unitId: Id<'units'>;

/** The WEB-DL as an import named it while TMDB's title was still the placeholder. */
const UNTITLED = `${SEASON_1}/Show (2019) - S01E02 [AMZN][WEBDL-1080p][EAC3 5.1][h264]-GRP.mkv`;
const PILOT_BASE = `${SEASON_1}/Show (2019) - S01E02 - Pilot [AMZN][WEBDL-1080p][EAC3 5.1][h264]-GRP`;
const UNTITLED_BASE = UNTITLED.slice(0, -'.mkv'.length);
const sidecar = (base: string, language: 'en' | 'de'): Sidecar => ({ path: `${base}.${language}.srt`, language, forced: false, sdh: false, format: 'srt' });

beforeEach(async () => {
  t = setup();
  libraries = await seedLibraries(t);
  workId = await seedShow(t, libraries);
  unitId = await seedUnit(t, workId, 2, 'Episode 2');
});

const jobs = () => t.run((ctx) => ctx.db.query('jobs').collect());
const retitle = async (title: string, ids: Id<'units'>[] = [unitId]) => {
  await t.run(async (ctx) => {
    for (const id of ids) await ctx.db.patch(id, { title });
  });
  return await t.run((ctx) => unitsRetitled(ctx, ids));
};

describe('unitsRetitled', () => {
  test('a real title replacing the placeholder enqueues one rename of the file and its sidecars', async () => {
    const { fileId } = await seedFile(t, {
      unitIds: [unitId],
      path: UNTITLED,
      sidecars: [sidecar(UNTITLED_BASE, 'en'), sidecar(UNTITLED_BASE, 'de')],
      fits: false,
    });
    expect(await retitle('Pilot')).toBe(1);
    // A second sync with the same title is the same job.
    await t.run((ctx) => unitsRetitled(ctx, [unitId]));
    const renames = (await jobs()).filter((job) => job.class === 'maintenance');
    expect(renames).toHaveLength(1);
    expect(renames[0]).toMatchObject({
      idempotencyKey: `renameLibraryFile:${fileId}:${WEBDL_PATH}`,
      status: 'queued',
      payload: {
        class: 'maintenance',
        action: 'renameLibraryFile',
        fileId,
        from: UNTITLED,
        to: WEBDL_PATH,
        sidecars: [
          { from: `${UNTITLED_BASE}.en.srt`, to: `${PILOT_BASE}.en.srt` },
          { from: `${UNTITLED_BASE}.de.srt`, to: `${PILOT_BASE}.de.srt` },
        ],
      },
    });
  });

  test('a multi-episode file whose two Units are retitled is renamed once, with both titles', async () => {
    const third = await seedUnit(t, workId, 3, 'Episode 3');
    await seedFile(t, { unitIds: [unitId, third], path: `${SEASON_1}/Show (2019) - S01E02-E03 [AMZN][WEBDL-1080p][EAC3 5.1][h264]-GRP.mkv` });
    await t.run(async (ctx) => {
      await ctx.db.patch(unitId, { title: 'Pilot' });
      await ctx.db.patch(third, { title: 'Second Light' });
    });
    expect(await t.run((ctx) => unitsRetitled(ctx, [unitId, third]))).toBe(1);
    const [rename] = (await jobs()).filter((job) => job.class === 'maintenance');
    expect(rename!.payload).toMatchObject({ to: `${SEASON_1}/Show (2019) - S01E02-E03 - Pilot + Second Light [AMZN][WEBDL-1080p][EAC3 5.1][h264]-GRP.mkv` });
  });

  test('a file that keeps its name, a file being prepared, and a name that didn’t change are left alone', async () => {
    const scanned = await seedUnit(t, workId, 4, 'Episode 4');
    await seedFile(t, { unitIds: [scanned], origin: 'scan', keepsName: true, release: null, path: '/data/library/series/Old/Old - 4.mkv' });
    const preparing = await seedUnit(t, workId, 5, 'Episode 5');
    const { fileId } = await seedFile(t, { unitIds: [preparing], path: `${SEASON_1}/Show (2019) - S01E05 [AMZN][WEBDL-1080p][EAC3 5.1][h264]-GRP.mkv` });
    await t.run((ctx) => start(ctx, fileId, 'import'));
    const named = await seedUnit(t, workId, 2, 'Pilot', 2);
    await seedFile(t, {
      unitIds: [named],
      path: `/data/library/series/Show (2019) [tmdbid-123]/Season 02/Show (2019) - S02E02 - Pilot [AMZN][WEBDL-1080p][EAC3 5.1][h264]-GRP.mkv`,
    });

    expect(await retitle('A real title', [scanned, preparing])).toBe(0);
    expect(await t.run((ctx) => unitsRetitled(ctx, [named]))).toBe(0);
    expect((await jobs()).filter((job) => job.class === 'maintenance')).toEqual([]);
  });
});

describe('a queued rename whose file is replaced or gone', () => {
  const claimRename = async () => {
    const w = await prepareWorker(t);
    return await t.mutation(api.jobs.queue.claim, { ...worker, sessionId: w.sessionId, class: 'maintenance', max: 1 });
  };

  test('a deleted file’s rename is dropped at the claim: no worker gets it', async () => {
    const { fileId } = await seedFile(t, { unitIds: [unitId], path: UNTITLED });
    await retitle('Pilot');
    await t.run((ctx) => ctx.db.delete(fileId));
    expect(await claimRename()).toEqual([]);
    const [rename] = (await jobs()).filter((job) => job.class === 'maintenance');
    expect(rename!.status).toBe('cancelled');
    expect(rename!.payload).toBeUndefined();
  });

  test('a file no longer at the rename’s `from` (replaced, moved to originals/) keeps its path: the rename is dropped', async () => {
    const original = `/data/library/series/originals/Show (2019) [tmdbid-123]/Season 01/${UNTITLED.slice(SEASON_1.length + 1)}`;
    const { fileId } = await seedFile(t, { unitIds: [unitId], path: UNTITLED });
    await retitle('Pilot');
    await t.run((ctx) => ctx.db.patch(fileId, { path: original }));
    expect(await claimRename()).toEqual([]);
    expect((await jobs()).find((job) => job.class === 'maintenance')).toMatchObject({ status: 'cancelled' });
    expect((await t.run((ctx) => ctx.db.get(fileId)))!.path).toBe(original);
  });

  test('a rename leased before its file moved leaves the row alone when it completes', async () => {
    const { fileId } = await seedFile(t, { unitIds: [unitId], path: UNTITLED });
    await retitle('Pilot');
    const [job] = await claimRename();
    await t.run((ctx) => ctx.db.patch(fileId, { path: '/data/library/series/elsewhere.mkv' }));
    await t.mutation(api.jobs.queue.complete, {
      ...worker,
      jobId: job!.jobId,
      leaseEpoch: job!.leaseEpoch,
      result: { class: 'maintenance', action: 'renameLibraryFile', path: WEBDL_PATH },
    });
    expect((await t.run((ctx) => ctx.db.get(fileId)))!.path).toBe('/data/library/series/elsewhere.mkv');
    expect((await jobs()).filter((row) => row.class === 'publish')).toEqual([]);
  });
});

describe('the rename’s result (results.maintenance)', () => {
  test('patches the path and sidecars, resets the Publication to pending with the next generation and its item, and enqueues its publish; the Unit keeps its state', async () => {
    const { fileId, versionIds } = await seedFile(t, { unitIds: [unitId], path: UNTITLED, sidecars: [sidecar(UNTITLED_BASE, 'en')], fits: false });
    await t.run((ctx) => recomputeUnits(ctx, [unitId]));
    const before = (await t.run((ctx) => ctx.db.get(unitId)))!.derivedState;
    expect(before).toBe('notInTargetFormat');
    await retitle('Pilot');

    const w = await prepareWorker(t);
    const [job] = await t.mutation(api.jobs.queue.claim, { ...worker, sessionId: w.sessionId, class: 'maintenance', max: 1 });
    await t.mutation(api.jobs.queue.complete, {
      ...worker,
      jobId: job!.jobId,
      leaseEpoch: job!.leaseEpoch,
      result: { class: 'maintenance', action: 'renameLibraryFile', path: WEBDL_PATH },
    });

    const file = (await t.run((ctx) => ctx.db.get(fileId)))!;
    expect(file.path).toBe(WEBDL_PATH);
    expect(file.sidecars).toEqual([sidecar(PILOT_BASE, 'en')]);
    const [publication] = (await t.run((ctx) => ctx.db.query('publications').collect())) as Doc<'publications'>[];
    expect(publication).toMatchObject({ fileVersionId: versionIds[0], state: 'pending', generation: 1, targetItemRef: `jf-${unitId}` });
    const publish = (await jobs()).find((row) => row.class === 'publish')!;
    expect(publish).toMatchObject({ idempotencyKey: `${publication!._id}:publish:1`, status: 'queued' });
    expect(publication!.jobId).toBe(publish._id);
    expect(publish.payload).toEqual({
      class: 'publish',
      publicationIds: [publication!._id],
      workFolderPath: '/data/library/series/Show (2019) [tmdbid-123]',
      items: [{ publicationId: publication!._id, path: WEBDL_PATH }],
      library: { libraryId: libraries.series, root: '/data/library/series', kind: 'series' },
    });
    expect((await t.run((ctx) => ctx.db.get(unitId)))!.derivedState).toBe(before);
  });
});
