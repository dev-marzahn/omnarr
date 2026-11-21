// Release 1 of the upgrade fixture: a run that records a step,
// then blocks on `awaitEvent`, as a Grab's run blocks on its download.
// Release 2 (../../upgrade-v2) adds a step before the wait, with a migration.
import { sendEvent, WorkflowManager, vWorkflowId } from '@dev-marzahn/convex-workflow-migrations';
import { v } from 'convex/values';

import { components, internal } from './_generated/api';
import { internalMutation, internalQuery } from './_generated/server';

export const workflow = new WorkflowManager(components.workflow, {
  migrationsComponent: components.workflowMigrations,
  onPause: (_ctx, info) => console.error(`paused (${info.reason}): ${info.detail}`),
});

export const first = internalMutation({ args: {}, returns: v.object({ release: v.number() }), handler: () => ({ release: 1 }) });

export const last = internalMutation({ args: {}, returns: v.object({ release: v.number() }), handler: () => ({ release: 1 }) });

export const run = workflow.define({
  args: {},
  migrations: [],
  returns: v.any(),
  handler: async (step): Promise<unknown> => {
    const started = await step.runMutation(internal.run.first, {});
    await step.awaitEvent({ name: 'go' });
    const ended = await step.runMutation(internal.run.last, {});
    return { started, ended };
  },
});

export const start = internalMutation({ args: {}, returns: v.string(), handler: (ctx): Promise<string> => workflow.start(ctx, internal.run.run, {}) });

export const send = internalMutation({
  args: { workflowId: vWorkflowId },
  returns: v.null(),
  handler: async (ctx, { workflowId }) => {
    await sendEvent(ctx, components.workflow, { workflowId, name: 'go', value: null });
    return null;
  },
});

export const status = internalQuery({
  args: { workflowId: vWorkflowId },
  returns: v.any(),
  handler: (ctx, { workflowId }) => workflow.status(ctx, workflowId),
});
