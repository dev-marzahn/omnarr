// Jellyfin for the admin: the setup's status, which the first run
// and the System page read, and the re-run behind `rerunJellyfinSetup`.
import { JellyfinStatus, PINNED_JELLYFIN, RerunSetupRequest, RerunSetupResponse, SetupStep, type SetupStepState } from '@omnarr/contracts';

import { components, internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import type { ActionCtx, QueryCtx } from '../_generated/server';
import { createAuth } from '../auth';
import { liveSetupJob, serverRow, stepOfProgress } from '../jellyfin/setup';
import { adminAction, adminQuery } from '../lib/functions';

/** The steps with the running setup job's progress (`detail = <step>:<state>`): the steps before the reported one have run. */
async function liveSteps(ctx: QueryCtx, row: Doc<'jellyfinServer'>): Promise<SetupStepState[]> {
  const job = await liveSetupJob(ctx);
  if (!job) return row.steps;
  const progress = await ctx.db
    .query('jobProgress')
    .withIndex('by_job', (q) => q.eq('jobId', job._id))
    .first();
  const step = stepOfProgress(progress?.detail);
  if (!step) return row.steps;
  const state = progress!.detail!.split(':')[1] === 'done' ? 'done' : 'pending';
  const at = SetupStep.options.indexOf(step);
  return SetupStep.options.map((name, i) => ({
    step: name,
    state: i < at ? 'done' : i === at ? state : 'pending',
    ...(i <= at ? { at: progress!.updatedAt } : {}),
  }));
}

/** Read through the database, so a query can build it; `system.status` carries it too. */
export async function jellyfinStatusOf(ctx: QueryCtx): Promise<JellyfinStatus> {
  const row = await serverRow(ctx);
  if (!row) return { state: 'notSetUp', steps: [], pinned: false, libraries: [] };
  const names: string[] = [];
  for (const { libraryId } of row.libraries) {
    const library = await ctx.db.get(libraryId);
    if (library) names.push(library.name);
  }
  return {
    state: row.state,
    steps: await liveSteps(ctx, row),
    ...(row.version ? { version: row.version } : {}),
    pinned: row.version === PINNED_JELLYFIN,
    libraries: names,
    ...(row.lastSetupAt ? { lastSetupAt: row.lastSetupAt } : {}),
  };
}

export const status = adminQuery({
  args: {},
  returns: JellyfinStatus,
  handler: (ctx) => jellyfinStatusOf(ctx),
});

/**
 * Checks the platform password by signing in, then revokes the session that
 * created. Better Auth 1.7 has no check that creates no session.
 */
async function passwordMatches(ctx: ActionCtx, username: string, password: string): Promise<boolean> {
  let token: string | undefined;
  try {
    token = (await createAuth(ctx).api.signInUsername({ body: { username, password } }))?.token;
  } catch {
    return false;
  }
  if (!token) return false;
  await ctx.runMutation(components.betterAuth.adapter.deleteOne, { input: { model: 'session', where: [{ field: 'token', value: token }] } } as never);
  return true;
}

/**
 * `rerunJellyfinSetup`'s dialog: the first run's password is gone, so
 * the admin enters it again. A wrong password or a setup job that is still
 * live enqueues nothing.
 */
export const rerunSetup = adminAction({
  args: RerunSetupRequest.shape,
  returns: RerunSetupResponse,
  handler: async (ctx, { password }): Promise<RerunSetupResponse> => {
    const username = ctx.user.username;
    if (!username || !(await passwordMatches(ctx, username, password))) return { error: 'wrongPassword' };
    const outcome = await ctx.runMutation(internal.jellyfin.setup.enqueueRerun, { userId: ctx.user.id, username, password });
    return outcome === 'alreadyRunning' ? { error: 'alreadyRunning' } : { ok: true };
  },
});
