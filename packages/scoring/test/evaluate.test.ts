import { type IndexerItem, type ParsedRelease, QualityId, type ReleaseProfileContent } from '@omnarr/contracts';
import { describe, expect, test } from 'vite-plus/test';

import { evaluate, type EvaluateInput, releaseKeyOf } from '../src/evaluate.ts';
import type { Id } from '../src/ids.ts';
import type { MatchResult } from '../src/match.ts';
import { DEFAULT_PREPARATION_TARGET } from '../src/preparation.ts';
import { release } from './release.ts';

const u = (id: string) => id as Id<'units'>;
const ALLOWED = new Map<QualityId, number>([
  ['webdl-1080p', 1],
  ['webrip-1080p', 2],
]);

const profile: ReleaseProfileContent = {
  name: 'Test',
  qualities: QualityId.options.map((quality, i) => ({ quality, allowed: ALLOWED.has(quality), rank: ALLOWED.get(quality) ?? 10 + i })),
  minimumScore: 100,
  cutoff: { quality: 'webdl-1080p', score: 1000 },
  minimumUpgradeStep: 10,
  languages: [{ kind: 'preferred' }, { kind: 'original' }],
  formatScores: [
    { formatId: 'group.tier1', score: 1500 },
    { formatId: 'source.webdl', score: 50 },
    { formatId: 'audio.eac3', score: 100 },
    { formatId: 'prep.video', score: -10000 },
    { formatId: 'prep.audioOrSubtitle', score: 0 },
  ],
  userFormats: [{ id: 'uf1', name: 'German audio', rule: { all: [{ field: 'languages', op: 'any', values: ['de'] }] }, score: 25 }],
  groupTiers: [{ formatId: 'group.tier1', groups: ['GRPA'] }],
  sizeLimits: [{ quality: 'webdl-1080p', minMbPerMin: 5, maxMbPerMin: 50 }],
  protocols: ['usenet', 'torrent'],
};

/** A WEB-DL 1080p H.264 E-AC-3 episode from a tier-1 group: base 1650, needs audio conversion. */
const good = release({
  source: 'webdl',
  resolution: 1080,
  videoCodec: 'h264',
  audioCodec: 'eac3',
  audioChannels: '5.1',
  group: 'GRPA',
  languages: ['en'],
  episodes: [{ season: 1, episode: 2 }],
});
const item: IndexerItem = {
  guid: 'guid-1',
  title: 'The.Long.Harbor.S01E02.1080p.WEB-DL.DDP5.1.H.264-GRPA',
  downloadUrl: 'https://indexer.example/1.nzb',
  sizeBytes: 1_200_000_000,
  protocol: 'usenet',
  publishedAt: 1,
  categories: [5040],
  ids: {},
};
const matched: MatchResult = { ok: true, coveredUnitIds: [u('u1')], alsoContainsUnitIds: [], matchDetail: 'tvdb/xem, mapped' };

const input = (overrides: Partial<EvaluateInput> & { parsed?: ParsedRelease } = {}): EvaluateInput => ({
  parsed: good,
  item,
  match: matched,
  profile,
  blocklistKeys: { releaseKeys: [], normalizedTitles: [] },
  target: DEFAULT_PREPARATION_TARGET,
  runtimeMinutes: 45,
  originalLanguage: 'en',
  preferredLanguage: 'en',
  ...overrides,
});

describe('evaluate', () => {
  test('an acceptable release: quality, scores, breakdown, preparation and Units', () => {
    expect(evaluate(input())).toEqual({
      accepted: true,
      matchDetail: 'tvdb/xem, mapped',
      quality: 'webdl-1080p',
      qualityRank: 1,
      qualityAssumed: false,
      baseScore: 1650,
      score: 1650,
      breakdown: [
        { name: 'Group tier 1', points: 1500, kind: 'format' },
        { name: 'WEB-DL', points: 50, kind: 'format' },
        { name: 'E-AC-3', points: 100, kind: 'format' },
        { name: 'Needs audio or subtitle conversion', points: 0, kind: 'preparation' },
      ],
      preparation: { step: 'audio', assumed: false },
      coveredUnitIds: ['u1'],
      alsoContainsUnitIds: [],
    });
  });

  test('the breakdown adds up to the score, with the preparation format and user formats', () => {
    const hevc = release({ ...good, videoCodec: 'h265', languages: ['de'] });
    const verdict = evaluate(input({ parsed: hevc, originalLanguage: 'de' }));
    expect(verdict.breakdown).toContainEqual({ name: 'German audio', points: 25, kind: 'format' });
    expect(verdict.breakdown).toContainEqual({ name: 'Needs video transcode', points: -10000, kind: 'preparation' });
    expect(verdict.breakdown.reduce((sum, entry) => sum + entry.points, 0)).toBe(verdict.score);
    expect(verdict).toMatchObject({ baseScore: 1675, score: -8325 });
  });

  test('formats the profile scores at 0 are left out of the breakdown', () => {
    const verdict = evaluate(input({ parsed: release({ ...good, revision: { version: 2, real: 0, repack: true } }) }));
    expect(verdict.breakdown.map((entry) => entry.name)).not.toContain('Repack or proper');
  });

  test('an assumed quality and preparation are reported', () => {
    const verdict = evaluate(input({ parsed: release({ ...good, resolution: undefined, audioCodec: undefined }) }));
    expect(verdict).toMatchObject({ quality: 'webdl-1080p', qualityAssumed: true, preparation: { step: 'audio', assumed: true } });
  });

  describe('the checks, in order (one reason each)', () => {
    test('1. a failed title or Unit match is wrongTitleOrEpisode, with its detail', () => {
      expect(evaluate(input({ match: { ok: false, detail: 'title' } }))).toMatchObject({
        accepted: false,
        reason: 'wrongTitleOrEpisode',
        matchDetail: 'title',
        coveredUnitIds: [],
      });
      expect(evaluate(input({ match: { ok: false, detail: 'otherEpisode' } }))).toMatchObject({ reason: 'wrongTitleOrEpisode', matchDetail: 'otherEpisode' });
    });

    test('1 comes before 2', () => {
      expect(evaluate(input({ match: { ok: false, detail: 'kind' }, blocklistKeys: { releaseKeys: ['guid-1'], normalizedTitles: [] } })).reason).toBe(
        'wrongTitleOrEpisode',
      );
    });

    test('2. blocklisted by GUID', () => {
      expect(evaluate(input({ blocklistKeys: { releaseKeys: ['guid-1'], normalizedTitles: [] } })).reason).toBe('blocklisted');
    });

    test('2. blocklisted by normalized title, so a re-post under a new GUID is caught', () => {
      const keys = { releaseKeys: [], normalizedTitles: ['the long harbor s01e02 1080p web dl ddp5 1 h 264 grpa'] };
      expect(evaluate(input({ item: { ...item, guid: 'new', title: `${item.title}-Obfuscated` }, blocklistKeys: keys })).reason).toBe('blocklisted');
    });

    test('2. a torrent is keyed by its info hash, else its GUID', () => {
      const torrent: IndexerItem = { ...item, protocol: 'torrent', torrent: { infoHash: 'abc', seeders: 3 } };
      expect(evaluate(input({ item: torrent, blocklistKeys: { releaseKeys: ['abc'], normalizedTitles: [] } })).reason).toBe('blocklisted');
      expect(evaluate(input({ item: torrent, blocklistKeys: { releaseKeys: ['guid-1'], normalizedTitles: [] } })).accepted).toBe(true);
    });

    test('2. the info hash key is normalized, so a base32 magnet hash and a hex infohash give one key', () => {
      const base32: IndexerItem = { ...item, guid: 'other', protocol: 'torrent', torrent: { infoHash: 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567' } };
      const hex: IndexerItem = { ...item, protocol: 'torrent', torrent: { infoHash: '00443214C74254B635CF84653A56D7C675BE77DF' } };
      expect(releaseKeyOf(base32)).toBe('00443214c74254b635cf84653a56d7c675be77df');
      expect(releaseKeyOf(hex)).toBe('00443214c74254b635cf84653a56d7c675be77df');
      expect(evaluate(input({ item: base32, blocklistKeys: { releaseKeys: [releaseKeyOf(hex)], normalizedTitles: [] } })).reason).toBe('blocklisted');
    });

    test('2 comes before 3', () => {
      const uhd = release({ ...good, resolution: 2160 });
      expect(evaluate(input({ parsed: uhd, blocklistKeys: { releaseKeys: ['guid-1'], normalizedTitles: [] } })).reason).toBe('blocklisted');
    });

    test('3. a quality the profile does not allow is notInProfile', () => {
      expect(evaluate(input({ parsed: release({ ...good, resolution: 2160 }) }))).toMatchObject({ reason: 'notInProfile', quality: 'webdl-2160p' });
    });

    test('3. so is a protocol the profile does not allow', () => {
      expect(evaluate(input({ profile: { ...profile, protocols: ['torrent'] } })).reason).toBe('notInProfile');
    });

    test('4. a size outside the limit, in MB per minute of the summed runtime', () => {
      // 1.2 GB over 45 minutes is 26.7 MB/min: inside 5–50.
      expect(evaluate(input()).accepted).toBe(true);
      expect(evaluate(input({ item: { ...item, sizeBytes: 3_000_000_000 } })).reason).toBe('sizeOutOfRange');
      expect(evaluate(input({ item: { ...item, sizeBytes: 100_000_000 } })).reason).toBe('sizeOutOfRange');
      // A two-episode pack doubles the runtime.
      expect(evaluate(input({ item: { ...item, sizeBytes: 3_000_000_000 }, runtimeMinutes: 90 })).accepted).toBe(true);
    });

    test('4. is skipped when the runtime or the size is unknown, or the quality has no limit', () => {
      expect(evaluate(input({ item: { ...item, sizeBytes: 3_000_000_000 }, runtimeMinutes: undefined })).accepted).toBe(true);
      expect(evaluate(input({ item: { ...item, sizeBytes: 0 } })).accepted).toBe(true);
      const webrip = release({ ...good, source: 'webrip' });
      expect(evaluate(input({ parsed: webrip, item: { ...item, sizeBytes: 9_000_000_000 } })).reason).not.toBe('sizeOutOfRange');
    });

    test('5. no language of the release in the profile is language', () => {
      expect(evaluate(input({ parsed: release({ ...good, languages: ['de'] }) })).reason).toBe('language');
    });

    test('6. a torrent with 0 seeders is noSeeders', () => {
      expect(evaluate(input({ item: { ...item, protocol: 'torrent', torrent: { seeders: 0 } } })).reason).toBe('noSeeders');
      expect(evaluate(input({ item: { ...item, protocol: 'torrent', torrent: { seeders: 1 } } })).accepted).toBe(true);
    });

    test('7. a base score below the minimum is belowMinimumScore', () => {
      const untiered = release({ ...good, group: 'GRPX' });
      expect(evaluate(input({ parsed: untiered }))).toMatchObject({ accepted: true, baseScore: 150 });
      expect(evaluate(input({ parsed: untiered, profile: { ...profile, minimumScore: 1000 } }))).toMatchObject({
        accepted: false,
        reason: 'belowMinimumScore',
      });
    });

    test('7. the minimum is checked against baseScore, so a transcode never rejects', () => {
      const hevc = release({ ...good, videoCodec: 'h265' });
      expect(evaluate(input({ parsed: hevc, profile: { ...profile, minimumScore: 1000 } }))).toMatchObject({ accepted: true, baseScore: 1650, score: -8350 });
    });

    test('a rejected release still gets its quality, scores and preparation', () => {
      expect(evaluate(input({ parsed: release({ ...good, languages: ['de'] }) }))).toMatchObject({
        quality: 'webdl-1080p',
        baseScore: 1675,
        preparation: { step: 'audio' },
      });
    });
  });

  describe('languages', () => {
    test('an untagged release counts as the original language', () => {
      const untagged = release({ ...good, languages: [], notes: ['languageAssumed'] });
      expect(
        evaluate(input({ parsed: untagged, originalLanguage: 'en', preferredLanguage: 'de', profile: { ...profile, languages: [{ kind: 'original' }] } }))
          .accepted,
      ).toBe(true);
      expect(
        evaluate(input({ parsed: untagged, originalLanguage: 'ja', preferredLanguage: 'de', profile: { ...profile, languages: [{ kind: 'preferred' }] } }))
          .reason,
      ).toBe('language');
    });

    test('multi adds the original language', () => {
      const multi = release({ ...good, languages: ['multi', 'de'] });
      expect(
        evaluate(input({ parsed: multi, originalLanguage: 'en', preferredLanguage: 'fr', profile: { ...profile, languages: [{ kind: 'original' }] } }))
          .accepted,
      ).toBe(true);
    });

    test('dubbed adds the preferred language', () => {
      const dubbed = release({ ...good, languages: [], notes: ['dubbed', 'languageAssumed'] });
      expect(
        evaluate(input({ parsed: dubbed, originalLanguage: 'ja', preferredLanguage: 'de', profile: { ...profile, languages: [{ kind: 'preferred' }] } }))
          .accepted,
      ).toBe(true);
    });

    test('an untagged release passes when the original language is unknown, and the breakdown says so', () => {
      const untagged = release({ ...good, languages: [], notes: ['languageAssumed'] });
      const verdict = evaluate(
        input({ parsed: untagged, originalLanguage: undefined, preferredLanguage: 'de', profile: { ...profile, languages: [{ kind: 'preferred' }] } }),
      );
      expect(verdict.accepted).toBe(true);
      expect(verdict.breakdown).toContainEqual({ name: 'Language unknown', points: 0, kind: 'format' });
    });

    test('a listed code matches', () => {
      const german = release({ ...good, languages: ['de'] });
      expect(evaluate(input({ parsed: german, profile: { ...profile, languages: [{ kind: 'code', code: 'de' }] } })).accepted).toBe(true);
    });
  });
});
