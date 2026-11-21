import { type ParsedRelease, QualityId } from '@omnarr/contracts';
import { describe, expect, test } from 'vite-plus/test';

import { QUALITIES, qualityOf } from '../src/qualities.ts';
import { release } from './release.ts';

type Source = NonNullable<ParsedRelease['source']>;
const R = [2160, 1080, 720, 576, 540, 480, 360] as const;

/** One row of the quality table: the quality for each resolution column, then for no resolution. */
const TABLE: [string, { source?: Source; modifier?: 'remux' }, string[], string, boolean][] = [
  [
    'bluray (remux)',
    { source: 'bluray', modifier: 'remux' },
    ['remux-2160p', 'remux-1080p', 'remux-1080p', 'remux-1080p', 'remux-1080p', 'remux-1080p', 'remux-1080p'],
    'remux-1080p',
    false,
  ],
  [
    'bluray',
    { source: 'bluray' },
    ['bluray-2160p', 'bluray-1080p', 'bluray-720p', 'bluray-576p', 'bluray-480p', 'bluray-480p', 'bluray-480p'],
    'bluray-1080p',
    true,
  ],
  ['webdl', { source: 'webdl' }, ['webdl-2160p', 'webdl-1080p', 'webdl-720p', 'webdl-480p', 'webdl-480p', 'webdl-480p', 'webdl-480p'], 'webdl-1080p', true],
  [
    'webrip',
    { source: 'webrip' },
    ['webrip-2160p', 'webrip-1080p', 'webrip-720p', 'webrip-480p', 'webrip-480p', 'webrip-480p', 'webrip-480p'],
    'webrip-1080p',
    true,
  ],
  ['hdtv', { source: 'hdtv' }, ['hdtv-2160p', 'hdtv-1080p', 'hdtv-720p', 'sdtv', 'sdtv', 'sdtv', 'sdtv'], 'hdtv-720p', true],
  ['ppv', { source: 'ppv' }, ['hdtv-2160p', 'hdtv-1080p', 'hdtv-720p', 'sdtv', 'sdtv', 'sdtv', 'sdtv'], 'hdtv-720p', true],
  ['none (resolution only)', {}, ['webdl-2160p', 'webdl-1080p', 'webdl-720p', 'webdl-480p', 'webdl-480p', 'webdl-480p', 'webdl-480p'], 'unknown', false],
];

describe('qualityOf', () => {
  for (const [name, fields, byResolution, none, noneAssumed] of TABLE) {
    describe(name, () => {
      test.each(R.map((resolution, i) => [resolution, byResolution[i]!] as const))('%ip → %s', (resolution, quality) => {
        expect(qualityOf(release({ ...fields, resolution }))).toEqual({ quality, assumed: false });
      });
      test(`no resolution → ${none}${noneAssumed ? ', assumed' : ''}`, () => {
        expect(qualityOf(release(fields))).toEqual({ quality: none, assumed: noneAssumed });
      });
    });
  }

  test.each(['sdtv', 'dvd', 'cam', 'telesync', 'telecine', 'screener', 'workprint'] as const)('%s is the same quality at any resolution', (source) => {
    for (const resolution of [...R, undefined])
      expect(qualityOf(release({ source, ...(resolution ? { resolution } : {}) }))).toEqual({ quality: source, assumed: false });
  });

  test('a DVD remux is DVD quality: the remux row is the Bluray row', () => {
    expect(qualityOf(release({ source: 'dvd', modifier: 'remux', resolution: 480 }))).toEqual({ quality: 'dvd', assumed: false });
  });

  test.each(['brdisk', 'rawhd'] as const)('the %s modifier gives %s', (modifier) => {
    expect(qualityOf(release({ source: 'bluray', modifier, resolution: 1080 }))).toEqual({ quality: modifier, assumed: false });
  });
});

describe('QUALITIES', () => {
  test('lists every QualityId once, with a display name', () => {
    expect(QUALITIES.map((q) => q.id)).toEqual(QualityId.options);
    expect(QUALITIES.find((q) => q.id === 'webdl-1080p')?.name).toBe('WEB-DL 1080p');
    expect(QUALITIES.find((q) => q.id === 'remux-2160p')?.name).toBe('Remux 2160p');
  });
});
