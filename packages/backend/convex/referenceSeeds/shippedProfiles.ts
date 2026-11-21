// The insert-or-update rule every release-profile seed applies: a shipped
// version reaches every profile with its key that the user hasn't edited;
// an edited one only learns that the version exists.
import type { ReleaseProfileContent } from '@omnarr/contracts';

import type { MutationCtx } from '../_generated/server';

export async function applyShippedProfileVersion(ctx: MutationCtx, shippedKey: string, version: number, content: ReleaseProfileContent): Promise<void> {
  const profiles = await ctx.db
    .query('releaseProfiles')
    .withIndex('by_shipped_key', (q) => q.eq('shippedKey', shippedKey))
    .collect();
  if (profiles.length === 0) {
    await ctx.db.insert('releaseProfiles', { ...content, shippedKey, shippedVersion: version, editedByUser: false });
    return;
  }
  for (const profile of profiles) {
    if (profile.editedByUser) await ctx.db.patch(profile._id, { pendingShippedVersion: version });
    else await ctx.db.replace(profile._id, { ...content, shippedKey, shippedVersion: version, editedByUser: false });
  }
}
