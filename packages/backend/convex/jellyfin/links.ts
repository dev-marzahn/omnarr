// "Open in Jellyfin": the item path jellyfin-web opens. The web app
// puts the origin in front of it.
import type { Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';

/**
 * `/web/#/details?id=<targetItemRef>&serverId=<serverId>`, from the `primary`
 * version's `visible` Publication. Undefined while there is none, or before
 * setup has recorded the server ID.
 */
export async function jellyfinItemPath(ctx: QueryCtx, unitId: Id<'units'>, serverId: string | undefined): Promise<string | undefined> {
  if (!serverId) return undefined;
  const publications = await ctx.db
    .query('publications')
    .withIndex('by_unit', (q) => q.eq('unitId', unitId))
    .collect();
  for (const publication of publications) {
    if (publication.state !== 'visible' || !publication.targetItemRef) continue;
    const version = await ctx.db.get(publication.fileVersionId);
    if (version?.kind === 'primary') return detailsPath(publication.targetItemRef, serverId);
  }
  return undefined;
}

/**
 * The Work's own item, its series or its movie, in the same shape
 * as `jellyfinItemPath`. Undefined until a publish has recorded the item, or
 * before setup has recorded the server ID.
 */
export async function jellyfinWorkPath(ctx: QueryCtx, workId: Id<'works'>, serverId: string | undefined): Promise<string | undefined> {
  const itemRef = serverId ? (await ctx.db.get(workId))?.jellyfinItemRef : undefined;
  return itemRef && serverId ? detailsPath(itemRef, serverId) : undefined;
}

const detailsPath = (itemRef: string, serverId: string): string => `/web/#/details?id=${encodeURIComponent(itemRef)}&serverId=${encodeURIComponent(serverId)}`;

/** The server ID item links need, read once per query. */
export const jellyfinServerId = async (ctx: QueryCtx): Promise<string | undefined> => (await ctx.db.query('jellyfinServer').first())?.serverId;
