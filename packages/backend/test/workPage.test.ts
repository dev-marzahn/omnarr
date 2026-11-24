// The series Work page's tabs and "…" menu: its Blocklist tab, its Files
// tab, Edit monitoring, and Delete.
import { DEFAULT_LIMITS } from '@omnarr/contracts';
import { parseRelease } from '@omnarr/parser';
import { describe, expect, test, vi } from 'vite-plus/test';

import { api, internal } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import type { MutationCtx } from '../convex/_generated/server';
import { PAGE_BUDGET, purgeBudget, purgePage } from '../convex/library/deleteWork';
import { addToBlocklist } from '../convex/pipeline/blocklist';
import { workflow } from '../convex/pipeline/workflow';
import { PREPARED_PROBE, SEASON_1, SERIES_ROOT, SHOW_FOLDER, WEBDL_PATH, prepareWorker, seedFile, seedShow, seedUnit } from './fakePrepare';
import { E1_RELEASES, pipelineHarness, release } from './harness';
import { countingReads } from './reads';
import { seedIndexer, useFetchFakes, worker } from './setup';

const h = pipelineHarness();
const SWEEP_RETRY_MS = DEFAULT_LIMITS.orphanSweepRetryMs;

describe('the Blocklist tab', () => {
  test("lists the Work's entries newest first, with the episode of the run that added one, and unblocking removes only that entry", async () => {
    await h.indexer(E1_RELEASES);
    const workId = await h.subscribe();
    const [grab] = await h.all('grabs');
    await h.admin.mutation(api.api.units.cancelGrab, { grabId: grab!._id, blocklist: true });
    await h.settle();
    const guid = 'https://indexer.fake/details/other';
    await h.t.run((ctx) =>
      addToBlocklist(ctx, { workId, item: { guid, title: 'Harbour.Lights.S01E02.1080p.WEB.H264-GRPX', protocol: 'usenet' }, reason: 'missingArticles' }),
    );

    const entries = await h.admin.query(api.api.library.blocklist, { workId });
    expect(entries).toEqual([
      expect.objectContaining({ title: 'Harbour.Lights.S01E02.1080p.WEB.H264-GRPX', reason: 'missingArticles', units: [] }),
      expect.objectContaining({ title: E1_RELEASES[0]!.title, reason: 'manual', grabId: grab!._id, units: [{ tmdbSeason: 1, tmdbEpisode: 1 }] }),
    ]);
    expect(entries[0]!.addedAt).toBeGreaterThanOrEqual(entries[1]!.addedAt);

    await h.admin.mutation(api.api.library.unblock, { entryId: entries[1]!.entryId });
    expect((await h.admin.query(api.api.library.blocklist, { workId })).map((entry) => entry.reason)).toEqual(['missingArticles']);
  });
});

describe('Edit monitoring', () => {
  test('turns "monitor new episodes" off and on again, as subscribe sets it', async () => {
    const workId = await seedShow(h.t, h.libraries);
    await h.admin.mutation(api.api.library.setMonitorNew, { workId, monitorNewUnits: false });
    expect((await h.admin.query(api.api.library.detail, { workId }))!.work.monitorNewUnits).toBe(false);
    await h.admin.mutation(api.api.library.setMonitorNew, { workId, monitorNewUnits: true });
    expect((await h.admin.query(api.api.library.detail, { workId }))!.work.monitorNewUnits).toBe(true);
  });
});

describe('deleteWork', () => {
  const deleteLibraryFiles = async () =>
    (await h.all('jobs')).map((job) => job.payload).filter((payload) => payload?.class === 'maintenance' && payload.action === 'deleteLibraryFiles');

  test("removes the Work's rows, its blocklist and its metadata rows, and its stored images through images.remove; the files stay on disk", async () => {
    useFetchFakes();
    const workId = await h.subscribe();
    const images = await h.all('images');
    expect(images.length).toBeGreaterThan(0);
    const [e1] = await h.all('units');
    await seedFile(h.t, { unitIds: [e1!._id] });
    await h.t.run((ctx) =>
      addToBlocklist(ctx, { workId, item: { guid: 'g', title: 'Harbour.Lights.S01E01.720p.WEB.H264-GRPX', protocol: 'usenet' }, reason: 'missingArticles' }),
    );

    await h.admin.mutation(api.api.library.deleteWork, { workId, deleteFiles: false });
    await h.settle();

    expect(await h.admin.query(api.api.library.detail, { workId })).toBeNull();
    for (const table of [
      'units',
      'images',
      'blocklist',
      'workMetadata',
      'unitMetadata',
      'workAliases',
      'externalIds',
      'unitMappings',
      'files',
      'fileUnits',
      'fileVersions',
      'publications',
    ] as const)
      expect(await h.all(table), table).toEqual([]);
    for (const image of images) expect(await h.t.run((ctx) => ctx.storage.getUrl(image.storageId))).toBeNull();
    expect(await deleteLibraryFiles()).toEqual([]);
  });

  test('with "Also delete files from disk", it asks the worker to delete the files and kept originals, and Jellyfin to forget the Work folder', async () => {
    const workId = await seedShow(h.t, h.libraries);
    const e1 = await seedUnit(h.t, workId, 1);
    await seedFile(h.t, { unitIds: [e1], sidecars: [{ path: `${SEASON_1}/Show - S01E02.en.srt`, language: 'en', format: 'srt', forced: false, sdh: false }] });

    await h.admin.mutation(api.api.library.deleteWork, { workId, deleteFiles: true });
    await h.settle();

    expect(await deleteLibraryFiles()).toEqual([
      {
        class: 'maintenance',
        action: 'deleteLibraryFiles',
        paths: [WEBDL_PATH, `${SEASON_1}/Show - S01E02.en.srt`],
        libraryId: h.libraries.series,
        folders: [`${SERIES_ROOT}/${SHOW_FOLDER}`],
        originalsFolder: `/data/originals/series/${SHOW_FOLDER}`,
      },
    ]);
    expect(await h.all('works')).toEqual([]);
  });

  test('cancels an active Grab and deletes nothing until its run has ended', async () => {
    await h.indexer(E1_RELEASES);
    const workId = await h.subscribe();
    const w = await h.worker();
    await w.submitAll();
    await h.settle();

    await h.admin.mutation(api.api.library.deleteWork, { workId, deleteFiles: false });
    const [grab] = await h.all('grabs');
    expect(grab!.cancelRequested).toBe(true);
    expect(await h.get(workId)).not.toBeNull();

    await h.settle();
    expect(await h.all('works')).toEqual([]);
    expect(await h.all('units')).toEqual([]);
    expect(await h.all('grabs')).toEqual([]);
    expect(await h.all('downloads')).toEqual([]);
    expect(await h.all('candidates')).toEqual([]);
    expect(await h.all('searchAttempts')).toEqual([]);
  });

  test("a prepared file's publish job outlives its deleted Work and ends cleanly, done or failed, with no Issue", async () => {
    const workId = await seedShow(h.t, h.libraries);
    const e1 = await seedUnit(h.t, workId, 1);
    const e2 = await seedUnit(h.t, workId, 2);
    await seedFile(h.t, { unitIds: [e1], inode: '2049:1' });
    await seedFile(h.t, { unitIds: [e2], path: `${SEASON_1}/Show - S01E02.mkv`, inode: '2049:2' });
    const w = await prepareWorker(h.t);
    for (const unitId of [e1, e2]) {
      await h.admin.mutation(api.api.units.prepareNow, { unitId });
      await w.prepareNext();
    }
    // Each prepared file waits for its publish job, which no Grab owns.
    const publish = () => h.t.mutation(api.jobs.queue.claim, { ...worker, sessionId: w.sessionId, class: 'publish', max: 1 });
    expect((await h.all('jobs')).filter((job) => job.class === 'publish' && job.status === 'queued')).toHaveLength(2);

    await h.admin.mutation(api.api.library.deleteWork, { workId, deleteFiles: false });
    await h.settle();
    expect(await h.all('works')).toEqual([]);
    expect(await h.all('publications')).toEqual([]);

    // The worker publishes one anyway and fails the other on its last attempt.
    const [done] = await publish();
    await h.t.mutation(api.jobs.queue.complete, {
      ...worker,
      jobId: done!.jobId,
      leaseEpoch: done!.leaseEpoch,
      result: { class: 'publish', targetItemRefs: {} },
    });
    for (;;) {
      const [job] = await publish();
      if (!job) break;
      await w.fail(job, 'jellyfinUnavailable', 'Jellyfin did not answer.');
      await h.settle();
    }

    // Once both have ended, the sweep deletes them too.
    vi.advanceTimersByTime(SWEEP_RETRY_MS);
    await h.settle();
    expect((await h.all('jobs')).filter((job) => job.class === 'publish')).toEqual([]);
    expect(await h.all('issues')).toEqual([]);
    expect(await h.all('publications')).toEqual([]);
  });

  test('leaves no orphan row: every search attempt of a Unit, the jobs of its run and its clean-up, and the run’s workflow records', async () => {
    await h.indexer(E1_RELEASES);
    const workId = await h.subscribe();
    const w = await h.worker();
    await w.submitAll();
    await h.settle();
    await w.completed(await h.activeDownload());
    await h.settle();
    await w.importAll();
    await h.settle();
    await w.publishAll();
    await h.settle();
    const [grab] = await h.all('grabs');
    expect(grab!.state).toBe('done');
    // A later search replaces the Unit's lastSearchAttemptId: the first attempt is named only by its events.
    const e1 = await h.unit(workId, 1, 1);
    await h.admin.mutation(api.api.units.searchNow, { unitIds: [e1._id] });
    await h.settle();
    expect((await h.all('searchAttempts')).length).toBeGreaterThan(1);
    // The run's clean-up (removeDownload) is still queued when the Work goes.
    expect((await h.all('jobs')).some((job) => job.status === 'queued' && job.class === 'maintenance')).toBe(true);

    await h.admin.mutation(api.api.library.deleteWork, { workId, deleteFiles: false });
    await h.settle();
    for (const table of ['works', 'units', 'searchAttempts', 'candidates', 'grabs', 'grabUnits', 'downloads', 'importJobs', 'events'] as const)
      expect(await h.all(table), table).toEqual([]);
    await expect(h.t.run((ctx) => workflow.status(ctx, grab!.workflowId!))).rejects.toThrow();
    // Only the queued clean-up is left, so the worker still removes the download; once it has, the sweep deletes it.
    expect((await h.all('jobs')).map((job) => [job.class, job.status])).toEqual([['maintenance', 'queued']]);
    for (const job of await w.claim('maintenance')) await w.complete(job, { class: 'maintenance', action: 'removeDownload', removed: true });
    vi.advanceTimersByTime(SWEEP_RETRY_MS);
    await h.settle();
    expect(await h.all('jobs')).toEqual([]);
    expect(await h.all('jobProgress')).toEqual([]);
  });

  test("a seeding torrent's kept Grab stays while it seeds, and the sweep deletes it with its Download and jobs once it is removed", async () => {
    await h.tracker([
      release('t1', 'Harbour.Lights.S01E01.1080p.WEB-DL.AAC2.0.H.264-GRPB', {
        torrent: { infoHash: 'c1'.repeat(20), seeders: 8, minimumSeedTimeSec: 3600, file: new Uint8Array([1]) },
      }),
    ]);
    const workId = await h.subscribe();
    const w = await h.worker();
    await w.submitAll();
    await h.settle();
    const downloadId = await h.activeDownload();
    await w.torrentCompleted(downloadId, { private: true });
    await h.settle();
    await w.importAll();
    await h.settle();
    await w.publishAll();
    await h.settle();

    await h.admin.mutation(api.api.library.deleteWork, { workId, deleteFiles: false });
    await h.settle();
    vi.advanceTimersByTime(SWEEP_RETRY_MS);
    await h.settle();
    expect(await h.all('grabs')).toHaveLength(1);
    expect(await h.all('downloads')).toHaveLength(1);

    await w.seedingDone(downloadId, { ratio: 2, seedTimeMs: 2 * 3_600_000 });
    await h.settle();
    for (const job of await w.claim('maintenance')) await w.complete(job, { class: 'maintenance', action: 'removeDownload', removed: true });
    await h.settle();
    vi.advanceTimersByTime(SWEEP_RETRY_MS);
    await h.settle();
    for (const table of ['grabs', 'downloads', 'jobs', 'candidates', 'searchAttempts', 'events'] as const) expect(await h.all(table), table).toEqual([]);
  });

  test('a leased import keeps the Work until the worker has ended it: the purge looks again later', async () => {
    await h.indexer(E1_RELEASES);
    const workId = await h.subscribe();
    const w = await h.worker();
    await w.submitAll();
    await h.settle();
    await w.completed(await h.activeDownload());
    await h.settle();
    const [job] = await w.claim('import');

    await h.admin.mutation(api.api.library.deleteWork, { workId, deleteFiles: false });
    vi.advanceTimersByTime(0);
    await h.t.finishInProgressScheduledFunctions();
    expect(await h.get(workId)).not.toBeNull();
    expect(await h.all('grabs')).toHaveLength(1);

    expect((await w.heartbeat()).cancelJobIds).toEqual([job!.jobId]);
    await w.fail(job!, 'cancelled');
    await h.settle();
    expect(await h.all('works')).toEqual([]);
    expect(await h.all('grabs')).toEqual([]);
  });
});

describe('deleteWork leaves no orphan row', () => {
  /** `count` finished search attempts of the Unit, each with `candidates` candidates and its `searchAttempt` event, as years of searches leave. */
  async function seedAttempts(workId: Id<'works'>, unitId: Id<'units'>, count: number, candidates: number): Promise<void> {
    const indexerId = await seedIndexer(h.t);
    const title = 'Show.S01E01.1080p.WEB-DL.AAC2.0.H.264-GRPB';
    await h.t.run(async (ctx) => {
      for (let n = 0; n < count; n++) {
        const searchAttemptId = await ctx.db.insert('searchAttempts', {
          unitIds: [unitId],
          wantedUnitIds: [unitId],
          workId,
          groupKind: 'episode',
          trigger: 'backfill',
          state: 'noAcceptable',
          indexerResults: [],
        });
        await ctx.db.insert('events', {
          unitId,
          stage: 'search',
          kind: 'stageStarted',
          message: 'Searching (backfill).',
          data: { entity: 'searchAttempt', entityId: searchAttemptId, to: 'running' },
          at: n,
        });
        for (let c = 0; c < candidates; c++)
          await ctx.db.insert('candidates', {
            searchAttemptId,
            indexerId,
            guid: `${n}-${c}`,
            title,
            downloadUrl: 'https://indexer.fake/get',
            sizeBytes: 1_000_000_000,
            protocol: 'usenet',
            publishedAt: 0,
            parsed: parseRelease(title, 'series'),
            unitIds: [unitId],
            alsoContainsUnitIds: [],
            quality: 'webdl-1080p',
            qualityRank: 1,
            qualityAssumed: false,
            baseScore: 0,
            score: 0,
            scoreBreakdown: [],
            preparationStep: 'remux',
            preparationAssumed: false,
            outcome: 'rejected',
          });
      }
    });
  }

  /** A maintenance job the deleted Work's purge or runs left, in the status a test needs. */
  const seedJob = (idempotencyKey: string, status: 'queued' | 'leased' | 'done') =>
    h.t.run((ctx) =>
      ctx.db.insert('jobs', {
        class: 'maintenance',
        status,
        attempt: 0,
        maxAttempts: 3,
        leaseEpoch: status === 'leased' ? 1 : 0,
        ...(status === 'leased' ? { leaseOwner: 'w1', leaseExpiresAt: Date.now() + 60_000 } : {}),
        idempotencyKey,
        protocolVersion: 1,
        cancelRequested: false,
      }),
    );

  test('a Unit with years of searches goes over several pages, each within the write budget, and none of its attempts or candidates is left', async () => {
    // The real budget is 4 000 rows; 60 here lets 40 searches span pages, as 365 daily ones would at 4 000.
    purgeBudget.rows = 60;
    try {
      const workId = await seedShow(h.t, h.libraries);
      const e1 = await seedUnit(h.t, workId, 1);
      const e2 = await seedUnit(h.t, workId, 2);
      // 40 searches of 5 candidates, each with its event: 280 rows for E1 alone.
      await seedAttempts(workId, e1, 40, 5);
      await seedAttempts(workId, e2, 3, 2);
      const rows = async () => {
        let n = 0;
        for (const table of ['candidates', 'searchAttempts', 'events', 'units'] as const) n += (await h.all(table)).length;
        return n;
      };

      await h.admin.mutation(api.api.library.deleteWork, { workId, deleteFiles: false });
      // Each page runs alone, so what it deleted is counted between pages.
      let before = await rows();
      let pages = 0;
      while ((await h.all('works')).length > 0) {
        if (pages > 50) throw new Error(`purge stuck at ${before} rows`);
        await h.t.mutation(internal.library.deleteWork.purge, { workId, deleteFiles: false, started: pages > 0 });
        const after = await rows();
        // A page may go past the budget by one attempt's candidates and its own last row.
        expect(before - after).toBeLessThanOrEqual(60 + 6);
        before = after;
        pages++;
      }
      expect(pages).toBeGreaterThan(3);
      for (const table of ['works', 'units', 'searchAttempts', 'candidates', 'events'] as const) expect(await h.all(table), table).toEqual([]);
    } finally {
      purgeBudget.rows = PAGE_BUDGET;
    }
  });

  test('with "Also delete files", the purge\'s own deleteLibraryFiles job is the sweep\'s: it stays while the worker runs it and goes once it has ended', async () => {
    const workId = await seedShow(h.t, h.libraries);
    const e1 = await seedUnit(h.t, workId, 1);
    await seedFile(h.t, { unitIds: [e1] });
    await h.admin.mutation(api.api.library.deleteWork, { workId, deleteFiles: true });
    await h.settle();
    expect(await h.all('works')).toEqual([]);
    const [job] = await h.all('jobs');
    expect(job!.idempotencyKey).toBe(`deleteLibraryFiles:work:${workId}`);

    // Leased by the worker across a sweep: it stays.
    const w = await prepareWorker(h.t);
    const [leased] = await h.t.mutation(api.jobs.queue.claim, { ...worker, sessionId: w.sessionId, class: 'maintenance', max: 1 });
    vi.advanceTimersByTime(SWEEP_RETRY_MS);
    await h.settle();
    expect((await h.all('jobs')).map((row) => row.status)).toEqual(['leased']);

    await h.t.mutation(api.jobs.queue.complete, {
      ...worker,
      jobId: leased!.jobId,
      leaseEpoch: leased!.leaseEpoch,
      result: { class: 'maintenance', action: 'deleteLibraryFiles', removedPaths: [WEBDL_PATH] },
    });
    vi.advanceTimersByTime(SWEEP_RETRY_MS);
    await h.settle();
    expect(await h.all('jobs')).toEqual([]);
  });

  test('a job shared by two pages is handed to the sweep once and goes once it has ended', async () => {
    const jobId = await seedJob('shared', 'queued');
    // Two pages both name it, as two Units' Publications name one publish job.
    await h.t.mutation(internal.library.deleteWork.sweep, { jobIds: [jobId, jobId], grabIds: [], since: Date.now() });
    expect(await h.get(jobId)).not.toBeNull();
    await h.t.run((ctx) => ctx.db.patch(jobId, { status: 'done' }));
    vi.advanceTimersByTime(SWEEP_RETRY_MS);
    await h.settle();
    expect(await h.get(jobId)).toBeNull();
  });

  test('the sweep stops after 7 days and raises one orphanAfterDelete Issue for what never ended; removeOrphans deletes it, even a leased job', async () => {
    const leased = await seedJob('removeDownload:gone', 'leased');
    const queued = await seedJob('cleanStaging:gone', 'queued');
    const ended = await seedJob('done:gone', 'done');
    await h.t.mutation(internal.library.deleteWork.sweep, { jobIds: [leased, queued, ended], grabIds: [], since: Date.now() });
    expect(await h.get(ended)).toBeNull();

    // Hourly for 7 days, never ending: no Issue until the cap, then one, and the sweep stops.
    for (let hour = 0; hour < 7 * 24 - 1; hour++) {
      vi.advanceTimersByTime(SWEEP_RETRY_MS);
      await h.t.finishInProgressScheduledFunctions();
    }
    expect(await h.all('issues')).toEqual([]);
    vi.advanceTimersByTime(2 * SWEEP_RETRY_MS);
    await h.t.finishInProgressScheduledFunctions();
    const issues = await h.all('issues');
    expect(issues).toEqual([
      expect.objectContaining({
        scope: 'system',
        failureCode: 'orphanAfterDelete',
        state: 'open',
        fixActions: ['removeOrphans', 'dismiss'],
        detail: 'A deleted series or movie left 2 jobs that never ended.',
        orphanRows: { jobIds: [leased, queued], grabIds: [] },
      }),
    ]);
    vi.advanceTimersByTime(30 * SWEEP_RETRY_MS);
    await h.t.finishInProgressScheduledFunctions();
    expect(await h.all('issues')).toHaveLength(1);

    const [row] = (await h.admin.query(api.api.issues.list, {})).system;
    expect(row!.fixActions).toEqual(['removeOrphans', 'dismiss']);
    await h.admin.mutation(api.api.issues.act, { issueId: issues[0]!._id, action: 'removeOrphans' });
    expect(await h.all('jobs')).toEqual([]);
    expect((await h.get(issues[0]!._id))!.state).toBe('resolved');
  });

  /** A private torrent of E1 imported and published, then its Work deleted while it seeds. */
  async function deletedWhileSeeding(): Promise<{ w: Awaited<ReturnType<typeof h.worker>>; downloadId: Id<'downloads'> }> {
    await h.tracker([
      release('t1', 'Harbour.Lights.S01E01.1080p.WEB-DL.AAC2.0.H.264-GRPB', {
        torrent: { infoHash: 'c2'.repeat(20), seeders: 8, minimumSeedTimeSec: 30 * 86_400, file: new Uint8Array([1]) },
      }),
    ]);
    const workId = await h.subscribe();
    const w = await h.worker();
    await w.submitAll();
    await h.settle();
    const downloadId = await h.activeDownload();
    await w.torrentCompleted(downloadId, { private: true });
    await h.settle();
    await w.importAll();
    await h.settle();
    await w.publishAll();
    await h.settle();
    await h.admin.mutation(api.api.library.deleteWork, { workId, deleteFiles: false });
    await h.settle();
    return { w, downloadId };
  }

  const hours = async (n: number) => {
    for (let hour = 0; hour < n; hour++) {
      vi.advanceTimersByTime(SWEEP_RETRY_MS);
      await h.t.finishInProgressScheduledFunctions();
    }
  };

  test('a torrent seeding past 7 days raises nothing: the sweep keeps watching it and deletes its Grab once seeding ends', async () => {
    const { w, downloadId } = await deletedWhileSeeding();
    // 20 days of seeding toward a 30-day tracker minimum.
    await hours(20 * 24);
    expect(await h.all('issues')).toEqual([]);
    expect(await h.all('grabs')).toHaveLength(1);

    await w.seedingDone(downloadId, { ratio: 1, seedTimeMs: 30 * 86_400_000 });
    await h.settle();
    for (const job of await w.claim('maintenance')) await w.complete(job, { class: 'maintenance', action: 'removeDownload', removed: true });
    await h.settle();
    await hours(1);
    for (const table of ['grabs', 'downloads', 'jobs', 'candidates', 'searchAttempts', 'events', 'issues'] as const)
      expect(await h.all(table), table).toEqual([]);
  });

  test('a torrent whose removal never ran is raised after 7 days; removeOrphans asks the client again and keeps the rows until it is removed', async () => {
    const { w, downloadId } = await deletedWhileSeeding();
    await w.seedingDone(downloadId, { ratio: 1, seedTimeMs: 30 * 86_400_000 });
    await h.settle();
    // The worker fails the removal for good (the client refused it).
    for (let attempt = 0; attempt < DEFAULT_LIMITS.maxAttempts.maintenance; attempt++) {
      const [job] = await w.claim('maintenance');
      if (!job) break;
      await w.fail(job, 'clientUnreachable', 'qBittorrent refused the removal.');
      vi.advanceTimersByTime(DEFAULT_LIMITS.backoffCapMs);
      await h.settle();
    }
    const [grab] = await h.all('grabs');
    await hours(7 * 24 + 1);
    const [issue] = await h.all('issues').then((rows) => rows.filter((row) => row.failureCode === 'orphanAfterDelete'));
    expect(issue).toMatchObject({ orphanRows: { jobIds: [], grabIds: [grab!._id] } });
    expect(issue!.detail).toBe('A deleted series or movie left 1 torrent run whose torrent was never removed.');

    // The client still has the torrent: the rows stay, and the removal is asked again, with its data.
    await h.admin.mutation(api.api.issues.act, { issueId: issue!._id, action: 'removeOrphans' });
    expect(await h.all('grabs')).toHaveLength(1);
    expect((await w.watched()).map((row) => row.downloadId)).toEqual([downloadId]);
    const asked = (await h.all('jobs')).filter((job) => job.status === 'queued');
    expect(asked.map((job) => job.payload)).toEqual([expect.objectContaining({ action: 'removeDownload', downloadId, deleteData: true })]);

    for (const job of await w.claim('maintenance')) await w.complete(job, { class: 'maintenance', action: 'removeDownload', removed: true });
    await h.settle();
    await hours(1);
    for (const table of ['grabs', 'downloads', 'jobs', 'candidates', 'searchAttempts', 'events'] as const) expect(await h.all(table), table).toEqual([]);
  });

  test("a lost torrent of a done Grab is asked again with its data, so its files don't stay behind", async () => {
    const { w, downloadId } = await deletedWhileSeeding();
    await w.seedingLost(downloadId);
    await h.settle();
    for (let attempt = 0; attempt < DEFAULT_LIMITS.maxAttempts.maintenance; attempt++) {
      const [job] = await w.claim('maintenance');
      if (!job) break;
      await w.fail(job, 'clientUnreachable', 'qBittorrent refused the removal.');
      vi.advanceTimersByTime(DEFAULT_LIMITS.backoffCapMs);
      await h.settle();
    }
    await hours(7 * 24 + 1);
    const [issue] = await h.all('issues').then((rows) => rows.filter((row) => row.failureCode === 'orphanAfterDelete'));
    await h.admin.mutation(api.api.issues.act, { issueId: issue!._id, action: 'removeOrphans' });
    const asked = (await h.all('jobs')).filter((job) => job.status === 'queued');
    expect(asked.map((job) => job.payload)).toEqual([expect.objectContaining({ action: 'removeDownload', downloadId, deleteData: true })]);
  });

  test('a seeding torrent whose client never answers is raised once its goal time plus 7 days has passed, and not before', async () => {
    const { downloadId } = await deletedWhileSeeding();
    // The tracker asks for 30 days; the client never reports again, so the Download stays `completed` and watched.
    expect((await h.get(downloadId))!.seedGoal?.seedTimeMs).toBe(30 * 86_400_000);
    await hours(36 * 24);
    expect(await h.all('issues')).toEqual([]);
    await hours(24 + 1);
    const [grab] = await h.all('grabs');
    expect(await h.all('issues')).toEqual([expect.objectContaining({ failureCode: 'orphanAfterDelete', orphanRows: { jobIds: [], grabIds: [grab!._id] } })]);
    // The sweep has stopped for it.
    await hours(30 * 24);
    expect(await h.all('issues')).toHaveLength(1);
  });

  test('a seeding torrent with no time in its goal is raised after 60 days', async () => {
    const { downloadId } = await deletedWhileSeeding();
    await h.t.run((ctx) => ctx.db.patch(downloadId, { seedGoal: { ratio: 5 } }));
    await hours(59 * 24);
    expect(await h.all('issues')).toEqual([]);
    await hours(24 + 1);
    expect((await h.all('issues')).map((issue) => issue.failureCode)).toEqual(['orphanAfterDelete']);
  });

  test('a read-heavy Unit (5 000 events, few attempts) finishes over several pages, none reading more than its budget', async () => {
    purgeBudget.rows = 1000;
    try {
      const workId = await seedShow(h.t, h.libraries);
      const e1 = await seedUnit(h.t, workId, 1);
      await seedAttempts(workId, e1, 2, 1);
      await h.t.run(async (ctx) => {
        for (let n = 0; n < 5000; n++)
          await ctx.db.insert('events', { unitId: e1, stage: 'publish', kind: 'stageFinished', message: 'Visible in Jellyfin.', at: 10 + n });
      });
      await h.admin.mutation(api.api.library.deleteWork, { workId, deleteFiles: false });

      let pages = 0;
      while ((await h.all('works')).length > 0) {
        if (pages > 30) throw new Error('purge stuck');
        const reads = await h.t.run(async (ctx) => {
          const { ctx: counted, counter } = countingReads(ctx);
          await purgePage(counted as unknown as MutationCtx, workId, pages > 0);
          return counter.reads;
        });
        // One page of 500 events past the budget at most.
        expect(reads).toBeLessThanOrEqual(1000 + 500 + 20);
        pages++;
      }
      expect(pages).toBeGreaterThan(4);
      for (const table of ['units', 'events', 'searchAttempts', 'candidates'] as const) expect(await h.all(table), table).toEqual([]);
    } finally {
      purgeBudget.rows = PAGE_BUDGET;
    }
  });
});

describe('the Files tab', () => {
  test("lists the Work's file versions in episode order, each with its Unit, size, quality and fit, as the item page's Files tab has them", async () => {
    const workId = await seedShow(h.t, h.libraries);
    const e1 = await seedUnit(h.t, workId, 1);
    const e2 = await seedUnit(h.t, workId, 2);
    await seedUnit(h.t, workId, 3);
    const { fileId: second } = await seedFile(h.t, {
      unitIds: [e2],
      path: `${SEASON_1}/Show - S01E02.mp4`,
      probe: PREPARED_PROBE,
      fits: true,
      release: null,
      origin: 'scan',
      inode: '2049:2',
    });
    const { fileId: first } = await seedFile(h.t, { unitIds: [e1], inode: '2049:1' });

    const rows = await h.admin.query(api.api.library.files, { workId });
    expect(rows).toEqual([
      expect.objectContaining({
        fileId: first,
        unitId: e1,
        tmdbSeason: 1,
        tmdbEpisode: 1,
        sizeBytes: 1_500_000_000,
        quality: 'webdl-1080p',
        kind: 'primary',
        fits: false,
      }),
      expect.objectContaining({ fileId: second, unitId: e2, tmdbSeason: 1, tmdbEpisode: 2, sizeBytes: 1_500_000_000, kind: 'primary', fits: true, steps: [] }),
    ]);
    // The scanned file has no release, so no quality.
    expect(rows[1]).not.toHaveProperty('quality');
    expect(rows[0]!.steps.length).toBeGreaterThan(0);
  });
});
