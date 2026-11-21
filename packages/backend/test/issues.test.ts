// The Issues page: `issues.list` with its "Needs action" / "In progress"
// split, `issues.counts` for the sidebar badge, and `issues.act`, which runs
// every fix action but the client ones.
import { DEFAULT_LIMITS, type LeasedJob } from '@omnarr/contracts';
import { beforeEach, describe, expect, test } from 'vite-plus/test';

import { api, internal } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import { raiseIssue } from '../convex/lib/issues';
import type { FakeWorker } from './fakeWorker';
import { E1, E1_RELEASES, pipelineHarness } from './harness';
import { worker } from './setup';

const h = pipelineHarness();
let w: FakeWorker;
let workId: Id<'works'>;

beforeEach(async () => {
  await h.indexer(E1_RELEASES);
  workId = await h.subscribe();
  w = await h.worker();
});

const list = () => h.admin.query(api.api.issues.list, {});
const counts = () => h.admin.query(api.api.issues.counts, {});
const act = (issueId: Id<'issues'>, action: Parameters<typeof h.admin.mutation<typeof api.api.issues.act>>[1]['action']) =>
  h.admin.mutation(api.api.issues.act, { issueId, action });
const openIssue = async () => (await h.all('issues')).find((issue) => issue.state === 'open')!;

/** The Unit's current Grab is submitted, then its download fails repair. */
async function failCurrent(code: 'missingArticles' | 'parFailed' = 'missingArticles') {
  await w.submitAll();
  await h.settle();
  await w.failed(await h.activeDownload(), code);
  await h.settle();
}

/** Three releases in a row fail: the third is raised. */
async function badReleaseAtLimit() {
  for (let n = 0; n < DEFAULT_LIMITS.badReleaseGrabs; n++) await failCurrent();
  return openIssue();
}

/** The Unit's current Grab runs to a published file. */
async function succeed() {
  await w.submitAll();
  await h.settle();
  await w.completed(await h.activeDownload());
  await h.settle();
  await w.importAll();
  await h.settle();
  await w.publishAll();
  await h.settle();
}

describe('issues.list and issues.counts', () => {
  test('a raised bad release is listed under Needs action with its Unit, and counted for the badge', async () => {
    const issue = await badReleaseAtLimit();
    const e1 = await h.unit(workId, 1, 1);

    const { needsAction, inProgress, system, resolved } = await list();
    expect(needsAction).toEqual([
      expect.objectContaining({
        issueId: issue._id,
        scope: 'unit',
        failureCode: 'missingArticles',
        class: 'badRelease',
        state: 'open',
        fixActions: ['tryNextBest', 'searchAndPick', 'retryRelease', 'blocklistRemove', 'dismiss'],
        unit: expect.objectContaining({ unitId: e1._id, workId, workTitle: 'Harbour Lights', workKind: 'series', tmdbSeason: 1, tmdbEpisode: 1 }),
        raisedAt: expect.any(Number),
      }),
    ]);
    expect([inProgress, system, resolved]).toEqual([[], [], []]);
    expect(await counts()).toEqual({ needsAction: 1, inProgress: 0, system: 0 });
  });

  test('a system Issue is listed under System only', async () => {
    await h.t.run((ctx) => raiseIssue(ctx, { code: 'diskFull', detail: 'Importing needs 4.2 GB; 1.1 GB is free.' }));
    const { needsAction, system } = await list();
    expect(needsAction).toEqual([]);
    expect(system).toEqual([
      expect.objectContaining({ scope: 'system', failureCode: 'diskFull', fixActions: ['retryNow'], detail: expect.stringContaining('4.2 GB') }),
    ]);
    expect(await counts()).toEqual({ needsAction: 0, inProgress: 0, system: 1 });
  });

  test('a fix that is running moves its Issue to In progress with the stage; the run succeeding resolves it', async () => {
    const issue = await badReleaseAtLimit();
    await act(issue._id, 'tryNextBest');

    // The next-best search is running: nothing to click until it ends.
    expect((await list()).inProgress).toEqual([expect.objectContaining({ issueId: issue._id, inProgress: expect.objectContaining({ stage: 'searching' }) })]);
    await h.settle();
    const grab = (await h.all('grabs')).at(-1)!;
    expect((await list()).inProgress).toEqual([expect.objectContaining({ inProgress: { grabId: grab._id, stage: 'grabbed' } })]);
    expect(await counts()).toEqual({ needsAction: 0, inProgress: 1, system: 0 });

    await succeed();
    const after = await list();
    expect([after.needsAction, after.inProgress]).toEqual([[], []]);
    expect(after.resolved).toEqual([expect.objectContaining({ issueId: issue._id, state: 'resolved', resolvedAt: expect.any(Number) })]);
  });

  test('a paused run is not running: its workflowPaused Issue needs action', async () => {
    const grab = (await h.all('grabs'))[0]!;
    await h.breakReplay(grab.workflowId!);
    await w.submitAll();
    await h.settle();
    expect((await list()).needsAction).toEqual([
      expect.objectContaining({ failureCode: 'workflowPaused', grabId: grab._id, fixActions: ['resumeRun', 'cancelRun', 'dismiss'] }),
    ]);
  });
});

describe('issues.act: the fix actions', () => {
  test('tryNextBest starts a fresh next-best search for the Unit, which grabs the next release in a new run', async () => {
    const issue = await badReleaseAtLimit();
    expect(await act(issue._id, 'tryNextBest')).toEqual({ outcome: 'done' });
    await h.settle();

    const attempts = await h.all('searchAttempts');
    expect(attempts.at(-1)).toMatchObject({ trigger: 'nextBest', unitIds: [issue.unitId] });
    expect((await h.all('grabs')).at(-1)).toMatchObject({ state: 'submitting' });
    expect((await h.unit(workId, 1, 1)).derivedState).toBe('grabbed');
  });

  test('retryRelease removes the release from the blocklist and grabs it again in a new run', async () => {
    const issue = await badReleaseAtLimit();
    const failedGrab = (await h.get(issue.grabId!))!;
    await act(issue._id, 'retryRelease');

    const grabs = await h.all('grabs');
    expect(grabs.at(-1)).toMatchObject({ candidateId: failedGrab.candidateId, state: 'submitting' });
    expect(grabs.at(-1)!._id).not.toBe(failedGrab._id);
    expect((await h.all('blocklist')).map((row) => row.grabId)).not.toContain(failedGrab._id);
  });

  test('blocklistRemove removes the entry only: no Grab starts and the Issue stays open', async () => {
    const issue = await badReleaseAtLimit();
    const before = (await h.all('grabs')).length;
    await act(issue._id, 'blocklistRemove');

    expect((await h.all('blocklist')).map((row) => row.grabId)).not.toContain(issue.grabId);
    expect(await h.all('grabs')).toHaveLength(before);
    expect((await h.get(issue._id))!.state).toBe('open');
    // Nothing left to unblock, so the action isn't offered again.
    expect((await list()).needsAction[0]!.fixActions).toEqual(['tryNextBest', 'searchAndPick', 'retryRelease', 'dismiss']);
  });

  test('dismiss moves a unit-scope Issue to Resolved & dismissed; a system Issue that resolves itself refuses it', async () => {
    const issue = await badReleaseAtLimit();
    await act(issue._id, 'dismiss');
    expect((await list()).resolved).toEqual([expect.objectContaining({ issueId: issue._id, state: 'dismissed' })]);

    const diskFull = await h.t.run((ctx) => raiseIssue(ctx, { code: 'diskFull' }));
    await expect(act(diskFull, 'dismiss')).rejects.toThrow(/doesn't offer dismiss/);
  });

  test('an action the Issue does not offer is refused', async () => {
    const issue = await badReleaseAtLimit();
    await expect(act(issue._id, 'resumeRun')).rejects.toThrow(/doesn't offer/);
  });

  test('retryNow on a transient failure that ended its run grabs the same release again', async () => {
    for (let attempt = 0; attempt < DEFAULT_LIMITS.maxAttempts['download.submit']; attempt++) {
      const [job] = await w.claim('download.submit');
      await w.fail(job!, 'clientUnreachable');
      await h.t.mutation(internal.jobs.queue.wake, { jobId: job!.jobId });
    }
    await h.settle();
    const issue = await openIssue();
    expect(issue.failureCode).toBe('clientUnreachable');
    const failedGrab = (await h.all('grabs'))[0]!;

    await act(issue._id, 'retryNow');
    const grabs = await h.all('grabs');
    expect(grabs).toHaveLength(2);
    expect(grabs[1]).toMatchObject({ candidateId: failedGrab.candidateId, state: 'submitting' });
    expect((await list()).inProgress).toEqual([expect.objectContaining({ issueId: issue._id })]);
  });

  test('retryNow on jellyfinUnavailable publishes the recorded file again; the publish resolves the Issue', async () => {
    await w.submitAll();
    await h.settle();
    await w.completed(await h.activeDownload());
    await h.settle();
    await w.importAll();
    await h.settle();
    for (let attempt = 0; attempt < DEFAULT_LIMITS.maxAttempts.publish; attempt++) {
      const [job] = await w.claim('publish');
      await w.fail(job!, 'jellyfinUnavailable');
      await h.t.mutation(internal.jobs.queue.wake, { jobId: job!.jobId });
    }
    await h.settle();
    const issue = await openIssue();
    expect(issue.failureCode).toBe('jellyfinUnavailable');

    await act(issue._id, 'retryNow');
    expect((await h.all('publications'))[0]).toMatchObject({ state: 'pending', generation: 1 });
    await w.publishAll();
    await h.settle();
    expect((await h.get(issue._id))!.state).toBe('resolved');
    expect((await h.all('publications'))[0]!.state).toBe('visible');
  });

  test('retryNow on diskFull wakes the jobs waiting for space at once', async () => {
    const [job] = await w.claim('download.submit');
    await w.fail(job!, 'diskFull', 'Needs 2 GB; 1 GB free.');
    expect((await h.get(job!.jobId))!.status).toBe('waiting');
    const issue = await openIssue();

    await act(issue._id, 'retryNow');
    expect((await h.get(job!.jobId))!).toMatchObject({ status: 'queued' });
    expect(await w.claim('download.submit')).toHaveLength(1);
  });

  test('resumeRun replays a paused run; cancelRun ends it cancelled and resolves the Issue', async () => {
    const grab = (await h.all('grabs'))[0]!;
    await h.breakReplay(grab.workflowId!);
    await w.submitAll();
    await h.settle();
    const issue = await openIssue();
    expect(issue.failureCode).toBe('workflowPaused');

    // Still broken: it pauses again and stays open.
    expect(await act(issue._id, 'resumeRun')).toEqual({ outcome: 'done' });
    await h.settle();
    expect((await h.get(issue._id))!.state).toBe('open');

    await act(issue._id, 'cancelRun');
    await h.settle();
    expect((await h.get(grab._id))!.state).toBe('cancelled');
    expect((await h.get(issue._id))!.state).toBe('resolved');
  });

  test('removeClientItem removes every orphan item the Issue names from its client, with its data', async () => {
    await h.t.mutation(api.jobs.downloads.orphans, {
      ...worker,
      sessionId: w.sessionId,
      items: [{ clientKind: 'nzbget', clientRef: '41', name: 'Stray.Show.S01E01', correlationTag: 'unknown-tag' }],
    });
    const issue = await openIssue();
    expect(issue.failureCode).toBe('orphanClientItem');

    await act(issue._id, 'removeClientItem');
    const removal = (await h.all('jobs')).find((job) => job.payload?.class === 'maintenance' && job.payload.action === 'removeDownload');
    // A tag only matters to a torrent shared between Grabs.
    expect(removal!.payload).toEqual({ class: 'maintenance', action: 'removeDownload', clientKind: 'nzbget', clientRef: '41', deleteData: true });
    expect((await h.get(issue._id))!.state).toBe('resolved');
  });
});

describe('the fixes a playable Unit gets', () => {
  /** E1 imported and published, then its preparation fails twice. */
  async function transcodeFailed(): Promise<{ issueId: Id<'issues'>; job: LeasedJob }> {
    await succeed();
    let last: LeasedJob | undefined;
    for (let attempt = 0; attempt < DEFAULT_LIMITS.maxAttempts.prepare; attempt++) {
      const [job] = await w.claim('prepare');
      last = job!;
      await w.fail(job!, 'transcodeFailed', 'ffmpeg exited with code 1.');
      await h.t.mutation(internal.jobs.queue.wake, { jobId: job!.jobId });
    }
    await h.settle();
    return { issueId: (await openIssue())._id, job: last! };
  }

  test('transcodeFailed on a playable Unit offers Retry preparation and a new release, which is an upgrade', async () => {
    const { issueId } = await transcodeFailed();
    const [row] = (await list()).needsAction;
    expect(row).toMatchObject({ issueId, failureCode: 'transcodeFailed', fixActions: ['retryPreparation', 'searchAndPick', 'tryNextBest', 'dismiss'] });
  });

  test('retryPreparation starts a retry Rendition; the Issue is In progress while it is pending', async () => {
    const { issueId } = await transcodeFailed();
    await act(issueId, 'retryPreparation');
    expect((await h.all('renditions')).at(-1)).toMatchObject({ reason: 'retry', state: 'pending' });
    expect((await list()).inProgress).toEqual([expect.objectContaining({ issueId, inProgress: expect.objectContaining({ stage: 'preparing' }) })]);
  });

  test('downloadLog returns the stored ffmpeg log', async () => {
    const { issueId, job } = await transcodeFailed();
    const storageId = await h.t.run((ctx) => ctx.storage.store(new Blob(['ffmpeg: exit 1'])));
    await h.t.run((ctx) => ctx.db.patch(job.jobId, { artifactStorageId: storageId }));
    await h.t.run(async (ctx) => {
      const issue = (await ctx.db.get(issueId))!;
      await ctx.db.patch(issueId, { jobId: issue.jobId ?? job.jobId });
    });
    expect((await list()).needsAction[0]!.fixActions).toEqual(['retryPreparation', 'searchAndPick', 'tryNextBest', 'downloadLog', 'dismiss']);
    expect(await act(issueId, 'downloadLog')).toEqual({ outcome: 'url', url: expect.stringContaining('/api/storage/') });
  });
});

test('the release a failed Grab came from is shown on the row', async () => {
  const issue = await badReleaseAtLimit();
  const [row] = (await list()).needsAction;
  expect(row).toMatchObject({ issueId: issue._id, release: E1_RELEASES[2]!.title });
  expect(E1.title).not.toBe(row!.release);
});
