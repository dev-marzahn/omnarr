// The Grab run: one run per Grab. Each worker step is a
// mutation that enqueues a job, followed by `awaitEvent` for that job's
// event; the download's completion is its own event, since `download.submit`
// finishes once the client accepts the item. A `failed` or `cancelled` value
// ends the run with a PipelineRunResult that `grabs.onRunComplete` classifies.
import { WorkflowManager } from '@dev-marzahn/convex-workflow-migrations';
import { downloadEventName, jobEventName, type JobEventValue, PipelineRunResult } from '@omnarr/contracts';
import { zodToConvex } from 'convex-helpers/server/zod4';
import { v } from 'convex/values';

import { components, internal } from '../_generated/api';
import type { MutationCtx } from '../_generated/server';
import { onRunPaused } from './grabs';

export const workflow = new WorkflowManager(components.workflow, {
  migrationsComponent: components.workflowMigrations,
  onPause: (ctx, info) => onRunPaused(ctx as unknown as MutationCtx, info),
});

const ended = (event: JobEventValue, stage: PipelineRunResult['stage']): PipelineRunResult => ({
  outcome: event.outcome,
  stage,
  jobId: event.jobId,
  ...(event.failureCode ? { failureCode: event.failureCode } : {}),
});

/** Permanent name: runs in flight replay against it. */
export const pipelineRun = workflow.define({
  args: { grabId: v.id('grabs') },
  migrations: [],
  returns: zodToConvex(PipelineRunResult),
  handler: async (step, { grabId }): Promise<PipelineRunResult> => {
    const { jobId: submitJob, downloadId } = await step.runMutation(internal.pipeline.steps.submitDownload, { grabId });
    const submitted = await step.awaitEvent<JobEventValue>({ name: jobEventName(submitJob) });
    if (submitted.outcome !== 'done') return ended(submitted, 'download');
    const downloaded = await step.awaitEvent<JobEventValue>({ name: downloadEventName(downloadId) });
    if (downloaded.outcome !== 'done') return ended(downloaded, 'download');

    const { jobId: importJob } = await step.runMutation(internal.pipeline.steps.startImport, { grabId });
    const imported = await step.awaitEvent<JobEventValue>({ name: jobEventName(importJob) });
    if (imported.outcome !== 'done') return ended(imported, 'import');

    const { jobId: publishJob } = await step.runMutation(internal.pipeline.steps.startPublish, { grabId });
    const published = await step.awaitEvent<JobEventValue>({ name: jobEventName(publishJob) });
    if (published.outcome !== 'done') return ended(published, 'publish');

    await step.runMutation(internal.pipeline.steps.finish, { grabId });
    return { outcome: 'done', stage: 'finish' };
  },
});
