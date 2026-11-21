// Hand-built histories of `pipelineRun`: one for each wait point of
// each step list. Users' installations can't be exported, so these stand in
// for the runs a release may find in flight. Append a step list's histories
// when it changes (with its migration); never edit a released one.
//
// The step list before v1 is the current one; an earlier one-step list was
// never released (`pipelineRun` changes freely until v1 is tagged).
import { history, type RecordedHistory } from '@dev-marzahn/convex-workflow-migrations/replay';

import { internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';

const grabId = 'grab1' as Id<'grabs'>;
const args = { grabId };
const steps = internal.pipeline.steps;
const done = (jobId: string) => ({ outcome: 'done', jobId });

const submitted = { step: steps.submitDownload, args, result: { jobId: 'job1', downloadId: 'dl1' } };
const submitEvent = { event: 'job:job1', result: done('job1') };
const downloadEvent = { event: 'download:dl1', result: done('job1') };
const importStarted = { step: steps.startImport, args, result: { jobId: 'job2' } };
const importEvent = { event: 'job:job2', result: done('job2') };
const publishStarted = { step: steps.startPublish, args, result: { jobId: 'job3' } };
const publishEvent = { event: 'job:job3', result: done('job3') };

const of = (list: Parameters<typeof history>[0]) => history(list, { args, applied: [] });

/** Release 1 (v1's step list), at each place a run can wait. */
export const RELEASE_1: Record<string, RecordedHistory> = {
  submitting: of([{ step: steps.submitDownload, args, status: 'running' }]),
  awaitingSubmit: of([submitted, { event: 'job:job1', status: 'running' }]),
  awaitingDownload: of([submitted, submitEvent, { event: 'download:dl1', status: 'running' }]),
  startingImport: of([submitted, submitEvent, downloadEvent, { step: steps.startImport, args, status: 'running' }]),
  awaitingImport: of([submitted, submitEvent, downloadEvent, importStarted, { event: 'job:job2', status: 'running' }]),
  awaitingPublish: of([submitted, submitEvent, downloadEvent, importStarted, importEvent, publishStarted, { event: 'job:job3', status: 'running' }]),
  finishing: of([
    submitted,
    submitEvent,
    downloadEvent,
    importStarted,
    importEvent,
    publishStarted,
    publishEvent,
    { step: steps.finish, args, status: 'running' },
  ]),
  done: of([submitted, submitEvent, downloadEvent, importStarted, importEvent, publishStarted, publishEvent, { step: steps.finish, args }]),
  downloadFailed: of([submitted, submitEvent, { event: 'download:dl1', result: { outcome: 'failed', jobId: 'job1', failureCode: 'missingArticles' } }]),
  importCancelled: of([submitted, submitEvent, downloadEvent, importStarted, { event: 'job:job2', result: { outcome: 'cancelled', jobId: 'job2' } }]),
};
