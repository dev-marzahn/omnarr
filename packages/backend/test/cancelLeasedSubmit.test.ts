import { DEFAULT_LIMITS, type LeasedJob } from '@omnarr/contracts';
import type { FakeItem } from '@omnarr/e2e/fakes/newznab';
import { beforeEach, describe, expect, test } from 'vite-plus/test';

import { api, components, internal } from '../convex/_generated/api';
import type { Doc, Id } from '../convex/_generated/dataModel';
import type { FakeWorker } from './fakeWorker';
import { E1_RELEASES, pipelineHarness, release } from './harness';

const HASH = 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a';
const E1_TORRENT: FakeItem = release('t1', 'Harbour.Lights.S01E01.1080p.WEB-DL.AAC2.0.H.264-GRPB', {
  torrent: { infoHash: HASH, seeders: 8, file: new Uint8Array([1]) },
});
const CONTENTION = 'Documents read from or written to the "workerSessions" table changed while this mutation was being run and on every subsequent retry.';

const h = pipelineHarness();
let w: FakeWorker;
let workId: Id<'works'>;
let submit: LeasedJob;
let grab: Doc<'grabs'>;

async function failRunNow(): Promise<Doc<'grabs'>> {
  const [running] = await h.all('grabs');
  await h.t.run(async (ctx) => {
    const { workflow } = await ctx.runQuery(components.workflow.workflow.getStatus, { workflowId: running!.workflowId! });
    await ctx.runMutation(components.workflow.workflow.complete, {
      workflowId: running!.workflowId!,
      generationNumber: workflow.generationNumber,
      runResult: { kind: 'failed', error: CONTENTION },
    });
  });
  return running!;
}

async function cancelWhileTheRestartWaits(): Promise<void> {
  workId = await h.subscribe();
  w = await h.worker();
  [submit] = (await w.claim('download.submit')) as [LeasedJob];
  grab = await failRunNow();
  expect(await h.get(grab._id)).toMatchObject({ state: 'submitting', runRestarts: 1 });
  await h.admin.mutation(api.api.units.cancelGrab, { grabId: grab._id });
  await h.settle();
}

const removals = async () =>
  (await h.all('jobs')).flatMap((job) => (job.payload?.class === 'maintenance' && job.payload.action === 'removeDownload' ? [job.payload] : []));
const openIssues = async () => (await h.all('issues')).filter((issue) => issue.state === 'open');
const releaseTitle = async () => (await h.get(grab.candidateId))!.title;
const downloadId = async () => (await h.all('downloads'))[0]!._id;
const fix = (issueId: Id<'issues'>) => h.admin.mutation(api.api.issues.act, { issueId, action: 'removeClientItem' });

async function clientRefusesEveryRemoval(): Promise<void> {
  for (let attempt = 0; attempt < DEFAULT_LIMITS.maxAttempts.maintenance; attempt++) {
    const [removal] = await w.claim('maintenance');
    await w.fail(removal!, 'clientUnreachable', 'The client did not answer.');
    await h.t.mutation(internal.jobs.queue.wake, { jobId: removal!.jobId });
  }
  await h.settle();
}

async function byTag() {
  return { downloadId: await downloadId(), clientKind: 'nzbget', releaseTitle: await releaseTitle(), deleteData: true, correlationTag: grab._id };
}

describe('a Usenet Grab cancelled while its failed run waits for a restart, with its submit leased', () => {
  beforeEach(async () => {
    await h.indexer(E1_RELEASES);
    await cancelWhileTheRestartWaits();
  });

  test('ends cancelled at once and frees its Unit, and the worker is asked to stop the submit', async () => {
    expect(await h.get(grab._id)).toMatchObject({ state: 'cancelled', cancelRequested: true });
    expect((await h.unit(workId, 1, 1)).activeGrabId).toBeUndefined();
    expect((await w.heartbeat()).cancelJobIds).toEqual([submit.jobId]);
  });

  test('a submit the worker stops is removed by its tag, with its data, since the client may already have it', async () => {
    await w.fail(submit, 'cancelled', 'Cancelled.');
    await h.settle();

    expect(await h.get(submit.jobId)).toMatchObject({ status: 'cancelled' });
    expect(await removals()).toEqual([{ class: 'maintenance', action: 'removeDownload', ...(await byTag()) }]);
  });

  test('a submit that fails ambiguously ends cancelled, is never retried, and is removed by its tag', async () => {
    await w.fail(submit, 'clientUnreachable', 'qBittorrent took the torrent but never listed it.');
    await h.settle();

    expect(await h.get(submit.jobId)).toMatchObject({ status: 'cancelled' });
    expect(await w.claim('download.submit')).toEqual([]);
    expect(await removals()).toEqual([expect.objectContaining(await byTag())]);
    expect(await openIssues()).toEqual([]);
  });

  test('a submit whose lease expires ends cancelled, is never claimed again, and is removed by its tag', async () => {
    await h.t.run((ctx) => ctx.db.patch(submit.jobId, { leaseExpiresAt: Date.now() - 1 }));
    await h.t.mutation(internal.jobs.queue.supervise, {});
    await h.settle();

    expect(await h.get(submit.jobId)).toMatchObject({ status: 'cancelled' });
    expect(await w.claim('download.submit')).toEqual([]);
    expect(await removals()).toEqual([expect.objectContaining(await byTag())]);
  });

  test('a submit the client accepted before the worker heard of the cancel is removed by its clientRef', async () => {
    await w.complete(submit, { class: 'download.submit', clientRef: 'nzb-late' });
    await h.settle();

    expect(await removals()).toEqual([expect.objectContaining({ clientKind: 'nzbget', clientRef: 'nzb-late', deleteData: true })]);
    expect(await h.get(grab._id)).toMatchObject({ state: 'cancelled' });
  });

  test('a removal by tag the client keeps refusing ends in an orphanClientItem Issue, whose fix asks the same again and keeps the release title', async () => {
    await w.fail(submit, 'cancelled', 'Cancelled.');
    await h.settle();
    await clientRefusesEveryRemoval();
    const item = { clientKind: 'nzbget', correlationTag: grab._id, name: await releaseTitle(), downloadId: await downloadId(), deleteData: true };
    const [issue] = await openIssues();
    expect(issue).toMatchObject({
      failureCode: 'orphanClientItem',
      orphanItems: [item],
      detail: `nzbget tagged ${grab._id}: ${await releaseTitle()}: the removal failed: The client did not answer.`,
    });

    await fix(issue!._id);
    expect((await removals()).at(-1)).toEqual({ class: 'maintenance', action: 'removeDownload', ...(await byTag()) });
    await clientRefusesEveryRemoval();
    expect(await openIssues()).toEqual([expect.objectContaining({ failureCode: 'orphanClientItem', orphanItems: [item] })]);
  });
});

describe('a removal that ends failed', () => {
  let removalOf: (deleteData: boolean) => Promise<void>;

  beforeEach(async () => {
    await h.indexer(E1_RELEASES);
    workId = await h.subscribe();
    w = await h.worker();
    await w.submitAll();
    await h.settle();
    grab = (await h.all('grabs'))[0]!;
    removalOf = async (deleteData) => {
      const download = (await h.all('downloads'))[0]!;
      await h.t.mutation(internal.jobs.queue.enqueue, {
        payload: { class: 'maintenance', action: 'removeDownload', downloadId: download._id, clientKind: 'nzbget', clientRef: download.clientRef!, deleteData },
        idempotencyKey: `removeDownload:${download._id}`,
        grabId: grab._id,
      });
    };
  });

  test('keeps its deleteData in the Issue and in the Issue’s fix', async () => {
    await removalOf(false);
    await clientRefusesEveryRemoval();
    const [issue] = await openIssues();
    expect(issue!.orphanItems).toEqual([expect.objectContaining({ deleteData: false, name: await releaseTitle() })]);

    await fix(issue!._id);
    expect((await removals()).at(-1)).toMatchObject({ deleteData: false });
  });

  test('of a deleted Work raises no orphanClientItem while its Download and kept Grab remain: the deleted Work’s sweep owns it', async () => {
    await removalOf(false);
    await h.t.run((ctx) => ctx.db.delete(workId));
    await clientRefusesEveryRemoval();

    expect(await openIssues()).toEqual([]);
  });
});

describe('a Work deleted while its Grab’s failed run waits for a restart, with the submit leased', () => {
  let title: string;
  let removedDownloadId: Id<'downloads'>;

  beforeEach(async () => {
    await h.indexer(E1_RELEASES);
    workId = await h.subscribe();
    w = await h.worker();
    [submit] = (await w.claim('download.submit')) as [LeasedJob];
    grab = await failRunNow();
    title = await releaseTitle();
    removedDownloadId = await downloadId();
    await h.admin.mutation(api.api.library.deleteWork, { workId, deleteFiles: false });
    await h.settle();
    expect(await h.get(grab._id)).toBeNull();
    expect(await h.get(removedDownloadId)).toBeNull();
  });

  const removal = (fields: object) => ({
    class: 'maintenance',
    action: 'removeDownload',
    downloadId: removedDownloadId,
    releaseTitle: title,
    deleteData: true,
    ...fields,
  });

  test('a submit the client accepts late is removed by its clientRef, though the Grab and Download rows are gone', async () => {
    await w.complete(submit, { class: 'download.submit', clientRef: 'nzb-late' });
    await h.settle();

    expect(await removals()).toEqual([removal({ clientKind: 'nzbget', clientRef: 'nzb-late' })]);
  });

  test('a submit the worker stops is removed by its tag, though the Grab and Download rows are gone', async () => {
    await w.fail(submit, 'cancelled', 'Cancelled.');
    await h.settle();

    expect(await removals()).toEqual([removal({ clientKind: 'nzbget', correlationTag: grab._id })]);
  });

  test('a submit that fails ambiguously ends cancelled, is never claimed again, and is removed by its tag, though its Grab is gone', async () => {
    await w.fail(submit, 'clientUnreachable', 'qBittorrent took the torrent but never listed it.');
    await h.settle();

    expect(await h.get(submit.jobId)).toMatchObject({ status: 'cancelled' });
    expect(await w.claim('download.submit')).toEqual([]);
    expect(await removals()).toEqual([removal({ clientKind: 'nzbget', correlationTag: grab._id })]);
  });

  test('a submit whose lease expires ends cancelled, is never claimed again, and is removed by its tag, though its Grab is gone', async () => {
    await h.t.run((ctx) => ctx.db.patch(submit.jobId, { leaseExpiresAt: Date.now() - 1 }));
    await h.t.mutation(internal.jobs.queue.supervise, {});
    await h.settle();

    expect(await w.claim('download.submit')).toEqual([]);
    expect(await removals()).toEqual([removal({ clientKind: 'nzbget', correlationTag: grab._id })]);
  });

  test('a removal of its rowless item that the client keeps refusing raises orphanClientItem under the release title', async () => {
    await w.complete(submit, { class: 'download.submit', clientRef: 'nzb-late' });
    await h.settle();
    await clientRefusesEveryRemoval();

    expect(await openIssues()).toEqual([
      expect.objectContaining({
        failureCode: 'orphanClientItem',
        orphanItems: [{ clientKind: 'nzbget', clientRef: 'nzb-late', name: title, downloadId: removedDownloadId, deleteData: true }],
      }),
    ]);
  });
});

describe('a torrent Grab cancelled while its failed run waits for a restart, with its submit leased', () => {
  beforeEach(async () => {
    await h.tracker([E1_TORRENT]);
    await cancelWhileTheRestartWaits();
    await w.complete(submit, { class: 'download.submit', clientRef: HASH });
    await h.settle();
  });

  test('the late torrent loses only this Grab’s tag, so another Grab sharing it keeps it', async () => {
    expect(await removals()).toEqual([expect.objectContaining({ clientKind: 'qbittorrent', clientRef: HASH, correlationTag: grab._id, deleteData: true })]);
  });

  test('a stuck removal’s Issue keeps the tag, so removing it from the Issue spares a sharing Grab too', async () => {
    await clientRefusesEveryRemoval();
    const [issue] = await openIssues();
    expect(issue).toMatchObject({
      failureCode: 'orphanClientItem',
      orphanItems: [expect.objectContaining({ clientKind: 'qbittorrent', clientRef: HASH, correlationTag: grab._id, name: await releaseTitle() })],
    });

    await fix(issue!._id);
    expect((await removals()).at(-1)).toMatchObject({ clientRef: HASH, correlationTag: grab._id, deleteData: true });
  });
});
