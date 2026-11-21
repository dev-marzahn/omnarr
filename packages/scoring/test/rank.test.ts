import { describe, expect, test } from 'vite-plus/test';

import type { Id } from '../src/ids.ts';
import { compareCandidates, type RankContext, selectCandidates, type StoredCandidate } from '../src/rank.ts';

const u = (...ids: string[]) => ids.map((id) => id as Id<'units'>);

/** An accepted WEB-DL 1080p episode that needs no preparation: rank 1, base 150. */
function candidate(id: string, overrides: Partial<StoredCandidate> = {}): StoredCandidate {
  return {
    _id: id as Id<'candidates'>,
    indexerId: 'idx1' as Id<'indexers'>,
    guid: id,
    publishedAt: 1_000,
    sizeBytes: 1_000,
    protocol: 'usenet',
    unitIds: u('e1'),
    alsoContainsUnitIds: [],
    qualityRank: 1,
    baseScore: 150,
    score: 150,
    parsed: { revision: { version: 1, real: 0, repack: false } },
    ...overrides,
  };
}

const ctx: RankContext = { profile: {}, indexerPriority: { idx1: 25, idx2: 10 } };
const compare = (a: StoredCandidate, b: StoredCandidate, context = ctx) => compareCandidates(a, b, context);

describe('compareCandidates: each key, in order', () => {
  test.each<[string, Partial<StoredCandidate>, Partial<StoredCandidate>, string]>([
    ['1. preparation points, higher first', { score: 150 }, { score: -9850 }, 'preparation'],
    ['2. quality rank, better first', { qualityRank: 1 }, { qualityRank: 2 }, 'quality'],
    ['3. base score, higher first', { baseScore: 1650, score: 1650 }, { baseScore: 150, score: 150 }, 'score'],
    ['4. revision version', { parsed: { revision: { version: 2, real: 0, repack: true } } }, {}, 'revision'],
    [
      '4. revision real',
      { parsed: { revision: { version: 2, real: 1, repack: false } } },
      { parsed: { revision: { version: 2, real: 0, repack: false } } },
      'revision',
    ],
    ['5. more covered Units', { unitIds: u('e1', 'e2') }, { unitIds: u('e1') }, 'coverage'],
    ['5. then fewer also-contained Units', { alsoContainsUnitIds: [] }, { alsoContainsUnitIds: u('e9') }, 'coverage'],
    ['7. Usenet: newer first', { publishedAt: 2_000 }, { publishedAt: 1_000 }, 'seedersOrAge'],
    ['8. indexer priority, lower first', { indexerId: 'idx2' as Id<'indexers'> }, { indexerId: 'idx1' as Id<'indexers'> }, 'priority'],
    ['9. size, larger first', { sizeBytes: 2_000 }, { sizeBytes: 1_000 }, 'size'],
    ['10. GUID, as a last fixed tie-break', { guid: 'a' }, { guid: 'b' }, 'guid'],
  ])('%s', (_name, better, worse, key) => {
    expect(compare(candidate('x', better), candidate('y', worse))).toEqual({ order: -1, key });
    expect(compare(candidate('y', worse), candidate('x', better))).toEqual({ order: 1, key });
  });

  test('7. torrents: more seeders first', () => {
    const torrent = (seeders: number) => candidate(`t${seeders}`, { protocol: 'torrent', torrent: { seeders }, guid: 'same' });
    expect(compare(torrent(9), torrent(3))).toEqual({ order: -1, key: 'seedersOrAge' });
  });

  test('6. protocol, when the profile prefers one', () => {
    const usenet = candidate('u', { guid: 'same' });
    const torrent = candidate('t', { protocol: 'torrent', torrent: { seeders: 5 }, guid: 'same' });
    expect(compare(torrent, usenet, { ...ctx, profile: { preferredProtocol: 'torrent' } })).toEqual({ order: -1, key: 'protocol' });
    expect(compare(torrent, usenet).key).not.toBe('protocol');
  });

  test('an earlier key decides before a later one', () => {
    const transcode = candidate('x', { qualityRank: 1, baseScore: 9000, score: -1000 });
    const fits = candidate('y', { qualityRank: 3, baseScore: 10, score: 10 });
    expect(compare(fits, transcode)).toEqual({ order: -1, key: 'preparation' });
  });

  test('quality before score: a tier-1 WEB-DL 720p (1650) loses to an untiered WEB-DL 1080p (150)', () => {
    const tier1At720 = candidate('x', { qualityRank: 4, baseScore: 1650, score: 1650 });
    const untieredAt1080 = candidate('y', { qualityRank: 1, baseScore: 150, score: 150 });
    expect(compare(untieredAt1080, tier1At720)).toEqual({ order: -1, key: 'quality' });
  });

  test('the same row compares equal', () => {
    expect(compare(candidate('x'), candidate('x'))).toEqual({ order: 0, key: 'equal' });
  });
});

describe('selectCandidates', () => {
  const auto = { ...ctx, busyUnitIds: [], mode: 'auto' as const };

  test('picks the best and records why each other one lost', () => {
    const rows = [
      candidate('transcode', { baseScore: 1650, score: -8350 }),
      candidate('best', { baseScore: 1650, score: 1650 }),
      candidate('webrip', { qualityRank: 2, baseScore: 1420, score: 1420 }),
      candidate('lowscore', { baseScore: 150, score: 150 }),
      candidate('older', { baseScore: 1650, score: 1650, publishedAt: 1 }),
    ];
    const result = selectCandidates(rows, auto);
    expect(result.picks).toEqual(['best']);
    expect(result.verdicts).toEqual([
      { candidateId: 'best', outcome: 'picked', rank: 1 },
      { candidateId: 'older', outcome: 'rejected', reason: 'lowerScore', lostOn: 'tieBreak', rank: 2 },
      { candidateId: 'lowscore', outcome: 'rejected', reason: 'lowerScore', lostOn: 'score', rank: 3 },
      { candidateId: 'webrip', outcome: 'rejected', reason: 'lowerScore', lostOn: 'quality', rank: 4 },
      { candidateId: 'transcode', outcome: 'rejected', reason: 'needsMorePreparation', lostOn: 'preparation', rank: 5 },
    ]);
  });

  test('a season pack that ties on keys 1–4 beats the episodes it covers', () => {
    const pack = candidate('pack', { unitIds: u('e1', 'e2', 'e3') });
    const e1 = candidate('e1', { unitIds: u('e1') });
    const e2 = candidate('e2', { unitIds: u('e2') });
    expect(selectCandidates([e1, e2, pack], auto).picks).toEqual(['pack']);
  });

  test('a pack of lower quality loses to the episodes, which are picked separately', () => {
    const pack = candidate('pack', { unitIds: u('e1', 'e2'), qualityRank: 2 });
    const e1 = candidate('e1', { unitIds: u('e1') });
    const e2 = candidate('e2', { unitIds: u('e2') });
    const result = selectCandidates([pack, e1, e2], auto);
    expect(result.picks).toEqual(['e1', 'e2']);
    expect(result.verdicts.find((v) => v.candidateId === 'pack')).toEqual({
      candidateId: 'pack',
      outcome: 'rejected',
      reason: 'lowerScore',
      lostOn: 'quality',
      rank: 3,
    });
  });

  test('a pack whose Units went to several picks loses to the first of them', () => {
    const e1 = candidate('e1', { unitIds: u('e1'), score: 150 });
    const e2 = candidate('e2', { unitIds: u('e2'), baseScore: 160, score: 160 });
    const pack = candidate('pack', { unitIds: u('e1', 'e2'), baseScore: 160, score: -9840 });
    const result = selectCandidates([pack, e1, e2], auto);
    expect(result.picks).toEqual(['e2', 'e1']);
    expect(result.verdicts.find((v) => v.candidateId === 'pack')).toMatchObject({ reason: 'needsMorePreparation', lostOn: 'preparation' });
  });

  test('a candidate with a covered Unit that gained an active Grab is unitBusy', () => {
    const result = selectCandidates([candidate('a', { unitIds: u('e1', 'e2') }), candidate('b', { unitIds: u('e2'), baseScore: 10, score: 10 })], {
      ...auto,
      busyUnitIds: u('e1'),
    });
    expect(result.picks).toEqual(['b']);
    expect(result.verdicts[0]).toEqual({ candidateId: 'a', outcome: 'rejected', reason: 'unitBusy', rank: 1 });
  });

  test('offer mode picks nothing and ranks every candidate as pending', () => {
    const result = selectCandidates([candidate('b', { baseScore: 10, score: 10 }), candidate('a')], { ...auto, mode: 'offer' });
    expect(result).toEqual({
      picks: [],
      verdicts: [
        { candidateId: 'a', outcome: 'pending', rank: 1 },
        { candidateId: 'b', outcome: 'pending', rank: 2 },
      ],
    });
  });

  test('nothing to rank picks nothing', () => {
    expect(selectCandidates([], auto)).toEqual({ picks: [], verdicts: [] });
  });
});

describe('selectCandidates: prefer full-season packs', () => {
  const season = { kind: 'season' as const, wantedUnitIds: u('e1', 'e2', 'e3') };
  const on = { ...ctx, profile: { preferSeasonPacks: true }, group: season, busyUnitIds: [], mode: 'auto' as const };
  // The Andor case: a whole-season pack at 150 against a tier-1 single episode at 1650.
  const pack = candidate('pack', { unitIds: u('e1', 'e2', 'e3') });
  const e1 = candidate('e1', { unitIds: u('e1'), baseScore: 1650, score: 1650 });
  const e2 = candidate('e2', { unitIds: u('e2') });
  const e3 = candidate('e3', { unitIds: u('e3'), qualityRank: 2, baseScore: 0, score: 0 });

  test('a pack covering every wanted Unit wins over higher-scoring single episodes, which lose on seasonPack', () => {
    const result = selectCandidates([e1, e2, e3, pack], on);
    expect(result.picks).toEqual(['pack']);
    expect(result.verdicts[0]).toEqual({ candidateId: 'pack', outcome: 'picked', rank: 1 });
    expect(result.verdicts.find((v) => v.candidateId === 'e1')).toEqual({
      candidateId: 'e1',
      outcome: 'rejected',
      reason: 'lowerScore',
      lostOn: 'seasonPack',
      rank: 2,
    });
  });

  test('off, the ranking is as before: the 1650 episode beats the pack on score', () => {
    const result = selectCandidates([e1, e2, e3, pack], { ...on, profile: { preferSeasonPacks: false } });
    expect(result.picks).toEqual(['e1', 'e2', 'e3']);
    expect(result.verdicts.find((v) => v.candidateId === 'pack')).toMatchObject({ reason: 'lowerScore', lostOn: 'score' });
  });

  test('inside the tier, score decides between packs', () => {
    const better = candidate('better', { unitIds: u('e1', 'e2', 'e3'), baseScore: 650, score: 650 });
    const result = selectCandidates([e1, pack, better], on);
    expect(result.picks).toEqual(['better']);
    expect(result.verdicts.find((v) => v.candidateId === 'pack')).toMatchObject({ reason: 'lowerScore', lostOn: 'score' });
  });

  test('a pack of worse quality than the best alternative stays in its usual place', () => {
    const bluray = candidate('pack', { unitIds: u('e1', 'e2', 'e3'), qualityRank: 2 });
    expect(selectCandidates([e1, e2, bluray], on).picks).toEqual(['e1', 'e2']);
  });

  test('a pack that needs more preparation than the best alternative stays in its usual place', () => {
    const hevc = candidate('pack', { unitIds: u('e1', 'e2', 'e3'), score: -9850 });
    expect(selectCandidates([e1, e2, hevc], on).picks).toEqual(['e1', 'e2']);
  });

  test('a partial pack is no full-season pack', () => {
    const partial = candidate('partial', { unitIds: u('e1', 'e2') });
    expect(selectCandidates([e1, e2, e3, partial], on).picks).toEqual(['e1', 'e2', 'e3']);
  });

  test('applies to anime season groups, and not to episode groups', () => {
    expect(selectCandidates([e1, pack], { ...on, group: { ...season, kind: 'animeSeason' } }).picks).toEqual(['pack']);
    expect(selectCandidates([e1, pack], { ...on, group: { kind: 'episode', wantedUnitIds: u('e1') } }).picks).toEqual(['e1']);
  });
});
