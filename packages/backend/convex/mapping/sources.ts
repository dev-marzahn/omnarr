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

const stateOf = (ctx: QueryCtx, source: MappingSourceName) =>
  ctx.db
    .query('mappingSourceState')
    .withIndex('by_source', (q) => q.eq('source', source))
    .unique();

/** What a fetch needs from the last one: the version, and Anime-Lists' ETag for a conditional GET. */
export const sourceState = internalQuery({
  args: zodToConvexFields({ source: MappingSourceName }),
  returns: zodToConvex(z.object({ version: z.string().optional(), etag: z.string().optional() })),
  handler: async (ctx, { source }) => {
    const state = await stateOf(ctx, source);
    return { version: state?.version, etag: state?.etag };
  },
});

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

const STALE_PAGE = 500;

/**
 * Deletes a page of entries the file of `version` no longer has. Versions
 * are hashes, not ordered, so it reads the index on both sides of `version`.
 * Returns the TMDB series IDs they linked, and whether any are left.
 */
export const deleteStaleEntries = internalMutation({
  args: zodToConvexFields({ version: z.string() }),
  returns: zodToConvex(z.object({ tmdbTvIds: z.array(z.number()), done: z.boolean() })),
  handler: async (ctx, { version }) => {
    const before = await ctx.db
      .query('animeListEntries')
      .withIndex('by_seen_version', (q) => q.lt('seenVersion', version))
      .take(STALE_PAGE);
    const after =
      before.length < STALE_PAGE
        ? await ctx.db
            .query('animeListEntries')
            .withIndex('by_seen_version', (q) => q.gt('seenVersion', version))
            .take(STALE_PAGE - before.length)
        : [];
    const stale = [...before, ...after];
    for (const entry of stale) await ctx.db.delete(entry._id);
    return { tmdbTvIds: stale.flatMap((entry) => (entry.tmdbTvId === undefined ? [] : [entry.tmdbTvId])), done: stale.length < STALE_PAGE };
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

/** Deletes a page of scene mappings the list of `version` no longer has, as `deleteStaleEntries` does; returns their TVDB IDs. */
export const deleteStaleSceneMappings = internalMutation({
  args: zodToConvexFields({ version: z.string() }),
  returns: zodToConvex(z.object({ tvdbIds: z.array(z.number()), done: z.boolean() })),
  handler: async (ctx, { version }) => {
    const before = await ctx.db
      .query('sceneMappings')
      .withIndex('by_seen_version', (q) => q.lt('seenVersion', version))
      .take(STALE_PAGE);
    const after =
      before.length < STALE_PAGE
        ? await ctx.db
            .query('sceneMappings')
            .withIndex('by_seen_version', (q) => q.gt('seenVersion', version))
            .take(STALE_PAGE - before.length)
        : [];
    const stale = [...before, ...after];
    for (const row of stale) await ctx.db.delete(row._id);
    return { tvdbIds: stale.map((row) => row.tvdbId), done: stale.length < STALE_PAGE };
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

/**
 * A successful fetch: writes the source's state, records its health, and
 * enqueues a sync for every Work linked to an Anime-Lists entry that changed,
 * whose TVDB ID entered XEM's list, or whose scene-mapping names changed.
 */
export const recordSourceFetch = internalMutation({
  args: zodToConvexFields({
    source: MappingSourceName,
    version: z.string().optional(),
    etag: z.string().optional(),
    xemTvdbIds: z.array(z.number()).optional(),
    changedTmdbTvIds: z.array(z.number()).optional(),
    changedTvdbIds: z.array(z.number()).optional(),
  }),
  returns: zodToConvex(z.null()),
  handler: async (ctx, { source, version, etag, xemTvdbIds, changedTmdbTvIds, changedTvdbIds }) => {
    const now = Date.now();
    const state = await stateOf(ctx, source);
    const fields = { ...(version !== undefined ? { version } : {}), ...(etag !== undefined ? { etag } : {}), ...(xemTvdbIds ? { xemTvdbIds } : {}) };
    if (state) await ctx.db.patch(state._id, fields);
    else await ctx.db.insert('mappingSourceState', { source, lastAttemptAt: now, ...fields });
    await recordHealthIn(ctx, { source, outcome: 'success', at: now });

    const works = new Set<Id<'works'>>();
    for (const tmdbTvId of new Set(changedTmdbTvIds ?? [])) {
      const workId = await findWorkByTmdbId(ctx, String(tmdbTvId), 'series');
      if (workId) works.add(workId);
    }
    if (xemTvdbIds) {
      const known = new Set(state?.xemTvdbIds ?? []);
      for (const tvdbId of xemTvdbIds) if (!known.has(tvdbId)) for (const workId of await worksByTvdbId(ctx, tvdbId)) works.add(workId);
    }
    for (const tvdbId of new Set(changedTvdbIds ?? [])) for (const workId of await worksByTvdbId(ctx, tvdbId)) works.add(workId);
    for (const workId of works) await enqueueSync(ctx, workId);
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
