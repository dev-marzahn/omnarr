// Playback profiles: one row per library, its target from
// the ticked devices or edited directly, first run's defaults, and a new
// device table, the save dialog's preview, and the recompute a changed
// target runs (preparation.recomputeFits).
import {
  type ChangePreview,
  compare,
  DEFAULT_LIMITS,
  DEVICE_TABLE_VERSION,
  type DeviceId,
  type LibraryKind,
  mostExpensive,
  type PlaybackDraft,
  type TargetFormat,
  targetForDevices,
} from '@omnarr/contracts';
import { ConvexError } from 'convex/values';

import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';

const PROFILE_NAMES: Record<LibraryKind, string> = { series: 'Series', movies: 'Movies' };

/**
 * Called when a save or a new device table changed a profile's `target`:
 * schedules `preparation.recomputeFits(profileId)`, which
 * rewrites `fits` and starts or cancels Renditions for the profile's files,
 * 100 versions per mutation.
 */
export async function onTargetChanged(ctx: MutationCtx, profileId: Id<'playbackProfiles'>): Promise<void> {
  await ctx.scheduler.runAfter(0, internal.pipeline.preparation.recomputeFits, { playbackProfileId: profileId });
}

/** Key order doesn't count: a stored target may come back with its keys in another order. */
export function sameTarget(a: TargetFormat | undefined, b: TargetFormat): boolean {
  const canonical = (value: unknown): unknown =>
    value && typeof value === 'object' && !Array.isArray(value)
      ? Object.fromEntries(
          Object.entries(value)
            .sort(([x], [y]) => x.localeCompare(y))
            .map(([key, inner]) => [key, canonical(inner)]),
        )
      : Array.isArray(value)
        ? value.map(canonical)
        : value;
  return a !== undefined && JSON.stringify(canonical(a)) === JSON.stringify(canonical(b));
}

/**
 * First run and reference seed 0003: one profile per
 * library in `devices` mode with these devices. The first library on a row
 * fills it; a library whose row another one already took gets its own, and
 * its file versions move with it (a row shared by an older install).
 */
export async function setupDefaults(ctx: MutationCtx, devices: DeviceId[]): Promise<void> {
  // Two rows: Series first, so it keeps a shared row.
  const libraries = (await ctx.db.query('libraries').collect()).sort((a, b) => Number(a.kind !== 'series') - Number(b.kind !== 'series'));
  const fields = {
    mode: 'devices' as const,
    devices,
    target: targetForDevices(devices),
    deviceTableVersion: DEVICE_TABLE_VERSION,
    maxHeightOverride: undefined,
  };
  const taken = new Set<Id<'playbackProfiles'>>();
  for (const library of libraries) {
    const name = PROFILE_NAMES[library.kind];
    const current = await ctx.db.get(library.playbackProfileId);
    if (current && !taken.has(current._id)) {
      await ctx.db.patch(current._id, { name, ...fields });
      taken.add(current._id);
      continue;
    }
    const profileId = await ctx.db.insert('playbackProfiles', { name, ...fields });
    await ctx.db.patch(library._id, { playbackProfileId: profileId });
    taken.add(profileId);
    if (current) await moveVersions(ctx, current._id, library, profileId);
  }
}

/** The file versions of `library`'s Units on the shared row move to its own (from an older install, at most a few hundred). */
async function moveVersions(ctx: MutationCtx, shared: Id<'playbackProfiles'>, library: Doc<'libraries'>, profileId: Id<'playbackProfiles'>): Promise<void> {
  const versions = await ctx.db
    .query('fileVersions')
    .withIndex('by_profile', (q) => q.eq('playbackProfileId', shared))
    .collect();
  const libraryOfUnit = new Map<Id<'units'>, Id<'libraries'> | undefined>();
  for (const version of versions) {
    if (!libraryOfUnit.has(version.unitId)) {
      const unit = await ctx.db.get(version.unitId);
      const work = unit && (await ctx.db.get(unit.workId));
      libraryOfUnit.set(version.unitId, work?.libraryId);
    }
    if (libraryOfUnit.get(version.unitId) === library._id) await ctx.db.patch(version._id, { playbackProfileId: profileId });
  }
}

/**
 * The target a draft saves: the ticked devices' with the cap
 * override, or the one edited directly. Throws for a draft `applyDraft`
 * refuses.
 */
export function draftTarget(draft: PlaybackDraft): TargetFormat {
  if (draft.mode === 'devices') {
    if (!draft.devices.length) throw new ConvexError({ code: 'invalid', message: 'Tick at least one device.' });
    return targetForDevices(draft.devices, draft.maxHeightOverride);
  }
  if (draft.target.subtitles.mode === 'keep' && draft.target.containers[0] !== 'mkv') {
    throw new ConvexError({ code: 'invalid', message: 'Keeping subtitles in the file needs mkv as the first container.' });
  }
  return draft.target;
}

/**
 * The save dialog's counts: of the profile's primary files (a
 * multi-episode file once), those that would stop fitting the draft's target,
 * by their most expensive step, split into those `recomputeFits` would
 * prepare and the scanned ones it leaves alone, and those that would start
 * fitting. At most `previewChangeLimit` versions are read (`truncated`).
 */
export async function previewChange(ctx: QueryCtx, profileId: Id<'playbackProfiles'>, draft: PlaybackDraft): Promise<ChangePreview> {
  const target = draftTarget(draft);
  const limit = DEFAULT_LIMITS.previewChangeLimit;
  const versions = await ctx.db
    .query('fileVersions')
    .withIndex('by_profile', (q) => q.eq('playbackProfileId', profileId))
    .take(limit + 1);
  const preview: ChangePreview = {
    noLongerFit: { remux: 0, audio: 0, subtitle: 0, video: 0 },
    willPrepare: 0,
    scannedOnDemand: 0,
    nowFit: 0,
    truncated: versions.length > limit,
  };
  const seen = new Set<Id<'files'>>();
  for (const version of versions.slice(0, limit)) {
    if (version.kind !== 'primary' || seen.has(version.fileId)) continue;
    seen.add(version.fileId);
    const file = await ctx.db.get(version.fileId);
    if (!file?.probe) continue;
    const { fits, steps } = compare(file.probe, target);
    if (fits && !version.fits) preview.nowFit += 1;
    if (fits || !version.fits) continue;
    const step = mostExpensive(steps);
    if (step !== 'none') preview.noLongerFit[step] += 1;
    if (file.origin === 'scan') preview.scannedOnDemand += 1;
    else preview.willPrepare += 1;
  }
  return preview;
}

/**
 * Validates and saves the playback settings' draft: in `devices` mode the
 * target comes from the ticked devices and the cap override, in `custom`
 * mode it is the draft's. A changed target calls `onTargetChanged`.
 */
export async function applyDraft(ctx: MutationCtx, profileId: Id<'playbackProfiles'>, draft: PlaybackDraft): Promise<{ targetChanged: boolean }> {
  const profile = await ctx.db.get(profileId);
  if (!profile) throw new ConvexError({ code: 'notFound' });
  const target = draftTarget(draft);
  if (draft.mode === 'devices') {
    await ctx.db.patch(profileId, {
      mode: 'devices',
      devices: draft.devices,
      maxHeightOverride: draft.maxHeightOverride,
      target,
      deviceTableVersion: DEVICE_TABLE_VERSION,
      keepOriginal: draft.keepOriginal,
    });
  } else {
    // The devices and the cap stay, for "Reset to devices".
    await ctx.db.patch(profileId, { mode: 'custom', target, keepOriginal: draft.keepOriginal });
  }
  const targetChanged = !sameTarget(profile.target, target);
  if (targetChanged) await onTargetChanged(ctx, profileId);
  return { targetChanged };
}

/**
 * A new device table (a reference seed): recomputes `target` for
 * every `devices`-mode profile computed with an older table version.
 * Rows without devices are the defaults seed's (0003).
 */
export async function recomputeForTable(ctx: MutationCtx): Promise<void> {
  // One row per library: two.
  for (const profile of await ctx.db.query('playbackProfiles').collect()) {
    if (profile.mode === 'custom' || !profile.devices?.length || (profile.deviceTableVersion ?? 0) >= DEVICE_TABLE_VERSION) continue;
    const target = targetForDevices(profile.devices, profile.maxHeightOverride);
    await ctx.db.patch(profile._id, { target, deviceTableVersion: DEVICE_TABLE_VERSION });
    if (!sameTarget(profile.target, target)) await onTargetChanged(ctx, profile._id);
  }
}
