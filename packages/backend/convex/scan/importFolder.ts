// The scan import: per folder, the Work (created
// through subscribe with the folder, monitoring nothing, when it is new),
// then `importFolder`, which records each matched file and enqueues one
// publish job for the files that stay where they are, and, when asked,
// monitors a new Work and searches only the Units that still have no file.
// A file Jellyfin would misread (`movesToLibraryNaming`) is moved to library
// naming in its Work folder first, and published once it is there. Nothing
// is prepared.
import { compare, movesToLibraryNaming, type ScanImportResponse } from '@omnarr/contracts';
import { parseRelease } from '@omnarr/parser';
import { zid, zodToConvex, zodToConvexFields } from 'convex-helpers/server/zod4';
import { ConvexError } from 'convex/values';
import { z } from 'zod';

import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { internalMutation, internalQuery, type ActionCtx, type MutationCtx } from '../_generated/server';
import { subscribeWork } from '../api/library';
import { enqueueJob } from '../jobs/queue';
import { recomputeUnits } from '../lib/derivedState';
import { moveToLibraryNaming, workFolderOf, workFolderPathOf } from '../library/naming';
import { startSearch } from '../pipeline/search';
import { publishKey } from '../pipeline/steps';
import { targetOf } from '../playback/target';
import { hasPrimary, recount } from './match';
import { isTracked, stemOf } from './report';
import { folderItems } from './review';

/** What the import needs to know of a folder before it creates a Work. */
export const folderToImport = internalQuery({
  args: zodToConvexFields({ scanRunId: zid('scanRuns'), libraryId: zid('libraries'), folder: z.string() }),
  returns: zodToConvex(
    z.object({
      matched: z.number(),
      work: z.object({ workId: zid('works').optional(), tmdbId: z.string(), kind: z.enum(['series', 'movie']) }).nullable(),
      /** Its files move to library naming, so the folder doesn't name the Work. */
      moves: z.boolean(),
    }),
  ),
  handler: async (ctx, { scanRunId, libraryId, folder }) => {
    const matched = (await folderItems(ctx, scanRunId, libraryId, folder)).filter((item) => item.status === 'matched' && item.match);
    const match = matched[0]?.match;
    return {
      matched: matched.length,
      work: match ? { ...(match.workId ? { workId: match.workId } : {}), tmdbId: match.tmdbId, kind: match.kind } : null,
      moves: match !== undefined && movesToLibraryNaming(match, folder, match.workId ? (await ctx.db.get(match.workId))?.folder : undefined),
    };
  },
});

/** The Units a matched item names in the Work's real Units: its own IDs, else its TMDB numbers (a Work the import just created). */
async function unitsOf(ctx: MutationCtx, work: Doc<'works'>, item: Doc<'scanItems'>): Promise<Id<'units'>[] | null> {
  const match = item.match!;
  if (match.workId === work._id && match.unitIds.length > 0) {
    const units = await Promise.all(match.unitIds.map((id) => ctx.db.get(id)));
    return units.every((unit) => unit?.workId === work._id) ? match.unitIds : null;
  }
  const all = await ctx.db
    .query('units')
    .withIndex('by_work', (q) => q.eq('workId', work._id))
    .collect();
  if (work.kind === 'movie') return all.length === 1 ? [all[0]!._id] : null;
  const ids: Id<'units'>[] = [];
  for (const label of match.units) {
    const unit = all.find((u) => u.tmdbSeason === label.season && u.tmdbEpisode === label.episode);
    if (!unit) return null;
    ids.push(unit._id);
  }
  return ids.length > 0 ? ids : null;
}

/**
 * `scan.importFolder`: checks each matched file against
 * `files` again, so a file an import recorded meanwhile isn't added twice;
 * resolves it against the Work's real Units; inserts its `files` row
 * (`origin = scan`, `keepsName`, its path as it is), links, a primary
 * version with `fits` and a pending Publication; then enqueues one publish
 * job for the files that stay, and one `moveLibraryFile` per file that
 * moves, whose Publication waits for the move. Files that no longer resolve
 * go back to `unmatched`.
 */
export async function importFolderOf(
  ctx: MutationCtx,
  { scanRunId, libraryId, folder, workId }: { scanRunId: Id<'scanRuns'>; libraryId: Id<'libraries'>; folder: string; workId: Id<'works'> },
): Promise<number> {
  const library = await ctx.db.get(libraryId);
  const work = await ctx.db.get(workId);
  if (!library || !work) return 0;
  const target = await targetOf(ctx, libraryId);
  const items = (await folderItems(ctx, scanRunId, libraryId, folder)).filter((item) => item.status === 'matched' && item.match && item.probe);
  // Only a folder whose files stay names the Work; one whose files move gives the Work the library's folder name.
  // Once the Work has a folder, a file in any other folder moves into it (one Work, one folder).
  if (work.folder === undefined && folder !== '' && items.some((item) => !movesToLibraryNaming(item.match!, folder, undefined)))
    await ctx.db.patch(workId, { folder });
  else if (work.folder === undefined && items.length > 0) await ctx.db.patch(workId, { folder: await workFolderOf(ctx, work) });
  const workFolder = (await ctx.db.get(workId))!.folder;
  const publications: { _id: Id<'publications'>; generation: number; path: string }[] = [];
  const moving: Id<'files'>[] = [];
  const touched: Id<'units'>[] = [];
  let imported = 0;
  for (const item of items) {
    if (await isTracked(ctx, item.path, item.inode)) {
      await ctx.db.patch(item._id, { status: 'conflict' });
      continue;
    }
    const unitIds = await unitsOf(ctx, work, item);
    if (!unitIds) {
      await ctx.db.patch(item._id, { status: 'unmatched', unmatchedReason: 'unitNotFound' });
      continue;
    }
    if (await hasPrimary(ctx, unitIds)) {
      await ctx.db.patch(item._id, { status: 'conflict' });
      continue;
    }
    const fits = compare(item.probe!, target).fits;
    const fileId = await ctx.db.insert('files', {
      path: item.path,
      sizeBytes: item.sizeBytes,
      inode: item.inode,
      probe: item.probe!,
      origin: 'scan',
      role: 'source',
      keepsName: true,
      release: parseRelease(stemOf(item.path), work.kind),
    });
    const moves = movesToLibraryNaming(item.match!, folder, workFolder);
    if (moves) moving.push(fileId);
    for (const [i, unitId] of unitIds.entries()) {
      await ctx.db.insert('fileUnits', { fileId, unitId, ...(unitIds.length > 1 ? { part: i + 1 } : {}) });
      const fileVersionId = await ctx.db.insert('fileVersions', { unitId, fileId, kind: 'primary', playbackProfileId: library.playbackProfileId, fits });
      const publicationId = await ctx.db.insert('publications', { unitId, fileVersionId, generation: 0, target: 'jellyfin', state: 'pending' });
      if (!moves) publications.push({ _id: publicationId, generation: 0, path: item.path });
      touched.push(unitId);
    }
    await ctx.db.patch(item._id, { status: 'imported', match: { ...item.match!, workId, unitIds } });
    imported += 1;
  }
  if (publications.length > 0) {
    // Jellyfin already lists the files; publish finds their items, and checks they are under the Work folder's series.
    const jobId = await enqueueJob(ctx, {
      payload: {
        class: 'publish',
        publicationIds: publications.map((p) => p._id),
        workFolderPath: await workFolderPathOf(ctx, library, (await ctx.db.get(workId))!),
        items: publications.map((p) => ({ publicationId: p._id, path: p.path })),
        library: { libraryId, root: library.rootPath, kind: library.kind },
      },
      idempotencyKey: publishKey(publications)!,
    });
    for (const publication of publications) await ctx.db.patch(publication._id, { jobId });
  }
  for (const fileId of moving) await moveToLibraryNaming(ctx, fileId);
  await recomputeUnits(ctx, touched);
  await recount(ctx, scanRunId);
  return imported;
}

export const importFolder = internalMutation({
  args: zodToConvexFields({ scanRunId: zid('scanRuns'), libraryId: zid('libraries'), folder: z.string(), workId: zid('works') }),
  returns: zodToConvex(z.number()),
  handler: (ctx, args) => importFolderOf(ctx, args),
});

/**
 * "After import, series are: Monitored" for a Work the import created: its
 * aired Units are monitored, and new ones will be, and `search.start` runs
 * only for those that still have no file.
 */
export const monitorImported = internalMutation({
  args: zodToConvexFields({ workId: zid('works') }),
  returns: zodToConvex(z.null()),
  handler: async (ctx, { workId }) => {
    const now = Date.now();
    await ctx.db.patch(workId, { monitorNewUnits: true });
    const units = await ctx.db
      .query('units')
      .withIndex('by_work', (q) => q.eq('workId', workId))
      .collect();
    const wanted: Id<'units'>[] = [];
    for (const unit of units) {
      if (unit.kind === 'special' || unit.airDateUtc === undefined || unit.airDateUtc > now) continue;
      if (!unit.monitored) await ctx.db.patch(unit._id, { monitored: true });
      const versions = await ctx.db
        .query('fileVersions')
        .withIndex('by_unit', (q) => q.eq('unitId', unit._id))
        .first();
      if (!versions) wanted.push(unit._id);
    }
    await recomputeUnits(
      ctx,
      units.map((unit) => unit._id),
    );
    if (wanted.length > 0) await startSearch(ctx, wanted, 'manual');
    return null;
  },
});

/** `scan.import`. */
export async function importScan(
  ctx: ActionCtx,
  request: {
    scanRunId: Id<'scanRuns'>;
    folders: { libraryId: Id<'libraries'>; folder: string }[];
    releaseProfileId: Id<'releaseProfiles'>;
    monitor: boolean;
  },
): Promise<ScanImportResponse> {
  const { scanRunId, releaseProfileId, monitor } = request;
  const response: ScanImportResponse = { imported: 0, works: 0, failed: [] };
  const folders = await Promise.all(
    request.folders.map(async ({ libraryId, folder }) => ({
      libraryId,
      folder,
      state: await ctx.runQuery(internal.scan.importFolder.folderToImport, { scanRunId, libraryId, folder }),
    })),
  );
  // Folders whose files stay go first, so one of them names a new Work before a folder whose files move does.
  folders.sort((a, b) => Number(a.state.moves) - Number(b.state.moves));
  for (const { libraryId, folder, state } of folders) {
    if (!state.work || state.matched === 0) continue;
    let workId = state.work.workId;
    let created = false;
    if (!workId) {
      try {
        const result = await subscribeWork(ctx, {
          tmdbId: state.work.tmdbId,
          kind: state.work.kind,
          libraryId,
          releaseProfileId,
          seasons: [],
          monitorNewUnits: false,
          ...(folder === '' || state.moves ? {} : { folder }),
        });
        workId = result.workId;
        created = result.created;
      } catch (error) {
        const message =
          error instanceof ConvexError
            ? String((error.data as { message?: string }).message ?? 'The title could not be added.')
            : 'The title could not be added.';
        response.failed.push({ libraryId, folder, message });
        continue;
      }
    }
    response.imported += await ctx.runMutation(internal.scan.importFolder.importFolder, { scanRunId, libraryId, folder, workId });
    if (created) {
      response.works += 1;
      if (monitor) await ctx.runMutation(internal.scan.importFolder.monitorImported, { workId });
    }
  }
  return response;
}
