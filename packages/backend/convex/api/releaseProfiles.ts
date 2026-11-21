// The release-profile functions. Any saved change sets
// `editedByUser`, so a later shipped version only marks an update available;
// "Reset to shipped" applies the latest one.
import { Ack, ReleaseProfileContent, ReleaseProfileDetail, ReleaseProfileSummary } from '@omnarr/contracts';
import { BUILT_IN_FORMATS, SHIPPED_PROFILES, type ShippedKey, toPreparationTarget, wouldNeedTranscode } from '@omnarr/scoring';
import { zid } from 'convex-helpers/server/zod4';
import { ConvexError } from 'convex/values';
import { z } from 'zod';

import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';
import { adminMutation, adminQuery } from '../lib/functions';
import { profileContent } from '../pipeline/search';
import { targetOf } from '../playback/target';

/** The libraries that default to the profile and the Works that use it. */
async function usersOf(ctx: QueryCtx, id: Id<'releaseProfiles'>) {
  // The table has two rows, so no index.
  const libraries = (await ctx.db.query('libraries').collect()).filter((library) => library.defaultReleaseProfileId === id);
  const works = await ctx.db
    .query('works')
    .withIndex('by_release_profile', (q) => q.eq('releaseProfileId', id))
    .collect();
  return { libraries, works };
}

const FORMAT_CATALOGUE = BUILT_IN_FORMATS.map((format) => ({ id: format.id, name: format.name, kind: format.kind }));

async function detailOf(ctx: QueryCtx, profile: Doc<'releaseProfiles'>): Promise<ReleaseProfileDetail> {
  const { libraries, works } = await usersOf(ctx, profile._id);
  const { _id, _creationTime, ...stored } = profile;
  // Each library's own target.
  const warned = [];
  for (const library of await ctx.db.query('libraries').collect())
    if (wouldNeedTranscode(profile, toPreparationTarget(await targetOf(ctx, library._id)))) warned.push(library);
  return {
    id: profile._id,
    profile: stored,
    usedBy: {
      libraries: libraries.map((library) => ({ libraryId: library._id, name: library.name })),
      works: works.map((work) => ({ workId: work._id, title: work.title })),
    },
    formatCatalogue: FORMAT_CATALOGUE,
    ...(profile.pendingShippedVersion === undefined ? {} : { pendingShippedVersion: profile.pendingShippedVersion }),
    targetWarnings: warned.map((library) => ({
      libraryId: library._id,
      message: `Most releases this profile prefers will need a full video transcode for ${library.name}.`,
    })),
  };
}

async function load(ctx: QueryCtx, id: Id<'releaseProfiles'>): Promise<Doc<'releaseProfiles'>> {
  const profile = await ctx.db.get(id);
  if (!profile) throw new ConvexError({ code: 'notFound' });
  return profile;
}

async function assertNameFree(ctx: MutationCtx, name: string, except?: Id<'releaseProfiles'>): Promise<void> {
  const taken = (await ctx.db.query('releaseProfiles').collect()).some((p) => p._id !== except && p.name.trim().toLowerCase() === name.trim().toLowerCase());
  if (taken) throw new ConvexError({ code: 'nameTaken' });
}

export const list = adminQuery({
  args: {},
  returns: z.array(ReleaseProfileSummary),
  handler: async (ctx) => {
    const profiles = await ctx.db.query('releaseProfiles').collect();
    return Promise.all(
      profiles.map(async (profile) => {
        const { libraries, works } = await usersOf(ctx, profile._id);
        return {
          id: profile._id,
          name: profile.name,
          ...(profile.shippedKey ? { shippedKey: profile.shippedKey } : {}),
          edited: profile.editedByUser,
          updateAvailable: profile.pendingShippedVersion !== undefined,
          usedBy: libraries.length + works.length,
        };
      }),
    );
  },
});

export const get = adminQuery({
  args: { id: zid('releaseProfiles') },
  returns: ReleaseProfileDetail.nullable(),
  handler: async (ctx, { id }) => {
    const profile = await ctx.db.get(id);
    return profile && detailOf(ctx, profile);
  },
});

/** Saves an edit: everything but the shipped key and versions. Editing changes future picks only. */
export const update = adminMutation({
  args: { id: zid('releaseProfiles'), profile: ReleaseProfileContent },
  returns: ReleaseProfileDetail,
  handler: async (ctx, { id, profile }) => {
    const current = await load(ctx, id);
    // The wrapper's validator drops Zod refinements, so check them here.
    const content = ReleaseProfileContent.parse(profile);
    await assertNameFree(ctx, content.name, id);
    const { shippedKey, shippedVersion, pendingShippedVersion } = current;
    await ctx.db.replace(id, { ...content, shippedKey, shippedVersion, pendingShippedVersion, editedByUser: true });
    return detailOf(ctx, (await ctx.db.get(id))!);
  },
});

/** "New profile": the latest shipped content of `web-1080p`, under a new name. */
export const create = adminMutation({
  args: { name: z.string().trim().min(1) },
  returns: ReleaseProfileDetail,
  handler: async (ctx, { name }) => {
    await assertNameFree(ctx, name);
    const id = await ctx.db.insert('releaseProfiles', { ...SHIPPED_PROFILES['web-1080p'].content, name, editedByUser: false });
    return detailOf(ctx, (await ctx.db.get(id))!);
  },
});

/** "Duplicate": any profile as stored, without its shipped key. */
export const duplicate = adminMutation({
  args: { id: zid('releaseProfiles'), name: z.string().trim().min(1) },
  returns: ReleaseProfileDetail,
  handler: async (ctx, { id, name }) => {
    const source = await load(ctx, id);
    await assertNameFree(ctx, name);
    const copy = await ctx.db.insert('releaseProfiles', { ...profileContent(source), name, editedByUser: false });
    return detailOf(ctx, (await ctx.db.get(copy))!);
  },
});

/** Allowed only when no library default and no Work uses it; the error lists them. */
export const remove = adminMutation({
  args: { id: zid('releaseProfiles') },
  returns: Ack,
  handler: async (ctx, { id }) => {
    await load(ctx, id);
    const { libraries, works } = await usersOf(ctx, id);
    if (libraries.length + works.length > 0) {
      throw new ConvexError({ code: 'inUse', libraries: libraries.map((l) => l.name).join(', '), works: works.map((w) => w.title).join(', ') });
    }
    await ctx.db.delete(id);
    return null;
  },
});

/** Writes the latest shipped version's content and clears the edit flag and any pending version. */
export const resetToShipped = adminMutation({
  args: { id: zid('releaseProfiles') },
  returns: ReleaseProfileDetail,
  handler: async (ctx, { id }) => {
    const profile = await load(ctx, id);
    const shipped = profile.shippedKey ? SHIPPED_PROFILES[profile.shippedKey as ShippedKey] : undefined;
    if (!shipped) throw new ConvexError({ code: 'notShipped' });
    await ctx.db.replace(id, { ...shipped.content, shippedKey: profile.shippedKey, shippedVersion: shipped.version, editedByUser: false });
    return detailOf(ctx, (await ctx.db.get(id))!);
  },
});
