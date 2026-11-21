// Preparation: deciding,
// starting with priorities, the profile edit's recompute, cancel, "Prepare
// all", recording the output, and the ends of a failed or cancelled job.
import { DEFAULT_DEVICES, libraryFileName, type PreparePayload, type TargetFormat, targetForDevices } from '@omnarr/contracts';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';

import { api, internal } from '../convex/_generated/api';
import type { Doc, Id } from '../convex/_generated/dataModel';
import { cancelForUnit, decide, prepareAllPage, prepareEnded, start } from '../convex/pipeline/preparation';
import {
  BLURAY_PROBE,
  HEVC_PROBE,
  MKV_PROBE,
  PREPARED_PROBE,
  preparedResult,
  prepareWorker,
  SEASON_1,
  seedFile,
  seedShow,
  seedUnit,
  WEBDL_PATH,
  WEBDL_PROBE,
  type PrepareWorker,
} from './fakePrepare';
import { pipelineHarness, release } from './harness';
import { asAdmin, seedLibraries, setup, type Backend, type Libraries } from './setup';

let t: Backend;
let admin: Awaited<ReturnType<typeof asAdmin>>;
let libraries: Libraries;
let workId: Id<'works'>;
let pilot: Id<'units'>;

beforeEach(async () => {
  vi.useFakeTimers();
  t = setup();
  admin = await asAdmin(t, 30 * 86_400_000);
  libraries = await seedLibraries(t);
  workId = await seedShow(t, libraries);
  pilot = await seedUnit(t, workId, 2, 'Pilot');
});
afterEach(() => {
  vi.useRealTimers();
});

type Table = 'renditions' | 'jobs' | 'files' | 'fileVersions' | 'publications' | 'issues' | 'fileUnits' | 'events';
const all = <T extends Table>(table: T) => t.run((ctx) => ctx.db.query(table).collect()) as Promise<Doc<T>[]>;
const get = <T extends 'units' | 'files' | 'renditions' | 'jobs' | 'fileVersions'>(id: Id<T>) => t.run((ctx) => ctx.db.get(id)) as Promise<Doc<T> | null>;
const stateOf = async (unitId: Id<'units'>) => (await get(unitId))!.derivedState;
const runDecide = (fileId: Id<'files'>) => t.run((ctx) => decide(ctx, fileId));
const runStart = (fileId: Id<'files'>, reason: Parameters<typeof start>[2]) => t.run((ctx) => start(ctx, fileId, reason));
const settle = () => t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(1_000));
const prepareJobs = async () => (await all('jobs')).filter((job) => job.class === 'prepare');
const payloadOf = async (renditionId: Id<'renditions'>): Promise<PreparePayload> => {
  const job = (await get((await get(renditionId))!.jobId))!;
  if (job.payload?.class !== 'prepare') throw new Error('no prepare payload');
  return job.payload;
};
const renditionsOf = async (fileId: Id<'files'>) => (await all('renditions')).filter((rendition) => rendition.sourceFileId === fileId);
const profileIdOf = async (libraryId: Id<'libraries'>) => t.run(async (ctx) => (await ctx.db.get(libraryId))!.playbackProfileId);

/** The default target (Chrome and the Jellyfin Android app), which seedLibraries gives both libraries. */
const DEFAULT_TARGET = targetForDevices(DEFAULT_DEVICES);

describe('decide', () => {
  test('a downloaded file that needs steps: fits = false, a Rendition in group 0 with its prepare job, and the Unit is preparing', async () => {
    const { fileId, versionIds } = await seedFile(t, { unitIds: [pilot], fits: true });
    await runDecide(fileId);

    expect((await all('fileVersions')).map((version) => [version._id, version.fits])).toEqual([[versionIds[0], false]]);
    const [rendition] = await all('renditions');
    expect(rendition).toMatchObject({ sourceFileId: fileId, steps: ['audio', 'subtitle', 'remux'], reason: 'import', state: 'pending' });
    const job = (await get(rendition!.jobId))!;
    expect(job).toMatchObject({ class: 'prepare', status: 'queued', idempotencyKey: `${rendition!._id}:prepare`, renditionId: rendition!._id });
    // Group 0 without a video step: priority 0, stored as absent.
    expect(job.priority).toBeUndefined();
    expect(await stateOf(pilot)).toBe('preparing');
  });

  test('the payload: the source, its library target, the disposition, the naming that gives the prepared MP4’s name, and the folders', async () => {
    const { fileId } = await seedFile(t, { unitIds: [pilot] });
    await runDecide(fileId);
    const [rendition] = await all('renditions');
    const payload = await payloadOf(rendition!._id);
    expect(payload).toMatchObject({
      class: 'prepare',
      renditionId: rendition!._id,
      sourceFileId: fileId,
      sourcePath: WEBDL_PATH,
      sourceInode: '2049:100',
      targetProfileId: await profileIdOf(libraries.series),
      target: DEFAULT_TARGET,
      disposition: 'replace',
      units: [{ season: 1, episode: 2, title: 'Pilot' }],
      outputFolder: SEASON_1,
      originalsFolder: '/data/originals/series/Show (2019) [tmdbid-123]/Season 01',
    });
    expect(payload.naming).toMatchObject({ kind: 'series', title: 'Show', year: 2019, tmdbId: 123, anime: false });
    if ('keepBaseName' in payload.naming) throw new Error('expected a naming context');
    expect(libraryFileName({ naming: payload.naming, units: payload.units, probe: PREPARED_PROBE, ext: '.mp4' })).toBe(
      'Show (2019) - S01E02 - Pilot [AMZN][WEBDL-1080p][AAC 2.0][h264]-GRP.mp4',
    );
  });

  test('a scanned file stops at fits: no Rendition, and the Unit is "not yet in target format"', async () => {
    const { fileId } = await seedFile(t, { unitIds: [pilot], origin: 'scan', keepsName: true, release: null, fits: true });
    await runDecide(fileId);
    expect((await all('fileVersions'))[0]!.fits).toBe(false);
    expect(await all('renditions')).toEqual([]);
    expect(await stateOf(pilot)).toBe('notInTargetFormat');
  });

  test('a file that fits: fits = true and nothing to prepare; the Unit is ready', async () => {
    const { fileId } = await seedFile(t, { unitIds: [pilot], probe: PREPARED_PROBE, path: `${SEASON_1}/E2.mp4` });
    await runDecide(fileId);
    expect((await all('fileVersions'))[0]!.fits).toBe(true);
    expect(await all('renditions')).toEqual([]);
    expect(await stateOf(pilot)).toBe('ready');
  });

  test('a file that keeps its name is prepared under its own base name; "Keep the original" makes the disposition keep', async () => {
    await admin.mutation(api.api.playback.update, { libraryId: libraries.series, draft: { mode: 'devices', devices: DEFAULT_DEVICES, keepOriginal: true } });
    const path = '/data/library/series/Old Show (2015)/Season 1/Old Show - S01E01 - Pilot.mkv';
    const { fileId } = await seedFile(t, { unitIds: [pilot], origin: 'scan', keepsName: true, release: null, path });
    const renditionId = (await runStart(fileId, 'manual'))!;
    expect(await payloadOf(renditionId)).toMatchObject({
      naming: { keepBaseName: 'Old Show - S01E01 - Pilot' },
      disposition: 'keep',
      outputFolder: '/data/library/series/Old Show (2015)/Season 1',
      originalsFolder: '/data/originals/series/Old Show (2015)/Season 1',
    });
  });

  test('a multi-episode file names its Units in part order', async () => {
    const third = await seedUnit(t, workId, 3, 'Second Light');
    const { fileId } = await seedFile(t, { unitIds: [pilot, third] });
    await runDecide(fileId);
    const [rendition] = await all('renditions');
    expect((await payloadOf(rendition!._id)).units).toEqual([
      { season: 1, episode: 2, title: 'Pilot' },
      { season: 1, episode: 3, title: 'Second Light' },
    ]);
    expect(await all('renditions')).toHaveLength(1);
  });
});

describe('start (and its priorities)', () => {
  test('cancels a pending Rendition for the same file and profile: its queued job ends cancelled', async () => {
    const { fileId } = await seedFile(t, { unitIds: [pilot] });
    const first = (await runStart(fileId, 'import'))!;
    const second = (await runStart(fileId, 'manual'))!;
    expect((await get(first))!.state).toBe('cancelled');
    expect((await get((await get(first))!.jobId))!.status).toBe('cancelled');
    expect((await get(second))!).toMatchObject({ state: 'pending', reason: 'manual' });
    expect(await stateOf(pilot)).toBe('preparing');
  });

  test('priority is group × 2 + 1 for a video step: imports, "Prepare now" and retries in group 0, profile edits and "Prepare all" in group 1', async () => {
    let episode = 10;
    const priorityOf = async (reason: Parameters<typeof start>[2], probe = MKV_PROBE) => {
      const unitId = await seedUnit(t, workId, episode++, 'X');
      const { fileId } = await seedFile(t, { unitIds: [unitId], probe, path: `${SEASON_1}/${unitId}.mkv` });
      const renditionId = (await runStart(fileId, reason))!;
      return (await get((await get(renditionId))!.jobId))!.priority ?? 0;
    };
    expect(await priorityOf('import')).toBe(0);
    expect(await priorityOf('manual')).toBe(0);
    expect(await priorityOf('retry')).toBe(0);
    expect(await priorityOf('import', HEVC_PROBE)).toBe(1);
    expect(await priorityOf('profileEdit')).toBe(2);
    expect(await priorityOf('bulk')).toBe(2);
    expect(await priorityOf('profileEdit', HEVC_PROBE)).toBe(3);
  });

  test('a file without a probe or that already fits starts nothing', async () => {
    const { fileId } = await seedFile(t, { unitIds: [pilot], probe: PREPARED_PROBE });
    expect(await runStart(fileId, 'manual')).toBeNull();
    expect(await all('renditions')).toEqual([]);
  });
});

/** A target that takes Matroska and HEVC as they are, so the seeded files fit before the edit. */
const LOOSE_TARGET: TargetFormat = {
  ...DEFAULT_TARGET,
  containers: ['mp4', 'mkv'],
  video: { ...DEFAULT_TARGET.video, codecs: ['h264', 'hevc'], maxBitDepth: { h264: 8, hevc: 10, av1: 8 } },
};
const setTarget = (target: TargetFormat, libraryId = libraries.series) =>
  admin.mutation(api.api.playback.update, { libraryId, draft: { mode: 'custom', target, keepOriginal: false } });

describe('recomputeFits and the claim order', () => {
  test('a new import’s remux is claimed before 142 profile-edit jobs; video jobs come after the no-video ones of their group; undoing the edit cancels them', async () => {
    await setTarget(LOOSE_TARGET);
    await settle();
    const files: Id<'files'>[] = [];
    for (let n = 0; n < 142; n++) {
      const unitId = await seedUnit(t, workId, 100 + n, `Episode title ${n}`);
      const { fileId } = await seedFile(t, { unitIds: [unitId], probe: n < 8 ? HEVC_PROBE : MKV_PROBE, path: `${SEASON_1}/${n}.mkv`, fits: true });
      files.push(fileId);
    }
    // The user ticks back to the default devices: 134 need a remux, 8 a video transcode.
    await setTarget(DEFAULT_TARGET);
    await settle();
    expect((await all('fileVersions')).filter((version) => !version.fits)).toHaveLength(142);
    expect(await prepareJobs()).toHaveLength(142);
    expect((await all('renditions')).every((rendition) => rendition.reason === 'profileEdit')).toBe(true);

    const w = await prepareWorker(t);
    const [running] = await w.claim(1);
    expect(running!.payload).toMatchObject({ sourceFileId: files[8] });

    // A new episode is imported and needs a remux.
    const { fileId: imported } = await seedFile(t, { unitIds: [pilot], probe: MKV_PROBE, path: `${SEASON_1}/new.mkv` });
    await runDecide(imported);

    const order = [...(await w.claim(100)), ...(await w.claim(100))].map((job) => (job.payload as PreparePayload).sourceFileId);
    expect(order[0]).toBe(imported);
    expect(order.slice(1, 134)).toEqual(files.slice(9));
    expect(order.slice(134)).toEqual(files.slice(0, 8));

    // Unticking again: every file fits, and their pending Renditions are cancelled.
    await setTarget(LOOSE_TARGET);
    await settle();
    expect((await all('fileVersions')).filter((version) => version.fits)).toHaveLength(143);
    // Every job is leased by now: each is asked to cancel at the worker's next heartbeat.
    const jobs = await prepareJobs();
    expect(jobs.filter((job) => job.cancelRequested)).toHaveLength(143);
    expect((await w.heartbeat()).cancelJobIds).toHaveLength(143);
  });

  test('a file that fits again loses its queued Rendition; one that no longer fits is prepared once per file, not per version', async () => {
    const third = await seedUnit(t, workId, 3, 'Second Light');
    const { fileId: double } = await seedFile(t, { unitIds: [pilot, third], probe: MKV_PROBE, path: `${SEASON_1}/double.mkv`, fits: true });
    const fourth = await seedUnit(t, workId, 4, 'Four');
    const { fileId: single } = await seedFile(t, { unitIds: [fourth], probe: MKV_PROBE, path: `${SEASON_1}/single.mkv` });
    await runDecide(single);
    const queued = (await renditionsOf(single))[0]!;

    await setTarget(LOOSE_TARGET);
    await settle();
    expect((await get(queued._id))!.state).toBe('cancelled');
    expect(await stateOf(fourth)).toBe('ready');

    await setTarget(DEFAULT_TARGET);
    await settle();
    expect((await renditionsOf(double)).filter((rendition) => rendition.state === 'pending')).toHaveLength(1);
    expect((await renditionsOf(single)).filter((rendition) => rendition.state === 'pending')).toHaveLength(1);
    expect(await stateOf(pilot)).toBe('preparing');
    expect(await stateOf(third)).toBe('preparing');
  });

  test('a pending Rendition with the same target is kept; one with another target is restarted in its own group, never a lower one', async () => {
    const { fileId } = await seedFile(t, { unitIds: [pilot], probe: MKV_PROBE, path: `${SEASON_1}/E2.mkv` });
    await runDecide(fileId);
    const imported = (await renditionsOf(fileId))[0]!;

    // A recompute with the same target leaves it.
    await t.mutation(internal.pipeline.preparation.recomputeFits, { playbackProfileId: await profileIdOf(libraries.series) });
    expect((await renditionsOf(fileId)).map((rendition) => rendition.state)).toEqual(['pending']);

    // A 720p cap: the import's Rendition is restarted for the new target, still in group 0.
    await admin.mutation(api.api.playback.update, {
      libraryId: libraries.series,
      draft: { mode: 'devices', devices: DEFAULT_DEVICES, maxHeightOverride: 720, keepOriginal: false },
    });
    await settle();
    const renditions = await renditionsOf(fileId);
    expect(renditions.map((rendition) => [rendition.reason, rendition.state])).toEqual([
      ['import', 'cancelled'],
      ['import', 'pending'],
    ]);
    const restarted = (await get(renditions[1]!.jobId))!;
    expect(restarted.priority ?? 0).toBe(1);
    expect((restarted.payload as PreparePayload).target.video.maxHeight).toBe(720);
    expect(imported._id).toBe(renditions[0]!._id);
  });

  test('scanned files are left as they are: fits is rewritten, nothing starts', async () => {
    const { fileId } = await seedFile(t, { unitIds: [pilot], origin: 'scan', keepsName: true, release: null, probe: MKV_PROBE, fits: true });
    await setTarget(DEFAULT_TARGET, libraries.series);
    await setTarget(LOOSE_TARGET);
    await settle();
    await setTarget(DEFAULT_TARGET);
    await settle();
    expect((await all('fileVersions'))[0]!.fits).toBe(false);
    expect(await renditionsOf(fileId)).toEqual([]);
    expect(await stateOf(pilot)).toBe('notInTargetFormat');
  });
});

describe('cancelForUnit', () => {
  test('a queued job is cancelled at once: the Rendition is cancelled, no Issue, and the Unit is "not yet in target format"', async () => {
    const { fileId } = await seedFile(t, { unitIds: [pilot] });
    await runDecide(fileId);
    expect(await t.run((ctx) => cancelForUnit(ctx, pilot))).toBe(1);
    const [rendition] = await all('renditions');
    expect(rendition!.state).toBe('cancelled');
    expect((await get(rendition!.jobId))!.status).toBe('cancelled');
    expect(await all('issues')).toEqual([]);
    expect(await stateOf(pilot)).toBe('notInTargetFormat');
  });

  test('a leased job is asked to cancel: the worker hears it at its heartbeat, fails it cancelled, and the Rendition follows', async () => {
    const { fileId } = await seedFile(t, { unitIds: [pilot] });
    await runDecide(fileId);
    const w = await prepareWorker(t);
    const [job] = await w.claim();
    await t.run((ctx) => cancelForUnit(ctx, pilot));
    const [rendition] = await all('renditions');
    expect(rendition!.state).toBe('pending');
    expect((await w.heartbeat()).cancelJobIds).toEqual([job!.jobId]);
    await w.fail(job!, 'cancelled', 'Cancelled.');
    expect((await get(rendition!._id))!.state).toBe('cancelled');
    expect(await all('issues')).toEqual([]);
    expect(await stateOf(pilot)).toBe('notInTargetFormat');
  });
});

describe('prepareAll', () => {
  test('100 Units per mutation, the rest in the next page; only primaries that don’t fit and have no pending Rendition, scanned files included', async () => {
    for (let n = 0; n < 149; n++) {
      const unitId = await seedUnit(t, workId, 100 + n);
      await seedFile(t, {
        unitIds: [unitId],
        probe: MKV_PROBE,
        path: `${SEASON_1}/${n}.mkv`,
        ...(n === 0 ? { origin: 'scan', keepsName: true, release: null } : {}),
      });
    }
    // The pilot fits; one more is already being prepared.
    await seedFile(t, { unitIds: [pilot], probe: PREPARED_PROBE, path: `${SEASON_1}/fits.mp4`, fits: true });
    const preparing = await seedUnit(t, workId, 300);
    const { fileId: busy } = await seedFile(t, { unitIds: [preparing], probe: MKV_PROBE, path: `${SEASON_1}/busy.mkv` });
    await runStart(busy, 'import');

    const queued = await t.run((ctx) => prepareAllPage(ctx, workId, null));
    // The first 100 Units in creation order: the pilot, which fits, and 99 that don't.
    expect(queued).toBe(99);
    await settle();
    const renditions = await all('renditions');
    expect(renditions.filter((rendition) => rendition.reason === 'bulk')).toHaveLength(149);
    expect(renditions.filter((rendition) => rendition.sourceFileId === busy)).toHaveLength(1);
    expect(new Set((await prepareJobs()).map((job) => job.priority))).toEqual(new Set([2, undefined]));
  });
});

/** Movies with "Keep the original" on, and a Bluray film. */
async function seedFilm() {
  await admin.mutation(api.api.playback.update, { libraryId: libraries.movies, draft: { mode: 'devices', devices: DEFAULT_DEVICES, keepOriginal: true } });
  const filmWorkId = await t.run(async (ctx) => {
    const id = await ctx.db.insert('works', {
      libraryId: libraries.movies,
      kind: 'movie',
      title: 'Film',
      year: 2020,
      numberingScheme: 'standard',
      releaseProfileId: libraries.releaseProfileId,
      monitorNewUnits: true,
      folder: 'Film (2020) [tmdbid-9]',
    });
    await ctx.db.insert('externalIds', { workId: id, provider: 'tmdb', value: '9' });
    return id;
  });
  const film = await t.run((ctx) => ctx.db.insert('units', { workId: filmWorkId, kind: 'movie', monitored: true, derivedState: 'wanted' }));
  const path = '/data/library/movies/Film (2020) [tmdbid-9]/Film (2020) [tmdbid-9] - [Bluray-1080p][DTS 5.1][h264]-GRP.mkv';
  const { fileId } = await seedFile(t, { unitIds: [film], probe: BLURAY_PROBE, path, release: 'Film.2020.1080p.BluRay.DTS.x264-GRP' });
  return { film, fileId, path };
}

describe('results.prepared', () => {
  let w: PrepareWorker;
  beforeEach(async () => {
    w = await prepareWorker(t);
  });

  test('replace: the output is staged with a pending Publication and one publish job; the source’s rows are gone; the Unit shows preparing until it is visible', async () => {
    const { fileId } = await seedFile(t, { unitIds: [pilot] });
    await runDecide(fileId);
    const { result, payload } = await w.prepareNext();
    if (result.noChange) throw new Error('expected an output');

    const rendition = (await get(payload.renditionId))!;
    const [output] = await all('files');
    expect(rendition).toMatchObject({ state: 'done', outputFileId: output!._id, encoder: 'copy' });
    expect(output).toMatchObject({
      path: `${SEASON_1}/Show (2019) - S01E02 - Pilot [AMZN][WEBDL-1080p][AAC 2.0][h264]-GRP.mp4`,
      origin: 'prepared',
      role: 'rendition',
      sidecars: result.sidecars,
      release: expect.objectContaining({ group: 'GRP', streamingService: 'AMZN' }),
    });
    expect((await all('fileUnits')).map((link) => [link.fileId, link.unitId])).toEqual([[output!._id, pilot]]);
    const [version] = await all('fileVersions');
    expect(version).toMatchObject({ unitId: pilot, fileId: output!._id, kind: 'staged', fits: true, playbackProfileId: payload.targetProfileId });
    const [publication] = await all('publications');
    expect(publication).toMatchObject({ unitId: pilot, fileVersionId: version!._id, state: 'pending', generation: 0 });

    const publish = (await all('jobs')).find((job) => job.class === 'publish')!;
    expect(publish).toMatchObject({ idempotencyKey: `${publication!._id}:publish:0`, status: 'queued' });
    expect(publication!.jobId).toBe(publish._id);
    expect(publish.payload).toEqual({
      class: 'publish',
      publicationIds: [publication!._id],
      workFolderPath: '/data/library/series/Show (2019) [tmdbid-123]',
      items: [{ publicationId: publication!._id, path: output!.path }],
      library: { libraryId: libraries.series, root: '/data/library/series', kind: 'series' },
    });
    expect(await stateOf(pilot)).toBe('preparing');
  });

  test('keep: the source becomes the original under originals/, with no Publication; a later profile edit prepares from it', async () => {
    const { film, fileId } = await seedFilm();
    await runDecide(fileId);
    const [job] = await w.claim();
    const payload = w.payloadOf(job!);
    expect(payload).toMatchObject({
      disposition: 'keep',
      outputFolder: '/data/library/movies/Film (2020) [tmdbid-9]',
      originalsFolder: '/data/originals/movies/Film (2020) [tmdbid-9]',
    });
    if ('keepBaseName' in payload.naming) throw new Error('expected a naming context');
    expect(libraryFileName({ naming: payload.naming, units: payload.units, probe: PREPARED_PROBE, ext: '.mp4' })).toBe(
      'Film (2020) [tmdbid-9] - [Bluray-1080p][AAC 2.0][h264]-GRP.mp4',
    );
    await w.complete(job!, preparedResult(payload, { sidecarLanguages: [], steps: ['audio', 'subtitle', 'remux'] }));

    const source = (await get(fileId))!;
    expect(source.path).toBe('/data/originals/movies/Film (2020) [tmdbid-9]/Film (2020) [tmdbid-9] - [Bluray-1080p][DTS 5.1][h264]-GRP.mkv');
    const versions = await all('fileVersions');
    expect(versions.map((version) => [version.fileId === fileId ? 'source' : 'output', version.kind])).toEqual([
      ['source', 'original'],
      ['output', 'staged'],
    ]);
    const publications = await all('publications');
    expect(publications.map((publication) => publication.fileVersionId)).toEqual([versions[1]!._id]);
    expect(await stateOf(film)).toBe('preparing');

    // Published: the staged version is the primary, and the film is ready. A 720p cap then prepares the original again.
    await w.publishAll();
    expect((await get(versions[1]!._id))!.kind).toBe('primary');
    expect(await stateOf(film)).toBe('ready');
    await admin.mutation(api.api.playback.update, {
      libraryId: libraries.movies,
      draft: { mode: 'devices', devices: DEFAULT_DEVICES, maxHeightOverride: 720, keepOriginal: true },
    });
    await settle();
    const again = (await all('renditions')).filter((rendition) => rendition.state === 'pending');
    expect(again.map((rendition) => [rendition.sourceFileId, rendition.reason])).toEqual([[fileId, 'profileEdit']]);
    const earlier = versions[1]!.fileId;
    expect(await payloadOf(again[0]!._id)).toMatchObject({
      sourcePath: source.path,
      outputFolder: '/data/library/movies/Film (2020) [tmdbid-9]',
      originalsFolder: '/data/originals/movies/Film (2020) [tmdbid-9]',
      replacesPath: (await get(earlier))!.path,
    });

    // The new output takes the earlier one's place: same name, so its rename replaced the file, and only its rows go.
    const [next] = await w.claim();
    await w.complete(next!, preparedResult(w.payloadOf(next!), { sidecarLanguages: [], originalPath: source.path, inode: '2049:901' }));
    expect(await get(earlier)).toBeNull();
    const after = await all('fileVersions');
    expect(after.map((version) => [version.fileId === fileId ? 'source' : version.fileId === earlier ? 'earlier' : 'new', version.kind])).toEqual([
      ['source', 'original'],
      ['new', 'staged'],
    ]);
    expect((await all('jobs')).filter((job) => job.class === 'maintenance')).toEqual([]);
  });

  test('noChange: the versions fit and nothing else changes', async () => {
    const { fileId } = await seedFile(t, { unitIds: [pilot] });
    await runDecide(fileId);
    const [job] = await w.claim();
    await w.complete(job!, { class: 'prepare', noChange: true });
    expect((await all('renditions'))[0]!.state).toBe('done');
    expect((await all('files')).map((file) => file._id)).toEqual([fileId]);
    expect((await all('fileVersions')).map((version) => [version.kind, version.fits])).toEqual([['primary', true]]);
    expect((await all('jobs')).filter((j) => j.class === 'publish')).toEqual([]);
    expect(await stateOf(pilot)).toBe('ready');
  });

  test('a torrent’s library link is removed and only its rows go; nothing is enqueued for downloads/', async () => {
    const { fileId } = await seedFile(t, { unitIds: [pilot], inode: '2049:777' });
    await runDecide(fileId);
    await w.prepareNext({ sourceRemoved: true });
    expect(await get(fileId)).toBeNull();
    expect((await all('fileUnits')).every((link) => link.fileId !== fileId)).toBe(true);
    expect((await all('jobs')).filter((job) => job.class === 'maintenance')).toEqual([]);
  });

  test('the Rendition’s entry names the dropped image tracks', async () => {
    const { fileId } = await seedFile(t, { unitIds: [pilot], probe: BLURAY_PROBE });
    await runDecide(fileId);
    await w.prepareNext({
      droppedTracks: [
        { language: 'en', forced: false },
        { language: 'en', forced: true },
      ],
      steps: ['audio', 'subtitle', 'remux'],
    });
    const done = (await all('events')).find((event) => event.unitId === pilot && event.data?.to === 'done')!;
    expect(done.message).toBe('Prepared: audio, subtitle, remux. Dropped 2 image subtitle tracks (English, English forced): OCR comes later.');
  });

  test('resolves the Unit’s transcodeFailed Issue', async () => {
    const { fileId } = await seedFile(t, { unitIds: [pilot] });
    await t.run((ctx) =>
      ctx.db.insert('issues', { scope: 'unit', unitId: pilot, failureCode: 'transcodeFailed', class: 'preparation', state: 'open', fixActions: [] }),
    );
    await runDecide(fileId);
    await w.prepareNext();
    expect((await all('issues')).map((issue) => issue.state)).toEqual(['resolved']);
  });
});

/** The WEB-DL episode kept under originals/, and the prepared primary made from it, published. */
const ORIGINAL_PATH = '/data/originals/series/Show (2019) [tmdbid-123]/Season 01/Show (2019) - S01E02 - Pilot [AMZN][WEBDL-1080p][AAC 2.0][h264]-GRP.mkv';
const OLD_PRIMARY_PATH = `${SEASON_1}/Show (2019) - S01E02 [AMZN][WEBDL-1080p][AAC 2.0][h264]-GRP.mp4`;
/** The default target, but Matroska only: the kept MKV fits, the prepared MP4 doesn't. */
const MKV_TARGET: TargetFormat = { ...DEFAULT_TARGET, containers: ['mkv'] };

async function seedKeptOriginal(probe = MKV_PROBE) {
  const { fileId: originalId } = await seedFile(t, { unitIds: [pilot], path: ORIGINAL_PATH, probe, kind: 'original', published: false });
  const { fileId: primaryId } = await seedFile(t, {
    unitIds: [pilot],
    path: OLD_PRIMARY_PATH,
    probe: PREPARED_PROBE,
    origin: 'prepared',
    role: 'rendition',
    inode: '2049:900',
    fits: true,
    sidecars: [{ path: OLD_PRIMARY_PATH.replace('.mp4', '.en.srt'), language: 'en', forced: false, sdh: false, format: 'srt' }],
  });
  return { originalId, primaryId };
}

describe('a kept original that fits is restored', () => {
  let w: PrepareWorker;
  beforeEach(async () => {
    w = await prepareWorker(t);
  });

  test('start enqueues a restore for a kept original that fits, naming the primary it replaces', async () => {
    await setTarget(MKV_TARGET);
    await settle();
    const { originalId } = await seedKeptOriginal();
    const renditionId = (await runStart(originalId, 'manual'))!;
    expect(await get(renditionId)).toMatchObject({ sourceFileId: originalId, steps: [], reason: 'manual', state: 'pending' });
    const job = (await get((await get(renditionId))!.jobId))!;
    expect(job.priority).toBeUndefined();
    expect(await payloadOf(renditionId)).toMatchObject({
      sourcePath: ORIGINAL_PATH,
      outputFolder: SEASON_1,
      originalsFolder: '/data/originals/series/Show (2019) [tmdbid-123]/Season 01',
      replacesPath: OLD_PRIMARY_PATH,
    });
    const queued = (await all('events')).find((event) => event.unitId === pilot && event.kind === 'stageStarted' && event.stage === 'prepare')!;
    expect(queued.message).toBe("Restore queued: the kept original fits the library's target.");
  });

  test('a profile edit that both the primary and the kept original fit starts a restore in the profile-edit group: the original is the better copy', async () => {
    const { originalId } = await seedKeptOriginal();
    await setTarget(LOOSE_TARGET);
    await settle();
    const pending = (await all('renditions')).filter((rendition) => rendition.state === 'pending');
    expect(pending.map((rendition) => [rendition.sourceFileId, rendition.reason, rendition.steps])).toEqual([[originalId, 'profileEdit', []]]);
    expect((await get(pending[0]!.jobId))!.priority).toBe(2);
    expect((await payloadOf(pending[0]!._id)).replacesPath).toBe(OLD_PRIMARY_PATH);
    // A second edit to the same target queues nothing more.
    await setTarget({ ...LOOSE_TARGET, subtitles: { mode: 'text', textFormats: ['srt'] } });
    await settle();
    await setTarget(LOOSE_TARGET);
    await settle();
    expect((await all('renditions')).filter((rendition) => rendition.state === 'pending')).toHaveLength(1);
  });

  test('Prepare now on a Unit whose primary fits queues nothing, kept original or not: restores come only from a profile edit', async () => {
    await seedKeptOriginal(WEBDL_PROBE);
    expect(await admin.mutation(api.api.units.prepareNow, { unitId: pilot })).toEqual({ queued: 0 });
    expect(await all('renditions')).toEqual([]);
  });

  test('Prepare all skips a Unit whose primary fits, and doesn’t restore its kept original', async () => {
    await seedKeptOriginal(WEBDL_PROBE);
    expect(await t.run((ctx) => prepareAllPage(ctx, workId, null))).toBe(0);
    expect(await all('renditions')).toEqual([]);
  });

  test('a profile edit that the original fits and the prepared primary does not starts the restore', async () => {
    const { originalId, primaryId } = await seedKeptOriginal();
    await setTarget(MKV_TARGET);
    await settle();
    expect(
      (await all('fileVersions')).map((version) => [version.fileId === originalId ? 'original' : version.fileId === primaryId && 'primary', version.fits]),
    ).toEqual([
      ['original', true],
      ['primary', false],
    ]);
    const pending = (await all('renditions')).filter((rendition) => rendition.state === 'pending');
    expect(pending.map((rendition) => [rendition.sourceFileId, rendition.reason, rendition.steps])).toEqual([[originalId, 'profileEdit', []]]);
    expect((await payloadOf(pending[0]!._id)).replacesPath).toBe(OLD_PRIMARY_PATH);
  });

  test('results.prepared with restored: the original’s row moves back and is staged, the old primary’s rows go, one publish, then ready', async () => {
    const { originalId, primaryId } = await seedKeptOriginal();
    await setTarget(MKV_TARGET);
    await settle();
    const [job] = await w.claim();
    const payload = w.payloadOf(job!);
    const restoredPath = `${SEASON_1}/Show (2019) - S01E02 - Pilot [AMZN][WEBDL-1080p][AAC 2.0][h264]-GRP.mkv`;
    const sidecars = [{ path: restoredPath.replace('.mkv', '.en.srt'), language: 'en' as const, forced: false, sdh: false, format: 'srt' as const }];
    await w.complete(job!, {
      class: 'prepare',
      noChange: false,
      restored: true,
      outputPath: restoredPath,
      sizeBytes: 1_500_000_000,
      inode: '2049:100',
      probe: MKV_PROBE,
      encoder: 'copy',
      steps: [],
      sidecars,
      droppedTracks: [],
      sourceRemoved: true,
    });

    expect((await all('files')).map((file) => file._id)).toEqual([originalId]);
    expect(await get(originalId)).toMatchObject({
      path: restoredPath,
      inode: '2049:100',
      sizeBytes: 1_500_000_000,
      probe: MKV_PROBE,
      sidecars,
      origin: 'download',
    });
    expect(await get(primaryId)).toBeNull();
    expect((await all('fileUnits')).map((link) => link.fileId)).toEqual([originalId]);
    const [version, ...others] = await all('fileVersions');
    expect(others).toEqual([]);
    expect(version).toMatchObject({ fileId: originalId, unitId: pilot, kind: 'staged', fits: true, playbackProfileId: payload.targetProfileId });
    const [publication, ...morePublications] = await all('publications');
    expect(morePublications).toEqual([]);
    expect(publication).toMatchObject({ fileVersionId: version!._id, state: 'pending', generation: 0 });
    const jobs = await all('jobs');
    expect(jobs.filter((j) => j.class === 'maintenance')).toEqual([]);
    const publish = jobs.find((j) => j.class === 'publish')!;
    expect(publish).toMatchObject({ idempotencyKey: `${publication!._id}:publish:0`, status: 'queued' });
    expect(publish.payload).toEqual({
      class: 'publish',
      publicationIds: [publication!._id],
      workFolderPath: '/data/library/series/Show (2019) [tmdbid-123]',
      items: [{ publicationId: publication!._id, path: restoredPath }],
      library: { libraryId: libraries.series, root: '/data/library/series', kind: 'series' },
    });
    expect(await get(payload.renditionId)).toMatchObject({ state: 'done', outputFileId: originalId, encoder: 'copy' });
    const done = (await all('events')).find((event) => event.unitId === pilot && event.data?.to === 'done')!;
    expect(done.message).toBe("Original restored: the kept original fits the library's target.");
    expect(await stateOf(pilot)).toBe('preparing');

    await w.publishAll();
    expect((await get(version!._id))!.kind).toBe('primary');
    expect(await stateOf(pilot)).toBe('ready');
  });

  test('re-preparing from a kept original that does not fit: the worker replaces the old primary, so no deleteLibraryFiles job', async () => {
    await admin.mutation(api.api.playback.update, { libraryId: libraries.series, draft: { mode: 'devices', devices: DEFAULT_DEVICES, keepOriginal: true } });
    const { originalId, primaryId } = await seedKeptOriginal(WEBDL_PROBE);
    // The primary fits, so this one is "Prepare now".
    await runStart(originalId, 'manual');
    const [job] = await w.claim();
    const payload = w.payloadOf(job!);
    expect(payload).toMatchObject({ sourcePath: ORIGINAL_PATH, disposition: 'keep', replacesPath: OLD_PRIMARY_PATH });
    await w.complete(job!, preparedResult(payload));
    expect(await get(primaryId)).toBeNull();
    expect((await get(originalId))!.path).toBe(ORIGINAL_PATH);
    expect((await all('jobs')).filter((j) => j.class === 'maintenance')).toEqual([]);
    expect((await all('fileVersions')).map((version) => [version.fileId === originalId ? 'original' : 'new', version.kind])).toEqual([
      ['original', 'original'],
      ['new', 'staged'],
    ]);
  });

  test('a primary that moved after the job was queued is not the one the worker replaced: its file and sidecars are deleted by a deleteLibraryFiles job', async () => {
    await admin.mutation(api.api.playback.update, { libraryId: libraries.series, draft: { mode: 'devices', devices: DEFAULT_DEVICES, keepOriginal: true } });
    const { originalId, primaryId } = await seedKeptOriginal(WEBDL_PROBE);
    await runStart(originalId, 'manual');
    const [job] = await w.claim();
    const payload = w.payloadOf(job!);
    // A rename landed meanwhile: the primary is no longer at the path the job names.
    const moved = `${SEASON_1}/Show (2019) - S01E02 - The Real Title [AMZN][WEBDL-1080p][AAC 2.0][h264]-GRP.mp4`;
    const movedSrt = moved.replace('.mp4', '.en.srt');
    await t.run((ctx) => ctx.db.patch(primaryId, { path: moved, sidecars: [{ path: movedSrt, language: 'en', forced: false, sdh: false, format: 'srt' }] }));
    await w.complete(job!, preparedResult(payload));

    expect(await get(primaryId)).toBeNull();
    const maintenance = (await all('jobs')).filter((j) => j.class === 'maintenance');
    expect(maintenance.map((j) => [j.idempotencyKey, j.payload])).toEqual([
      [
        `deleteLibraryFiles:${primaryId}`,
        { class: 'maintenance', action: 'deleteLibraryFiles', paths: [moved, movedSrt], libraryId: libraries.series, folders: [] },
      ],
    ]);
  });
});

describe('an episode end to end: import, decide, prepare, record, publish, ready', () => {
  const h = pipelineHarness();

  test('a WEB-DL episode is imported, prepared without a video transcode, and the Unit is ready once the MP4 is visible', async () => {
    await h.indexer([release('s1e1', 'Harbour.Lights.S01E01.1080p.AMZN.WEB-DL.DDP5.1.H.264-GRP')]);
    const showId = await h.subscribe();
    const w = await h.worker();
    await w.submitAll();
    await h.settle();
    await w.completed(await h.activeDownload());
    await h.settle();
    await w.importAll();
    await h.settle();
    await w.publishAll();
    await h.settle();

    // Step 2: the run's finish decided the file needs audio, subtitle and remux, in group 0.
    const e1 = (await h.unit(showId, 1, 1))._id;
    expect((await h.get(e1))!.derivedState).toBe('preparing');
    const [rendition] = await h.all('renditions');
    expect(rendition).toMatchObject({ steps: ['audio', 'subtitle', 'remux'], reason: 'import', state: 'pending' });
    const source = (await h.all('files'))[0]!;

    // Step 3: the worker prepares it and swaps it in.
    const p = await prepareWorker(h.t);
    const { result } = await p.prepareNext();
    if (result.noChange) throw new Error('expected an output');
    expect(result.outputPath).toBe(
      '/data/library/series/Harbour Lights (2021) [tmdbid-900001]/Season 01/Harbour Lights (2021) - S01E01 [AMZN][WEBDL-1080p][AAC 2.0][h264]-GRP.mp4',
    );
    expect(await h.get(source._id)).toBeNull();
    expect((await h.get(e1))!.derivedState).toBe('preparing');

    // Step 4: the publish makes the staged MP4 the primary, visible: ready.
    await w.publishAll();
    await h.settle();
    const versions = await h.all('fileVersions');
    expect(versions.map((version) => [version.kind, version.fits])).toEqual([['primary', true]]);
    expect((await h.get(versions[0]!.fileId))!).toMatchObject({ path: result.outputPath, origin: 'prepared', sidecars: result.sidecars });
    expect((await h.all('publications')).map((publication) => publication.state)).toEqual(['visible']);
    expect((await h.get(e1))!.derivedState).toBe('ready');
  });
});

describe('applyEnd’s prepare branch (failures)', () => {
  let w: PrepareWorker;
  beforeEach(async () => {
    w = await prepareWorker(t);
  });

  const LOG = 'ffmpeg exited with code 1\n[last 50 lines]';

  test('two failed attempts fail the Rendition; the log stays on the job; a transcodeFailed Issue per Unit with the detail; the original stays published', async () => {
    const third = await seedUnit(t, workId, 3, 'Second Light');
    const { fileId } = await seedFile(t, { unitIds: [pilot, third], probe: HEVC_PROBE, path: `${SEASON_1}/double.mp4` });
    await runDecide(fileId);
    const log = await t.run((ctx) => ctx.storage.store(new Blob(['ffmpeg log'])));

    const [first] = await w.claim();
    await w.fail(first!, 'transcodeFailed', LOG, log);
    await t.mutation(internal.jobs.queue.wake, { jobId: first!.jobId });
    const [second] = await w.claim();
    await w.fail(second!, 'transcodeFailed', LOG, log);

    const [rendition] = await all('renditions');
    expect(rendition!.state).toBe('failed');
    expect((await get(rendition!.jobId))!).toMatchObject({ status: 'failed', failureCode: 'transcodeFailed', artifactStorageId: log });
    const issues = await all('issues');
    expect(issues.map((issue) => [issue.unitId, issue.failureCode, issue.detail, issue.jobId])).toEqual([
      [pilot, 'transcodeFailed', LOG, rendition!.jobId],
      [third, 'transcodeFailed', LOG, rendition!.jobId],
    ]);
    expect((await all('files')).map((file) => file._id)).toEqual([fileId]);
    expect(await stateOf(pilot)).toBe('notInTargetFormat');
  });

  test('the Issue’s detail is the failure’s own when applyEnd passes it', async () => {
    const { fileId } = await seedFile(t, { unitIds: [pilot] });
    await runDecide(fileId);
    const [rendition] = await all('renditions');
    const job = (await get(rendition!.jobId))!;
    await t.run((ctx) => prepareEnded(ctx, { ...job, lastError: 'an earlier attempt' }, 'failed', 'transcodeFailed', 'Output check failed: duration'));
    expect((await all('issues'))[0]!.detail).toBe('Output check failed: duration');
  });

  test('a cancel moves the Rendition to cancelled and raises nothing', async () => {
    const { fileId } = await seedFile(t, { unitIds: [pilot] });
    await runDecide(fileId);
    const [job] = await w.claim();
    await w.fail(job!, 'cancelled', 'Cancelled.');
    expect((await all('renditions'))[0]!.state).toBe('cancelled');
    expect(await all('issues')).toEqual([]);
  });

  test('a lease that expires with a cancel asked: supervision cancels the job, and the Rendition is cancelled with no Issue', async () => {
    const { fileId } = await seedFile(t, { unitIds: [pilot] });
    await runDecide(fileId);
    await w.claim();
    await t.run((ctx) => cancelForUnit(ctx, pilot));
    vi.advanceTimersByTime(120_000);
    await t.mutation(internal.jobs.queue.supervise, {});
    const [rendition] = await all('renditions');
    expect(rendition!.state).toBe('cancelled');
    expect((await get(rendition!.jobId))!.status).toBe('cancelled');
    // The worker is gone too, which is a system Issue; the Unit has none.
    expect((await all('issues')).filter((issue) => issue.scope === 'unit')).toEqual([]);
    expect(await stateOf(pilot)).toBe('notInTargetFormat');
  });

  test('pipelineError (a missing source or binary) raises pipelineError, not transcodeFailed', async () => {
    const { fileId } = await seedFile(t, { unitIds: [pilot] });
    await runDecide(fileId);
    const [job] = await w.claim();
    await w.fail(job!, 'pipelineError', 'source file missing');
    expect((await all('renditions'))[0]!.state).toBe('failed');
    expect((await all('issues')).map((issue) => [issue.failureCode, issue.detail])).toEqual([['pipelineError', 'source file missing']]);
  });
});
