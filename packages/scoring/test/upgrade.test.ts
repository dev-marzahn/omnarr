// The upgrade rule: the cutoff, and when a candidate beats the Unit's current
// release, both against the current profile.
import { type ParsedRelease, QualityId, type ReleaseProfileContent } from '@omnarr/contracts';
import { describe, expect, test } from 'vite-plus/test';

import { isUpgrade, meetsCutoff, weigh } from '../src/upgrade.ts';
import { release } from './release.ts';

const RANKS = new Map<QualityId, number>([
  ['webdl-1080p', 1],
  ['bluray-1080p', 2],
  ['webrip-1080p', 3],
]);

/** A "1080p WEB" profile: cutoff WEB-DL 1080p at 1500, a minimum upgrade step of 10. */
const profile: ReleaseProfileContent = {
  name: '1080p WEB',
  qualities: QualityId.options.map((quality, i) => ({ quality, allowed: RANKS.has(quality), rank: RANKS.get(quality) ?? 10 + i })),
  minimumScore: 0,
  cutoff: { quality: 'webdl-1080p', score: 1500 },
  minimumUpgradeStep: 10,
  languages: [{ kind: 'original' }],
  formatScores: [
    { formatId: 'group.tier1', score: 1500 },
    { formatId: 'group.tier2', score: 1000 },
    { formatId: 'audio.eac3', score: 100 },
    { formatId: 'source.webdl', score: 50 },
    { formatId: 'repack', score: 5 },
    { formatId: 'prep.video', score: -10000 },
    { formatId: 'prep.remux', score: -10 },
  ],
  userFormats: [],
  groupTiers: [
    { formatId: 'group.tier1', groups: ['TIERONE'] },
    { formatId: 'group.tier2', groups: ['TIERTWO'] },
  ],
  sizeLimits: [],
  protocols: ['usenet', 'torrent'],
};

/** A WEB-DL 1080p E-AC-3 episode; untiered its base score is 150. */
const web = (overrides: Partial<ParsedRelease> = {}) =>
  release({ source: 'webdl', resolution: 1080, videoCodec: 'h264', audioCodec: 'eac3', group: 'UNTIERED', ...overrides });

describe('meetsCutoff', () => {
  test('a quality at or above the cutoff quality with the cutoff score meets it', () => {
    expect(meetsCutoff(weigh(web({ group: 'TIERONE' }), 'none', profile), profile)).toBe(true);
  });

  test('a lower base score than the cutoff score does not, even at the cutoff quality (150 < 1500)', () => {
    expect(meetsCutoff(weigh(web(), 'none', profile), profile)).toBe(false);
  });

  test('a worse quality than the cutoff quality does not, whatever its score', () => {
    expect(meetsCutoff(weigh(web({ source: 'webrip', group: 'TIERONE' }), 'none', profile), profile)).toBe(false);
  });
});

describe('isUpgrade', () => {
  const current = weigh(web(), 'none', profile);

  test("a tier-1 group's release with the same preparation is an upgrade over an untiered one (1650 over 150)", () => {
    expect(isUpgrade(weigh(web({ group: 'TIERONE' }), 'none', profile), current, profile)).toBe(true);
  });

  test('a release that needs a transcode never replaces one that does not, whatever its score', () => {
    expect(isUpgrade(weigh(web({ group: 'TIERONE', source: 'bluray' }), 'video', profile), current, profile)).toBe(false);
  });

  test('a current file that needed a video transcode is replaced by a release that does not, even a lower-scored one', () => {
    const transcoded = weigh(web({ group: 'TIERONE' }), 'video', profile);
    expect(isUpgrade(weigh(web({ source: 'webrip' }), 'remux', profile), transcoded, profile)).toBe(true);
  });

  test('a better quality wins on key 2 without the minimum step', () => {
    const bluray = weigh(web({ source: 'bluray', audioCodec: 'eac3' }), 'none', profile);
    expect(isUpgrade(weigh(web({ audioCodec: undefined }), 'none', profile), bluray, profile)).toBe(true);
  });

  test('a win on score alone needs the minimum upgrade step: a rise of 5 is not enough, 10 is', () => {
    expect(isUpgrade(weigh(web({ revision: { version: 2, real: 0, repack: true }, group: 'OTHER' }), 'none', profile), current, profile)).toBe(false);
    const ten = {
      ...profile,
      userFormats: [{ id: 'u', name: 'Ten', rule: { all: [{ field: 'group' as const, op: 'in' as const, values: ['OTHER'] }] }, score: 10 }],
    };
    expect(isUpgrade(weigh(web({ group: 'OTHER' }), 'none', ten), weigh(web(), 'none', ten), ten)).toBe(true);
  });

  test('the same group, quality and preparation with a higher revision is an upgrade: a PROPER, a REPACK, anime v2', () => {
    expect(isUpgrade(weigh(web({ revision: { version: 2, real: 0, repack: false } }), 'none', profile), current, profile)).toBe(true);
    expect(isUpgrade(weigh(web({ revision: { version: 1, real: 1, repack: false } }), 'none', profile), current, profile)).toBe(true);
  });

  test("another group's higher revision is not, nor the same release again", () => {
    expect(isUpgrade(weigh(web({ group: 'ELSE', revision: { version: 2, real: 0, repack: false } }), 'none', profile), current, profile)).toBe(false);
    expect(isUpgrade(weigh(web(), 'none', profile), current, profile)).toBe(false);
  });

  test('a worse release is not an upgrade', () => {
    expect(isUpgrade(current, weigh(web({ group: 'TIERONE' }), 'none', profile), profile)).toBe(false);
  });
});
