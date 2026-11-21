// The failure table: every bad-release row, table-driven, the rows the run
// reaches, the Issue dedupe, and the resolve points of "Resolving Issues". The rows raised outside a run have their
// tests beside their code: storageUnavailable, workerOffline and
// protocolMismatch in worker.test.ts, vpnDown in vpn.test.ts, the Jellyfin
// codes in jellyfin.test.ts and passwordPushes.test.ts, jellyfinMisread in
// scan.test.ts, the metadata codes in metadata/keys.test.ts and
// metadata/sources.test.ts, transcodeFailed in preparation.test.ts,
// workflowPaused in pause.test.ts, unknownClientFailure in pipeline.test.ts.
// Each fix action is run in issues.test.ts.
import { DEFAULT_LIMITS, type FailureCode, FIX_ACTIONS, type LeasedJob } from '@omnarr/contracts';
import { beforeEach, describe, expect, test } from 'vite-plus/test';

import { internal } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import { dismissIssue, raiseIssue } from '../convex/lib/issues';
import { removeDownloads } from '../convex/pipeline/cleanup';
import type { FakeWorker } from './fakeWorker';
import { E1_RELEASES, pipelineHarness } from './harness';

const h = pipelineHarness();
let w: FakeWorker;
let workId: Id<'works'>;

beforeEach(async () => {
  await h.indexer(E1_RELEASES);
  workId = await h.subscribe();
  w = await h.worker();
});

const grabs = () => h.all('grabs');
const openIssues = async () => (await h.all('issues')).filter((issue) => issue.state === 'open');

/** Fails the queued job of a class on every attempt it has, waking it after each backoff. */
async function failEveryAttempt(cls: LeasedJob['class'], code: 'clientUnreachable' | 'jellyfinUnavailable') {
  for (let attempt = 0; attempt < DEFAULT_LIMITS.maxAttempts[cls]; attempt++) {
    const [job] = await w.claim(cls);
    await w.fail(job!, code);
    await h.t.run(async (ctx) => {
      for (const row of await ctx.db.query('jobs').collect())
        if (row.status === 'waiting') await ctx.db.patch(row._id, { status: 'queued', availableAt: undefined });
    });
  }
  await h.settle();
}

async function toPublishing() {
  await w.submitAll();
  await h.settle();
  await w.completed(await h.activeDownload());
  await h.settle();
  await w.importAll();
  await h.settle();
}

/** How each bad-release code reaches the run: the reconciler's report, or the job that found it. */
const BAD_RELEASES: [FailureCode, (w: FakeWorker) => Promise<void>][] = [
  ['missingArticles', async (w) => void (await w.failed(await h.activeDownload(), 'missingArticles'))],
  ['parFailed', async (w) => void (await w.failed(await h.activeDownload(), 'parFailed'))],
  ['unpackFailed', async (w) => void (await w.failed(await h.activeDownload(), 'unpackFailed'))],
  [
    'torrentStalled',
    async (w) =>
      void (await w.report([{ downloadId: await h.activeDownload(), outcome: 'stalled', clientStatus: { stage: 'stalledDL', progress: 0.4, raw: {} } }])),
  ],
  ...(['passwordProtected', 'noMediaFile', 'fakeOrWrongContent', 'importMismatch'] as const).map(
    (code) =>
      [
        code,
        async (w: FakeWorker) => {
          await w.completed(await h.activeDownload());
          await h.settle();
          const [job] = await w.claim('import');
          await w.fail(job!, code);
        },
      ] as [FailureCode, (w: FakeWorker) => Promise<void>],
  ),
];

describe('every bad-release row: blocklist and next-best, raised at the third failed Grab', () => {
  test.each(BAD_RELEASES)('%s', async (code, fail) => {
    for (let n = 1; n <= DEFAULT_LIMITS.badReleaseGrabs; n++) {
      await w.submitAll();
      await h.settle();
      await fail(w);
      await h.settle();
      expect((await h.all('blocklist')).at(-1)).toMatchObject({ reason: code });
      if (n < DEFAULT_LIMITS.badReleaseGrabs) {
        expect(await openIssues()).toEqual([]);
        expect((await grabs()).at(-1)!.state).toBe('submitting');
      }
    }
    expect(await openIssues()).toEqual([expect.objectContaining({ failureCode: code, class: 'badRelease', fixActions: FIX_ACTIONS[code] })]);
    expect((await grabs()).map((grab) => grab.state)).toEqual(['failed', 'failed', 'failed']);
  });

  test('a release file the worker found invalid is a bad release too', async () => {
    const [job] = await w.claim('download.submit');
    await w.fail(job!, 'releaseFileInvalid', 'The indexer answered 404 for the NZB.');
    await h.settle();
    expect(await h.all('blocklist')).toEqual([expect.objectContaining({ reason: 'releaseFileInvalid' })]);
    expect((await grabs()).at(-1)!.state).toBe('submitting');
  });
});

describe('transient failures', () => {
  test('clientUnreachable backs off, and on the last attempt the run fails and is raised with retryNow and dismiss', async () => {
    await failEveryAttempt('download.submit', 'clientUnreachable');

    const job = (await h.all('jobs')).find((row) => row.class === 'download.submit')!;
    expect(job).toMatchObject({ status: 'failed', attempt: DEFAULT_LIMITS.maxAttempts['download.submit'], failureCode: 'clientUnreachable' });
    expect((await grabs())[0]).toMatchObject({ state: 'failed', failureCode: 'clientUnreachable' });
    expect(await openIssues()).toEqual([
      expect.objectContaining({ failureCode: 'clientUnreachable', class: 'transient', fixActions: ['retryNow', 'dismiss'] }),
    ]);
    // Not a bad release: nothing is blocklisted and no next-best search starts.
    expect(await h.all('blocklist')).toEqual([]);
    expect(await grabs()).toHaveLength(1);
    expect((await h.unit(workId, 1, 1)).derivedState).toBe('failed');
  });

  test("releaseFetchFailed (the worker's fetch of the NZB may pass later) backs off and is retried like any transient failure; the last attempt raises it, with no blocklist", async () => {
    const detail = 'indexer.fake: the download limit is reached (GET /getnzb).';
    const [first] = await w.claim('download.submit');
    await w.fail(first!, 'releaseFetchFailed', detail);
    expect(await h.get(first!.jobId)).toMatchObject({ status: 'waiting', attempt: 1 });
    expect((await grabs())[0]!.state).toBe('submitting');

    await h.t.mutation(internal.jobs.queue.wake, { jobId: first!.jobId });
    for (let attempt = 1; attempt < DEFAULT_LIMITS.maxAttempts['download.submit']; attempt++) {
      const [job] = await w.claim('download.submit');
      await w.fail(job!, 'releaseFetchFailed', detail);
      await h.t.mutation(internal.jobs.queue.wake, { jobId: job!.jobId });
    }
    await h.settle();
    expect((await grabs())[0]).toMatchObject({ state: 'failed', failureCode: 'releaseFetchFailed' });
    expect(await openIssues()).toEqual([expect.objectContaining({ failureCode: 'releaseFetchFailed', fixActions: ['retryNow', 'dismiss'] })]);
    expect(await grabs()).toHaveLength(1);
    expect(await h.all('blocklist')).toEqual([]);
  });

  test('jellyfinUnavailable on the 5th publish attempt is raised without rerunJellyfinSetup; the file is recorded but not playable', async () => {
    await toPublishing();
    await failEveryAttempt('publish', 'jellyfinUnavailable');

    expect(await openIssues()).toEqual([expect.objectContaining({ failureCode: 'jellyfinUnavailable', fixActions: ['retryNow', 'dismiss'] })]);
    expect((await h.all('publications'))[0]!.state).toBe('failed');
    expect(await h.all('fileVersions')).toHaveLength(1);
    expect((await h.unit(workId, 1, 1)).derivedState).toBe('failed');
  });

  test('a lease that expires on every attempt fails the job as leaseExpired, which is raised', async () => {
    for (let attempt = 0; attempt < DEFAULT_LIMITS.maxAttempts['download.submit']; attempt++) {
      const [job] = await w.claim('download.submit');
      await h.t.run((ctx) => ctx.db.patch(job!.jobId, { leaseExpiresAt: Date.now() - 1 }));
      await h.t.mutation(internal.jobs.queue.supervise, {});
    }
    await h.settle();
    expect(await openIssues()).toEqual([expect.objectContaining({ failureCode: 'leaseExpired', class: 'transient' })]);
  });
});

describe('importMismatch', () => {
  test('a wrong-episode import is a bad release: blocklisted, and the next release is grabbed', async () => {
    await w.submitAll();
    await h.settle();
    await w.completed(await h.activeDownload());
    await h.settle();
    const [job] = await w.claim('import');
    await w.fail(job!, 'importMismatch', 'The download holds S01E02, not S01E01.');
    await h.settle();

    expect((await h.all('importJobs'))[0]!.state).toBe('failed');
    expect((await grabs()).map((grab) => [grab.state, grab.failureCode])).toEqual([
      ['failed', 'importMismatch'],
      ['submitting', undefined],
    ]);
    expect(await h.all('blocklist')).toEqual([expect.objectContaining({ reason: 'importMismatch' })]);
    expect(await openIssues()).toEqual([]);
    // The failed Grab's finished download goes from NZBGet and from downloads/usenet/.
    const removal = (await h.all('jobs')).find((job) => job.payload?.class === 'maintenance' && job.payload.action === 'removeDownload');
    expect(removal!.payload).toMatchObject({ deleteData: true, contentPath: expect.stringMatching(/^\/data\/downloads\/usenet\//) });
  });
});

test("a torrent's removal never carries its folder: qBittorrent deletes its own files", async () => {
  const [grab] = await grabs();
  await h.t.run(async (ctx) => {
    await ctx.db.insert('downloads', {
      grabId: grab!._id,
      clientKind: 'qbittorrent',
      clientRef: 'abc',
      correlationTag: grab!._id,
      state: 'completed',
      clientStage: 'downloading',
      contentPath: '/data/downloads/torrents/x',
    });
    await removeDownloads(ctx, grab!._id);
  });
  const removal = (await h.all('jobs')).find(
    (job) => job.payload?.class === 'maintenance' && job.payload.action === 'removeDownload' && job.payload.clientKind === 'qbittorrent',
  );
  expect(removal!.payload).not.toHaveProperty('contentPath');
});

test('a Usenet removal carries its folder only when it is under /data/downloads/usenet/', async () => {
  const [grab] = await grabs();
  await h.t.run(async (ctx) => {
    for (const contentPath of ['/data/downloads/usenet/completed/platform-series/A', '/data/library/series/A', '/data/downloads/usenet'])
      await ctx.db.insert('downloads', {
        grabId: grab!._id,
        clientKind: 'nzbget',
        clientRef: contentPath,
        correlationTag: grab!._id,
        state: 'failed',
        clientStage: 'downloading',
        contentPath,
      });
    await removeDownloads(ctx, grab!._id);
  });
  const payloads = (await h.all('jobs')).flatMap((job) =>
    job.payload?.class === 'maintenance' && job.payload.action === 'removeDownload' ? [job.payload] : [],
  );
  expect(payloads.map((payload) => [payload.clientRef, payload.contentPath])).toEqual([
    ['/data/downloads/usenet/completed/platform-series/A', '/data/downloads/usenet/completed/platform-series/A'],
    ['/data/library/series/A', undefined],
    ['/data/downloads/usenet', undefined],
  ]);
});

describe('pipelineError', () => {
  test('a run whose handler threw is raised at once with retryRelease, and blocklists nothing', async () => {
    const [grab] = await grabs();
    await h.t.mutation(internal.pipeline.grabs.onRunComplete, {
      workflowId: grab!.workflowId!,
      result: { kind: 'failed', error: 'boom' },
      context: { grabId: grab!._id },
    });
    expect(await openIssues()).toEqual([
      expect.objectContaining({ failureCode: 'pipelineError', class: 'system', scope: 'unit', fixActions: ['retryRelease', 'dismiss'] }),
    ]);
    expect(await h.all('blocklist')).toEqual([]);
    expect((await grabs())[0]).toMatchObject({ state: 'failed', failureCode: 'pipelineError' });
  });
});

describe('Resolving Issues', () => {
  test("steps.finish resolves the Unit's transient, bad-release and pipelineError Issues, and nothing else", async () => {
    const unitId = (await h.unit(workId, 1, 1))._id;
    await h.t.run(async (ctx) => {
      for (const code of ['clientUnreachable', 'missingArticles', 'pipelineError', 'transcodeFailed'] as const) await raiseIssue(ctx, { code, unitId });
    });
    await toPublishing();
    await w.publishAll();
    await h.settle();
    expect((await h.all('issues')).map((issue) => [issue.failureCode, issue.state])).toEqual([
      ['clientUnreachable', 'resolved'],
      ['missingArticles', 'resolved'],
      ['pipelineError', 'resolved'],
      // results.prepared resolves it.
      ['transcodeFailed', 'open'],
    ]);
  });
});

describe('diskFull', () => {
  test('waits 30 minutes without counting an attempt, raises one system Issue, and resolves it when a submit gets through', async () => {
    const [job] = await w.claim('download.submit');
    await w.fail(job!, 'diskFull', 'Needs 1.5 GB, 200 MB free.');
    expect(await h.get(job!.jobId)).toMatchObject({ status: 'waiting', attempt: 0 });
    expect(await openIssues()).toEqual([expect.objectContaining({ failureCode: 'diskFull', scope: 'system', fixActions: ['retryNow'] })]);

    await h.t.mutation(internal.jobs.queue.wake, { jobId: job!.jobId });
    await w.submitAll();
    expect(await openIssues()).toEqual([]);
  });
});

describe('Issues', () => {
  test('a repeated failure stays one Issue, with the latest detail', async () => {
    const unitId = (await h.unit(workId, 1, 1))._id;
    await h.t.run(async (ctx) => {
      await raiseIssue(ctx, { code: 'clientUnreachable', unitId, detail: 'first' });
      await raiseIssue(ctx, { code: 'clientUnreachable', unitId, detail: 'second' });
    });
    expect(await openIssues()).toEqual([expect.objectContaining({ detail: 'second' })]);
  });

  test('a system Issue that resolves itself cannot be dismissed; a unit-scope one can', async () => {
    const unitId = (await h.unit(workId, 1, 1))._id;
    const [system, unit] = await h.t.run(async (ctx) => [
      await raiseIssue(ctx, { code: 'workerOffline' }),
      await raiseIssue(ctx, { code: 'clientUnreachable', unitId }),
    ]);
    await expect(h.t.run((ctx) => dismissIssue(ctx, system!))).rejects.toThrow(/can't be dismissed/);
    await h.t.run((ctx) => dismissIssue(ctx, unit!));
    expect((await h.get(unit!))!.state).toBe('dismissed');
  });
});
