// Shipped profile "1080p WEB" (`web-1080p`), version 1. Frozen: a
// content change is a new version module and a new reference seed.
import type { ReleaseProfileContent } from '@omnarr/contracts';

import { COMMON, groupTiers, PREPARATION, qualities, scores } from './common.ts';

/** The 1080p WEB format scores, which 2160p builds on. */
export const WEB_SCORES = {
  'group.tier1': 1500,
  'group.tier2': 1000,
  'group.tier3': 500,
  'group.lowQuality': -10000,
  'source.webdl': 50,
  'audio.eac3': 100,
  repack: 5,
  'hdr.dvNoFallback': -10000,
  ...PREPARATION,
};

export const web1080p: ReleaseProfileContent = {
  name: '1080p WEB',
  qualities: qualities({ 'webdl-1080p': 1, 'bluray-1080p': 2, 'webrip-1080p': 3, 'webdl-720p': 4 }),
  cutoff: { quality: 'webdl-1080p', score: 1500 },
  formatScores: scores(WEB_SCORES),
  groupTiers: groupTiers(['group.tier1', 'group.tier2', 'group.tier3', 'group.lowQuality']),
  ...COMMON,
};
