// The upgrade rule: the cutoff, and whether a candidate beats the Unit's
// current release. Both are weighed against the current profile, so a profile
// edit applies to old files. Pure.
import type { ParsedRelease, PreparationStep, QualityId, ReleaseProfileContent, Revision } from '@omnarr/contracts';

import { scoreFormats } from './evaluate.ts';
import type { Id } from './ids.ts';
import { qualityOf } from './qualities.ts';
import { compareCandidates, type StoredCandidate } from './rank.ts';

/** A release as the rule weighs it: the first three ranking keys (preparation, quality, score), its group and its revision. */
export type Weighed = { quality: QualityId; qualityRank: number; baseScore: number; preparationPoints: number; group?: string; revision: Revision };

const rankOf = (profile: ReleaseProfileContent, quality: QualityId) =>
  profile.qualities.find((entry) => entry.quality === quality)?.rank ?? Number.MAX_SAFE_INTEGER;

/**
 * A release with its preparation step under the profile: for the current
 * file the real step (from the probed file), for a candidate the predicted one.
 */
export function weigh(release: ParsedRelease, step: PreparationStep, profile: ReleaseProfileContent): Weighed {
  const { quality } = qualityOf(release);
  const { baseScore, score } = scoreFormats(release, profile, step, []);
  return {
    quality,
    qualityRank: rankOf(profile, quality),
    baseScore,
    preparationPoints: score - baseScore,
    ...(release.group === undefined ? {} : { group: release.group }),
    revision: release.revision,
  };
}

/** Rank 1 is best: the current release is at least the cutoff quality and reaches its score. */
export function meetsCutoff(current: Pick<Weighed, 'qualityRank' | 'baseScore'>, profile: ReleaseProfileContent): boolean {
  return current.qualityRank <= rankOf(profile, profile.cutoff.quality) && current.baseScore >= profile.cutoff.score;
}

const asStored = (release: Weighed, id: string): StoredCandidate => ({
  _id: id as Id<'candidates'>,
  indexerId: '' as Id<'indexers'>,
  guid: id,
  publishedAt: 0,
  sizeBytes: 0,
  protocol: 'usenet',
  unitIds: [],
  alsoContainsUnitIds: [],
  qualityRank: release.qualityRank,
  baseScore: release.baseScore,
  score: release.baseScore + release.preparationPoints,
  parsed: { revision: release.revision },
});

/**
 * An accepted candidate is an upgrade when it wins `compareCandidates` over
 * the current release on keys 1–3, with a score-only win rising by at least
 * `minimumUpgradeStep`; or when it has the current release's preparation,
 * quality and group with a higher revision (PROPER, REPACK, anime v2). The
 * cooldown and acceptance are the caller's.
 */
export function isUpgrade(candidate: Weighed, current: Weighed, profile: Pick<ReleaseProfileContent, 'minimumUpgradeStep'>): boolean {
  const { order, key } = compareCandidates(asStored(candidate, 'candidate'), asStored(current, 'current'), { profile: {}, indexerPriority: {} });
  if (order < 0 && (key === 'preparation' || key === 'quality')) return true;
  if (order < 0 && key === 'score' && candidate.baseScore - current.baseScore >= profile.minimumUpgradeStep) return true;
  const same =
    candidate.preparationPoints === current.preparationPoints &&
    candidate.qualityRank === current.qualityRank &&
    candidate.group !== undefined &&
    candidate.group.toLowerCase() === current.group?.toLowerCase();
  const { version, real } = candidate.revision;
  return same && (version > current.revision.version || (version === current.revision.version && real > current.revision.real));
}
