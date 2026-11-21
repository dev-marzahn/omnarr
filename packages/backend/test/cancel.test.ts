// Each cancel path: `cancelGrab` ends the run wherever it waits, and
// `onRunComplete` treats any Grab with `cancelRequested` as cancelled.
import { beforeEach, describe, expect, test } from 'vite-plus/test';

import { api, internal } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import type { FakeWorker } from './fakeWorker';
import { E1, E1_RELEASES, pipelineHarness } from './harness';

const h = pipelineHarness();
let w: FakeWorker;
let workId: Id<'works'>;

beforeEach(async () => {
  await h.indexer(E1_RELEASES);
  workId = await h.subscribe();
  w = await h.worker();
});

const grab = async () => (await h.all('grabs'))[0]!;
const cancel = async (blocklist?: boolean) =>
  h.admin.mutation(api.api.units.cancelGrab, { grabId: (await grab())._id, ...(blocklist === undefined ? {} : { blocklist }) });
const maintenance = async () => (await h.all('jobs')).filter((job) => job.class === 'maintenance').map((job) => job.payload);

describe('cancelGrab', () => {
  test('a queued job is cancelled and its event sent: the Grab ends cancelled and its Unit is free', async () => {
    await cancel();
    expect((await h.unit(workId, 1, 1)).derivedState).toBe('grabbed');
    expect((await grab()).cancelRequested).toBe(true);
    await h.settle();

    expect((await grab()).state).toBe('cancelled');
    expect((await h.all('jobs')).find((job) => job.class === 'download.submit')!.status).toBe('cancelled');
    const e1 = await h.unit(workId, 1, 1);
    expect(e1.activeGrabId).toBeUndefined();
    expect(e1.derivedState).toBe('wanted');
    // Nothing reached the client, so there is nothing to remove; a cancel doesn't count against the release.
    expect(await maintenance()).toEqual([]);
    expect(await h.all('blocklist')).toEqual([]);
    expect(await h.all('issues')).toEqual([]);
    expect((await h.all('grabUnits'))[0]!.outcome).toBe('skipped');
  });

  test('while the run waits for the download, the download event is sent cancelled and the download removed', async () => {
    await w.submitAll();
    await h.settle();
    await cancel();
    await h.settle();

    expect((await grab()).state).toBe('cancelled');
    expect(await maintenance()).toEqual([expect.objectContaining({ action: 'removeDownload', clientRef: expect.stringMatching(/^nzb-/), deleteData: true })]);
    // A late report from the client changes nothing.
    await w.completed(await h.activeDownload());
    await h.settle();
    expect((await grab()).state).toBe('cancelled');
  });

  test('a leased import is cancelled at the next heartbeat; the worker fails it cancelled and staging is cleaned', async () => {
    await w.submitAll();
    await h.settle();
    await w.completed(await h.activeDownload());
    await h.settle();
    const [job] = await w.claim('import');
    await cancel();
    expect((await w.heartbeat()).cancelJobIds).toEqual([job!.jobId]);
    await w.fail(job!, 'cancelled');
    await h.settle();

    expect((await grab()).state).toBe('cancelled');
    expect((await h.all('importJobs'))[0]!.state).toBe('cancelled');
    expect(await maintenance()).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ action: 'removeDownload' }),
        expect.objectContaining({ action: 'cleanStaging', paths: [`/data/staging/${job!.jobId}`] }),
      ]),
    );
  });

  test('a leased job whose worker is offline is cancelled by supervision when its lease expires, not re-queued', async () => {
    const [job] = await w.claim('download.submit');
    await cancel();
    await h.t.run((ctx) => ctx.db.patch(job!.jobId, { leaseExpiresAt: Date.now() - 1 }));
    await h.t.mutation(internal.jobs.queue.supervise, {});
    await h.settle();

    expect((await h.get(job!.jobId))!.status).toBe('cancelled');
    expect((await grab()).state).toBe('cancelled');
  });

  test('a paused run is ended with workflow.fail: cancelled, no pipelineError, its workflowPaused Issue resolved', async () => {
    await w.submitAll();
    await h.settle();
    await h.breakReplay((await grab()).workflowId!);
    await w.completed(await h.activeDownload());
    await h.settle();
    expect((await grab()).pausedAt).toEqual(expect.any(Number));
    expect((await h.all('issues')).map((issue) => [issue.failureCode, issue.state])).toEqual([['workflowPaused', 'open']]);

    await cancel();
    await h.settle();
    expect((await grab()).state).toBe('cancelled');
    expect((await h.all('issues')).map((issue) => [issue.failureCode, issue.state])).toEqual([['workflowPaused', 'resolved']]);
  });

  test('with blocklist, the release is blocklisted as manual and the next search grabs another', async () => {
    await cancel(true);
    await h.settle();
    expect(await h.all('blocklist')).toEqual([expect.objectContaining({ workId, reason: 'manual', title: E1.title })]);

    await h.admin.mutation(api.api.units.searchNow, { unitIds: [(await h.unit(workId, 1, 1))._id] });
    await h.settle();
    const grabs = await h.all('grabs');
    expect(grabs).toHaveLength(2);
    expect((await h.get(grabs[1]!.candidateId))!.title).toBe(E1_RELEASES[1]!.title);
  });

  test('without blocklist, the same release can be picked again', async () => {
    await cancel(false);
    await h.settle();
    await h.admin.mutation(api.api.units.searchNow, { unitIds: [(await h.unit(workId, 1, 1))._id] });
    await h.settle();
    const grabs = await h.all('grabs');
    expect((await h.get(grabs[1]!.candidateId))!.title).toBe(E1.title);
  });

  test("a cancelled Grab's Unit stays monitored and wanted, and the backfill searches and grabs it again", async () => {
    await w.submitAll();
    await h.settle();
    await cancel();
    await h.settle();
    const e1 = await h.unit(workId, 1, 1);
    expect(e1).toMatchObject({ monitored: true, derivedState: 'wanted' });
    expect(e1.activeGrabId).toBeUndefined();
    expect((await h.all('grabUnits'))[0]!.outcome).toBe('skipped');

    await h.t.mutation(internal.pipeline.backfill.runBackfill, {});
    await h.settle();
    const attempts = await h.all('searchAttempts');
    // Every episode of season 1 is wanted again, so backfill searches the season, E1 with it.
    expect(attempts.at(-1)).toMatchObject({ trigger: 'backfill', unitIds: expect.arrayContaining([e1._id]) });
    const grabs = await h.all('grabs');
    expect(grabs.map((grab) => grab.state)).toEqual(['cancelled', 'submitting']);
    expect((await h.unit(workId, 1, 1)).derivedState).toBe('grabbed');
  });

  test('a waiting job is cancelled at once, whatever it waits for, and its wake then does nothing', async () => {
    const [job] = await w.claim('download.submit');
    await w.fail(job!, 'clientUnreachable', 'NZBGet did not answer.');
    expect((await h.get(job!.jobId))!.status).toBe('waiting');
    await cancel();
    expect((await h.get(job!.jobId))!.status).toBe('cancelled');
    await h.t.mutation(internal.jobs.queue.wake, { jobId: job!.jobId });
    await h.settle();

    expect((await h.get(job!.jobId))!.status).toBe('cancelled');
    expect((await grab()).state).toBe('cancelled');
  });

  test('a job waiting for disk space is cancelled at once too', async () => {
    const [job] = await w.claim('download.submit');
    await w.fail(job!, 'diskFull', 'Needs 1.5 GB.');
    await cancel();
    await h.settle();
    expect((await h.get(job!.jobId))!.status).toBe('cancelled');
    expect((await grab()).state).toBe('cancelled');
  });

  test('a submit waiting for the VPN is cancelled at once too', async () => {
    const [job] = await w.claim('download.submit');
    await w.fail(job!, 'vpnDown', 'A VPN is chosen and it is not up.');
    expect((await h.get(job!.jobId))!.status).toBe('waiting');
    await cancel();
    await h.settle();
    expect((await h.get(job!.jobId))!.status).toBe('cancelled');
    expect((await grab()).state).toBe('cancelled');
  });

  describe("a cancelled Grab's job isn't retried", () => {
    test('a run job that fails retryably while its Grab has cancelRequested ends at once, and the Grab ends cancelled', async () => {
      const [job] = await w.claim('download.submit');
      await cancel();
      // The worker never saw the cancel: its attempt fails as it would have anyway.
      await w.fail(job!, 'clientUnreachable', 'NZBGet did not answer.');
      expect((await h.get(job!.jobId))!).toMatchObject({ status: 'cancelled', attempt: 0 });
      await h.settle();

      expect((await grab()).state).toBe('cancelled');
      expect(await h.all('issues')).toEqual([]);
      expect((await h.unit(workId, 1, 1)).derivedState).toBe('wanted');
    });

    test('the check runs first: a diskFull failure of a cancelled Grab neither waits nor raises diskFull', async () => {
      const [job] = await w.claim('download.submit');
      await cancel();
      await w.fail(job!, 'diskFull', 'Needs 1.5 GB.');
      await h.settle();

      expect((await h.get(job!.jobId))!.status).toBe('cancelled');
      expect(await h.all('issues')).toEqual([]);
      expect((await grab()).state).toBe('cancelled');
    });

    test('a terminal failure of a cancelled Grab still ends the run, as a cancel', async () => {
      const [job] = await w.claim('download.submit');
      await cancel();
      await w.fail(job!, 'releaseFileInvalid', 'indexer.fake answered HTTP 404 (GET /getnzb).');
      await h.settle();
      expect((await grab()).state).toBe('cancelled');
      expect(await h.all('blocklist')).toEqual([]);
    });

    test("a maintenance job of a cancelled Grab (its download's removal) is retried as usual", async () => {
      await w.submitAll();
      await h.settle();
      await cancel();
      await h.settle();
      const [removal] = await w.claim('maintenance');
      expect(removal!.payload).toMatchObject({ action: 'removeDownload' });
      await w.fail(removal!, 'clientUnreachable', 'NZBGet did not answer.');
      expect((await h.get(removal!.jobId))!).toMatchObject({ status: 'waiting', attempt: 1 });
    });
  });

  test('a finished run is left alone', async () => {
    await cancel();
    await h.settle();
    await expect(cancel()).resolves.toEqual({ cancelRequested: false });
  });

  test('unmonitoring every Unit a Grab covers cancels it', async () => {
    await h.admin.mutation(api.api.units.setMonitored, { target: { kind: 'units', unitIds: [(await h.unit(workId, 1, 1))._id] }, monitored: false });
    await h.settle();
    expect((await grab()).state).toBe('cancelled');
    expect((await h.unit(workId, 1, 1)).derivedState).toBe('notMonitored');
  });
});
