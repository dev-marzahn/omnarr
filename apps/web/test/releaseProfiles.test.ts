// The profile screens' logic: badges, the update banner, the quality
// ranking and the editor's error text.
import type { QualityEntry, ReleaseProfileSummary } from '@omnarr/contracts';
import { describe, expect, test } from 'vite-plus/test';

import {
  badges,
  buildCondition,
  conditionLabel,
  languageSpecOf,
  moveQuality,
  pendingBanner,
  profileBadges,
  profileErrorText,
  rankedGroups,
  setAllowed,
  versionLine,
} from '../lib/releaseProfiles';

describe('badges', () => {
  const summary = (overrides: Partial<ReleaseProfileSummary>) =>
    ({ name: 'x', edited: false, updateAvailable: false, usedBy: 0, ...overrides }) as ReleaseProfileSummary;
  test('Shipped, Edited and Update available', () => {
    expect(badges(summary({ shippedKey: 'web-1080p' }))).toEqual(['Shipped']);
    expect(badges(summary({ shippedKey: 'web-1080p', edited: true, updateAvailable: true }))).toEqual(['Shipped', 'Edited', 'Update available']);
    expect(badges(summary({}))).toEqual([]);
  });
});

test('pendingBanner names both versions', () => {
  expect(pendingBanner({ shippedVersion: 1, pendingShippedVersion: 2 })).toBe(
    'Shipped version 2 is available. Your edits keep this profile on version 1. Reset to apply it.',
  );
  expect(pendingBanner({ shippedVersion: 1 })).toBeUndefined();
});

describe('the profile header', () => {
  const shipped = { shippedKey: 'web-1080p', shippedVersion: 2, editedByUser: false };

  test('badges from the stored profile: Shipped, Edited and Update available', () => {
    expect(profileBadges(shipped)).toEqual(['Shipped']);
    expect(profileBadges({ ...shipped, shippedVersion: 1, editedByUser: true, pendingShippedVersion: 2 })).toEqual(['Shipped', 'Edited', 'Update available']);
    expect(profileBadges({ editedByUser: false })).toEqual([]);
  });

  test('the shipped version, and what an edit means for later updates', () => {
    expect(versionLine(shipped)).toBe('Shipped version 2 · updated with each release');
    expect(versionLine({ ...shipped, editedByUser: true })).toBe(
      "Shipped version 2 · edited. Later shipped updates won't overwrite this profile while it's edited.",
    );
    expect(versionLine({ editedByUser: false })).toBeUndefined();
  });
});

describe('the quality ranking', () => {
  const qualities: QualityEntry[] = [
    { quality: 'webrip-1080p', allowed: true, rank: 2 },
    { quality: 'webdl-1080p', allowed: true, rank: 1 },
    { quality: 'bluray-1080p', allowed: true, rank: 2 },
    { quality: 'cam', allowed: false, rank: 9 },
  ];

  test('groups equal ranks, best first, disallowed last', () => {
    expect(rankedGroups(qualities).map((group) => group.map((q) => q.quality))).toEqual([['webdl-1080p'], ['webrip-1080p', 'bluray-1080p'], ['cam']]);
  });

  test('moving a quality up takes it out of its group and in front of the group above', () => {
    const moved = moveQuality(qualities, 'bluray-1080p', 'up');
    expect(rankedGroups(moved).map((group) => group.map((q) => q.quality))).toEqual([['webdl-1080p'], ['bluray-1080p'], ['webrip-1080p'], ['cam']]);
  });

  test('moving a quality down past the next group', () => {
    const moved = moveQuality(qualities, 'webdl-1080p', 'down');
    expect(rankedGroups(moved).map((group) => group.map((q) => q.quality))).toEqual([['webrip-1080p', 'bluray-1080p'], ['webdl-1080p'], ['cam']]);
  });

  test('allowing a quality ranks it last among the allowed ones', () => {
    const allowed = setAllowed(qualities, 'cam', true);
    expect(allowed.find((q) => q.quality === 'cam')).toEqual({ quality: 'cam', allowed: true, rank: 3 });
  });
});

describe('the editor', () => {
  test('languageSpecOf: the two tokens, a code, or nothing', () => {
    expect(languageSpecOf('preferred')).toEqual({ kind: 'preferred' });
    expect(languageSpecOf('original')).toEqual({ kind: 'original' });
    expect(languageSpecOf('de')).toEqual({ kind: 'code', code: 'de' });
    expect(languageSpecOf('xx')).toBeUndefined();
  });

  test('buildCondition reads the values for the field, and refuses what the contract refuses', () => {
    expect(buildCondition('group', 'in', 'GRPA, grpb')).toEqual({ field: 'group', op: 'in', values: ['GRPA', 'grpb'] });
    expect(buildCondition('resolution', 'gte', '1080')).toEqual({ field: 'resolution', op: 'gte', values: [1080] });
    expect(buildCondition('languages', 'any', 'de')).toEqual({ field: 'languages', op: 'any', values: ['de'] });
    expect(buildCondition('atmos', 'is', 'true')).toEqual({ field: 'atmos', op: 'is', value: true });
    expect(buildCondition('resolution', 'any', '1080')).toBeUndefined();
    expect(buildCondition('group', 'in', '')).toBeUndefined();
  });

  test('conditionLabel', () => {
    expect(conditionLabel({ field: 'group', op: 'in', values: ['GRPA', 'GRPB'] })).toBe('group in GRPA, GRPB');
    expect(conditionLabel({ field: 'atmos', op: 'is', value: false })).toBe('atmos is false');
  });
});

test('profileErrorText', () => {
  expect(profileErrorText({ data: { code: 'inUse', libraries: 'Series', works: '' } })).toBe('Used by Series. Choose another profile there first.');
  expect(profileErrorText({ data: { code: 'nameTaken' } })).toBe('Another profile has this name.');
});
