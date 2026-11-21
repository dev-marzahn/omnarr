import { describe, expect, test } from 'vite-plus/test';

import { QualityId } from '../src/release.ts';
import { Condition, FormatRule, ReleaseProfile, ReleaseProfileContent, ReleaseProfileDetail, ReleaseProfileSummary } from '../src/releaseProfile.ts';

const allowed = new Map([
  ['webdl-1080p', 1],
  ['webrip-1080p', 2],
]);

/** A hand-written profile: two allowed qualities, the rest disallowed after them. */
const content = {
  name: 'Small WEB',
  qualities: QualityId.options.map((quality, i) => ({ quality, allowed: allowed.has(quality), rank: allowed.get(quality) ?? 10 + i })),
  minimumScore: 0,
  cutoff: { quality: 'webdl-1080p', score: 1500 },
  minimumUpgradeStep: 10,
  languages: [{ kind: 'preferred' }, { kind: 'original' }, { kind: 'code', code: 'de' }],
  formatScores: [
    { formatId: 'group.tier1', score: 1500 },
    { formatId: 'prep.video', score: -10000 },
  ],
  userFormats: [
    {
      id: 'uf1',
      name: 'German audio',
      rule: { all: [{ field: 'languages', op: 'any', values: ['de'] }], none: [{ field: 'resolution', op: 'gte', values: [2160] }] },
      score: 100,
    },
  ],
  groupTiers: [{ formatId: 'group.tier1', groups: ['GRPA', 'GRPB'] }],
  sizeLimits: [{ quality: 'webdl-1080p', maxMbPerMin: 40 }],
  protocols: ['usenet', 'torrent'],
};

describe('ReleaseProfileContent', () => {
  test('accepts a hand-written profile', () => {
    expect(ReleaseProfileContent.parse(content)).toEqual(content);
    expect(ReleaseProfile.parse({ ...content, shippedKey: 'web-1080p', shippedVersion: 1, editedByUser: false })).toMatchObject({ shippedKey: 'web-1080p' });
  });

  test('rejects a profile missing a quality', () => {
    expect(ReleaseProfileContent.safeParse({ ...content, qualities: content.qualities.slice(1) }).success).toBe(false);
  });

  test('rejects a profile listing a quality twice', () => {
    expect(ReleaseProfileContent.safeParse({ ...content, qualities: [...content.qualities, content.qualities[0]] }).success).toBe(false);
  });

  test('rejects a user format whose rule has no condition', () => {
    const empty = { ...content, userFormats: [{ id: 'uf2', name: 'Nothing', rule: { all: [], any: [] }, score: 1 }] };
    expect(ReleaseProfileContent.safeParse(empty).success).toBe(false);
  });
});

describe('FormatRule and Condition', () => {
  test('a rule needs at least one condition', () => {
    expect(FormatRule.safeParse({}).success).toBe(false);
    expect(FormatRule.safeParse({ none: [] }).success).toBe(false);
    expect(FormatRule.safeParse({ any: [{ field: 'atmos', op: 'is', value: true }] }).success).toBe(true);
  });

  test.each([
    { field: 'source', op: 'in', values: ['webdl'] },
    { field: 'group', op: 'notIn', values: ['GRPX'] },
    { field: 'resolution', op: 'lte', values: [1080] },
    { field: 'bitDepth', op: 'in', values: [10] },
    { field: 'hdr', op: 'none', values: ['dv'] },
    { field: 'subtitleLanguages', op: 'all', values: ['en'] },
    { field: 'repack', op: 'is', value: true },
    { field: 'edition.imax', op: 'is', value: true },
  ])('accepts %o', (condition) => {
    expect(Condition.safeParse(condition).success).toBe(true);
  });

  test.each([
    ['a set operator on a number field with strings', { field: 'resolution', op: 'in', values: ['1080'] }],
    ['an ordering operator on a string field', { field: 'source', op: 'gte', values: ['webdl'] }],
    ['an unknown edition flag', { field: 'edition.director', op: 'is', value: true }],
    ['a title regex', { field: 'title', op: 'in', values: ['.*'] }],
  ])('rejects %s', (_name, condition) => {
    expect(Condition.safeParse(condition).success).toBe(false);
  });
});

describe('the profile DTOs', () => {
  const summary = { id: 'k57abc', name: 'Small WEB', shippedKey: 'web-1080p', edited: true, updateAvailable: false, usedBy: 2 };
  const detail = {
    id: 'k57abc',
    profile: { ...content, editedByUser: true },
    usedBy: { libraries: [{ libraryId: 'lib1', name: 'Series' }], works: [{ workId: 'w1', title: 'The Long Harbor' }] },
    formatCatalogue: [{ id: 'prep.video', name: 'Needs video transcode', kind: 'preparation' }],
    targetWarnings: [],
  };

  test('accept their fields', () => {
    expect(ReleaseProfileSummary.safeParse(summary).success).toBe(true);
    expect(ReleaseProfileDetail.safeParse(detail).success).toBe(true);
  });

  test.each(['apiKey', 'downloadUrl', 'magnetUrl'])('reject a %s key (.strict())', (key) => {
    expect(ReleaseProfileSummary.safeParse({ ...summary, [key]: 'secret' }).success).toBe(false);
    expect(ReleaseProfileDetail.safeParse({ ...detail, [key]: 'secret' }).success).toBe(false);
  });
});
