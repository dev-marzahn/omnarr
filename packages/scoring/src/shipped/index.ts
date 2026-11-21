// The shipped profiles' latest versions. Each reference seed imports
// its own version module (`shipped/v<N>/`) directly.
import type { ReleaseProfileContent } from '@omnarr/contracts';

import { anime1080p, uhd2160p, web1080p } from './v2/index.ts';

export type ShippedKey = 'web-1080p' | 'uhd-2160p' | 'anime-1080p';

export const SHIPPED_PROFILES: Record<ShippedKey, { version: number; content: ReleaseProfileContent }> = {
  'web-1080p': { version: 2, content: web1080p },
  'uhd-2160p': { version: 2, content: uhd2160p },
  'anime-1080p': { version: 2, content: anime1080p },
};
