// Preparation: decided after a
// run's import and run outside the run. `decide` writes `fits` and starts a
// Rendition for a downloaded file; `start` enqueues the `prepare` job with its
// priority; `recomputeFits` follows a profile edit; `prepared` and
// `prepareEnded` record the job's end.
import {
  compare,
  DEFAULT_LIMITS,
  type FailureCode,
  type JobResult,
  type LanguageCode,
  ORIGINAL_RESTORED,
  type PreparePayload,
  RESTORE_QUEUED,
  type RenditionReason,
  type TargetFormat,
} from '@omnarr/contracts';
import { v } from 'convex/values';

import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { internalMutation, type MutationCtx, type QueryCtx } from '../_generated/server';
import { cancelJob, enqueueJob, enqueueWith } from '../jobs/queue';
import { isMissing, recomputeUnits } from '../lib/derivedState';
import { appendEvent } from '../lib/events';
import { raiseIssue, resolveIssuesForUnit } from '../lib/issues';
import { transition } from '../lib/stateMachine';
import { baseNameOf, folderOf, namedUnits, namingContextOf, unitsOfFile, unitsRetitled, workFolderPathOf } from '../library/naming';
import { sameTarget } from '../playback/profiles';
import { targetOf } from '../playback/target';
import { publishKey } from './steps';

/** Pages of `recomputeFits` and `prepareAll`. */
const PAGE = 100;

type FileContext = { file: Doc<'files'>; units: Doc<'units'>[]; work: Doc<'works'>; library: Doc<'libraries'>; profile: Doc<'playbackProfiles'> };

/** A file with its Units in part order, their Work, library and playback profile; null once any is gone. */
async function contextOf(ctx: QueryCtx, fileId: Id<'files'>): Promise<FileContext | null> {
  const file = await ctx.db.get(fileId);
  if (!file) return null;
  const units = await unitsOfFile(ctx, fileId);
  const work = units[0] ? await ctx.db.get(units[0].workId) : null;
  const library = work ? await ctx.db.get(work.libraryId) : null;
  const profile = library ? await ctx.db.get(library.playbackProfileId) : null;
  if (!work || !library || !profile) return null;
  return { file, units, work, library, profile };
}

const ids = (units: Doc<'units'>[]) => units.map((unit) => unit._id);

/** An upgrade import's file waiting for its preparation, under `staging/held/<jobId>/`. */
export const isHeld = (path: string): boolean => path.startsWith('/data/staging/held/');

/**
 * `/data/library/<series|movies>/…` → `/data/originals/<series|movies>/…`
 *: the same path under the Work folder, in the originals tree
 * beside the library roots. A path outside the library root keeps its folder.
 */
export function originalsTwin(library: Pick<Doc<'libraries'>, 'rootPath' | 'kind'>, folder: string): string {
  const root = library.rootPath.replace(/\/+$/, '');
  const data = folderOf(folderOf(root));
  const originals = `${data}/originals/${library.kind}`;
  if (folder === root || folder.startsWith(`${root}/`)) return `${originals}${folder.slice(root.length)}`;
  return folder;
}

/** The library twin of a folder under the originals tree: where a kept original's prepared copy goes. */
function libraryTwin(library: Pick<Doc<'libraries'>, 'rootPath' | 'kind'>, folder: string): string {
  const root = library.rootPath.replace(/\/+$/, '');
  const originals = originalsTwin(library, root);
  if (folder === originals || folder.startsWith(`${originals}/`)) return `${root}${folder.slice(originals.length)}`;
  return folder;
}

/** Writes `fits` on every version of the file; returns whether any changed. */
async function writeFits(ctx: MutationCtx, fileId: Id<'files'>, fits: boolean): Promise<boolean> {
  const versions = await ctx.db
    .query('fileVersions')
    .withIndex('by_file', (q) => q.eq('fileId', fileId))
    .collect();
  let changed = false;
  for (const version of versions)
    if (version.fits !== fits) {
      await ctx.db.patch(version._id, { fits });
      changed = true;
    }
  return changed;
}

/**
 * Called by `steps.finish` for each new source file:
 * `fits` from the comparison with the library's target, the Units
 * recomputed, and for a downloaded (or prepared) file with steps a Rendition
 * started. A scanned file stops at `fits`; it is prepared on demand only.
 */
export async function decide(ctx: MutationCtx, sourceFileId: Id<'files'>): Promise<void> {
  const context = await contextOf(ctx, sourceFileId);
  if (!context?.file.probe) return;
  const comparison = compare(context.file.probe, await targetOf(ctx, context.library._id));
  await writeFits(ctx, sourceFileId, comparison.fits);
  await recomputeUnits(ctx, ids(context.units));
  if (!comparison.fits && context.file.origin !== 'scan') await start(ctx, sourceFileId, 'import');
}

/** The file's `pending` Renditions with their jobs. */
async function pendingRenditions(ctx: QueryCtx, fileId: Id<'files'>): Promise<{ rendition: Doc<'renditions'>; job: Doc<'jobs'> | null }[]> {
  const renditions = await ctx.db
    .query('renditions')
    .withIndex('by_source_file', (q) => q.eq('sourceFileId', fileId))
    .filter((q) => q.eq(q.field('state'), 'pending'))
    .collect();
  return await Promise.all(renditions.map(async (rendition) => ({ rendition, job: await ctx.db.get(rendition.jobId) })));
}

/** A pending Rendition whose job still runs as planned: not one already asked to stop. */
const live = ({ job }: { job: Doc<'jobs'> | null }) => job !== null && !job.cancelRequested;

/** The target a pending Rendition's job prepares for, from its payload. */
const targetOfJob = (job: Doc<'jobs'> | null): TargetFormat | undefined => (job?.payload?.class === 'prepare' ? job.payload.target : undefined);

/**
 * Cancels a Rendition through its job: a queued or waiting job ends
 * now, and `applyEnd` moves the Rendition to `cancelled`; a leased one is
 * asked to stop, and its Rendition follows when the worker ends it.
 */
async function cancelRendition(ctx: MutationCtx, rendition: Doc<'renditions'>): Promise<void> {
  const ended = await cancelJob(ctx, rendition.jobId);
  // A job already gone (or never there) leaves nothing to end the Rendition.
  if (!ended && (await ctx.db.get(rendition._id))?.state === 'pending')
    await transition(ctx, 'rendition', rendition._id, 'cancelled', { kind: 'cancelled', message: 'Preparation cancelled.' });
}

/** `group × 2 + (video ? 1 : 0)`: within a group, files with no video step first. */
export const priorityOf = (reason: RenditionReason, steps: readonly string[]): number =>
  DEFAULT_LIMITS.prepareGroups[reason] * 2 + (steps.includes('video') ? 1 : 0);

/** The first primary of the Units that is another file than `fileId`: what a kept original's output replaces. */
async function primaryBesides(ctx: QueryCtx, units: Doc<'units'>[], fileId: Id<'files'>): Promise<Doc<'files'> | null> {
  for (const unit of units)
    for (const version of await versionsOf(ctx, unit._id)) {
      if (version.kind !== 'primary' || version.fileId === fileId) continue;
      const file = await ctx.db.get(version.fileId);
      if (file && file.missingSince === undefined) return file;
    }
  return null;
}

/**
 * Starts preparing a source file: cancels its pending
 * Rendition for the same profile, enqueues the `prepare` job with its
 * priority and the Rendition it serves, and recomputes the Units. A kept
 * original that fits is restored by the same job, with no steps;
 * a kept original's job names the Unit's current primary it replaces.
 * Returns the Rendition, or null when the file has no probe or, not being a
 * kept original, already fits.
 */
export async function start(ctx: MutationCtx, sourceFileId: Id<'files'>, reason: RenditionReason): Promise<Id<'renditions'> | null> {
  const context = await contextOf(ctx, sourceFileId);
  if (!context?.file.probe) return null;
  const { file, units, work, library, profile } = context;
  const target = await targetOf(ctx, library._id);
  const { steps } = compare(file.probe!, target);
  const kept = (
    await ctx.db
      .query('fileVersions')
      .withIndex('by_file', (q) => q.eq('fileId', sourceFileId))
      .collect()
  ).some((version) => version.kind === 'original');
  const restore = steps.length === 0;
  if (restore && !kept) return null;
  // A held upgrade file replaces the primary that plays, as a kept original's output does.
  const held = isHeld(file.path);
  const replaced = kept || held ? await primaryBesides(ctx, units, sourceFileId) : null;
  const outputWouldBeTheHeldFolder = held && !replaced;
  if (outputWouldBeTheHeldFolder) return null;

  for (const { rendition } of await pendingRenditions(ctx, sourceFileId))
    if (rendition.playbackProfileId === profile._id) await cancelRendition(ctx, rendition);

  const folder = folderOf(file.path);
  // A kept original lives under originals/: its prepared copy goes back to the library folder.
  // A held file's output goes where the primary it replaces is.
  const outputFolder = held && replaced ? folderOf(replaced.path) : libraryTwin(library, folder);
  const naming = file.keepsName ? undefined : await namingContextOf(ctx, work, file);
  let renditionId: Id<'renditions'> | undefined;
  // The key names the Rendition, which needs the job's ID: the job goes in under a key
  // no other job has, and gets its own once the Rendition exists.
  const { jobId } = await enqueueWith(
    ctx,
    { class: 'prepare', idempotencyKey: `${sourceFileId}:prepare:new`, priority: priorityOf(reason, steps) },
    async (jobId): Promise<PreparePayload> => {
      renditionId = await ctx.db.insert('renditions', { sourceFileId, jobId, playbackProfileId: profile._id, steps, reason, state: 'pending' });
      return {
        class: 'prepare',
        renditionId,
        sourceFileId,
        sourcePath: file.path,
        sourceInode: file.inode,
        targetProfileId: profile._id,
        target,
        disposition: profile.keepOriginal ? 'keep' : 'replace',
        naming: naming ?? { keepBaseName: baseNameOf(file.path) },
        units: await namedUnits(ctx, work, units),
        outputFolder,
        originalsFolder: originalsTwin(library, outputFolder),
        ...(replaced ? { replacesPath: replaced.path } : {}),
      };
    },
  );
  await ctx.db.patch(jobId, { idempotencyKey: `${renditionId}:prepare`, renditionId });
  for (const unit of units)
    await appendEvent(ctx, {
      unitId: unit._id,
      stage: 'prepare',
      kind: 'stageStarted',
      message: restore ? RESTORE_QUEUED : `Preparation queued: ${steps.join(', ')}.`,
      data: { entity: 'rendition', entityId: renditionId!, jobId },
    });
  await recomputeUnits(ctx, ids(units));
  return renditionId!;
}

/** A Unit's versions by kind. */
async function versionsOf(ctx: QueryCtx, unitId: Id<'units'>): Promise<Doc<'fileVersions'>[]> {
  return await ctx.db
    .query('fileVersions')
    .withIndex('by_unit', (q) => q.eq('unitId', unitId))
    .collect();
}

/**
 * The file a Unit is prepared from: its kept `original` when there
 * is one, else its current `primary`, which may be an earlier prepared file.
 */
export async function sourceForUnit(ctx: QueryCtx, unitId: Id<'units'>): Promise<Id<'files'> | null> {
  const versions = await versionsOf(ctx, unitId);
  return (versions.find((version) => version.kind === 'original') ?? versions.find((version) => version.kind === 'primary'))?.fileId ?? null;
}

/**
 * After a profile edit, one page of the profile's versions:
 * `fits` rewritten and the Units recomputed; a file that fits again loses
 * its pending Renditions; a downloaded or prepared primary that no longer
 * fits is prepared once per file from its source, unless a pending Rendition
 * already has this target. One with another target is restarted in its own
 * group, never a lower one. Scanned files are left as they are.
 */
async function recomputeFitsPage(ctx: MutationCtx, playbackProfileId: Id<'playbackProfiles'>, cursor: string | null): Promise<void> {
  const library = (await ctx.db.query('libraries').collect()).find((row) => row.playbackProfileId === playbackProfileId);
  if (!library) return;
  const target = await targetOf(ctx, library._id);
  const page = await ctx.db
    .query('fileVersions')
    .withIndex('by_profile', (q) => q.eq('playbackProfileId', playbackProfileId))
    .paginate({ numItems: PAGE, cursor });
  const touched = new Set<Id<'units'>>();
  for (const version of page.page) {
    const file = await ctx.db.get(version.fileId);
    if (!file?.probe) continue;
    const fits = compare(file.probe, target).fits;
    if (version.fits !== fits) {
      await ctx.db.patch(version._id, { fits });
      touched.add(version.unitId);
    }
    if (version.kind !== 'primary') continue;
    const sourceId = (await sourceForUnit(ctx, version.unitId)) ?? file._id;
    const pending = [...(await pendingRenditions(ctx, file._id)), ...(sourceId === file._id ? [] : await pendingRenditions(ctx, sourceId))].filter(
      ({ rendition }) => rendition.playbackProfileId === playbackProfileId,
    );
    if (fits) {
      // A kept original that fits too is the better copy: it is restored, replacing the primary (author, 2026-11-18).
      const original = sourceId === file._id ? null : await ctx.db.get(sourceId);
      if (original?.probe && compare(original.probe, target).fits) {
        if (!pending.filter(live).some(({ job }) => sameTarget(targetOfJob(job), target))) await start(ctx, sourceId, 'profileEdit');
        continue;
      }
      for (const { rendition } of pending) await cancelRendition(ctx, rendition);
      continue;
    }
    if (file.origin === 'scan') continue;
    const running = pending.filter(live);
    if (running.some(({ job }) => sameTarget(targetOfJob(job), target))) continue;
    // A Rendition for another target keeps its group: an import's stays ahead of the edit's.
    const [earlier] = running;
    await start(ctx, sourceId, earlier ? earlier.rendition.reason : 'profileEdit');
  }
  await recomputeUnits(ctx, [...touched]);
  if (!page.isDone) await ctx.scheduler.runAfter(0, internal.pipeline.preparation.recomputeFits, { playbackProfileId, cursor: page.continueCursor });
}

/** `preparation.recomputeFits(profileId)`: 100 versions per mutation, each scheduling the next page. */
export const recomputeFits = internalMutation({
  args: { playbackProfileId: v.id('playbackProfiles'), cursor: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { playbackProfileId, cursor }) => {
    await recomputeFitsPage(ctx, playbackProfileId, cursor ?? null);
    return null;
  },
});

/**
 * "Cancel preparation": every pending Rendition of the Unit's files, through
 * the job cancel. No Issue. Returns how many it cancelled.
 */
export async function cancelForUnit(ctx: MutationCtx, unitId: Id<'units'>): Promise<number> {
  const links = await ctx.db
    .query('fileUnits')
    .withIndex('by_unit', (q) => q.eq('unitId', unitId))
    .collect();
  let cancelled = 0;
  for (const { fileId } of links)
    for (const { rendition } of await pendingRenditions(ctx, fileId)) {
      await cancelRendition(ctx, rendition);
      cancelled += 1;
    }
  await recomputeUnits(ctx, [unitId]);
  return cancelled;
}

/**
 * "Prepare all": one page of 100 of the Work's Units. Each whose
 * primary doesn't fit and has no pending Rendition is prepared from its
 * source with reason `bulk`, scanned files included, once per file. The next
 * page is scheduled. Returns how many it queued in this page.
 */
export async function prepareAllPage(ctx: MutationCtx, workId: Id<'works'>, cursor: string | null): Promise<number> {
  const page = await ctx.db
    .query('units')
    .withIndex('by_work', (q) => q.eq('workId', workId))
    .paginate({ numItems: PAGE, cursor });
  let queued = 0;
  for (const unit of page.page) {
    const versions = await versionsOf(ctx, unit._id);
    const primary = versions.find((version) => version.kind === 'primary');
    if (!primary || primary.fits) continue;
    const sourceId = (await sourceForUnit(ctx, unit._id))!;
    const pending = [...(await pendingRenditions(ctx, primary.fileId)), ...(sourceId === primary.fileId ? [] : await pendingRenditions(ctx, sourceId))];
    if (pending.length > 0) continue;
    if (await start(ctx, sourceId, 'bulk')) queued += 1;
  }
  if (!page.isDone) await ctx.scheduler.runAfter(0, internal.pipeline.preparation.prepareAll, { workId, cursor: page.continueCursor });
  return queued;
}

/** `preparation.prepareAll(workId, cursor?)`'s later pages. */
export const prepareAll = internalMutation({
  args: { workId: v.id('works'), cursor: v.optional(v.string()) },
  returns: v.null(),
  handler: async (ctx, { workId, cursor }) => {
    await prepareAllPage(ctx, workId, cursor ?? null);
    return null;
  },
});

/** English names of the subtitle languages a dropped track can have. */
const LANGUAGE_NAMES: Record<Exclude<LanguageCode, 'multi'>, string> = {
  en: 'English',
  de: 'German',
  fr: 'French',
  es: 'Spanish',
  it: 'Italian',
  pt: 'Portuguese',
  nl: 'Dutch',
  pl: 'Polish',
  ru: 'Russian',
  ja: 'Japanese',
  ko: 'Korean',
  zh: 'Chinese',
  sv: 'Swedish',
  no: 'Norwegian',
  da: 'Danish',
  fi: 'Finnish',
  tr: 'Turkish',
  el: 'Greek',
  hu: 'Hungarian',
  cs: 'Czech',
  uk: 'Ukrainian',
  he: 'Hebrew',
  ar: 'Arabic',
  hi: 'Hindi',
  th: 'Thai',
  vi: 'Vietnamese',
};

type Dropped = Extract<JobResult, { class: 'prepare'; noChange: false }>['droppedTracks'];

/** The note for dropped image tracks: "Dropped 2 image subtitle tracks (English, English forced): OCR comes later". */
export function droppedNote(dropped: Dropped): string | undefined {
  if (dropped.length === 0) return undefined;
  const names = dropped.map((track) => {
    const language =
      track.language === undefined || track.language === 'und' || track.language === 'multi' ? 'Unknown language' : LANGUAGE_NAMES[track.language];
    return track.forced ? `${language} forced` : language;
  });
  return `Dropped ${dropped.length} image subtitle track${dropped.length === 1 ? '' : 's'} (${names.join(', ')}): OCR comes later`;
}

/** Deletes a file's versions and their Publications; with `withFile`, its links and row too. */
async function removeVersions(ctx: MutationCtx, fileId: Id<'files'>, withFile: boolean): Promise<void> {
  const versions = await ctx.db
    .query('fileVersions')
    .withIndex('by_file', (q) => q.eq('fileId', fileId))
    .collect();
  for (const version of versions) {
    for (const publication of await ctx.db
      .query('publications')
      .withIndex('by_unit', (q) => q.eq('unitId', version.unitId))
      .filter((q) => q.eq(q.field('fileVersionId'), version._id))
      .collect())
      await ctx.db.delete(publication._id);
    if (withFile) await ctx.db.delete(version._id);
  }
  if (!withFile) return;
  for (const link of await ctx.db
    .query('fileUnits')
    .withIndex('by_file', (q) => q.eq('fileId', fileId))
    .collect())
    await ctx.db.delete(link._id);
  await ctx.db.delete(fileId);
}

/**
 * After a file becomes a Unit's primary (`results.published`): an earlier
 * release's files leave the Unit, whatever the disposition. Those are its
 * other primaries and the originals of another release than the new file's;
 * the new file's own kept original stays. A
 * file no Unit links any more is deleted from disk by a `deleteLibraryFiles`
 * job, its sidecars with it, and its pending Renditions are cancelled.
 */
export async function retireOldVersions(ctx: MutationCtx, unitId: Id<'units'>, fileId: Id<'files'>): Promise<void> {
  const current = await ctx.db.get(fileId);
  const unit = await ctx.db.get(unitId);
  const work = unit && (await ctx.db.get(unit.workId));
  if (!work) return;
  for (const version of await versionsOf(ctx, unitId)) {
    if (version.fileId === fileId || (version.kind !== 'primary' && version.kind !== 'original')) continue;
    const old = await ctx.db.get(version.fileId);
    if (!old || (version.kind === 'original' && old.candidateId === current?.candidateId)) continue;
    const goneFromDiskSoItsShareMayOnlyBeDown = old.missingSince !== undefined;
    if (goneFromDiskSoItsShareMayOnlyBeDown) continue;
    for (const publication of await ctx.db
      .query('publications')
      .withIndex('by_unit', (q) => q.eq('unitId', unitId))
      .filter((q) => q.eq(q.field('fileVersionId'), version._id))
      .collect())
      await ctx.db.delete(publication._id);
    await ctx.db.delete(version._id);
    const links = await ctx.db
      .query('fileUnits')
      .withIndex('by_file', (q) => q.eq('fileId', old._id))
      .collect();
    for (const link of links) if (link.unitId === unitId) await ctx.db.delete(link._id);
    const others = links.filter((link) => link.unitId !== unitId).map((link) => link.unitId);
    if (others.length > 0) {
      // A multi-episode file the user's pick upgraded in part stays for its other Units, renamed to them
      // alone, so Jellyfin doesn't list it as a second file of this one.
      await unitsRetitled(ctx, others);
      continue;
    }
    for (const { rendition } of await pendingRenditions(ctx, old._id)) await cancelRendition(ctx, rendition);
    await enqueueJob(ctx, {
      payload: {
        class: 'maintenance',
        action: 'deleteLibraryFiles',
        paths: [old.path, ...(old.sidecars ?? []).map((sidecar) => sidecar.path)],
        libraryId: work.libraryId,
        folders: [],
      },
      idempotencyKey: `deleteLibraryFiles:${old._id}`,
    });
    await ctx.db.delete(old._id);
  }
}

/**
 * `results.prepared`: the disk facts at once. The
 * Rendition is `done`; with `noChange` the source's versions fit and nothing
 * else changes. Otherwise the output is a `files` row with a `staged`
 * version per Unit and a `pending` Publication, inserted just before one
 * publish job; the source's rows are deleted (`replace`) or become the
 * `original` under `originals/` (`keep`). A restored original is
 * its own output: its row moves back to the library and its versions become
 * `staged`, with the same Publications and publish. An earlier primary a
 * kept original's job replaced loses its rows; the worker removed its file.
 * The Units' `transcodeFailed` Issues resolve.
 */
export async function prepared(ctx: MutationCtx, job: Doc<'jobs'>, result: Extract<JobResult, { class: 'prepare' }>): Promise<void> {
  if (job.payload?.class !== 'prepare') return;
  const payload = job.payload;
  const rendition = await ctx.db.get(payload.renditionId);
  const context = await contextOf(ctx, payload.sourceFileId);
  const done = async (message: string, patch: Partial<Doc<'renditions'>> = {}) => {
    if (rendition?.state !== 'pending') return;
    await ctx.db.patch(rendition._id, patch);
    await transition(ctx, 'rendition', rendition._id, 'done', { kind: 'stageFinished', message });
  };
  if (result.noChange) {
    await writeFits(ctx, payload.sourceFileId, true);
    await done('The file already fits: nothing to prepare.');
    if (context) await recomputeUnits(ctx, ids(context.units));
    return;
  }
  if (!context) return await done('Prepared.');
  const { file: source, units, work, library } = context;

  let outputFileId: Id<'files'>;
  if (result.restored) {
    // A kept original that fits is back in the library: its own row is the output.
    outputFileId = source._id;
    await ctx.db.patch(source._id, {
      path: result.outputPath,
      sizeBytes: result.sizeBytes,
      inode: result.inode,
      probe: result.probe,
      sidecars: result.sidecars,
    });
    await done(ORIGINAL_RESTORED, { outputFileId, encoder: result.encoder });
  } else {
    outputFileId = await ctx.db.insert('files', {
      path: result.outputPath,
      sizeBytes: result.sizeBytes,
      inode: result.inode,
      probe: result.probe,
      origin: 'prepared',
      role: 'rendition',
      ...(source.release ? { release: source.release } : {}),
      ...(source.candidateId ? { candidateId: source.candidateId } : {}),
      ...(source.keepsName ? { keepsName: true } : {}),
      sidecars: result.sidecars,
    });
    const links = await ctx.db
      .query('fileUnits')
      .withIndex('by_file', (q) => q.eq('fileId', source._id))
      .collect();
    for (const link of links)
      await ctx.db.insert('fileUnits', { fileId: outputFileId, unitId: link.unitId, ...(link.part !== undefined ? { part: link.part } : {}) });

    // The Rendition's entry names what it did, and the image tracks it dropped.
    const note = droppedNote(result.droppedTracks);
    await done([`Prepared: ${result.steps.join(', ')}.`, note && `${note}.`].filter(Boolean).join(' '), { outputFileId, encoder: result.encoder });
  }

  // A primary that wasn't the source (a kept original's job) leaves with its rows; the worker's swap removed its file (`replacesPath`).
  const replaced = new Set<Id<'files'>>();
  for (const unit of units)
    for (const version of await versionsOf(ctx, unit._id))
      if (version.kind === 'primary' && version.fileId !== source._id && version.fileId !== outputFileId && !(await isMissing(ctx, version.fileId)))
        replaced.add(version.fileId);
  for (const fileId of replaced) {
    // A primary that moved after the job was queued (a rename, say) isn't the file the worker replaced: delete it here.
    const file = await ctx.db.get(fileId);
    if (file && file.path !== payload.replacesPath)
      await enqueueJob(ctx, {
        payload: {
          class: 'maintenance',
          action: 'deleteLibraryFiles',
          paths: [file.path, ...(file.sidecars ?? []).map((sidecar) => sidecar.path)],
          libraryId: library._id,
          folders: [],
        },
        idempotencyKey: `deleteLibraryFiles:${fileId}`,
      });
    await removeVersions(ctx, fileId, true);
  }

  /** Each Unit's `staged` version of the output, waiting for its publish. */
  const staged: Id<'fileVersions'>[] = [];
  if (result.restored) {
    // The original's versions are the output's: `original` becomes `staged`.
    await removeVersions(ctx, source._id, false);
    for (const version of await ctx.db
      .query('fileVersions')
      .withIndex('by_file', (q) => q.eq('fileId', source._id))
      .collect()) {
      await ctx.db.patch(version._id, { kind: 'staged', fits: true, playbackProfileId: payload.targetProfileId });
      staged.push(version._id);
    }
  } else if (result.originalPath) {
    // `keep`: the source moved to originals/; Jellyfin no longer sees it.
    await ctx.db.patch(source._id, { path: result.originalPath, sidecars: result.originalSidecars ?? [] });
    await removeVersions(ctx, source._id, false);
    for (const version of await ctx.db
      .query('fileVersions')
      .withIndex('by_file', (q) => q.eq('fileId', source._id))
      .collect())
      await ctx.db.patch(version._id, { kind: 'original' });
  } else if (result.sourceRemoved) {
    // `replace`: only the library's path went; a torrent's seeding copy belongs to the download client.
    await removeVersions(ctx, source._id, true);
    for (const { rendition: other } of await pendingRenditions(ctx, source._id)) await cancelRendition(ctx, other);
  }

  if (!result.restored)
    for (const unit of units)
      staged.push(
        await ctx.db.insert('fileVersions', {
          unitId: unit._id,
          fileId: outputFileId,
          kind: 'staged',
          playbackProfileId: payload.targetProfileId,
          fits: true,
        }),
      );
  const publications: Doc<'publications'>[] = [];
  for (const fileVersionId of staged) {
    const { unitId } = (await ctx.db.get(fileVersionId))!;
    const publicationId = await ctx.db.insert('publications', { unitId, fileVersionId, generation: 0, target: 'jellyfin', state: 'pending' });
    publications.push((await ctx.db.get(publicationId))!);
  }
  // The Publications come first: the job's payload and key name them.
  const jobId = await enqueueJob(ctx, {
    payload: {
      class: 'publish',
      publicationIds: publications.map((publication) => publication._id),
      workFolderPath: await workFolderPathOf(ctx, library, work),
      items: publications.map((publication) => ({ publicationId: publication._id, path: result.outputPath })),
      library: { libraryId: library._id, root: library.rootPath, kind: library.kind },
    },
    idempotencyKey: publishKey(publications)!,
  });
  for (const publication of publications) await ctx.db.patch(publication._id, { jobId });
  for (const unit of units) await resolveIssuesForUnit(ctx, unit._id, ['transcodeFailed']);
  await recomputeUnits(ctx, ids(units));
}

/**
 * A held upgrade file whose preparation failed or was cancelled:
 * the staged source goes, rows and held folder, and nothing is raised, since
 * the old primary still plays. The release isn't blocklisted.
 */
async function heldEnded(
  ctx: MutationCtx,
  job: Doc<'jobs'>,
  rendition: Doc<'renditions'>,
  source: Doc<'files'>,
  outcome: 'failed' | 'cancelled',
): Promise<void> {
  const units = await unitsOfFile(ctx, source._id);
  const message =
    outcome === 'failed' ? 'Preparing the upgrade failed. The current file stays, and the upgrade file was removed.' : 'Preparation of the upgrade cancelled.';
  await transition(ctx, 'rendition', rendition._id, outcome, {
    kind: outcome === 'failed' ? 'stageFailed' : 'cancelled',
    message,
    ...(outcome === 'failed' && job.lastError ? { detail: job.lastError } : {}),
  });
  const work = units[0] && (await ctx.db.get(units[0].workId));
  if (work)
    await enqueueJob(ctx, {
      payload: { class: 'maintenance', action: 'deleteLibraryFiles', paths: [folderOf(source.path)], libraryId: work.libraryId, folders: [] },
      idempotencyKey: `deleteLibraryFiles:${source._id}`,
    });
  await removeVersions(ctx, source._id, true);
  await recomputeUnits(ctx, ids(units));
}

/**
 * `applyEnd`'s prepare branch: a terminal failure moves
 * the Rendition to `failed` and raises `transcodeFailed` (`pipelineError`
 * for that code) for each Unit of the source, with the failure's detail; the
 * artifact is already on the job. A cancel, or an expired lease with a
 * cancel asked, moves it to `cancelled` and raises nothing. `detail` is the
 * failure's `lastError`; without it, the job's last recorded one.
 */
export async function prepareEnded(
  ctx: MutationCtx,
  job: Doc<'jobs'>,
  outcome: 'failed' | 'cancelled',
  failureCode?: FailureCode,
  detail?: string,
): Promise<void> {
  if (job.payload?.class !== 'prepare') return;
  const rendition = await ctx.db.get(job.payload.renditionId);
  if (rendition?.state !== 'pending') return;
  const source = await ctx.db.get(rendition.sourceFileId);
  if (source && isHeld(source.path)) return await heldEnded(ctx, job, rendition, source, outcome);
  if (outcome === 'cancelled') {
    await transition(ctx, 'rendition', rendition._id, 'cancelled', { kind: 'cancelled', message: 'Preparation cancelled.' });
    return;
  }
  const lastError = detail ?? job.lastError;
  await transition(ctx, 'rendition', rendition._id, 'failed', {
    kind: 'stageFailed',
    message: 'Preparation failed. The original stays playable.',
    ...(failureCode ? { failureCode } : {}),
    ...(lastError ? { detail: lastError } : {}),
  });
  const units = await unitsOfFile(ctx, rendition.sourceFileId);
  const code: FailureCode = failureCode === 'pipelineError' ? 'pipelineError' : 'transcodeFailed';
  for (const unit of units) await raiseIssue(ctx, { code, unitId: unit._id, jobId: job._id, ...(lastError ? { detail: lastError } : {}) });
  await recomputeUnits(ctx, ids(units));
}
