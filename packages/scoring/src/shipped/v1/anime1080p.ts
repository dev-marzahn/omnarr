// Shipped profile "Anime 1080p" (`anime-1080p`), version 1. Frozen.
import type { ReleaseProfileContent } from '@omnarr/contracts';

import { COMMON, groupTiers, PREPARATION, qualities, scores } from './common.ts';

export const anime1080p: ReleaseProfileContent = {
  name: 'Anime 1080p',
  qualities: qualities({ 'bluray-1080p': 1, 'webdl-1080p': 2, 'webrip-1080p': 2, 'bluray-720p': 3, 'webdl-720p': 4 }),
  cutoff: { quality: 'bluray-1080p', score: 1500 },
  formatScores: scores({
    'anime.tier1': 1500,
    'anime.tier2': 1000,
    'anime.tier3': 500,
    'group.lowQuality': -10000,
    'bitDepth.10': 10,
    'language.multi': 50,
    repack: 5,
    ...PREPARATION,
  }),
  groupTiers: groupTiers(['anime.tier1', 'anime.tier2', 'anime.tier3', 'group.lowQuality']),
  ...COMMON,
};
