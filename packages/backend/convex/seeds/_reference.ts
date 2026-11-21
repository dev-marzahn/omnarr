// The interim runner for reference seeds, until convex-release's
// defineReferenceSeed exists. The setup container runs
// `seeds/_reference:apply` on every start; each seed runs once per deployment,
// recorded by name in `referenceSeeds`.
//
// The file name starts with `_` so convex-release, which treats every other
// file in this folder as a Faker seed for empty deployments, leaves it alone.
import { v } from 'convex/values';

import { internalMutation, type MutationCtx } from '../_generated/server';
import { releaseProfilesV1 } from '../referenceSeeds/0001_release_profiles';
import { releaseProfilesV2 } from '../referenceSeeds/0002_release_profiles_v2';
import { playbackProfileDefaults } from '../referenceSeeds/0003_playback_profile_defaults';

export type ReferenceSeed = {
  /** Permanent: a deployment records it. Never rename or reuse one. */
  name: string;
  /** Inserts new entries, or updates entries the user hasn't changed (`editedByUser`). */
  apply: (ctx: MutationCtx) => Promise<void>;
};

/** In order. Seeds live in referenceSeeds/. */
export const REFERENCE_SEEDS: ReferenceSeed[] = [releaseProfilesV1, releaseProfilesV2, playbackProfileDefaults];

export async function applyReferenceSeeds(ctx: MutationCtx, seeds: ReferenceSeed[]): Promise<string[]> {
  const applied: string[] = [];
  for (const seed of seeds) {
    const done = await ctx.db
      .query('referenceSeeds')
      .withIndex('by_name', (q) => q.eq('name', seed.name))
      .first();
    if (done) continue;
    await seed.apply(ctx);
    await ctx.db.insert('referenceSeeds', { name: seed.name });
    applied.push(seed.name);
  }
  return applied;
}

export const apply = internalMutation({
  args: {},
  returns: v.array(v.string()),
  handler: (ctx) => applyReferenceSeeds(ctx, REFERENCE_SEEDS),
});
