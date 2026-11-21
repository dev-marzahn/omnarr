// The password-push hold: Jellyfin can't refuse a
// stale password, so the queue keeps at most one leased push per user. A
// push enqueued while another is leased is held `waiting` with no
// `availableAt` and no wake, so nothing claims it; when the leased one ends,
// the user's newest held push is queued. These rules apply only to
// `maintenance` jobs whose action is `pushJellyfinPassword`.
import type { Doc } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';

const PREFIX = 'pushJellyfinPassword:';

/** The idempotency-key prefix of a user's pushes: `pushJellyfinPassword:<userId>:<n>`. */
export const pushKeyPrefix = (userId: string) => `${PREFIX}${userId}:`;

/** Whether a job is a password push. Keyed on the job kind: the class, and the action or, once the payload is cleared, the key. */
export const isPasswordPush = (job: Doc<'jobs'>): boolean =>
  job.class === 'maintenance' &&
  (job.payload ? job.payload.class === 'maintenance' && job.payload.action === 'pushJellyfinPassword' : job.idempotencyKey.startsWith(PREFIX));

/** A held push: `waiting` with no `availableAt` (a backoff always has one). */
export const isHeld = (job: Doc<'jobs'>): boolean => job.status === 'waiting' && job.availableAt === undefined;

/** Every push of a user, oldest first. */
export async function pushesOf(ctx: QueryCtx, userId: string): Promise<Doc<'jobs'>[]> {
  const prefix = pushKeyPrefix(userId);
  const rows = await ctx.db
    .query('jobs')
    .withIndex('by_idempotency_key', (q) => q.gte('idempotencyKey', prefix).lt('idempotencyKey', `${prefix}￿`))
    .collect();
  return rows.sort((a, b) => a._creationTime - b._creationTime);
}

/** The user a push's key names. */
function userOf(job: Doc<'jobs'>): string | undefined {
  const rest = job.idempotencyKey.slice(PREFIX.length);
  const end = rest.lastIndexOf(':');
  return end > 0 ? rest.slice(0, end) : undefined;
}

/**
 * Called when a job ends. When it is a push that was leased, the user's
 * newest held push becomes `queued`. A push that ends while
 * held or queued releases nothing.
 */
export async function releaseHeldPush(ctx: MutationCtx, ended: Doc<'jobs'>): Promise<void> {
  if (ended.status !== 'leased' || !isPasswordPush(ended)) return;
  const userId = userOf(ended);
  if (userId === undefined) return;
  const held = (await pushesOf(ctx, userId)).filter((job) => job._id !== ended._id && isHeld(job)).at(-1);
  if (held) await ctx.db.patch(held._id, { status: 'queued' });
}
