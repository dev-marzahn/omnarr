// The relay: a definition indexer's adapter. Each search, RSS page or test
// enqueues a leased `indexer` job for the worker's engine and polls its
// outcome every 250 ms; 90 s without one cancels the job and answers
// `workerUnavailable`. The indexer loop, health and usage code see an
// ordinary adapter. Offsets past 0 are answered at once with an empty
// page: Cardigann sites don't page.
import {
  type IndexerCaps,
  indexerFailureCode,
  IndexerJobPayload,
  IndexerPageResult,
  type IndexerFailure,
  type IndexerPage,
  type IndexerResult,
  type IndexerTestResult,
  IndexerTestResult as IndexerTestResultSchema,
} from '@omnarr/contracts';
import { zid, zodToConvex, zodToConvexFields } from 'convex-helpers/server/zod4';
import { z } from 'zod';

import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { type ActionCtx, internalMutation, internalQuery } from '../_generated/server';
import { cancelJob, enqueueJob } from '../jobs/queue';
import { limits } from '../lib/limits';
import type { IndexerAdapter } from './adapter';
import { whereOf } from './http';

export type RelayCtx = Pick<ActionCtx, 'runMutation' | 'runQuery'>;

export const enqueue = internalMutation({
  args: zodToConvexFields({ payload: IndexerJobPayload }),
  returns: zodToConvex(zid('jobs')),
  // A relayed request is its own job: the key is fresh each time.
  handler: (ctx, { payload }) => enqueueJob(ctx, { payload, idempotencyKey: `indexer:${payload.action}:${crypto.randomUUID()}` }),
});

const Outcome = z.object({
  status: z.enum(['queued', 'waiting', 'leased', 'done', 'failed', 'cancelled']),
  outcome: IndexerPageResult.optional(),
  test: IndexerTestResultSchema.optional(),
});

export const outcome = internalQuery({
  args: zodToConvexFields({ jobId: zid('jobs') }),
  returns: zodToConvex(Outcome.nullable()),
  handler: async (ctx, { jobId }) => {
    const job = await ctx.db.get(jobId);
    if (!job) return null;
    return { status: job.status, ...(job.indexerOutcome ? { outcome: job.indexerOutcome } : {}), ...(job.indexerTest ? { test: job.indexerTest } : {}) };
  },
});

/** Ends the relay's use of its job: a finished one is deleted (its answer was read), a live one is cancelled. */
export const finish = internalMutation({
  args: zodToConvexFields({ jobId: zid('jobs') }),
  returns: zodToConvex(z.null()),
  handler: async (ctx, { jobId }) => {
    const job = await ctx.db.get(jobId);
    if (!job) return null;
    if (job.status === 'done' || job.status === 'failed' || job.status === 'cancelled') await ctx.db.delete(jobId);
    else await cancelJob(ctx, jobId);
    return null;
  },
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** The failure when no worker ran the job: names the site's host, never a URL. */
export const workerUnavailable = (apiUrl: string): IndexerFailure => ({
  kind: 'workerUnavailable',
  code: indexerFailureCode('workerUnavailable'),
  ...whereOf(apiUrl),
});

type Answer = z.infer<typeof Outcome> | 'timeout';

/** Enqueues the job and polls until it ends or the relay's 90 s pass. */
async function relay(ctx: RelayCtx, payload: IndexerJobPayload): Promise<Answer> {
  const { relayPollMs, relayTimeoutMs } = limits();
  const jobId: Id<'jobs'> = await ctx.runMutation(internal.indexers.relay.enqueue, { payload });
  const deadline = Date.now() + relayTimeoutMs;
  while (Date.now() < deadline) {
    await sleep(relayPollMs);
    const answer = await ctx.runQuery(internal.indexers.relay.outcome, { jobId });
    if (answer && (answer.status === 'done' || answer.status === 'failed' || answer.status === 'cancelled')) {
      await ctx.runMutation(internal.indexers.relay.finish, { jobId });
      return answer;
    }
  }
  await ctx.runMutation(internal.indexers.relay.finish, { jobId });
  return 'timeout';
}

/** A job the worker failed (no indexer or definition) is an indexer error naming the host. */
const failedJob = (apiUrl: string): IndexerFailure => ({ kind: 'indexerError', code: indexerFailureCode('indexerError'), ...whereOf(apiUrl) });

async function page(ctx: RelayCtx, payload: IndexerJobPayload, apiUrl: string): Promise<IndexerResult<IndexerPage>> {
  const answer = await relay(ctx, payload);
  if (answer === 'timeout') return { ok: false, failure: workerUnavailable(apiUrl) };
  if (answer.outcome) return answer.outcome as IndexerResult<IndexerPage>;
  return { ok: false, failure: answer.status === 'cancelled' ? workerUnavailable(apiUrl) : failedJob(apiUrl) };
}

const empty = (offset: number): IndexerResult<IndexerPage> => ({ ok: true, value: { items: [], offset } });

/**
 * Whether a page at `offset` sends a request: a definition indexer answers
 * offsets past 0 itself, so the search and RSS loops count no call and
 * no page for them (usage counts requests).
 */
export const sendsRequest = (indexer: { kind: string }, offset: number): boolean => indexer.kind !== 'definition' || offset === 0;

export function createRelayAdapter(indexer: { id: Id<'indexers'>; apiUrl: string; caps?: IndexerCaps }, ctx: RelayCtx): IndexerAdapter {
  const answered = (offset: number) => !sendsRequest({ kind: 'definition' }, offset);
  return {
    caps: async () => (indexer.caps ? { ok: true, value: indexer.caps } : { ok: false, failure: failedJob(indexer.apiUrl) }),
    search: (request) =>
      answered(request.offset)
        ? Promise.resolve(empty(request.offset))
        : page(ctx, { class: 'indexer', action: 'search', indexerId: indexer.id, request }, indexer.apiUrl),
    rss: ({ offset }) =>
      answered(offset) ? Promise.resolve(empty(offset)) : page(ctx, { class: 'indexer', action: 'rss', indexerId: indexer.id }, indexer.apiUrl),
  };
}

/** A connection test through the worker: of a stored indexer, or of the form's values before it is saved. */
export async function relayTest(
  ctx: RelayCtx,
  payload: Extract<IndexerJobPayload, { action: 'test' | 'testDraft' }>,
  apiUrl: string,
  caps: IndexerCaps,
): Promise<IndexerTestResult> {
  const started = Date.now();
  const answer = await relay(ctx, payload);
  if (answer !== 'timeout' && answer.test) return answer.test;
  const failure = answer === 'timeout' || answer.status === 'cancelled' ? workerUnavailable(apiUrl) : failedJob(apiUrl);
  return {
    ok: false,
    kind: 'definition',
    searchModes: caps.searchModes,
    categories: caps.categories,
    latencyMs: Date.now() - started,
    failure: { kind: failure.kind, host: failure.host, path: failure.path },
  };
}
