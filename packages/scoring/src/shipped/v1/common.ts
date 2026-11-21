// Shared parts of the version-1 shipped profiles. Frozen with v1: a
// later version gets its own module rather than changing this one.
import { type FormatScore, type GroupTier, type QualityEntry, QualityId, type ReleaseProfileContent } from '@omnarr/contracts';

import { GROUP_TIERS } from '../groupTiers.ts';

/** The allowed qualities at their ranks, then every other quality after them, in catalogue order. */
export function qualities(allowed: Partial<Record<QualityId, number>>): QualityEntry[] {
  const ranked = QualityId.options.filter((q) => allowed[q] !== undefined).map((quality) => ({ quality, allowed: true, rank: allowed[quality]! }));
  ranked.sort((a, b) => a.rank - b.rank);
  const worst = Math.max(...ranked.map((entry) => entry.rank));
  const rest = QualityId.options.filter((q) => allowed[q] === undefined).map((quality, i) => ({ quality, allowed: false, rank: worst + 1 + i }));
  return [...ranked, ...rest];
}

export function groupTiers(formatIds: (keyof typeof GROUP_TIERS)[]): GroupTier[] {
  return formatIds.map((formatId) => ({ formatId, groups: [...GROUP_TIERS[formatId]] }));
}

export const scores = (entries: Record<string, number>): FormatScore[] => Object.entries(entries).map(([formatId, score]) => ({ formatId, score }));

/** The preparation formats: a video transcode orders a release last; remux and audio steps cost nothing. */
export const PREPARATION = { 'prep.video': -10000, 'prep.remux': 0, 'prep.audioOrSubtitle': 0 };

/** The fields every v1 profile shares. */
export const COMMON: Pick<ReleaseProfileContent, 'minimumScore' | 'minimumUpgradeStep' | 'languages' | 'userFormats' | 'sizeLimits' | 'protocols'> = {
  minimumScore: 0,
  minimumUpgradeStep: 10,
  languages: [{ kind: 'preferred' }, { kind: 'original' }],
  userFormats: [],
  sizeLimits: [],
  protocols: ['usenet', 'torrent'],
};
