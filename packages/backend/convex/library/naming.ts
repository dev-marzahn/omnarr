// What names a library file, and the renames after a title change
//. The names themselves come from contracts'
// `libraryFileName`, the only function that names a library file.
import { folderTitle, type JobResult, libraryFileName, type NamedUnit, type NamingContext, sidecarName, workFolderName } from '@omnarr/contracts';
import { qualityOf } from '@omnarr/scoring';
import { zid, zodToConvex, zodToConvexFields } from 'convex-helpers/server/zod4';
import { z } from 'zod';

import type { Doc, Id } from '../_generated/dataModel';
import { internalMutation, type MutationCtx, type QueryCtx } from '../_generated/server';
import { enqueueJob } from '../jobs/queue';
import { transition } from '../lib/stateMachine';
import { publishKey } from '../pipeline/steps';

/** The folder of a path, without its trailing slash. */
export const folderOf = (path: string): string => path.slice(0, path.lastIndexOf('/'));
/** The last segment of a path. */
export const fileNameOf = (path: string): string => path.slice(path.lastIndexOf('/') + 1);
/** The extension with its dot, `''` for none. */
export const extensionOf = (path: string): string => {
  const name = fileNameOf(path);
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot) : '';
};
/** The name without its extension. */
export const baseNameOf = (path: string): string => {
  const name = fileNameOf(path);
  return name.slice(0, name.length - extensionOf(path).length);
};

/** The Work's TMDB ID from its `externalIds` row. */
export async function tmdbIdOf(ctx: QueryCtx, workId: Id<'works'>): Promise<number> {
  const row = await ctx.db
    .query('externalIds')
    .withIndex('by_work', (q) => q.eq('workId', workId))
    .filter((q) => q.eq(q.field('provider'), 'tmdb'))
    .first();
  return Number(row?.value);
}

/** The Work's stored folder, or the one its first import would choose. */
export async function workFolderOf(ctx: QueryCtx, work: Doc<'works'>): Promise<string> {
  if (work.folder !== undefined) return work.folder;
  return workFolderName({ kind: work.kind, title: work.title, ...(work.year !== undefined ? { year: work.year } : {}), tmdbId: await tmdbIdOf(ctx, work._id) });
}

/** The absolute path of the Work's folder, as a publish job's `workFolderPath`. */
export async function workFolderPathOf(ctx: QueryCtx, library: Doc<'libraries'>, work: Doc<'works'>): Promise<string> {
  return `${library.rootPath}/${await workFolderOf(ctx, work)}`;
}

/** A file's Units in part order (`fileUnits.part`). */
export async function unitsOfFile(ctx: QueryCtx, fileId: Id<'files'>): Promise<Doc<'units'>[]> {
  const links = await ctx.db
    .query('fileUnits')
    .withIndex('by_file', (q) => q.eq('fileId', fileId))
    .collect();
  links.sort((a, b) => (a.part ?? 0) - (b.part ?? 0));
  const units = await Promise.all(links.map((link) => ctx.db.get(link.unitId)));
  return units.filter((unit) => unit !== null);
}

/** The Units as a file name names them: TMDB numbers, the absolute number for anime, the title. */
export async function namedUnits(ctx: QueryCtx, work: Doc<'works'>, units: Doc<'units'>[]): Promise<NamedUnit[]> {
  return await Promise.all(
    units.map(async (unit): Promise<NamedUnit> => {
      const absolute =
        work.numberingScheme === 'anime'
          ? await ctx.db
              .query('unitMappings')
              .withIndex('by_unit', (q) => q.eq('unitId', unit._id))
              .filter((q) => q.eq(q.field('ordering'), 'absolute'))
              .first()
          : null;
      return {
        ...(unit.tmdbSeason !== undefined ? { season: unit.tmdbSeason } : {}),
        ...(unit.tmdbEpisode !== undefined ? { episode: unit.tmdbEpisode } : {}),
        ...(absolute?.absolute !== undefined ? { absolute: absolute.absolute } : {}),
        ...(unit.title !== undefined ? { title: unit.title } : {}),
      };
    }),
  );
}

/**
 * What names a file of the Work: the title and year of its stored
 * folder, its TMDB ID, and the file's release with its quality, the
 * candidate's when it still exists, as the import named it. Undefined for a
 * file without a release (a scanned file keeps its name anyway).
 */
export async function namingContextOf(ctx: QueryCtx, work: Doc<'works'>, file: Doc<'files'>): Promise<NamingContext | undefined> {
  if (!file.release) return undefined;
  const folder = folderTitle(await workFolderOf(ctx, work));
  const candidate = file.candidateId ? await ctx.db.get(file.candidateId) : null;
  return {
    kind: work.kind,
    title: folder.title,
    ...(folder.year !== undefined ? { year: folder.year } : {}),
    tmdbId: await tmdbIdOf(ctx, work._id),
    anime: work.numberingScheme === 'anime',
    release: { ...file.release, quality: candidate?.quality ?? qualityOf(file.release).quality },
  };
}

/** A pending Rendition of any file of these Units: a rename would race its swap. */
async function preparing(ctx: QueryCtx, units: Doc<'units'>[]): Promise<boolean> {
  for (const unit of units) {
    const links = await ctx.db
      .query('fileUnits')
      .withIndex('by_unit', (q) => q.eq('unitId', unit._id))
      .collect();
    for (const { fileId } of links) {
      const pending = await ctx.db
        .query('renditions')
        .withIndex('by_source_file', (q) => q.eq('sourceFileId', fileId))
        .filter((q) => q.eq(q.field('state'), 'pending'))
        .first();
      if (pending) return true;
    }
  }
  return false;
}

/**
 * The metadata sync changed these Units' titles. Each primary file of them
 * that doesn't keep its name and isn't being prepared gets the name
 * `libraryFileName` builds from its stored probe and release; a changed name
 * enqueues one `renameLibraryFile`, with its sidecars renamed beside it.
 * Returns how many renames it enqueued.
 */
export async function unitsRetitled(ctx: MutationCtx, unitIds: Id<'units'>[]): Promise<number> {
  const fileIds = new Set<Id<'files'>>();
  for (const unitId of new Set(unitIds)) {
    const versions = await ctx.db
      .query('fileVersions')
      .withIndex('by_unit', (q) => q.eq('unitId', unitId))
      .collect();
    for (const version of versions) if (version.kind === 'primary') fileIds.add(version.fileId);
  }
  let enqueued = 0;
  for (const fileId of fileIds) {
    const file = await ctx.db.get(fileId);
    if (!file?.probe || file.keepsName) continue;
    const units = await unitsOfFile(ctx, fileId);
    const work = units[0] && (await ctx.db.get(units[0].workId));
    if (!work || (await preparing(ctx, units))) continue;
    const naming = await namingContextOf(ctx, work, file);
    if (!naming) continue;
    const folder = folderOf(file.path);
    const name = libraryFileName({ naming, units: await namedUnits(ctx, work, units), probe: file.probe, ext: extensionOf(file.path) });
    const to = `${folder}/${name}`;
    if (to === file.path) continue;
    const taken = new Set<string>();
    const sidecars: { from: string; to: string }[] = (file.sidecars ?? []).map((sidecar) => ({
      from: sidecar.path,
      to: `${folder}/${sidecarName(baseNameOf(to), sidecar, taken)}`,
    }));
    await enqueueJob(ctx, {
      payload: { class: 'maintenance', action: 'renameLibraryFile', fileId, from: file.path, to, sidecars },
      idempotencyKey: `renameLibraryFile:${fileId}:${to}`,
    });
    enqueued += 1;
  }
  return enqueued;
}

/**
 * A scanned file Jellyfin would misread goes to library naming: one
 * `moveLibraryFile` job, which names the file and places it in the Work
 * folder as the import does. A Work
 * without a stored folder gets the library's folder name now. Returns
 * whether it enqueued the job.
 */
export async function moveToLibraryNaming(ctx: MutationCtx, fileId: Id<'files'>): Promise<boolean> {
  const file = await ctx.db.get(fileId);
  const units = await unitsOfFile(ctx, fileId);
  const found = units[0] && (await ctx.db.get(units[0].workId));
  const library = found && (await ctx.db.get(found.libraryId));
  if (!file?.probe || !found || !library) return false;
  if (found.folder === undefined) await ctx.db.patch(found._id, { folder: await workFolderOf(ctx, found) });
  const work = (await ctx.db.get(found._id))!;
  const naming = await namingContextOf(ctx, work, file);
  if (!naming) return false;
  await enqueueJob(ctx, {
    payload: {
      class: 'maintenance',
      action: 'moveLibraryFile',
      fileId,
      from: file.path,
      inode: file.inode,
      workFolderPath: await workFolderPathOf(ctx, library, work),
      naming,
      units: await namedUnits(ctx, work, units),
      probe: file.probe,
    },
    idempotencyKey: `moveLibraryFile:${fileId}:${file.path}`,
  });
  return true;
}

/**
 * The `moveToLibraryNaming` fix of a `jellyfinMisread` Issue, which
 * `issues.act` runs: the Unit's primary file, when it still keeps its
 * scanned name, is moved to library naming, and the move's result publishes
 * it again. A library-named file has nothing to move (`queued: 0`).
 */
export const moveUnitToLibraryNaming = internalMutation({
  args: zodToConvexFields({ unitId: zid('units') }),
  returns: zodToConvex(z.object({ queued: z.number() })),
  handler: async (ctx, { unitId }) => ({ queued: await moveUnitFiles(ctx, unitId) }),
});

/** `moveUnitToLibraryNaming`'s body, which `issues.act` calls: how many moves it enqueued. */
export async function moveUnitFiles(ctx: MutationCtx, unitId: Id<'units'>): Promise<number> {
  const versions = await ctx.db
    .query('fileVersions')
    .withIndex('by_unit', (q) => q.eq('unitId', unitId))
    .collect();
  let queued = 0;
  for (const version of versions) {
    const file = version.kind === 'primary' ? await ctx.db.get(version.fileId) : null;
    if (file?.keepsName && (await moveToLibraryNaming(ctx, file._id))) queued += 1;
  }
  return queued;
}

/**
 * `results.maintenance` for `renameLibraryFile`: the file's new path
 * and sidecars, each of its `visible` Publications reset to `pending` with
 * the next generation (keeping its `targetItemRef`, so the Unit keeps its
 * state), and one publish job for them.
 */
export async function renamed(
  ctx: MutationCtx,
  job: Doc<'jobs'>,
  result: Extract<JobResult, { class: 'maintenance'; action: 'renameLibraryFile' }>,
): Promise<void> {
  if (job.payload?.class !== 'maintenance' || job.payload.action !== 'renameLibraryFile') return;
  const { fileId, from, sidecars: moves } = job.payload;
  const file = await ctx.db.get(fileId);
  // A file replaced or moved while the rename was leased keeps its row as it is (the claim drops a queued one).
  if (file?.path !== from) return;
  const to = new Map(moves.map((move) => [move.from, move.to]));
  await ctx.db.patch(fileId, {
    path: result.path,
    ...(file.sidecars ? { sidecars: file.sidecars.map((sidecar) => ({ ...sidecar, path: to.get(sidecar.path) ?? sidecar.path })) } : {}),
  });
  await publishAt(ctx, fileId, result.path, { visible: true });
}

/**
 * `results.maintenance` for `moveLibraryFile`: the file's library path and
 * the sidecars that moved with it, and it is library-named from now on, so
 * the title-change renames apply to it and them. Its
 * Publications are published from the Work folder: the import's, which
 * waited for the move, and a `visible` or `failed` one when a fix moved it.
 */
export async function moved(ctx: MutationCtx, job: Doc<'jobs'>, result: Extract<JobResult, { class: 'maintenance'; action: 'moveLibraryFile' }>) {
  if (job.payload?.class !== 'maintenance' || job.payload.action !== 'moveLibraryFile') return;
  const { fileId } = job.payload;
  if (!(await ctx.db.get(fileId))) return;
  await ctx.db.patch(fileId, { path: result.path, keepsName: undefined, ...(result.sidecars?.length ? { sidecars: result.sidecars } : {}) });
  await publishAt(ctx, fileId, result.path, { visible: true, failed: true, waiting: true });
}

/**
 * Publishes a file at its new path: its Publications in the chosen states go
 * `pending` with the next generation (a `visible` one keeps its
 * `targetItemRef`, so the Unit keeps its state), a `pending` one with no job
 * yet (`waiting`) as it is, and one publish job takes them. The
 * "Retry now" on `jellyfinUnavailable` publishes a `failed` one again.
 */
export async function publishAt(
  ctx: MutationCtx,
  fileId: Id<'files'>,
  path: string,
  from: { visible?: boolean; failed?: boolean; waiting?: boolean },
  message = 'Publishing the renamed file.',
): Promise<void> {
  const versions = await ctx.db
    .query('fileVersions')
    .withIndex('by_file', (q) => q.eq('fileId', fileId))
    .collect();
  const reset: Doc<'publications'>[] = [];
  for (const version of versions) {
    const publications = await ctx.db
      .query('publications')
      .withIndex('by_unit', (q) => q.eq('unitId', version.unitId))
      .filter((q) => q.eq(q.field('fileVersionId'), version._id))
      .collect();
    for (const publication of publications) {
      if (publication.state === 'pending' && publication.jobId === undefined && from.waiting) reset.push(publication);
      if ((publication.state === 'visible' && from.visible) || (publication.state === 'failed' && from.failed)) {
        await ctx.db.patch(publication._id, { generation: publication.generation + 1 });
        await transition(ctx, 'publication', publication._id, 'pending', { kind: 'stageStarted', message });
        reset.push({ ...publication, generation: publication.generation + 1 });
      }
    }
  }
  const key = publishKey(reset);
  const unit = versions[0] && (await ctx.db.get(versions[0].unitId));
  const work = unit && (await ctx.db.get(unit.workId));
  const library = work && (await ctx.db.get(work.libraryId));
  if (!key || !work || !library) return;
  const jobId = await enqueueJob(ctx, {
    payload: {
      class: 'publish',
      publicationIds: reset.map((publication) => publication._id),
      workFolderPath: await workFolderPathOf(ctx, library, work),
      items: reset.map((publication) => ({ publicationId: publication._id, path })),
      library: { libraryId: library._id, root: library.rootPath, kind: library.kind },
    },
    idempotencyKey: key,
  });
  for (const publication of reset) await ctx.db.patch(publication._id, { jobId });
}
