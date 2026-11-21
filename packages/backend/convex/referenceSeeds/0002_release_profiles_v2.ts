// Reference seed 0002: the three shipped profiles at version 2, which
// turns `preferSeasonPacks` on. Unedited profiles take it;
// edited ones only get `pendingShippedVersion`. Applied seeds are never changed.
import { anime1080p, uhd2160p, web1080p } from '@omnarr/scoring/shipped/v2';

import type { ReferenceSeed } from '../seeds/_reference';
import { applyShippedProfileVersion } from './shippedProfiles';

export const releaseProfilesV2: ReferenceSeed = {
  name: '0002_release_profiles_v2',
  apply: async (ctx) => {
    await applyShippedProfileVersion(ctx, 'web-1080p', 2, web1080p);
    await applyShippedProfileVersion(ctx, 'uhd-2160p', 2, uhd2160p);
    await applyShippedProfileVersion(ctx, 'anime-1080p', 2, anime1080p);
  },
};
