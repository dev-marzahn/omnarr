// Human-readable labels for catalogue IDs on the settings pages.
import { QualityId } from '@omnarr/contracts';
import { describe, expect, test } from 'vite-plus/test';

import { groupTierLabel, qualityLabel } from '../lib/labels';

describe('qualityLabel', () => {
  test.each([
    ['webdl-1080p', 'WEB-DL 1080p'],
    ['bluray-1080p', 'Bluray 1080p'],
    ['webrip-1080p', 'WEBRip 1080p'],
    ['webdl-720p', 'WEB-DL 720p'],
    ['remux-2160p', 'Remux 2160p'],
    ['hdtv-720p', 'HDTV 720p'],
    ['sdtv', 'SDTV'],
    ['dvd', 'DVD'],
    ['brdisk', 'BR-DISK'],
    ['rawhd', 'Raw-HD'],
    ['cam', 'CAM'],
    ['unknown', 'Unknown'],
  ] as const)('%s is %s', (id, label) => {
    expect(qualityLabel(id)).toBe(label);
  });

  test('every quality in the catalogue has its own label', () => {
    const labels = QualityId.options.map(qualityLabel);
    expect(labels.every((label, i) => label !== QualityId.options[i])).toBe(true);
    expect(new Set(labels).size).toBe(labels.length);
  });
});

describe('groupTierLabel', () => {
  test.each([
    ['group.tier1', 'Release group tier 1 · TRaSH list'],
    ['group.tier3', 'Release group tier 3 · TRaSH list'],
    ['group.lowQuality', 'Low-quality groups · TRaSH list'],
    ['anime.tier2', 'Anime release group tier 2 · TRaSH list'],
  ])('%s is %s', (formatId, label) => {
    expect(groupTierLabel(formatId)).toBe(label);
  });

  test('a format outside the shipped tiers keeps its ID', () => {
    expect(groupTierLabel('group.custom')).toBe('group.custom');
  });
});
