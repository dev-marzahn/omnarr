// Writes of the mapping sources' data: Anime-Lists entries
// in batches, each source's state and health, and the syncs a change starts.
import { MappingSourceName } from '@omnarr/contracts';
import { zodToConvex, zodToConvexFields } from 'convex-helpers/server/zod4';
import { z } from 'zod';

import type { Id } from '../_generated/dataModel';
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from '../_generated/server';
import { findWorkByTmdbId } from '../library/works';
import { recordHealthIn } from '../metadata/keys';
import { enqueueSync } from '../metadata/pool';
import { AnimeListEntry } from './animeListsParse';
import { SceneMappingEntry } from './sceneMappingsParse';
import { XemName, XemShowNames } from './xemNamesParse';

const stateOf = (ctx: QueryCtx, source: MappingSourceName) =>
  ctx.db
    .query('mappingSourceState')
    .withIndex('by_source', (q) => q.eq('source', source))
    .unique();

export const sourceState = internalQuery({
  args: zodToConvexFields({ source: MappingSourceName }),
  returns: zodToConvex(z.object({ version: z.string().optional(), etag: z.string().optional(), xemTvdbIds: z.array(z.number()).optional() })),
  handler: async (ctx, { source }) => {
    const state = await stateOf(ctx, source);
    return { version: state?.version, etag: state?.etag, xemTvdbIds: state?.xemTvdbIds };
  },
});

const STALE_PAGE = 500;

type ListRow = { _id: Id<'animeListEntries' | 'sceneMappings' | 'xemNames'> };

async function deleteStalePage<Row extends ListRow>(
  ctx: MutationCtx,
  read: (side: 'lt' | 'gt', limit: number) => Promise<Row[]>,
): Promise<{ deleted: Row[]; done: boolean }> {
  const before = await read('lt', STALE_PAGE);
  const after = before.length < STALE_PAGE ? await read('gt', STALE_PAGE - before.length) : [];
  const deleted = [...before, ...after];
  for (const row of deleted) await ctx.db.delete(row._id);
  return { deleted, done: deleted.length < STALE_PAGE };
}

const StalePage = zodToConvex(z.object({ ids: z.array(z.number()), done: z.boolean() }));

/**
 * Writes one batch of a fetched file's entries: every entry gets the new
 * `seenVersion`, and only a new entry or one whose `contentHash` changed gets
 * its other fields written. Returns the TMDB series IDs those link, before
 * and after, so their Works sync.
 */
export const writeAnimeListEntries = internalMutation({
  args: zodToConvexFields({ version: z.string(), batch: z.array(AnimeListEntry) }),
  returns: zodToConvex(z.array(z.number())),
  handler: async (ctx, { version, batch }) => {
    const changed = new Set<number>();
    for (const entry of batch) {
      const existing = await ctx.db
        .query('animeListEntries')
        .withIndex('by_anidb', (q) => q.eq('anidbId', entry.anidbId))
        .unique();
      if (existing && existing.contentHash === entry.contentHash) {
        if (existing.seenVersion !== version) await ctx.db.patch(existing._id, { seenVersion: version });
        continue;
      }
      if (existing) {
        if (existing.tmdbTvId !== undefined) changed.add(existing.tmdbTvId);
        await ctx.db.replace(existing._id, { ...entry, seenVersion: version });
      } else {
        await ctx.db.insert('animeListEntries', { ...entry, seenVersion: version });
      }
      if (entry.tmdbTvId !== undefined) changed.add(entry.tmdbTvId);
    }
    return [...changed];
  },
});

export const deleteStaleEntries = internalMutation({
  args: zodToConvexFields({ version: z.string() }),
  returns: StalePage,
  handler: async (ctx, { version }) => {
    const { deleted, done } = await deleteStalePage(ctx, (side, limit) =>
      ctx.db
        .query('animeListEntries')
        .withIndex('by_seen_version', (q) => q[side]('seenVersion', version))
        .take(limit),
    );
    return { ids: deleted.flatMap((entry) => (entry.tmdbTvId === undefined ? [] : [entry.tmdbTvId])), done };
  },
});

/**
 * Writes one batch of Sonarr's scene mappings: every row gets the new
 * `seenVersion`; a new or changed one is written. Returns the TVDB IDs whose
 * names changed, before and after, so their Works sync.
 */
export const writeSceneMappings = internalMutation({
  args: zodToConvexFields({ version: z.string(), batch: z.array(SceneMappingEntry) }),
  returns: zodToConvex(z.array(z.number())),
  handler: async (ctx, { version, batch }) => {
    const changed = new Set<number>();
    for (const entry of batch) {
      const existing = await ctx.db
        .query('sceneMappings')
        .withIndex('by_mapping', (q) => q.eq('mappingId', entry.mappingId))
        .first();
      if (existing && existing.tvdbId === entry.tvdbId && existing.title === entry.title) {
        if (existing.seenVersion !== version) await ctx.db.patch(existing._id, { seenVersion: version });
        continue;
      }
      if (existing) {
        changed.add(existing.tvdbId);
        await ctx.db.replace(existing._id, { ...entry, seenVersion: version });
      } else {
        await ctx.db.insert('sceneMappings', { ...entry, seenVersion: version });
      }
      changed.add(entry.tvdbId);
    }
    return [...changed];
  },
});

export const deleteStaleSceneMappings = internalMutation({
  args: zodToConvexFields({ version: z.string() }),
  returns: StalePage,
  handler: async (ctx, { version }) => {
    const { deleted, done } = await deleteStalePage(ctx, (side, limit) =>
      ctx.db
        .query('sceneMappings')
        .withIndex('by_seen_version', (q) => q[side]('seenVersion', version))
        .take(limit),
    );
    return { ids: deleted.map((row) => row.tvdbId), done };
  },
});

const sameNames = (a: XemName[], b: XemName[]) =>
  a.length === b.length && a.every((name, i) => name.title === b[i]!.title && name.sceneSeason === b[i]!.sceneSeason);

export const writeXemNames = internalMutation({
  args: zodToConvexFields({ version: z.string(), batch: z.array(XemShowNames) }),
  returns: zodToConvex(z.array(z.number())),
  handler: async (ctx, { version, batch }) => {
    const changed: number[] = [];
    for (const show of batch) {
      const existing = await ctx.db
        .query('xemNames')
        .withIndex('by_tvdb', (q) => q.eq('tvdbId', show.tvdbId))
        .unique();
      if (existing && sameNames(existing.names, show.names)) {
        if (existing.seenVersion !== version) await ctx.db.patch(existing._id, { seenVersion: version });
        continue;
      }
      if (existing) await ctx.db.replace(existing._id, { ...show, seenVersion: version });
      else await ctx.db.insert('xemNames', { ...show, seenVersion: version });
      changed.push(show.tvdbId);
    }
    return changed;
  },
});

export const deleteStaleXemNames = internalMutation({
  args: zodToConvexFields({ version: z.string() }),
  returns: StalePage,
  handler: async (ctx, { version }) => {
    const { deleted, done } = await deleteStalePage(ctx, (side, limit) =>
      ctx.db
        .query('xemNames')
        .withIndex('by_seen_version', (q) => q[side]('seenVersion', version))
        .take(limit),
    );
    return { ids: deleted.map((row) => row.tvdbId), done };
  },
});

/** The Works holding a TVDB ID: Work rows only, as `findWorkByTmdbId` does for TMDB. */
async function worksByTvdbId(ctx: MutationCtx, tvdbId: number): Promise<Id<'works'>[]> {
  const rows = await ctx.db
    .query('externalIds')
    .withIndex('by_provider_value', (q) => q.eq('provider', 'tvdb').eq('value', String(tvdbId)))
    .collect();
  return rows.flatMap((row) => (row.workId ? [row.workId] : []));
}

export const recordSourceFetch = internalMutation({
  args: zodToConvexFields({
    source: MappingSourceName,
    version: z.string().optional(),
    etag: z.string().optional(),
    xemTvdbIds: z.array(z.number()).optional(),
    changedTvdbIds: z.array(z.number()).optional(),
  }),
  returns: zodToConvex(z.null()),
  handler: async (ctx, { source, version, etag, xemTvdbIds, changedTvdbIds }) => {
    const now = Date.now();
    const state = await stateOf(ctx, source);
    const fields = { ...(version !== undefined ? { version } : {}), ...(etag !== undefined ? { etag } : {}), ...(xemTvdbIds ? { xemTvdbIds } : {}) };
    if (state) await ctx.db.patch(state._id, fields);
    else await ctx.db.insert('mappingSourceState', { source, lastAttemptAt: now, ...fields });
    await recordHealthIn(ctx, { source, outcome: 'success', at: now });

    await resyncWorks(ctx, { tvdbIds: changedTvdbIds });
    return null;
  },
});

const ResyncIds = z.object({ tvdbIds: z.array(z.number()).optional(), tmdbTvIds: z.array(z.number()).optional() });
type ResyncIds = z.infer<typeof ResyncIds>;

async function resyncWorks(ctx: MutationCtx, { tvdbIds = [], tmdbTvIds = [] }: ResyncIds): Promise<void> {
  const works = new Set<Id<'works'>>();
  for (const tmdbTvId of new Set(tmdbTvIds)) {
    const workId = await findWorkByTmdbId(ctx, String(tmdbTvId), 'series');
    if (workId) works.add(workId);
  }
  for (const tvdbId of new Set(tvdbIds)) for (const workId of await worksByTvdbId(ctx, tvdbId)) works.add(workId);
  for (const workId of works) await enqueueSync(ctx, workId);
}

export const resyncChangedWorks = internalMutation({
  args: zodToConvexFields(ResyncIds.shape),
  returns: zodToConvex(z.null()),
  handler: async (ctx, ids) => {
    await resyncWorks(ctx, ids);
    return null;
  },
});

/** A failed fetch counts toward the source's health. */
export const recordSourceFailure = internalMutation({
  args: zodToConvexFields({ source: MappingSourceName }),
  returns: zodToConvex(z.null()),
  handler: async (ctx, { source }) => {
    await recordHealthIn(ctx, { source, outcome: 'failure', at: Date.now() });
    return null;
  },
});
