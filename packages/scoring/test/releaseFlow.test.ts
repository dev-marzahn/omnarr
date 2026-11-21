// Eight releases for S02E03 of The Long Harbor, through the parser, matching,
// evaluate and the pick, against a fixture profile of the test's own.
import { type IndexerItem, QualityId, type ReleaseProfileContent } from '@omnarr/contracts';
import { normalizeReleaseTitle, parseRelease } from '@omnarr/parser';
import { expect, test } from 'vite-plus/test';

import {
  DEFAULT_PREPARATION_TARGET,
  evaluate,
  type Id,
  matchTitle,
  matchUnits,
  selectCandidates,
  type StoredCandidate,
  type WorkForMatch,
} from '../src/index.ts';

const RANKS = new Map<QualityId, number>([
  ['webdl-1080p', 1],
  ['webrip-1080p', 2],
  ['hdtv-720p', 3],
]);

const profile: ReleaseProfileContent = {
  name: '1080p WEB',
  qualities: QualityId.options.map((quality, i) => ({ quality, allowed: RANKS.has(quality), rank: RANKS.get(quality) ?? 10 + i })),
  minimumScore: 1000,
  cutoff: { quality: 'webdl-1080p', score: 1500 },
  minimumUpgradeStep: 10,
  languages: [{ kind: 'preferred' }, { kind: 'original' }],
  formatScores: [
    { formatId: 'group.tier1', score: 1500 },
    { formatId: 'group.tier2', score: 1320 },
    { formatId: 'group.tier3', score: 300 },
    { formatId: 'source.webdl', score: 50 },
    { formatId: 'audio.eac3', score: 100 },
    { formatId: 'audio.aac', score: 100 },
    { formatId: 'prep.video', score: -10000 },
  ],
  userFormats: [],
  groupTiers: [
    { formatId: 'group.tier1', groups: ['GRPA', 'GRPB'] },
    { formatId: 'group.tier2', groups: ['GRPC'] },
    { formatId: 'group.tier3', groups: ['GRPF'] },
  ],
  sizeLimits: [],
  protocols: ['usenet', 'torrent'],
};

const E03 = 'unit-s02e03' as Id<'units'>;
const work: WorkForMatch = {
  kind: 'series',
  year: 2021,
  aliases: [{ aliasId: 'alias-1' as Id<'workAliases'>, normalized: 'the long harbor' }],
  ids: { tmdb: '900001' },
};
const GB = 1_000_000_000;

const ROWS: [string, number][] = [
  ['The.Long.Harbor.S02E03.1080p.WEB-DL.DDP5.1.H.264-GRPA', 2.1],
  ['The.Long.Harbor.S02E03.1080p.WEB-DL.DDP5.1.HEVC-GRPB', 1.4],
  ['The.Long.Harbor.S02E03.1080p.WEBRip.AAC2.0.x264-GRPC', 1.8],
  ['The.Long.Harbor.S02E03.1080p.WEB-DL.H.264-GRPD', 2.0],
  ['The.Long.Harbor.S02E03.2160p.WEB-DL.DV.HEVC-GRPA', 6.0],
  ['The.Long.Harbor.S02E03.720p.HDTV.x264-GRPF', 0.7],
  ['The.Long.Harbor.S02E03.GERMAN.1080p.WEB.H264-GRPG', 2.0],
  ['The.Long.Harbour.Tales.S02E03.1080p.WEB.H264-GRPH', 1.9],
];

test('eight releases: GRPA is picked and every other row has its reason', () => {
  const evaluated = ROWS.map(([title, size], i) => {
    const item: IndexerItem = {
      guid: `guid-${i}`,
      title,
      downloadUrl: `https://indexer.example/${i}.nzb`,
      sizeBytes: size * GB,
      protocol: 'usenet',
      publishedAt: 0,
      categories: [5040],
      ids: {},
    };
    const parsed = parseRelease(title, 'series');
    const title_ = matchTitle(parsed, item, work);
    // resolveUnits, stubbed: S02E03 is one Unit through the TVDB ordering.
    const match = title_.ok
      ? matchUnits({ unitIds: [E03], via: { ordering: 'tvdb', source: 'xem' }, confidence: 'mapped' }, { unitIds: [E03], wantedUnitIds: [E03] }, parsed)
      : title_;
    const verdict = evaluate({
      parsed,
      item,
      match,
      profile,
      blocklistKeys: { releaseKeys: [], normalizedTitles: [normalizeReleaseTitle('The.Long.Harbor.S02E03.1080p.WEB-DL.H.264-GRPD')] },
      target: DEFAULT_PREPARATION_TARGET,
      preferredLanguage: 'en',
      originalLanguage: 'en',
    });
    return { title, item, verdict };
  });

  const accepted = evaluated.filter((row) => row.verdict.accepted);
  const stored: StoredCandidate[] = accepted.map(({ item, verdict }) => ({
    _id: item.guid as Id<'candidates'>,
    indexerId: 'newznab-main' as Id<'indexers'>,
    guid: item.guid,
    publishedAt: item.publishedAt,
    sizeBytes: item.sizeBytes,
    protocol: item.protocol,
    unitIds: verdict.coveredUnitIds,
    alsoContainsUnitIds: verdict.alsoContainsUnitIds,
    qualityRank: verdict.qualityRank,
    baseScore: verdict.baseScore,
    score: verdict.score,
    parsed: { revision: { version: 1, real: 0, repack: false } },
  }));
  const { picks, verdicts } = selectCandidates(stored, { profile, indexerPriority: {}, busyUnitIds: [], mode: 'auto' });

  const outcome = (group: string) => {
    const row = evaluated.find((r) => r.title.endsWith(group))!;
    const pick = verdicts.find((v) => v.candidateId === row.item.guid);
    return {
      score: row.verdict.score,
      baseScore: row.verdict.baseScore,
      reason: row.verdict.reason ?? pick?.reason,
      lostOn: pick?.lostOn,
      picked: pick?.outcome === 'picked',
    };
  };

  expect(picks).toEqual(['guid-0']);
  expect(outcome('-GRPA')).toEqual({ score: 1650, baseScore: 1650, reason: undefined, lostOn: undefined, picked: true });
  expect(outcome('HEVC-GRPB')).toMatchObject({ baseScore: 1650, score: -8350, reason: 'needsMorePreparation', picked: false });
  expect(outcome('x264-GRPC')).toMatchObject({ score: 1420, reason: 'lowerScore', lostOn: 'quality' });
  expect(outcome('GRPD')).toMatchObject({ reason: 'blocklisted' });
  expect(outcome('DV.HEVC-GRPA')).toMatchObject({ reason: 'notInProfile' });
  expect(outcome('GRPF')).toMatchObject({ score: 300, reason: 'belowMinimumScore' });
  expect(outcome('GRPG')).toMatchObject({ reason: 'language' });
  expect(outcome('GRPH')).toMatchObject({ reason: 'wrongTitleOrEpisode' });
  expect(evaluated.find((r) => r.title.endsWith('GRPH'))!.verdict.matchDetail).toBe('title');
});
