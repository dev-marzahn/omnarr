// Shipped profile "2160p" (`uhd-2160p`), version 1. Frozen.
import type { ReleaseProfileContent } from '@omnarr/contracts';

import { COMMON, groupTiers, qualities, scores } from './common.ts';
import { WEB_SCORES } from './web1080p.ts';

export const uhd2160p: ReleaseProfileContent = {
  name: '2160p',
  qualities: qualities({ 'webdl-2160p': 1, 'bluray-2160p': 2, 'webrip-2160p': 3 }),
  cutoff: { quality: 'webdl-2160p', score: 1500 },
  formatScores: scores({ ...WEB_SCORES, 'hdr.dv': 100, 'hdr.hdr10plus': 50, 'hdr.hdr10': 25 }),
  groupTiers: groupTiers(['group.tier1', 'group.tier2', 'group.tier3', 'group.lowQuality']),
  ...COMMON,
};
