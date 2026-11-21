// Jellyfin's setup in the backend: the one
// `jellyfinServer` row, the `setupJellyfin` job's start, result and failure,
// the block a publish can raise, and the worker's connection query.
import {
  type FailureCode,
  type FailureData,
  JellyfinConnection,
  JellyfinConnectionRequest,
  type JellyfinSetupReason,
  type JobResult,
  localeFields,
  type MaintenancePayload,
  SetupStep,
  type SetupStepState,
} from '@omnarr/contracts';
import { v } from 'convex/values';

import { components } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { internalMutation, type MutationCtx, type QueryCtx } from '../_generated/server';
import { enqueueJob, enqueuePasswordPushJob } from '../jobs/queue';
import { acceptedSession } from '../jobs/worker';
import { workerQuery } from '../lib/functions';
import { raiseIssue, resolveSystemIssue } from '../lib/issues';

type SetupPayload = Extract<MaintenancePayload, { action: 'setupJellyfin' }>;

export const FIRST_RUN_KEY = 'setupJellyfin:firstRun';

const pendingSteps = (): SetupStepState[] => SetupStep.options.map((step) => ({ step, state: 'pending' }));

export const isSetupJob = (job: Doc<'jobs'>): boolean =>
  job.class === 'maintenance' &&
  (job.payload ? job.payload.class === 'maintenance' && job.payload.action === 'setupJellyfin' : job.idempotencyKey.startsWith('setupJellyfin:'));

/**
 * A publish got 401 or 403 with the stored key, or 404 on the library item
 *: while Jellyfin is `ready`, publishing is blocked with one Issue.
 * Otherwise the job only waits.
 */
export async function blockFromPublish(ctx: MutationCtx, data: FailureData): Promise<void> {
  if (data.reason !== 'keyRejected' && data.reason !== 'libraryMissing') return;
  const row = await serverRow(ctx);
  if (row?.state === 'ready') await block(ctx, row, data.reason, undefined);
}

/** The `setupJellyfin` job that is queued, waiting or leased, if one is: two never run at once. */
export async function liveSetupJob(ctx: QueryCtx): Promise<Doc<'jobs'> | null> {
  const rows = await ctx.db
    .query('jobs')
    .withIndex('by_idempotency_key', (q) => q.gte('idempotencyKey', 'setupJellyfin:').lt('idempotencyKey', 'setupJellyfin;'))
    .collect();
  return rows.find((job) => job.status === 'queued' || job.status === 'waiting' || job.status === 'leased') ?? null;
}

export const serverRow = (ctx: QueryCtx): Promise<Doc<'jellyfinServer'> | null> => ctx.db.query('jellyfinServer').first();

/** The platform's libraries, as the setup creates them in Jellyfin. */
async function setupLibraries(ctx: QueryCtx): Promise<SetupPayload['libraries']> {
  const rows = await ctx.db.query('libraries').collect();
  return rows.map((row) => ({ libraryId: row._id, name: row.name, kind: row.kind, rootPath: row.rootPath }));
}

/** The rest of a setup payload: the remote-access setting (Jellyfin's default until it exists) and the tests' offline libraries. */
async function setupPayload(ctx: QueryCtx, mode: SetupPayload['mode'], admin: SetupPayload['admin'], locale: SetupPayload['locale']): Promise<SetupPayload> {
  return {
    class: 'maintenance',
    action: 'setupJellyfin',
    mode,
    admin,
    locale,
    libraries: await setupLibraries(ctx),
    remoteAccess: true,
    ...(process.env.JELLYFIN_OFFLINE_LIBRARIES ? { offline: true as const } : {}),
  };
}

async function userIdOf(ctx: MutationCtx, username: string): Promise<string> {
  const user = (await ctx.runQuery(components.betterAuth.adapter.findOne, {
    model: 'user',
    where: [{ field: 'username', value: username }],
  } as never)) as { _id: string } | null;
  if (!user) throw new Error(`startSetup: no platform user ${username}`);
  return user._id;
}

type SetupResult = Extract<JobResult, { class: 'maintenance'; action: 'setupJellyfin' }>;

/**
 * A completed `setupJellyfin`: the result goes into
 * `jellyfinServer` (a run that made no new key keeps the stored one), the
 * state is `ready`, `jellyfinSetupNeeded` resolves, and every `publish` job
 * waiting for setup is queued.
 */
export async function applySetupResult(ctx: MutationCtx, result: SetupResult): Promise<void> {
  const row = await serverRow(ctx);
  if (!row) return;
  await ctx.db.patch(row._id, {
    state: 'ready',
    serverId: result.serverId,
    version: result.version,
    adminUserId: result.adminUserId,
    ...(result.apiKey ? { apiKey: result.apiKey } : {}),
    libraries: result.libraries,
    steps: result.steps,
    lastSetupAt: Date.now(),
  });
  await resolveSystemIssue(ctx, 'jellyfinSetupNeeded');
  const waiting = await ctx.db
    .query('jobs')
    .withIndex('by_status_class', (q) => q.eq('status', 'waiting').eq('class', 'publish'))
    .filter((q) => q.eq(q.field('failureCode'), 'jellyfinSetupNeeded'))
    .collect();
  for (const job of waiting) await ctx.db.patch(job._id, { status: 'queued', availableAt: undefined });
}

const FAILURE_TEXT: Record<JellyfinSetupReason, string> = {
  setupFailed: "Jellyfin didn't answer or failed on every attempt. Check that its container runs, then re-run the setup.",
  credentialsNeeded:
    "Jellyfin refused the platform admin's password. If Jellyfin's config volume holds an admin with another password, remove Jellyfin's config volume and re-run the setup.",
  keyRejected: "Jellyfin refused the platform's API key. Re-run the setup to create a new one.",
  libraryMissing: "One of the platform's libraries is missing in Jellyfin. Re-run the setup to create it again.",
};

/** The setup's detail for an Issue: the step, the reason, and what to do. */
const blockedDetail = (reason: JellyfinSetupReason, step?: SetupStep) =>
  `${step ? `Jellyfin setup failed at step ${step}` : 'Jellyfin is blocked'} (${reason}). ${FAILURE_TEXT[reason]}`;

/** Blocks publishing: `blocked` and one `jellyfinSetupNeeded` Issue (blocked ⇔ an open Issue). */
async function block(ctx: MutationCtx, row: Doc<'jellyfinServer'>, reason: JellyfinSetupReason, step: SetupStep | undefined, jobId?: Id<'jobs'>) {
  await ctx.db.patch(row._id, { state: 'blocked' });
  await raiseIssue(ctx, { code: 'jellyfinSetupNeeded', detail: blockedDetail(reason, step), ...(jobId ? { jobId } : {}) });
}

/**
 * A terminal `setupJellyfin` failure: the failed step and its reason
 * go into `steps` (the steps before it ran, so they are done), Jellyfin is
 * `blocked`, and `jellyfinSetupNeeded` is raised. A retryable code that ran
 * out of attempts, an expired lease included, is `setupFailed`.
 */
export async function applySetupFailure(
  ctx: MutationCtx,
  job: Doc<'jobs'>,
  code: FailureCode,
  data: FailureData | undefined,
  lastStep: SetupStep | undefined,
): Promise<void> {
  const row = await serverRow(ctx);
  if (!row) return;
  const reason: JellyfinSetupReason = code === 'jellyfinSetupNeeded' && data ? data.reason : 'setupFailed';
  const step = data?.step ?? lastStep ?? 'reachable';
  const at = Date.now();
  const failedAt = SetupStep.options.indexOf(step);
  const steps = SetupStep.options.map((name, i): SetupStepState => {
    const before = row.steps.find((s) => s.step === name)?.at;
    if (i < failedAt) return { step: name, state: 'done', ...(before ? { at: before } : {}) };
    if (i === failedAt) return { step: name, state: 'failed', reason, at };
    return { step: name, state: 'pending' };
  });
  await ctx.db.patch(row._id, { steps });
  await block(ctx, row, reason, step, job._id);
}

/** The step a setup job last reported through `job.progress` (`detail = <step>:<state>`). */
export function stepOfProgress(detail: string | undefined): SetupStep | undefined {
  const parsed = SetupStep.safeParse(detail?.split(':')[0]);
  return parsed.success ? parsed.data : undefined;
}

/**
 * The worker's view of Jellyfin, which it subscribes to inside each
 * session. The one worker function that returns a secret, the API key
 *.
 */
export const connection = workerQuery({
  args: JellyfinConnectionRequest.shape,
  returns: JellyfinConnection.nullable(),
  handler: (ctx, { sessionId }) => connectionOf(ctx, sessionId),
});

/** What the worker's Jellyfin adapter needs: the session and the one server row are all it reads (queryCost.test.ts). */
export async function connectionOf(ctx: QueryCtx, sessionId: Id<'workerSessions'>) {
  await acceptedSession(ctx, sessionId);
  const row = await serverRow(ctx);
  if (!row) return null;
  return {
    state: row.state,
    ...(row.apiKey ? { apiKey: row.apiKey } : {}),
    ...(row.adminUserId ? { adminUserId: row.adminUserId } : {}),
    libraries: row.libraries,
  };
}

/**
 * The re-run's branch: when Jellyfin is `ready` and only the
 * password didn't reach it, a push through the ordered queue; otherwise
 * `setupJellyfin` in `rerun` mode with the stored locale. Nothing while a
 * setup job is live.
 */
export const enqueueRerun = internalMutation({
  args: { userId: v.string(), username: v.string(), password: v.string() },
  returns: v.union(v.literal('enqueued'), v.literal('alreadyRunning')),
  handler: async (ctx, { userId, username, password }) => {
    if (await liveSetupJob(ctx)) return 'alreadyRunning';
    const row = await serverRow(ctx);
    const notPushed = await ctx.db
      .query('issues')
      .withIndex('by_state_scope', (q) => q.eq('state', 'open').eq('scope', 'system'))
      .filter((q) => q.eq(q.field('failureCode'), 'jellyfinPasswordNotPushed'))
      .first();
    if (row?.state === 'ready' && notPushed) {
      await enqueuePasswordPushJob(ctx, { userId, username, newPassword: password });
      return 'enqueued';
    }
    const locale = row?.locale ?? localeFields('en-US');
    if (!row) await ctx.db.insert('jellyfinServer', { state: 'settingUp', steps: pendingSteps(), locale, libraries: [], ownerUserId: userId });
    // Each re-run is its own job, so an earlier one's key doesn't dedupe it away.
    await enqueueJob(ctx, { payload: await setupPayload(ctx, 'rerun', { username, password }, locale), idempotencyKey: `setupJellyfin:rerun:${Date.now()}` });
    return 'enqueued';
  },
});

/**
 * The first-run setup calls this right after it creates the admin, the one
 * moment the plaintext password exists. It inserts the row in
 * `settingUp` and enqueues `setupJellyfin` in `firstRun` mode; a second call
 * finds both and changes nothing.
 */
export const startSetup = internalMutation({
  args: { username: v.string(), password: v.string(), locale: v.string() },
  returns: v.null(),
  handler: async (ctx, args) => {
    await startJellyfinSetup(ctx, args);
    return null;
  },
});

/** `startSetup`'s body, which the first-run `createAdminRecord` calls in the admin's transaction. */
export async function startJellyfinSetup(
  ctx: MutationCtx,
  { username, password, locale: tag, userId }: { username: string; password: string; locale: string; userId?: string },
): Promise<void> {
  const existing = await serverRow(ctx);
  const locale = existing?.locale ?? localeFields(tag);
  if (!existing)
    await ctx.db.insert('jellyfinServer', {
      state: 'settingUp',
      steps: pendingSteps(),
      locale,
      libraries: [],
      ownerUserId: userId ?? (await userIdOf(ctx, username)),
    });
  await enqueueJob(ctx, { payload: await setupPayload(ctx, 'firstRun', { username, password }, locale), idempotencyKey: FIRST_RUN_KEY });
}
