// Reference seed 0003: an install from before per-library playback targets
// has one playback profile row with no target, shared by both libraries.
// This gives each library its own row with first run's devices and their
// target. An install whose profiles all have a target, as first run now
// leaves them, is left alone. Applied seeds are never changed.
import { DEFAULT_DEVICES } from '@omnarr/contracts';

import { setupDefaults } from '../playback/profiles';
import type { ReferenceSeed } from '../seeds/_reference';

export const playbackProfileDefaults: ReferenceSeed = {
  name: '0003_playback_profile_defaults',
  apply: async (ctx) => {
    // Two rows.
    const libraries = await ctx.db.query('libraries').collect();
    const profileIds = libraries.map((library) => library.playbackProfileId);
    const shared = new Set(profileIds).size < profileIds.length;
    const profiles = await Promise.all(profileIds.map((id) => ctx.db.get(id)));
    if (shared || profiles.some((profile) => !profile?.target)) await setupDefaults(ctx, DEFAULT_DEVICES);
  },
};
