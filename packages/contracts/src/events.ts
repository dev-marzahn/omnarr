// The kinds of `events` rows and the data they carry.
import { z } from 'zod';

import { FailureCode } from './failures.ts';
import { CandidateReason } from './release.ts';

export const EventStage = z.enum(['search', 'grab', 'download', 'import', 'prepare', 'publish', 'system']);
export type EventStage = z.infer<typeof EventStage>;

/** `metadataChanged`: a sync moved a Unit's TMDB numbers, retired it or listed it again, with `from`/`to` as `S01E10`. */
export const EventKind = z.enum([
  'stageStarted',
  'stageFinished',
  'stageFailed',
  'decision',
  'retry',
  'blocklisted',
  'cancelled',
  'paused',
  'resumed',
  'metadataChanged',
]);
export type EventKind = z.infer<typeof EventKind>;

/**
 * What an event records beyond its message. A state change sets `entity`,
 * `from` and `to`; a job event sets `jobId`; a failure or retry sets
 * `failureCode` and `attempt`.
 */
export const EventData = z.object({
  entity: z.enum(['searchAttempt', 'grab', 'download', 'importJob', 'rendition', 'publication', 'job', 'worker']).optional(),
  entityId: z.string().optional(),
  from: z.string().optional(),
  to: z.string().optional(),
  jobId: z.string().optional(),
  failureCode: FailureCode.optional(),
  attempt: z.number().optional(),
  /** Platform-written detail, such as a client status no table maps yet; never a URL. */
  detail: z.string().optional(),
  /** A manual grab's pick step: the rejection the user confirmed. */
  confirmReason: CandidateReason.optional(),
});
export type EventData = z.infer<typeof EventData>;
