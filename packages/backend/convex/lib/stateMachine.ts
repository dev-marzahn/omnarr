// The only code that changes a pipeline state field. Each
// move is checked against TRANSITIONS, appends an `events` row and recomputes
// the affected Units in the same mutation.
import { canTransition, type EventKind, type FailureCode, type StateEntity, type StatesOf } from '@omnarr/contracts';

import type { Id, TableNames } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { recomputeUnits } from './derivedState';
import { appendEvent } from './events';

const TABLE = {
  searchAttempt: 'searchAttempts',
  grab: 'grabs',
  download: 'downloads',
  importJob: 'importJobs',
  rendition: 'renditions',
  publication: 'publications',
} as const satisfies Record<StateEntity, TableNames>;

type IdOf<E extends StateEntity> = Id<(typeof TABLE)[E]>;

/** What the timeline says about the move. Platform-written text only. */
export type TransitionEvent = { kind: EventKind; message: string; failureCode?: FailureCode; detail?: string };

const STAGE = { searchAttempt: 'search', grab: 'grab', download: 'download', importJob: 'import', rendition: 'prepare', publication: 'publish' } as const;

export async function unitsOfGrab(ctx: MutationCtx, grabId: Id<'grabs'>): Promise<Id<'units'>[]> {
  const rows = await ctx.db
    .query('grabUnits')
    .withIndex('by_grab', (q) => q.eq('grabId', grabId))
    .collect();
  return rows.map((row) => row.unitId);
}

/** Moves one entity to `to`; throws on a move TRANSITIONS doesn't allow. */
export async function transition<E extends StateEntity>(ctx: MutationCtx, entity: E, id: IdOf<E>, to: StatesOf[E], event: TransitionEvent): Promise<void> {
  const row = (await ctx.db.get(id as Id<'grabs'>)) as unknown as Record<string, unknown> | null;
  if (!row) throw new Error(`${entity} ${id} doesn't exist`);
  const from = row.state as StatesOf[E];
  if (!canTransition(entity, from, to)) throw new Error(`${entity} ${id}: ${from} → ${to} is not allowed`);
  await ctx.db.patch(id as Id<'grabs'>, { state: to as never });

  const { failureCode, detail, ...text } = event;
  const data = { entity, entityId: id, from, to, ...(failureCode ? { failureCode } : {}), ...(detail ? { detail } : {}) };
  const stage = STAGE[entity];
  let unitIds: Id<'units'>[];
  if (entity === 'searchAttempt') {
    unitIds = row.unitIds as Id<'units'>[];
    for (const unitId of unitIds) await appendEvent(ctx, { unitId, stage, ...text, data });
  } else if (entity === 'rendition' || (entity === 'publication' && !(await runOf(ctx, row)))) {
    // Outside a run: preparation, and a publication its result enqueued.
    unitIds = entity === 'publication' ? [row.unitId as Id<'units'>] : await unitsOfRendition(ctx, row);
    for (const unitId of unitIds) await appendEvent(ctx, { unitId, stage, ...text, data });
  } else {
    const grabId = entity === 'grab' ? (id as Id<'grabs'>) : ((row.grabId as Id<'grabs'> | undefined) ?? (await runOf(ctx, row))!);
    await appendEvent(ctx, { grabId, stage, ...text, data });
    unitIds = await unitsOfGrab(ctx, grabId);
  }
  await recomputeUnits(ctx, unitIds);
}

/** The Grab whose run enqueued a Publication's job, if a run did. */
async function runOf(ctx: MutationCtx, row: Record<string, unknown>): Promise<Id<'grabs'> | undefined> {
  if (row.grabId) return row.grabId as Id<'grabs'>;
  if (!row.jobId) return undefined;
  const job = await ctx.db.get(row.jobId as Id<'jobs'>);
  return job?.grabId;
}

async function unitsOfRendition(ctx: MutationCtx, row: Record<string, unknown>): Promise<Id<'units'>[]> {
  const links = await ctx.db
    .query('fileUnits')
    .withIndex('by_file', (q) => q.eq('fileId', row.sourceFileId as Id<'files'>))
    .collect();
  return links.map((link) => link.unitId);
}
