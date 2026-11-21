// `units.timeline`: the item page reads runs, stages and
// decision records from stored rows. A bad release's two runs are its
// example, with each candidate's stored fields and the Files section.
import { DEFAULT_DEVICES, targetForDevices } from '@omnarr/contracts';
import { beforeEach, describe, expect, test } from 'vite-plus/test';

import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import { raiseIssue } from '../convex/lib/issues';
import { MKV_PROBE as PREPARED_MKV_PROBE, PREPARED_PROBE, prepareWorker, SEASON_1, seedFile, seedShow, seedUnit, WEBDL_PATH } from './fakePrepare';
import type { FakeWorker } from './fakeWorker';
import { E1, E1_RELEASES, pipelineHarness } from './harness';
import { INDEXER_KEY, seedIndexer, seedNyaa, worker } from './setup';

const h = pipelineHarness();

describe('runs', () => {
  let w: FakeWorker;
  let workId: Id<'works'>;

  beforeEach(async () => {
    await h.indexer(E1_RELEASES);
    workId = await h.subscribe();
    w = await h.worker();
    // The first release fails repair; the next-best one goes all the way.
    await w.submitAll();
    await h.settle();
    await w.stage(await h.activeDownload(), 'postProcessing');
    await w.failed(await h.activeDownload(), 'missingArticles');
    await h.settle();
    await w.submitAll();
    await h.settle();
    await w.completed(await h.activeDownload());
    await h.settle();
    await w.importAll();
    await h.settle();
    await w.publishAll();
    await h.settle();
  });

  const timeline = async () => (await h.admin.query(api.api.units.timeline, { unitId: (await h.unit(workId, 1, 1))._id }))!;

  test('shows both runs, newest first, with their stages, outcome and the reason the first one failed', async () => {
    const { runs, state, workTitle } = await timeline();
    expect(workTitle).toBe('Harbour Lights');
    // The Matroska file needs a remux, so steps.finish's decide started its preparation.
    expect(state).toBe('preparing');
    expect(runs.map((run) => [run.title, run.state, run.outcome, run.failureCode])).toEqual([
      [E1_RELEASES[1]!.title, 'done', 'imported', undefined],
      [E1.title, 'failed', 'failed', 'missingArticles'],
    ]);
    const failed = runs[1]!;
    expect(failed.stages.map((s) => [s.stage, s.kind])).toEqual(
      expect.arrayContaining([
        ['grab', 'stageStarted'],
        ['download', 'stageStarted'],
        ['download', 'stageFailed'],
        ['grab', 'blocklisted'],
        ['grab', 'stageFailed'],
      ]),
    );
    expect(failed.stages.find((s) => s.to === 'postProcessing')).toBeDefined();
    expect(failed.download).toMatchObject({ clientStatus: { stage: 'FAILURE/HEALTH' } });
    expect(runs[0]!.search.trigger).toBe('nextBest');
    expect(failed.search.trigger).toBe('subscribe');
  });

  test("joins each run's decision records, with reasons and ranks, and never a download URL", async () => {
    const { runs } = await timeline();
    const first = runs[1]!.search.candidates;
    expect(first.map((c) => [c.title, c.outcome, c.rank, c.coversUnit])).toEqual(
      expect.arrayContaining([
        [E1.title, 'picked', 1, true],
        [E1_RELEASES[1]!.title, 'rejected', 2, true],
      ]),
    );
    const loser = first.find((c) => c.title === E1_RELEASES[1]!.title)!;
    expect(loser).toMatchObject({ reason: 'lowerScore', indexerName: 'indexer.fake', quality: 'bluray-1080p' });
    expect(loser.breakdown.every((entry) => entry.kind === 'format' || entry.kind === 'preparation')).toBe(true);
    // The next-best search saw the first release blocklisted.
    expect(runs[0]!.search.candidates.find((c) => c.title === E1.title)).toMatchObject({ outcome: 'rejected', reason: 'blocklisted' });
    expect(JSON.stringify(runs)).not.toContain(INDEXER_KEY);
    expect(JSON.stringify(runs)).not.toContain('getnzb');
  });

  test('lists events outside runs: the searches of the Unit', async () => {
    const { events } = await timeline();
    expect(events.filter((e) => e.stage === 'search').length).toBeGreaterThanOrEqual(2);
  });

  test('every candidate carries its parsed fields, score, breakdown and predicted preparation, read from the stored record', async () => {
    const { runs } = await timeline();
    const stored = await h.all('candidates');
    for (const row of runs[1]!.search.candidates) {
      const record = stored.find((candidate) => candidate._id === row.candidateId)!;
      expect(row).toMatchObject({
        parsed: record.parsed,
        score: record.score,
        baseScore: record.baseScore,
        breakdown: record.scoreBreakdown,
        preparationStep: record.preparationStep,
        covers: [expect.objectContaining({ tmdbSeason: 1, tmdbEpisode: 1 })],
      });
    }
    // The pick was automatic: no "Picked by you" on either run.
    expect(runs.map((run) => run.pickedBy)).toEqual(['auto', 'auto']);
    expect(runs[1]!.search.candidates.find((c) => c.outcome === 'picked')!.pickedBy).toBe('auto');
  });

  test("the failed run's blocklisted release says when and why it was blocklisted", async () => {
    const { runs } = await timeline();
    expect(runs[0]!.search.candidates.find((c) => c.title === E1.title)!.blocklisted).toEqual({ at: expect.any(Number), reason: 'missingArticles' });
  });

  test('a Unit with an open Issue carries it, with its fixes, for the alert on its Timeline tab', async () => {
    expect((await timeline()).issues).toEqual([]);
    const unitId = (await h.unit(workId, 1, 1))._id;
    await h.t.run((ctx) => raiseIssue(ctx, { code: 'pipelineError', unitId, detail: 'The run stopped.' }));
    expect((await timeline()).issues).toEqual([expect.objectContaining({ failureCode: 'pipelineError', fixActions: ['dismiss'], detail: 'The run stopped.' })]);
  });
});

describe("the last search's indexers (test-install backlog)", () => {
  test("each indexer's outcome: searched with its count, skipped with the reason, failed with the code, and no request when the plan had none", async () => {
    await h.indexer([]);
    await seedIndexer(h.t, { host: 'off.fake', enabled: false });
    const nyaaId = await seedNyaa(h.t);
    await seedIndexer(h.t, { host: 'broken.fake' });
    const workId = await h.subscribe();
    const unit = await h.unit(workId, 1, 1);
    const timeline = async () => (await h.admin.query(api.api.units.timeline, { unitId: unit._id }))!;

    const { lastSearch } = await timeline();
    expect(lastSearch?.indexers).toEqual([
      { indexerName: 'broken.fake', status: 'error', count: 0, failureCode: expect.any(String) },
      { indexerName: 'indexer.fake', status: 'ok', count: 0 },
      { indexerName: 'Nyaa', status: 'error', count: 0, skipped: 'animeOnly' },
      { indexerName: 'off.fake', status: 'error', count: 0, skipped: 'disabled' },
    ]);

    // The plan sends an indexer no request when no query fits the Units (the bug before the in-season fallback): the attempt has no row for it.
    await h.t.run(async (ctx) => {
      const attempt = (await ctx.db.get(unit.lastSearchAttemptId!))!;
      await ctx.db.patch(attempt._id, { indexerResults: attempt.indexerResults.filter((r) => r.indexerId !== nyaaId) });
    });
    expect((await timeline()).lastSearch?.indexers[2]).toEqual({ indexerName: 'Nyaa', status: 'ok', count: 0, skipped: 'noRequest' });
  });

  test('a row with `category`, stored before that skip was split, still reads as `category`, not as a newer skip', async () => {
    await h.indexer([]);
    const nyaaId = await seedNyaa(h.t);
    const workId = await h.subscribe();
    const unit = await h.unit(workId, 1, 1);
    await h.t.run(async (ctx) => {
      const attempt = (await ctx.db.get(unit.lastSearchAttemptId!))!;
      await ctx.db.patch(attempt._id, {
        indexerResults: attempt.indexerResults.map((r) => (r.indexerId === nyaaId ? { ...r, skipped: 'category' as const } : r)),
      });
    });
    const { lastSearch } = (await h.admin.query(api.api.units.timeline, { unitId: unit._id }))!;
    expect(lastSearch?.indexers.find((i) => i.indexerName === 'Nyaa')).toEqual({ indexerName: 'Nyaa', status: 'error', count: 0, skipped: 'category' });
  });
});

describe('the Files section', () => {
  test('the Unit’s versions, primary first: path, origin, kind, fits, the steps against the library’s target, and sidecars', async () => {
    const workId = await seedShow(h.t, h.libraries);
    const unitId = await seedUnit(h.t, workId, 2, 'Pilot');
    const { fileId: primary } = await seedFile(h.t, { unitIds: [unitId] });
    const sidecar = { path: `${SEASON_1}/Pilot.en.srt`, language: 'en' as const, forced: false, sdh: false, format: 'srt' as const };
    const { fileId: staged } = await seedFile(h.t, {
      unitIds: [unitId],
      path: `${SEASON_1}/Pilot.mp4`,
      probe: PREPARED_PROBE,
      origin: 'prepared',
      role: 'rendition',
      kind: 'staged',
      fits: true,
      published: false,
      sidecars: [sidecar],
    });
    const original = '/data/originals/series/Show (2019) [tmdbid-123]/Season 01/Pilot.mkv';
    const { fileId: kept } = await seedFile(h.t, { unitIds: [unitId], path: original, kind: 'original', published: false });

    const { files } = (await h.admin.query(api.api.units.timeline, { unitId }))!;
    expect(files).toEqual([
      { fileId: primary, path: WEBDL_PATH, origin: 'download', kind: 'primary', fits: false, steps: ['audio', 'subtitle', 'remux'], sidecars: [] },
      { fileId: staged, path: `${SEASON_1}/Pilot.mp4`, origin: 'prepared', kind: 'staged', fits: true, steps: [], sidecars: [sidecar] },
      { fileId: kept, path: original, origin: 'download', kind: 'original', fits: false, steps: ['audio', 'subtitle', 'remux'], sidecars: [] },
    ]);
  });

  test('a restore reads as "Original restored", not "Prepared", and its Rendition’s encoder is copy', async () => {
    const workId = await seedShow(h.t, h.libraries);
    const unitId = await seedUnit(h.t, workId, 2, 'Pilot');
    const original = '/data/originals/series/Show (2019) [tmdbid-123]/Season 01/Pilot.mkv';
    const { fileId: kept } = await seedFile(h.t, { unitIds: [unitId], path: original, probe: PREPARED_MKV_PROBE, kind: 'original', published: false });
    await seedFile(h.t, { unitIds: [unitId], path: `${SEASON_1}/Pilot.mp4`, probe: PREPARED_PROBE, origin: 'prepared', role: 'rendition', fits: true });
    // A profile edit that takes Matroska too: the kept original fits and is restored.
    const target = targetForDevices(DEFAULT_DEVICES);
    await h.admin.mutation(api.api.playback.update, {
      libraryId: h.libraries.series,
      draft: { mode: 'custom', target: { ...target, containers: ['mp4', 'mkv'] }, keepOriginal: true },
    });
    await h.settle();
    const w = await prepareWorker(h.t);
    const [job] = await w.claim();
    const restored = `${SEASON_1}/Show (2019) - S01E02 - Pilot [AMZN][WEBDL-1080p][AAC 2.0][h264]-GRP.mkv`;
    await w.complete(job!, {
      class: 'prepare',
      noChange: false,
      restored: true,
      outputPath: restored,
      sizeBytes: 1,
      inode: '2049:7',
      probe: PREPARED_MKV_PROBE,
      encoder: 'copy',
      steps: [],
      sidecars: [],
      droppedTracks: [],
      sourceRemoved: true,
    });

    const { events } = (await h.admin.query(api.api.units.timeline, { unitId }))!;
    const preparation = events.filter((event) => event.stage === 'prepare').map((event) => [event.message, event.to]);
    expect(preparation).toContainEqual(["Original restored: the kept original fits the library's target.", 'done']);
    expect(preparation.some(([message]) => message?.startsWith('Prepared'))).toBe(false);
    const [rendition] = await h.all('renditions');
    expect(rendition).toMatchObject({ sourceFileId: kept, state: 'done', encoder: 'copy', steps: [] });
  });

  test('refuses a caller without an admin session, and a worker', async () => {
    const workId = await seedShow(h.t, h.libraries);
    const unitId = await seedUnit(h.t, workId, 2, 'Pilot');
    await expect(h.t.query(api.api.units.timeline, { unitId })).rejects.toThrow(/unauthorized/);
    await expect(h.t.query(api.api.units.timeline, { ...worker, unitId } as never)).rejects.toThrow();
  });
});
