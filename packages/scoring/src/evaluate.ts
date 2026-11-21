// evaluate() and the verdict: one candidate against a profile, with the first
// failing check as its single reason.
import { normalizeInfoHash } from '@omnarr/contracts';
import type { CandidateReason, IndexerItem, ParsedRelease, PreparationStep, QualityId, ReleaseProfileContent, ScoreBreakdownEntry } from '@omnarr/contracts';
import { normalizeReleaseTitle } from '@omnarr/parser';

import { evaluateRule } from './conditions.ts';
import { matchingFormats } from './formats.ts';
import type { Id } from './ids.ts';
import type { MatchResult, TitleMatch } from './match.ts';
import { predictPreparation, type PreparationTarget } from './preparation.ts';
import { qualityOf } from './qualities.ts';

export type EvaluateInput = {
  parsed: ParsedRelease;
  item: IndexerItem;
  /** matchUnits' result, or matchTitle's failure. */
  match: MatchResult | Extract<TitleMatch, { ok: false }>;
  profile: ReleaseProfileContent;
  blocklistKeys: { releaseKeys: string[]; normalizedTitles: string[] };
  target: PreparationTarget;
  /** Summed over the covered and also-contained Units; absent when any is unknown. */
  runtimeMinutes?: number;
  originalLanguage?: string;
  preferredLanguage: string;
};

export type Verdict = {
  accepted: boolean;
  reason?: CandidateReason;
  matchDetail?: string;
  quality: QualityId;
  qualityRank: number;
  qualityAssumed: boolean;
  baseScore: number;
  score: number;
  breakdown: ScoreBreakdownEntry[];
  preparation: { step: PreparationStep; assumed: boolean };
  coveredUnitIds: Id<'units'>[];
  alsoContainsUnitIds: Id<'units'>[];
};

const MB = 1_000_000;

/**
 * A release's blocklist key: the info hash for a torrent that has one,
 * normalized, else the GUID. A hash in no known spelling is kept as given.
 */
export function releaseKeyOf(item: IndexerItem): string {
  const hash = item.protocol === 'torrent' ? item.torrent?.infoHash : undefined;
  return hash ? (normalizeInfoHash(hash) ?? hash) : item.guid;
}

/**
 * The formats a release matches, with the profile's points, preparation
 * last. `notes` are 0-point entries such as "Language unknown".
 */
export function scoreFormats(parsed: ParsedRelease, profile: ReleaseProfileContent, preparation: PreparationStep, notes: string[]) {
  const points = new Map(profile.formatScores.map((entry) => [entry.formatId, entry.score]));
  const breakdown: ScoreBreakdownEntry[] = [];
  let prep: ScoreBreakdownEntry | undefined;
  for (const format of matchingFormats(parsed, { groupTiers: profile.groupTiers, preparation })) {
    const score = points.get(format.id) ?? 0;
    if (format.kind === 'preparation') prep = { name: format.name, points: score, kind: 'preparation' };
    else if (score !== 0) breakdown.push({ name: format.name, points: score, kind: 'format' });
  }
  for (const format of profile.userFormats) {
    if (format.score !== 0 && evaluateRule(format.rule, parsed)) breakdown.push({ name: format.name, points: format.score, kind: 'format' });
  }
  const baseScore = breakdown.reduce((sum, entry) => sum + entry.points, 0);
  for (const name of notes) breakdown.push({ name, points: 0, kind: 'format' });
  // The preparation format is listed even at 0 points, so the candidate table can show "Needs audio conversion 0".
  if (prep) breakdown.push(prep);
  return { baseScore, score: baseScore + (prep?.points ?? 0), breakdown };
}

/**
 * Check 5: the release's languages, with an untagged release counting
 * as the original language, `multi` adding it and `dubbed` adding the
 * preferred one. `unknown` when the release is untagged and the original
 * language isn't known; it passes then.
 */
function languageCheck(input: EvaluateInput): 'pass' | 'fail' | 'unknown' {
  const { parsed, originalLanguage, preferredLanguage, profile } = input;
  const languages = new Set<string>(parsed.languages);
  const untagged = parsed.notes.includes('languageAssumed');
  if (untagged && originalLanguage === undefined) return 'unknown';
  if ((untagged || languages.has('multi')) && originalLanguage !== undefined) languages.add(originalLanguage);
  if (parsed.notes.includes('dubbed')) languages.add(preferredLanguage);
  const wanted = profile.languages.flatMap((spec) => {
    if (spec.kind === 'code') return [spec.code];
    if (spec.kind === 'preferred') return [preferredLanguage];
    return originalLanguage === undefined ? [] : [originalLanguage];
  });
  return wanted.some((code) => languages.has(code)) ? 'pass' : 'fail';
}

function sizeOutOfRange(input: EvaluateInput, quality: QualityId): boolean {
  const { item, runtimeMinutes, profile } = input;
  const limit = profile.sizeLimits.find((entry) => entry.quality === quality);
  if (!limit || runtimeMinutes === undefined || runtimeMinutes <= 0 || item.sizeBytes <= 0) return false;
  const mbPerMin = item.sizeBytes / MB / runtimeMinutes;
  return (limit.minMbPerMin !== undefined && mbPerMin < limit.minMbPerMin) || (limit.maxMbPerMin !== undefined && mbPerMin > limit.maxMbPerMin);
}

/** The first failing check, in the order below, or undefined when the release is acceptable. */
function firstFailure(
  input: EvaluateInput,
  quality: QualityId,
  allowed: boolean,
  baseScore: number,
  language: 'pass' | 'fail' | 'unknown',
): CandidateReason | undefined {
  const { match, item, profile, blocklistKeys } = input;
  if (!match.ok) return 'wrongTitleOrEpisode';
  if (blocklistKeys.releaseKeys.includes(releaseKeyOf(item)) || blocklistKeys.normalizedTitles.includes(normalizeReleaseTitle(item.title)))
    return 'blocklisted';
  if (!allowed || !profile.protocols.includes(item.protocol)) return 'notInProfile';
  if (sizeOutOfRange(input, quality)) return 'sizeOutOfRange';
  if (language === 'fail') return 'language';
  if (item.protocol === 'torrent' && item.torrent?.seeders === 0) return 'noSeeders';
  // Against the score without the preparation formats, so they never reject a release.
  if (baseScore < profile.minimumScore) return 'belowMinimumScore';
  return undefined;
}

/** Scores a candidate against a profile and decides whether it is acceptable, and why not. Pure. */
export function evaluate(input: EvaluateInput): Verdict {
  const { parsed, profile, match } = input;
  const { quality, assumed: qualityAssumed } = qualityOf(parsed);
  const entry = profile.qualities.find((q) => q.quality === quality);
  const preparation = predictPreparation(parsed, input.target);
  const language = languageCheck(input);
  const { baseScore, score, breakdown } = scoreFormats(parsed, profile, preparation.step, language === 'unknown' ? ['Language unknown'] : []);
  const reason = firstFailure(input, quality, entry?.allowed === true, baseScore, language);
  const verdict: Verdict = {
    accepted: reason === undefined,
    quality,
    qualityRank: entry?.rank ?? Number.MAX_SAFE_INTEGER,
    qualityAssumed,
    baseScore,
    score,
    breakdown,
    preparation,
    coveredUnitIds: match.ok ? match.coveredUnitIds : [],
    alsoContainsUnitIds: match.ok ? match.alsoContainsUnitIds : [],
  };
  if (reason) verdict.reason = reason;
  verdict.matchDetail = match.ok ? match.matchDetail : match.detail;
  return verdict;
}
