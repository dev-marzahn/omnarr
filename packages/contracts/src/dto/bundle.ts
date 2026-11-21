// The support bundle: what `worker.bundleData` returns for
// a `buildSupportBundle` job. Built from DTOs only, which hold no secret:
// System's status, the settings DTOs, the Issues, recent events and the jobs
// as `JobRow`, which has no payload.
import { zid } from 'convex-helpers/server/zod4';
import { z } from 'zod';

import { DownloadClientsDetail } from '../downloadClients.ts';
import { EventKind, EventStage } from '../events.ts';
import { FailureCode } from '../failures.ts';
import { IndexerRow } from '../indexer.ts';
import { JobClass } from '../kinds.ts';
import { IssueList } from './issues.ts';
import { SystemStatus } from './system.ts';

/** A job without its payload: its class, state and failure. */
export const JobRow = z
  .object({
    jobId: zid('jobs'),
    class: JobClass,
    /** A maintenance job's action. */
    action: z.string().optional(),
    status: z.enum(['queued', 'waiting', 'leased', 'done', 'failed', 'cancelled']),
    attempt: z.number(),
    maxAttempts: z.number(),
    failureCode: FailureCode.optional(),
    /** Platform-written text only. */
    lastError: z.string().optional(),
    createdAt: z.number(),
    grabId: zid('grabs').optional(),
  })
  .strict();
export type JobRow = z.infer<typeof JobRow>;

/** One `events` row, as the timeline shows it. */
export const BundleEvent = z
  .object({
    at: z.number(),
    stage: EventStage,
    kind: EventKind,
    message: z.string(),
    failureCode: FailureCode.optional(),
    unitId: zid('units').optional(),
    grabId: zid('grabs').optional(),
  })
  .strict();
export type BundleEvent = z.infer<typeof BundleEvent>;

export const SupportBundleData = z
  .object({
    builtAt: z.number(),
    backendProtocolVersion: z.number(),
    status: SystemStatus,
    indexers: z.array(IndexerRow),
    downloadClients: DownloadClientsDetail,
    issues: IssueList,
    /** The newest events, newest first. */
    events: z.array(BundleEvent),
    /** The newest jobs, newest first. */
    jobs: z.array(JobRow),
  })
  .strict();
export type SupportBundleData = z.infer<typeof SupportBundleData>;

/** `system.buildSupportBundle()`: the queued build, a running one if there is one. */
export const BuildSupportBundleResponse = z.object({ jobId: zid('jobs') });
