// Ranking and the pick: preparation, then quality, then score, with fixed
// tie-breaks. Also runs in the pickCandidate mutation.
import type { CandidateReason, DownloadProtocol, LostOn, Revision, SearchGroupKind } from '@omnarr/contracts';

import type { Id } from './ids.ts';

/** The stored candidate fields the ranking reads. */
export type StoredCandidate = {
  _id: Id<'candidates'>;
  indexerId: Id<'indexers'>;
  guid: string;
  publishedAt: number;
  sizeBytes: number;
  protocol: DownloadProtocol;
  /** The covered Units. */
  unitIds: Id<'units'>[];
  alsoContainsUnitIds: Id<'units'>[];
  qualityRank: number;
  baseScore: number;
  score: number;
  parsed: { revision: Revision };
  torrent?: { seeders?: number };
};

export type RankContext = {
  profile: { preferredProtocol?: DownloadProtocol; preferSeasonPacks?: boolean };
  /** Indexer priority by ID, 1–50; lower wins. A missing indexer counts as the default, 25. */
  indexerPriority: Record<string, number>;
};

export type RankKey = 'preparation' | 'quality' | 'score' | 'revision' | 'coverage' | 'protocol' | 'seedersOrAge' | 'priority' | 'size' | 'guid' | 'equal';

const DEFAULT_PRIORITY = 25;

/** Negative when `a` ranks first: each key returns a's advantage as a number. */
type Key = [RankKey, (a: StoredCandidate, b: StoredCandidate, ctx: RankContext) => number];

const higherFirst = (x: number, y: number) => y - x;
const lowerFirst = (x: number, y: number) => x - y;

const KEYS: Key[] = [
  ['preparation', (a, b) => higherFirst(a.score - a.baseScore, b.score - b.baseScore)],
  ['quality', (a, b) => lowerFirst(a.qualityRank, b.qualityRank)],
  ['score', (a, b) => higherFirst(a.baseScore, b.baseScore)],
  ['revision', (a, b) => higherFirst(a.parsed.revision.version, b.parsed.revision.version) || higherFirst(a.parsed.revision.real, b.parsed.revision.real)],
  ['coverage', (a, b) => higherFirst(a.unitIds.length, b.unitIds.length) || lowerFirst(a.alsoContainsUnitIds.length, b.alsoContainsUnitIds.length)],
  [
    'protocol',
    (a, b, ctx) => {
      const preferred = ctx.profile.preferredProtocol;
      if (preferred === undefined || a.protocol === b.protocol) return 0;
      return a.protocol === preferred ? -1 : 1;
    },
  ],
  [
    'seedersOrAge',
    (a, b) => {
      if (a.protocol === 'torrent' && b.protocol === 'torrent') return higherFirst(a.torrent?.seeders ?? 0, b.torrent?.seeders ?? 0);
      if (a.protocol === 'usenet' && b.protocol === 'usenet') return higherFirst(a.publishedAt, b.publishedAt);
      return 0;
    },
  ],
  ['priority', (a, b, ctx) => lowerFirst(ctx.indexerPriority[a.indexerId] ?? DEFAULT_PRIORITY, ctx.indexerPriority[b.indexerId] ?? DEFAULT_PRIORITY)],
  ['size', (a, b) => higherFirst(a.sizeBytes, b.sizeBytes)],
  ['guid', (a, b) => (a.guid < b.guid ? -1 : a.guid > b.guid ? 1 : 0)],
];

/** Compares two accepted candidates by the ten keys above and reports the first key that differs. */
export function compareCandidates(a: StoredCandidate, b: StoredCandidate, ctx: RankContext): { order: -1 | 0 | 1; key: RankKey } {
  for (const [key, compare] of KEYS) {
    const difference = compare(a, b, ctx);
    if (difference !== 0) return { order: difference < 0 ? -1 : 1, key };
  }
  return { order: 0, key: 'equal' };
}

/** Keys 4–10 count as a tie-break for the loser's explanation. */
function lostOnOf(key: RankKey | 'seasonPack'): LostOn {
  if (key === 'seasonPack' || key === 'preparation' || key === 'quality' || key === 'score') return key;
  return 'tieBreak';
}

/** The search group a pick is for: its kind and the Units it wants. */
export type PickGroup = { kind: SearchGroupKind; wantedUnitIds: Id<'units'>[] };

const preparationPoints = (row: StoredCandidate) => row.score - row.baseScore;

/**
 * The full-season packs the profile prefers: in a season group with
 * `preferSeasonPacks` on, each candidate covering every wanted Unit whose
 * preparation and quality are no worse than the best other candidate's.
 */
function preferredPacks(rows: StoredCandidate[], ctx: RankContext & { group?: PickGroup }): Set<Id<'candidates'>> {
  const group = ctx.group;
  if (!ctx.profile.preferSeasonPacks || !group || (group.kind !== 'season' && group.kind !== 'animeSeason') || group.wantedUnitIds.length === 0)
    return new Set();
  const full = rows.filter((row) => group.wantedUnitIds.every((id) => row.unitIds.includes(id)));
  const others = rows.filter((row) => !full.includes(row));
  const best = others.sort((a, b) => compareCandidates(a, b, ctx).order)[0];
  const noWorse = (pack: StoredCandidate) => best === undefined || (preparationPoints(pack) >= preparationPoints(best) && pack.qualityRank <= best.qualityRank);
  return new Set(full.filter(noWorse).map((row) => row._id));
}

export type SelectionVerdict = {
  candidateId: Id<'candidates'>;
  outcome: 'picked' | 'rejected' | 'pending';
  reason?: Extract<CandidateReason, 'needsMorePreparation' | 'lowerScore' | 'unitBusy'>;
  rank: number;
  lostOn?: LostOn;
};

/**
 * Ranks the accepted candidates and, in `auto` mode, walks the ranked list,
 * picking each candidate whose covered Units are all still free. One
 * attempt can so start several Grabs on disjoint Unit sets. A full-season
 * pack the profile prefers ranks above every other candidate (`seasonPack`).
 * `offer` mode (interactive search) picks nothing and ranks every candidate
 * as pending.
 */
export function selectCandidates(
  rows: StoredCandidate[],
  ctx: RankContext & { group?: PickGroup; busyUnitIds: Id<'units'>[]; mode: 'auto' | 'offer' },
): { picks: Id<'candidates'>[]; verdicts: SelectionVerdict[] } {
  const packs = preferredPacks(rows, ctx);
  // The tier only overrides an order the usual keys would decide the other way; otherwise they explain it.
  const compare = (a: StoredCandidate, b: StoredCandidate): { order: number; key: RankKey | 'seasonPack' } => {
    const usual = compareCandidates(a, b, ctx);
    const tier = Number(packs.has(b._id)) - Number(packs.has(a._id));
    return tier === 0 || tier === usual.order ? usual : { order: tier, key: 'seasonPack' };
  };
  const ranked = [...rows].sort((a, b) => compare(a, b).order);
  if (ctx.mode === 'offer') return { picks: [], verdicts: ranked.map((row, i) => ({ candidateId: row._id, outcome: 'pending', rank: i + 1 })) };
  const busy = new Set(ctx.busyUnitIds);
  const taken = new Map<Id<'units'>, StoredCandidate>();
  const picks: StoredCandidate[] = [];
  const verdicts = ranked.map((row, i): SelectionVerdict => {
    const rank = i + 1;
    if (row.unitIds.some((id) => busy.has(id))) return { candidateId: row._id, outcome: 'rejected', reason: 'unitBusy', rank };
    // The first pick, in rank order, that took any of this candidate's Units.
    const winner = picks.find((pick) => row.unitIds.some((id) => taken.get(id) === pick));
    if (winner === undefined && row.unitIds.length > 0) {
      picks.push(row);
      for (const id of row.unitIds) taken.set(id, row);
      return { candidateId: row._id, outcome: 'picked', rank };
    }
    const key = winner ? compare(winner, row).key : 'equal';
    const lostOn = lostOnOf(key);
    return { candidateId: row._id, outcome: 'rejected', reason: key === 'preparation' ? 'needsMorePreparation' : 'lowerScore', lostOn, rank };
  });
  return { picks: picks.map((pick) => pick._id), verdicts };
}
