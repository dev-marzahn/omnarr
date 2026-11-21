// Reference seed 0001: the three shipped profiles at
// version 1. Applied seeds are never changed; new content is a new seed.
import { anime1080p, uhd2160p, web1080p } from '@omnarr/scoring/shipped/v1';

import type { ReferenceSeed } from '../seeds/_reference';
import { applyShippedProfileVersion } from './shippedProfiles';

export const releaseProfilesV1: ReferenceSeed = {
  name: '0001_release_profiles',
  apply: async (ctx) => {
    await applyShippedProfileVersion(ctx, 'web-1080p', 1, web1080p);
    await applyShippedProfileVersion(ctx, 'uhd-2160p', 1, uhd2160p);
    await applyShippedProfileVersion(ctx, 'anime-1080p', 1, anime1080p);
  },
};
