// `units.derivedState`: the only code that computes it.
// `recomputeUnits` runs whenever a Unit's entities, file versions, Issues,
// `monitored` flag, profile `fits` or its Grab's `pausedAt` change.
import { deriveUnitState, type UnitSnapshot, type UnitState } from '@omnarr/contracts';

import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';

/** The state a Unit starts with: nothing exists for it yet but its own fields. */
export function stateOfNewUnit(unit: { monitored: boolean; airDateUtc?: number }, now: number): UnitState {
  return deriveUnitState({ now, monitored: unit.monitored, airDateUtc: unit.airDateUtc, hasOpenIssue: false, hasPendingRendition: false, versions: [] });
}

/** Everything the Unit state rules read about one Unit, all through indexes. */
export async function unitSnapshot(ctx: QueryCtx, unit: Doc<'units'>, now: number): Promise<UnitSnapshot> {
  const grab = unit.activeGrabId ? await ctx.db.get(unit.activeGrabId) : null;
  const download =
    grab?.state === 'downloading'
      ? await ctx.db
          .query('downloads')
          .withIndex('by_grab', (q) => q.eq('grabId', grab._id))
          .filter((q) => q.eq(q.field('state'), 'active'))
          .first()
      : null;

  const openIssue = await ctx.db
    .query('issues')
    .withIndex('by_unit', (q) => q.eq('unitId', unit._id))
    .filter((q) => q.and(q.eq(q.field('state'), 'open'), q.eq(q.field('scope'), 'unit')))
    .first();

  const fileUnits = await ctx.db
    .query('fileUnits')
    .withIndex('by_unit', (q) => q.eq('unitId', unit._id))
    .collect();
  let hasPendingRendition = false;
  for (const { fileId } of fileUnits) {
    const pending = await ctx.db
      .query('renditions')
      .withIndex('by_source_file', (q) => q.eq('sourceFileId', fileId))
      .filter((q) => q.eq(q.field('state'), 'pending'))
      .first();
    if (pending) {
      hasPendingRendition = true;
      break;
    }
  }

  const visible = new Set<Id<'fileVersions'>>();
  const pending = new Set<Id<'fileVersions'>>();
  const publications = await ctx.db
    .query('publications')
    .withIndex('by_unit', (q) => q.eq('unitId', unit._id))
    .collect();
  for (const publication of publications) {
    // A re-publish (`pending` with the earlier item) still plays, so it counts as visible.
    if (publication.state === 'visible' || (publication.state === 'pending' && publication.targetItemRef !== undefined)) visible.add(publication.fileVersionId);
    // Rule 6 reads it for a `staged` version waiting for its publish.
    if (publication.state === 'pending') pending.add(publication.fileVersionId);
  }
  const versions = await ctx.db
    .query('fileVersions')
    .withIndex('by_unit', (q) => q.eq('unitId', unit._id))
    .collect();

  const attempt = unit.lastSearchAttemptId ? await ctx.db.get(unit.lastSearchAttemptId) : null;

  return {
    now,
    monitored: unit.monitored,
    airDateUtc: unit.airDateUtc,
    activeGrab: grab
      ? { state: grab.state, paused: grab.pausedAt !== undefined, clientStage: download?.clientStage, ...(grab.kind ? { kind: grab.kind } : {}) }
      : undefined,
    hasOpenIssue: openIssue !== null,
    hasPendingRendition,
    versions: versions.map((version) => ({
      kind: version.kind,
      fits: version.fits,
      visible: visible.has(version._id),
      ...(pending.has(version._id) ? { pendingPublication: true } : {}),
    })),
    lastSearchState: attempt?.state,
  };
}

/** Derives each Unit's state and writes it only where it changed. */
export async function recomputeUnits(ctx: MutationCtx, unitIds: Id<'units'>[]): Promise<void> {
  const now = Date.now();
  for (const unitId of new Set(unitIds)) {
    const unit = await ctx.db.get(unitId);
    if (!unit) continue;
    const derivedState = deriveUnitState(await unitSnapshot(ctx, unit, now));
    if (derivedState !== unit.derivedState) await ctx.db.patch(unitId, { derivedState });
  }
}
