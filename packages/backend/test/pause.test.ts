// A run that can't replay pauses instead of failing. The
// pause is real: the run's record lists a migration the code doesn't have.
import { beforeEach, describe, expect, test } from 'vite-plus/test';

import { internal } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import type { FakeWorker } from './fakeWorker';
import { E1, pipelineHarness } from './harness';

const h = pipelineHarness();
let w: FakeWorker;
let workId: Id<'works'>;

beforeEach(async () => {
  await h.indexer([E1]);
  workId = await h.subscribe();
  w = await h.worker();
  await w.submitAll();
  await h.settle();
});

const grab = async () => (await h.all('grabs'))[0]!;

/** The download finishes, and the run's replay of it pauses. */
async function pause() {
  await h.breakReplay((await grab()).workflowId!);
  await w.completed(await h.activeDownload());
  await h.settle();
}

/** A published file of E1 from an earlier Grab, so the Unit is playable. */
async function playable() {
  const unitId = (await h.unit(workId, 1, 1))._id;
  await h.t.run(async (ctx) => {
    const library = (await ctx.db.query('libraries').first())!;
    const fileId = await ctx.db.insert('files', { path: '/data/library/series/old.mkv', sizeBytes: 1, inode: '1:9', origin: 'scan', role: 'source' });
    await ctx.db.insert('fileUnits', { fileId, unitId });
    const fileVersionId = await ctx.db.insert('fileVersions', { unitId, fileId, kind: 'primary', playbackProfileId: library.playbackProfileId, fits: true });
    const jobId = (await ctx.db.query('jobs').first())!._id;
    await ctx.db.insert('publications', { unitId, fileVersionId, jobId, generation: 0, target: 'jellyfin', state: 'visible' });
  });
}

describe('a paused run', () => {
  test('sets pausedAt and raises workflowPaused; with nothing playable the Unit is "failed", not a frozen stage', async () => {
    await pause();
    expect((await grab()).pausedAt).toEqual(expect.any(Number));
    const e1 = await h.unit(workId, 1, 1);
    expect(await h.all('issues')).toEqual([
      expect.objectContaining({
        unitId: e1._id,
        grabId: (await grab())._id,
        failureCode: 'workflowPaused',
        state: 'open',
        fixActions: ['resumeRun', 'cancelRun', 'dismiss'],
      }),
    ]);
    expect(e1.derivedState).toBe('failed');
  });

  test('a playable Unit keeps its playable state', async () => {
    await playable();
    await pause();
    expect((await h.unit(workId, 1, 1)).derivedState).toBe('ready');
  });

  test('supervision leaves a pause that is still there alone', async () => {
    await pause();
    await h.t.mutation(internal.jobs.queue.supervise, {});
    expect((await grab()).pausedAt).toEqual(expect.any(Number));
    expect((await h.all('issues'))[0]!.state).toBe('open');
  });

  test('once the pause has ended, supervision clears pausedAt, resolves the Issue and the Unit shows the run again', async () => {
    await pause();
    await h.fixReplay((await grab()).workflowId!);
    await h.t.mutation(internal.jobs.queue.supervise, {});

    expect((await grab()).pausedAt).toBeUndefined();
    expect((await h.all('issues'))[0]!.state).toBe('resolved');
    expect((await h.unit(workId, 1, 1)).derivedState).toBe('importing');
  });
});
