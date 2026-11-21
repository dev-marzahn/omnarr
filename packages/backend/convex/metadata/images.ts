// TMDB's images, fetched once and served by omnarr. The metadata stores
// the paths; the browser used to load them from TMDB's CDN, which told TMDB
// each viewer's address and what they looked at, and broke without
// internet. Now a Work's sync (and a monitoring change) schedules
// `fetchForWork`: it stores each wanted image in Convex file storage once,
// fetches it again after 30 days (TMDB's terms cap caching at six months),
// and deletes the images no longer wanted. The DTOs carry storage URLs.
import { v } from 'convex/values';

import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { internalAction, internalMutation, internalQuery, type QueryCtx } from '../_generated/server';

/** One width per kind: posters for 164 px cards at 2×, backdrops shown faded, stills in rows. */
export const IMAGE_SIZE = { poster: 'w342', backdrop: 'w780', still: 'w300', searchPoster: 'w92' } as const;
/** An image older than this is fetched again with the Work's next sync, so none is older than about 60 days. */
export const REFETCH_MS = 30 * 24 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 15_000;

/** TMDB's image CDN; `TMDB_IMAGE_URL` points the e2e stack and the tests at the fake. */
export const imageUrlOf = (size: string, path: string): string =>
  `${(process.env.TMDB_IMAGE_URL ?? 'https://image.tmdb.org').replace(/\/+$/, '')}/t/p/${size}${path}`;

/** States in which a Unit has a playable file (library/read.ts): a present Unit's season gets its stills. */
const PRESENT: ReadonlySet<string> = new Set(['preparing', 'ready', 'notInTargetFormat']);

type Wanted = { path: string; size: string };

/**
 * What the Work should have: its poster and backdrop, and the stills of the
 * seasons with a monitored or present Unit. Returns the wanted images that
 * are missing or older than 30 days, and the stored rows no longer wanted.
 */
export const plan = internalQuery({
  args: { workId: v.id('works'), now: v.number() },
  returns: v.object({ fetch: v.array(v.object({ path: v.string(), size: v.string() })), obsolete: v.array(v.id('images')) }),
  handler: async (ctx, { workId, now }) => {
    const wanted: Wanted[] = [];
    const meta = await ctx.db
      .query('workMetadata')
      .withIndex('by_work', (q) => q.eq('workId', workId))
      .unique();
    if (meta?.posterPath) wanted.push({ path: meta.posterPath, size: IMAGE_SIZE.poster });
    if (meta?.backdropPath) wanted.push({ path: meta.backdropPath, size: IMAGE_SIZE.backdrop });
    const units = await ctx.db
      .query('units')
      .withIndex('by_work', (q) => q.eq('workId', workId))
      .collect();
    const seasons = new Set(units.filter((unit) => unit.monitored || PRESENT.has(unit.derivedState)).map((unit) => unit.tmdbSeason));
    const stills = await ctx.db
      .query('unitMetadata')
      .withIndex('by_work', (q) => q.eq('workId', workId))
      .collect();
    const seasonOf = new Map(units.map((unit) => [unit._id, unit.tmdbSeason]));
    for (const row of stills)
      if (
        row.stillPath &&
        row.retiredAt === undefined &&
        seasonOf.has(row.unitId) &&
        seasons.has(seasonOf.get(row.unitId)) &&
        seasonOf.get(row.unitId) !== undefined
      )
        wanted.push({ path: row.stillPath, size: IMAGE_SIZE.still });

    const stored = await ctx.db
      .query('images')
      .withIndex('by_work', (q) => q.eq('workId', workId))
      .collect();
    const key = (image: Wanted) => `${image.size} ${image.path}`;
    const wantedKeys = new Set(wanted.map(key));
    const fresh = new Set(stored.filter((row) => now - row.fetchedAt < REFETCH_MS).map(key));
    return {
      fetch: [...new Map(wanted.filter((image) => !fresh.has(key(image))).map((image) => [key(image), image])).values()],
      obsolete: stored.filter((row) => !wantedKeys.has(key(row))).map((row) => row._id),
    };
  },
});

/** Records a fetched image, replacing (and deleting the file of) an older copy of the same path and size. */
export const save = internalMutation({
  args: { workId: v.id('works'), path: v.string(), size: v.string(), storageId: v.id('_storage') },
  returns: v.null(),
  handler: async (ctx, { workId, path, size, storageId }) => {
    const old = await ctx.db
      .query('images')
      .withIndex('by_path_size', (q) => q.eq('path', path).eq('size', size))
      .collect();
    for (const row of old.filter((row) => row.workId === workId)) {
      await ctx.storage.delete(row.storageId);
      await ctx.db.delete(row._id);
    }
    await ctx.db.insert('images', { workId, path, size, storageId, fetchedAt: Date.now() });
    return null;
  },
});

/** Deletes images and their files: a changed path's old image, or a Work's when it is removed. */
export const remove = internalMutation({
  args: { imageIds: v.array(v.id('images')) },
  returns: v.null(),
  handler: async (ctx, { imageIds }) => {
    for (const id of imageIds) {
      const row = await ctx.db.get(id);
      if (!row) continue;
      await ctx.storage.delete(row.storageId);
      await ctx.db.delete(id);
    }
    return null;
  },
});

/** Fetches one image from TMDB's CDN, or nothing when it can't be had; the next sync tries again. */
async function fetchImage(size: string, path: string): Promise<Blob | undefined> {
  try {
    const response = await fetch(imageUrlOf(size, path), { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
    if (!response.ok) return undefined;
    const type = response.headers.get('content-type') ?? 'image/jpeg';
    if (!type.startsWith('image/')) return undefined;
    return new Blob([await response.arrayBuffer()], { type });
  } catch {
    return undefined;
  }
}

/** Brings a Work's stored images in line with `plan`: fetches the missing and stale ones, then deletes the unwanted. */
export const fetchForWork = internalAction({
  args: { workId: v.id('works') },
  returns: v.null(),
  handler: async (ctx, { workId }) => {
    const todo = await ctx.runQuery(internal.metadata.images.plan, { workId, now: Date.now() });
    for (const { path, size } of todo.fetch) {
      const blob = await fetchImage(size, path);
      if (!blob) continue;
      const storageId = await ctx.storage.store(blob);
      await ctx.runMutation(internal.metadata.images.save, { workId, path, size, storageId });
    }
    if (todo.obsolete.length > 0) await ctx.runMutation(internal.metadata.images.remove, { imageIds: todo.obsolete });
    return null;
  },
});

/** A stored image's URL for a DTO, if it has been fetched. */
export async function storedUrl(ctx: QueryCtx, path: string | undefined, size: string): Promise<string | undefined> {
  if (!path) return undefined;
  const row = await ctx.db
    .query('images')
    .withIndex('by_path_size', (q) => q.eq('path', path).eq('size', size))
    .first();
  return row ? ((await ctx.storage.getUrl(row.storageId)) ?? undefined) : undefined;
}

/** A Work's poster and backdrop URLs and TMDB's overview, for the DTOs. */
export async function workImages(ctx: QueryCtx, workId: Id<'works'>): Promise<{ meta: Doc<'workMetadata'> | null; posterUrl?: string; backdropUrl?: string }> {
  const meta = await ctx.db
    .query('workMetadata')
    .withIndex('by_work', (q) => q.eq('workId', workId))
    .unique();
  const posterUrl = await storedUrl(ctx, meta?.posterPath, IMAGE_SIZE.poster);
  const backdropUrl = await storedUrl(ctx, meta?.backdropPath, IMAGE_SIZE.backdrop);
  return { meta, ...(posterUrl ? { posterUrl } : {}), ...(backdropUrl ? { backdropUrl } : {}) };
}

/** A Unit's still URL for a DTO. */
export async function stillUrlOf(ctx: QueryCtx, unitId: Id<'units'>): Promise<string | undefined> {
  const meta = await ctx.db
    .query('unitMetadata')
    .withIndex('by_unit', (q) => q.eq('unitId', unitId))
    .unique();
  return storedUrl(ctx, meta?.stillPath, IMAGE_SIZE.still);
}

/** The add-title search's poster: w92, fetched here and returned as a data URI, never stored. */
export async function posterDataUri(path: string | undefined): Promise<string | undefined> {
  if (!path) return undefined;
  const blob = await fetchImage(IMAGE_SIZE.searchPoster, path);
  if (!blob) return undefined;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return `data:${blob.type};base64,${btoa(binary)}`;
}
