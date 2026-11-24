// The library's size on disk, summed from the files omnarr tracks. An
// action pages over `files`, because one read of the whole table (each row
// with its probe, and the Unit and Work that say its kind) would pass a
// query's read limit on a big library, and a reactive query would rerun on
// every import.
import { type LibrarySize, WorkKind } from '@omnarr/contracts';
import { zodToConvex } from 'convex-helpers/server/zod4';
import { paginationOptsValidator } from 'convex/server';
import { v } from 'convex/values';
import { z } from 'zod';

import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { type ActionCtx, internalQuery } from '../_generated/server';

/** Files per page: each costs up to three more reads (its link, Unit and Work). */
export const LIBRARY_SIZE_PAGE = 250;

const SizedFile = z.object({ inode: z.string(), sizeBytes: z.number(), kind: WorkKind });

/**
 * One page of `files`: each file linked to a Unit, with its inode, size and
 * Work kind. A file no Unit links (a leftover) isn't the library's.
 */
export const sizedFiles = internalQuery({
  args: { paginationOpts: paginationOptsValidator },
  returns: v.object({ files: zodToConvex(z.array(SizedFile)), continueCursor: v.string(), isDone: v.boolean() }),
  handler: async (ctx, { paginationOpts }) => {
    const page = await ctx.db.query('files').paginate(paginationOpts);
    const kindOfUnit = new Map<Id<'units'>, WorkKind | null>();
    const kindOfWork = new Map<Id<'works'>, WorkKind | null>();
    const kindOf = async (unitId: Id<'units'>): Promise<WorkKind | null> => {
      if (!kindOfUnit.has(unitId)) {
        const unit = await ctx.db.get(unitId);
        if (unit && !kindOfWork.has(unit.workId)) kindOfWork.set(unit.workId, (await ctx.db.get(unit.workId))?.kind ?? null);
        kindOfUnit.set(unitId, unit ? (kindOfWork.get(unit.workId) ?? null) : null);
      }
      return kindOfUnit.get(unitId) ?? null;
    };
    const files: z.infer<typeof SizedFile>[] = [];
    for (const file of page.page) {
      const link = await ctx.db
        .query('fileUnits')
        .withIndex('by_file', (q) => q.eq('fileId', file._id))
        .first();
      const kind = link ? await kindOf(link.unitId) : null;
      if (kind) files.push({ inode: file.inode, sizeBytes: file.sizeBytes, kind });
    }
    return { files, continueCursor: page.continueCursor, isDone: page.isDone };
  },
});

/** Sums every page; an inode seen before (a hardlink, a file recorded twice) adds nothing. */
export async function librarySizeOf(ctx: ActionCtx): Promise<LibrarySize> {
  const seen = new Set<string>();
  const bytes: Record<WorkKind, number> = { series: 0, movie: 0 };
  let cursor: string | null = null;
  for (;;) {
    const page: { files: z.infer<typeof SizedFile>[]; continueCursor: string; isDone: boolean } = await ctx.runQuery(internal.library.size.sizedFiles, {
      paginationOpts: { cursor, numItems: LIBRARY_SIZE_PAGE },
    });
    for (const file of page.files) {
      if (seen.has(file.inode)) continue;
      seen.add(file.inode);
      bytes[file.kind] += file.sizeBytes;
    }
    if (page.isDone) break;
    cursor = page.continueCursor;
  }
  return { totalBytes: bytes.series + bytes.movie, seriesBytes: bytes.series, moviesBytes: bytes.movie, measuredAt: Date.now() };
}
