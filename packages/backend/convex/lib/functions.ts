// The wrappers every public function is built from: the
// four, plus `adminAction` for admin calls that need HTTP (metadata and indexers).
// Each checks the caller, takes Zod schemas from @omnarr/contracts for `args`
// and `returns`, requires `returns`, and marks the function with `__wrapped`
// for api.test.ts.
import { PROTOCOL_VERSION, WorkerCall, type WorkerErrorCode } from '@omnarr/contracts';
import { zCustomAction, zCustomMutation, zCustomQuery, zodToConvexFields } from 'convex-helpers/server/zod4';
import { ConvexError } from 'convex/values';

import { internal } from '../_generated/api';
import { action, mutation, query } from '../_generated/server';
import { authComponent } from '../auth';

export type WrapperKind = 'adminQuery' | 'adminMutation' | 'adminAction' | 'workerQuery' | 'workerMutation' | 'setupQuery' | 'setupAction';

/** Thrown to a caller the wrappers turn away, or by worker functions (`WorkerErrorCode`). */
export const workerError = (code: WorkerErrorCode, extra: Record<string, string | number> = {}) => new ConvexError({ code, ...extra });

/**
 * Compares two strings in time that depends only on `expected`'s length, so a
 * caller can't find the token one character at a time.
 */
export function constantTimeEqual(actual: string, expected: string): boolean {
  let diff = actual.length ^ expected.length;
  // charCodeAt past the end is NaN, which `|` treats as 0.
  for (let i = 0; i < expected.length; i++) diff |= actual.charCodeAt(i) ^ expected.charCodeAt(i);
  return diff === 0 && expected.length > 0;
}

/** Extra options a worker function can declare next to `args`, `returns` and `handler`. */
type WorkerExtra = {
  /** Only `worker.connect`: it answers a version mismatch instead of throwing. */
  acceptAnyProtocolVersion?: boolean;
};

const checkWorker = ({ workerToken, protocolVersion }: WorkerCall, extra: WorkerExtra) => {
  const expected = process.env.WORKER_TOKEN;
  if (!expected || !constantTimeEqual(workerToken, expected)) throw workerError('unauthorized');
  if (!extra.acceptAnyProtocolVersion && protocolVersion !== PROTOCOL_VERSION) {
    throw workerError('protocolMismatch', { expectedVersion: PROTOCOL_VERSION });
  }
  return { ctx: { worker: { protocolVersion } }, args: {} };
};

const workerArgs = zodToConvexFields(WorkerCall.shape);

const checkAdmin = async (ctx: Parameters<typeof authComponent.safeGetAuthUser>[0]) => {
  const user = await authComponent.safeGetAuthUser(ctx);
  if (!user || user.role !== 'admin' || user.banned) throw new ConvexError({ code: 'unauthorized' });
  return { ctx: { user: { id: user._id, username: user.username ?? null } }, args: {} };
};

const rawAdminQuery = zCustomQuery(query, { args: {}, input: checkAdmin });
const rawAdminMutation = zCustomMutation(mutation, { args: {}, input: checkAdmin });
const rawAdminAction = zCustomAction(action, { args: {}, input: checkAdmin });
const rawWorkerQuery = zCustomQuery(query, { args: workerArgs, input: (_ctx, args, extra: WorkerExtra) => checkWorker(args, extra) });
const rawWorkerMutation = zCustomMutation(mutation, { args: workerArgs, input: (_ctx, args, extra: WorkerExtra) => checkWorker(args, extra) });

/**
 * Wraps a builder so that a definition without `returns` fails when the
 * module loads (so the push fails), and the result carries the marker.
 */
function marked<Builder extends (definition: never) => object>(kind: WrapperKind, builder: Builder): Builder {
  const wrapped = (definition: { returns?: unknown }) => {
    if (definition.returns === undefined) throw new Error(`${kind}: every public function declares a returns schema`);
    return Object.assign(builder(definition as never), { __wrapped: kind });
  };
  return wrapped as unknown as Builder;
}

export const adminQuery = marked('adminQuery', rawAdminQuery);
export const adminMutation = marked('adminMutation', rawAdminMutation);
/** For admin calls that make an outside HTTP request: metadata (TMDB) and indexers. */
export const adminAction = marked('adminAction', rawAdminAction);
export const workerQuery = marked('workerQuery', rawWorkerQuery);
export const workerMutation = marked('workerMutation', rawWorkerMutation);

/**
 * First run's two functions that run before any account exists: no session
 * and no worker token. Only `setup.state` and
 * `setup.createAdmin` use them (api.test.ts).
 */
const noCaller = { args: {}, input: async () => ({ ctx: {}, args: {} }) };
export const setupQuery = marked('setupQuery', zCustomQuery(query, noCaller));
const rawSetupAction = zCustomAction(action, noCaller);
/** Answers `{ error: 'adminExists' }` without calling the handler once an admin exists. */
export const setupAction = marked('setupAction', ((definition: {
  handler: (ctx: { runQuery: (ref: unknown) => Promise<unknown> }, args: unknown) => unknown;
}) =>
  rawSetupAction({
    ...definition,
    handler: async (ctx: { runQuery: (ref: unknown) => Promise<unknown> }, args: unknown) =>
      (await ctx.runQuery(internal.setup.settings.adminExists)) ? { error: 'adminExists' } : definition.handler(ctx, args),
  } as never)) as unknown as typeof rawSetupAction);
