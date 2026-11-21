// Creating a Work (library.subscribe). The subscribe
// action fetches the metadata; this mutation checks for the title and
// inserts the Work row, its `tmdb` ID and its `workMetadata` row in one
// transaction. Its Units and mappings come from `applySnapshot`.
import { LIBRARY_OF, NumberingScheme, SubscribeRequest, SubscribeResponse, WorkPreviewRequest } from '@omnarr/contracts';
import { zid, zodToConvex, zodToConvexFields } from 'convex-helpers/server/zod4';
import { ConvexError } from 'convex/values';
import { z } from 'zod';

import type { Id } from '../_generated/dataModel';
import { internalMutation, internalQuery, type QueryCtx } from '../_generated/server';
import { WorkMetadata } from '../metadata/provider';

/** The tick leaves a new Work alone for this long, so it doesn't sync beside subscribe's first write. */
export const FIRST_SYNC_DELAY_MS = 60 * 60 * 1000;

/** The Work subscribed to with this TMDB ID and kind, if any. Episode IDs share the `tmdb` provider, so rows of Units are skipped. */
export async function findWorkByTmdbId(ctx: QueryCtx, tmdbId: string, kind: WorkMetadata['kind']): Promise<Id<'works'> | null> {
  const rows = await ctx.db
    .query('externalIds')
    .withIndex('by_provider_value', (q) => q.eq('provider', 'tmdb').eq('value', tmdbId))
    .collect();
  for (const row of rows) {
    if (!row.workId) continue;
    const work = await ctx.db.get(row.workId);
    if (work?.kind === kind) return work._id;
  }
  return null;
}

/** The Works subscribed to with these TMDB IDs, in order; null where there is none. For "In library". */
export const findWorks = internalQuery({
  args: zodToConvexFields({ refs: z.array(WorkPreviewRequest) }),
  returns: zodToConvex(z.array(zid('works').nullable())),
  handler: (ctx, { refs }) => Promise.all(refs.map(({ tmdbId, kind }) => findWorkByTmdbId(ctx, tmdbId, kind))),
});

export const insertWork = internalMutation({
  args: zodToConvexFields({
    ...SubscribeRequest.pick({ libraryId: true, releaseProfileId: true, seasons: true, monitorNewUnits: true, folder: true }).shape,
    numberingScheme: NumberingScheme,
    work: WorkMetadata.pick({ kind: true, tmdbId: true, title: true, year: true }),
  }),
  returns: zodToConvex(SubscribeResponse),
  handler: async (ctx, { libraryId, releaseProfileId, seasons, numberingScheme, monitorNewUnits, folder, work }) => {
    const existing = await findWorkByTmdbId(ctx, work.tmdbId, work.kind);
    if (existing) return { workId: existing, created: false };

    const library = await ctx.db.get(libraryId);
    if (!library) throw new ConvexError({ code: 'notFound', message: 'The library does not exist.' });
    if (library.kind !== LIBRARY_OF[work.kind])
      throw new ConvexError({ code: 'wrongLibrary', message: `A ${work.kind} belongs in the ${LIBRARY_OF[work.kind]} library.` });
    if (!(await ctx.db.get(releaseProfileId))) throw new ConvexError({ code: 'notFound', message: 'The release profile does not exist.' });

    const workId = await ctx.db.insert('works', {
      libraryId,
      kind: work.kind,
      title: work.title,
      year: work.year,
      numberingScheme,
      releaseProfileId,
      monitorNewUnits: monitorNewUnits ?? true,
      // A scanned folder is the Work's folder from the start.
      ...(folder === undefined ? {} : { folder }),
    });
    await ctx.db.insert('externalIds', { workId, provider: 'tmdb', value: work.tmdbId });
    await ctx.db.insert('workMetadata', {
      workId,
      buildState: 'building',
      initialSeasons: seasons,
      mappingNotes: [],
      projectionVersion: 0,
      nextSyncAt: Date.now() + FIRST_SYNC_DELAY_MS,
    });
    return { workId, created: true };
  },
});
