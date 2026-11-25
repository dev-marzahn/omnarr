// The scorer: matching, qualities, formats, evaluate, ranking and
// the predicted preparation step. Pure; no I/O and no Convex imports.
export { evaluateRule } from './conditions.ts';
export { evaluate, type EvaluateInput, releaseKeyOf, type Verdict } from './evaluate.ts';
export { BUILT_IN_FORMATS, type BuiltInFormat, type FormatContext, matchingFormats } from './formats.ts';
export type { Id } from './ids.ts';
export {
  filterWorks,
  matchTitle,
  namesEveryRelease,
  releaseSeasonAllows,
  type MatchResult,
  matchUnits,
  type ResolveResult,
  splitSeasonMark,
  splitSeasonName,
  type TitleMatch,
  type WorkForMatch,
} from './match.ts';
export { DEFAULT_PREPARATION_TARGET, predictPreparation, type PreparationTarget, toPreparationTarget, wouldNeedTranscode } from './preparation.ts';
export { QUALITIES, qualityOf } from './qualities.ts';
export { isReadableReleaseFilter, MAX_RELEASE_FILTER_LENGTH, releaseFilterMatches } from './releaseFilter.ts';
export { SHIPPED_PROFILES, type ShippedKey } from './shipped/index.ts';
export { isUpgrade, meetsCutoff, weigh, type Weighed } from './upgrade.ts';
export { compareCandidates, type RankContext, type RankKey, selectCandidates, type SelectionVerdict, type StoredCandidate } from './rank.ts';
