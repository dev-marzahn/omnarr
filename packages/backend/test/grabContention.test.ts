// A Grab run under contention. The workflow component never retries a
// mutation, so a step that runs out of Convex's conflict retries fails the
// whole run. Here `startPublish` fails as such a step does (it throws, and
// its writes roll back); onRunComplete restarts the run from that step after
// a backoff, capped by DEFAULT_LIMITS.runRestarts, and past the cap raises
// `pipelineError` with the error as its detail.

// steps.ts loads first: jobs/queue -> pipeline/grabs -> pipeline/steps is a cycle, and a
// steps.ts first loaded by the mock's importOriginal would bind the real enqueueJob.
import '../convex/pipeline/steps';
import { DEFAULT_LIMITS } from '@omnarr/contracts';
import { beforeEach, describe, expect, test, vi } from 'vite-plus/test';

// Fault injection: no outside input makes a mutation run out of conflict retries, so the publish step throws as one does.
const { contention, OCC } = vi.hoisted(() => ({
  contention: { publishFailures: 0 },
  OCC: 'Documents read from or written to the "workerSessions" table changed while this mutation was being run and on every subsequent retry.',
}));

vi.mock('../convex/jobs/queue', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../convex/jobs/queue')>();
  return {
    ...actual,
    enqueueJob: (...args: Parameters<typeof actual.enqueueJob>) => {
      if (args[1].payload.class === 'publish' && contention.publishFailures > 0) {
        contention.publishFailures--;
        throw new Error(OCC);
      }
      return actual.enqueueJob(...args);
    },
  };
});

import { api, components } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import type { FakeWorker } from './fakeWorker';
import { E1_RELEASES, pipelineHarness } from './harness';

const h = pipelineHarness();
let w: FakeWorker;
let workId: Id<'works'>;

beforeEach(async () => {
  contention.publishFailures = 0;
  await h.indexer(E1_RELEASES);
  workId = await h.subscribe();
  w = await h.worker();
});

/** Downloads and imports the run's release; the run then starts its publish step. */
async function throughImport() {
  await w.submitAll();
  await h.settle();
  await w.completed(await h.activeDownload());
  await h.settle();
  await w.importAll();
  await h.settle();
}

/** Ends the run as failed where it waits, as the component does when a step ran out of retries; onRunComplete then schedules the restart. */
async function failRunNow(error: string) {
  const [grab] = await h.all('grabs');
  await h.t.run(async (ctx) => {
    const { workflow } = await ctx.runQuery(components.workflow.workflow.getStatus, { workflowId: grab!.workflowId! });
    await ctx.runMutation(components.workflow.workflow.complete, {
      workflowId: grab!.workflowId!,
      generationNumber: workflow.generationNumber,
      runResult: { kind: 'failed', error },
    });
  });
  return grab!;
}

const jobsOf = async (cls: string) => (await h.all('jobs')).filter((job) => job.class === cls);
const openIssues = async () => (await h.all('issues')).filter((issue) => issue.state === 'open');

describe('a run whose step runs out of conflict retries', () => {
  test('restarts from that step after a backoff and publishes, without a second download, import or publish', async () => {
    contention.publishFailures = 1;
    await throughImport();

    const [grab] = await h.all('grabs');
    expect(grab).toMatchObject({ state: 'publishing', runRestarts: 1 });
    expect(await openIssues()).toEqual([]);
    expect((await h.all('events')).filter((event) => event.grabId === grab!._id && event.kind === 'retry')).toEqual([
      expect.objectContaining({
        stage: 'grab',
        message: `The run failed: ${OCC}. Running the failed step again in ${DEFAULT_LIMITS.runRestartBackoffMs / 1000} s (1 of ${DEFAULT_LIMITS.runRestarts}).`,
      }),
    ]);

    await w.publishAll();
    await h.settle();
    expect((await h.get(grab!._id))!.state).toBe('done');
    expect(await h.all('downloads')).toHaveLength(1);
    expect(await h.all('importJobs')).toHaveLength(1);
    // The failed attempt's Publication rolled back with it.
    expect(await h.all('publications')).toHaveLength(1);
    expect(await jobsOf('publish')).toHaveLength(1);
    expect((await h.unit(workId, 1, 1)).activeGrabId).toBeUndefined();
  });

  test('past its restarts fails with pipelineError carrying the error', async () => {
    contention.publishFailures = DEFAULT_LIMITS.runRestarts + 1;
    await throughImport();

    const [grab] = await h.all('grabs');
    expect(grab).toMatchObject({ state: 'failed', failureCode: 'pipelineError', runRestarts: DEFAULT_LIMITS.runRestarts });
    expect(await openIssues()).toEqual([expect.objectContaining({ failureCode: 'pipelineError', grabId: grab!._id, detail: `The run failed: ${OCC}` })]);
    expect(await h.all('downloads')).toHaveLength(1);
    expect(await h.all('importJobs')).toHaveLength(1);
    expect(await jobsOf('publish')).toHaveLength(0);
    expect((await h.unit(workId, 1, 1)).activeGrabId).toBeUndefined();
  });

  test('a restart the migrations package refuses fails the Grab with the run error and frees its Unit', async () => {
    const [grab] = await h.all('grabs');
    // A record whose migrations edited the history (its args, unchanged here): restart({ from }) throws for it.
    await h.t.run((ctx) =>
      ctx.runMutation(components.workflowMigrations.runs.save, {
        workflowId: grab!.workflowId!,
        applied: [],
        overlay: [{ op: 'workflowArgs', args: { grabId: grab!._id } }],
      }),
    );
    contention.publishFailures = 1;
    await throughImport();

    expect(await h.get(grab!._id)).toMatchObject({ state: 'failed', failureCode: 'pipelineError', runRestarts: 1 });
    expect(await openIssues()).toEqual([expect.objectContaining({ failureCode: 'pipelineError', detail: `The run failed: ${OCC}` })]);
    expect((await h.unit(workId, 1, 1)).activeGrabId).toBeUndefined();
  });

  test('a cancel while the restart waits cancels the queued job, ends the Grab, and the restart does nothing', async () => {
    // The run failed after submitDownload: its download.submit job is queued, and no worker has it.
    const grab = await failRunNow(OCC);
    expect(await h.get(grab._id)).toMatchObject({ runRestarts: 1 });
    expect((await jobsOf('download.submit')).map((job) => job.status)).toEqual(['queued']);
    await h.admin.mutation(api.api.units.cancelGrab, { grabId: grab._id, blocklist: true });
    await h.settle();

    expect(await h.get(grab._id)).toMatchObject({ state: 'cancelled', cancelRequested: true, cancelBlocklist: true });
    expect((await jobsOf('download.submit')).map((job) => job.status)).toEqual(['cancelled']);
    expect(await w.claim('download.submit')).toEqual([]);
    expect(await h.all('blocklist')).toHaveLength(1);
    expect(await openIssues()).toEqual([]);
    expect(await h.all('downloads')).toHaveLength(1);
    expect((await h.unit(workId, 1, 1)).activeGrabId).toBeUndefined();
  });
});

test("a job's pipelineError carries the job's last error", async () => {
  await w.submitAll();
  await h.settle();
  await w.completed(await h.activeDownload());
  await h.settle();
  const [job] = await w.claim('import');
  await w.fail(job!, 'pipelineError', 'The staging folder could not be created.');
  await h.settle();

  expect(await openIssues()).toEqual([expect.objectContaining({ failureCode: 'pipelineError', detail: 'The staging folder could not be created.' })]);
});
