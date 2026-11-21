// The lease rule of the site worker functions: each call names the
// job it serves, which must be leased at that epoch and be about the indexer
// or definition the call asks for. So `sites.config` returns an indexer's
// secrets only to the holder of a job for that indexer.
import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { leasedJob } from '../jobs/imports';
import { workerError } from '../lib/functions';

/** The indexer a job is for: an `indexer` job's, or a `download.submit` of its `siteUrl`. */
const indexerOf = (job: Doc<'jobs'>): Id<'indexers'> | undefined => {
  const payload = job.payload;
  if (payload?.class === 'indexer' && 'indexerId' in payload) return payload.indexerId;
  if (payload?.class === 'download.submit' && payload.source.kind === 'siteUrl') return payload.source.indexerId;
  return undefined;
};

export async function leaseForIndexer(ctx: QueryCtx, lease: { jobId: Id<'jobs'>; leaseEpoch: number }, indexerId: Id<'indexers'>): Promise<Doc<'jobs'>> {
  const job = await leasedJob(ctx, lease.jobId, lease.leaseEpoch);
  if (indexerOf(job) !== indexerId) throw workerError('invalidResult', { expected: 'a job for this indexer' });
  return job;
}

export async function leaseForDraft(ctx: QueryCtx, lease: { jobId: Id<'jobs'>; leaseEpoch: number }, definitionId: string): Promise<Doc<'jobs'>> {
  const job = await leasedJob(ctx, lease.jobId, lease.leaseEpoch);
  const payload = job.payload;
  if (payload?.class !== 'indexer' || payload.action !== 'testDraft' || payload.draft.definitionId !== definitionId)
    throw workerError('invalidResult', { expected: 'a test of this definition' });
  return job;
}

export async function leaseForSync(ctx: QueryCtx, lease: { jobId: Id<'jobs'>; leaseEpoch: number }): Promise<Doc<'jobs'>> {
  const job = await leasedJob(ctx, lease.jobId, lease.leaseEpoch);
  if (job.payload?.class !== 'maintenance' || job.payload.action !== 'syncDefinitions')
    throw workerError('invalidResult', { expected: 'maintenance/syncDefinitions' });
  return job;
}
