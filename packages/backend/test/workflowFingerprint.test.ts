// The step list `pipelineRun` records, from a fake run of one episode, against
// the committed fingerprint. A change to the step list
// changes the hash. Before v1 that only needs the fixture updated; from v1
// on it needs a migration and a history in test/histories first.
import { expect, test } from 'vite-plus/test';

import { workflow } from '../convex/pipeline/workflow';
import fingerprint from './fixtures/pipelineRun.fingerprint.json';
import { E1, pipelineHarness } from './harness';

const h = pipelineHarness();

/** A step as replay matches it, with the job and download IDs in event names left out. */
const shape = (step: { kind: string; name: string }) => `${step.kind}:${step.name.replace(/^(job|download):.*/, '$1:*')}`;

async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
}

test("pipelineRun's step list matches the committed fingerprint", async () => {
  await h.indexer([E1]);
  await h.subscribe();
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
  const recorded = await h.t.run((ctx) => workflow.listSteps(ctx, grab!.workflowId!, { paginationOpts: { numItems: 100, cursor: null } }));
  const steps = recorded.page.map(shape);
  expect(steps, 'the step list changed: from v1 on, add a migration and a history, then update the fingerprint').toEqual(fingerprint.steps);
  expect(await sha256(JSON.stringify(steps))).toBe(fingerprint.sha256);
});
