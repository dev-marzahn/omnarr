// The append-only event history the timeline reads.
import type { EventData, EventKind, EventStage } from '@omnarr/contracts';

import type { Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';

export type NewEvent = {
  /** For events outside a run: search, preparation, monitoring changes. */
  unitId?: Id<'units'>;
  /** For events inside a run, written once per Grab. */
  grabId?: Id<'grabs'>;
  stage: EventStage;
  kind: EventKind;
  /** Platform-written text only. */
  message: string;
  data?: EventData;
};

export async function appendEvent(ctx: MutationCtx, event: NewEvent): Promise<Id<'events'>> {
  return await ctx.db.insert('events', { ...event, at: Date.now() });
}
