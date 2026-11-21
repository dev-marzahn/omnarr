import { describe, expect, test } from 'vite-plus/test';

import { CandidateReason, LanguageCode, LostOn, ParsedRelease, QualityId, ScoreBreakdown } from '../src/release.ts';

/** Every field of a parse set, as a full parse of a WEB-DL episode would. */
const full = {
  title: 'The Long Harbor',
  normalizedTitle: 'the long harbor',
  year: 2021,
  episodes: [{ season: 1, episode: 2 }],
  airDate: '2021-03-11',
  pack: { seasons: [1], full: true },
  special: false,
  extras: false,
  resolution: 1080,
  source: 'webdl',
  modifier: 'remux',
  streamingService: 'AMZN',
  videoCodec: 'h264',
  bitDepth: 10,
  hdr: ['dv', 'hdr10'],
  audioCodec: 'eac3',
  audioChannels: '5.1',
  atmos: true,
  languages: ['en', 'multi'],
  subtitleLanguages: ['de'],
  hardcodedSubs: false,
  edition: { extended: true, criterion: true },
  revision: { version: 2, real: 0, repack: true },
  group: 'GRPA',
  container: 'mkv',
  notes: ['dubbed'],
};

/** The fewest fields a parse returns: an unknown string. */
const empty = {
  title: '',
  normalizedTitle: '',
  episodes: [],
  special: false,
  extras: false,
  hdr: [],
  atmos: false,
  languages: [],
  subtitleLanguages: [],
  hardcodedSubs: false,
  edition: {},
  revision: { version: 1, real: 0, repack: false },
  notes: ['languageAssumed'],
};

describe('ParsedRelease', () => {
  test('accepts a parse with every field set, and one with none of the optional fields', () => {
    expect(ParsedRelease.parse(full)).toEqual(full);
    expect(ParsedRelease.parse(empty)).toEqual(empty);
  });

  test.each([
    ['a resolution outside the list', { resolution: 1440 }],
    ['an unknown source', { source: 'vhs' }],
    ['an unknown codec', { videoCodec: 'divx' }],
    ['an unknown HDR type', { hdr: ['hdr12'] }],
    ['an air date that is not YYYY-MM-DD', { airDate: '2021-3-11' }],
    ['a language outside LanguageCode', { languages: ['xx'] }],
    ['channels outside the list', { audioChannels: '6.1' }],
    ['an unknown container', { container: 'wmv' }],
  ])('rejects %s', (_name, patch) => {
    expect(ParsedRelease.safeParse({ ...full, ...patch }).success).toBe(false);
  });

  test('LanguageCode is ISO 639-1 plus multi', () => {
    expect(LanguageCode.options).toContain('multi');
    expect(LanguageCode.options.filter((code) => code !== 'multi').every((code) => /^[a-z]{2}$/.test(code))).toBe(true);
    expect(LanguageCode.options).toHaveLength(27);
  });
});

describe('quality, reasons and the breakdown', () => {
  test('QualityId lists the quality catalogue, including unknown', () => {
    expect([...QualityId.options].sort()).toEqual(
      [
        'remux-2160p',
        'remux-1080p',
        'bluray-2160p',
        'bluray-1080p',
        'bluray-720p',
        'bluray-576p',
        'bluray-480p',
        'webdl-2160p',
        'webdl-1080p',
        'webdl-720p',
        'webdl-480p',
        'webrip-2160p',
        'webrip-1080p',
        'webrip-720p',
        'webrip-480p',
        'hdtv-2160p',
        'hdtv-1080p',
        'hdtv-720p',
        'sdtv',
        'dvd',
        'cam',
        'telesync',
        'telecine',
        'screener',
        'workprint',
        'brdisk',
        'rawhd',
        'unknown',
      ].sort(),
    );
  });

  test('CandidateReason has the size, seeder, busy and upgrade reasons', () => {
    for (const reason of ['sizeOutOfRange', 'noSeeders', 'unitBusy', 'notAnUpgrade']) expect(CandidateReason.options).toContain(reason);
  });

  test('breakdown entries say whether they are a format or the preparation', () => {
    expect(ScoreBreakdown.parse([{ name: 'Needs video transcode', points: -10000, kind: 'preparation' }])).toHaveLength(1);
    expect(ScoreBreakdown.safeParse([{ name: 'WEB-DL', points: 50 }]).success).toBe(false);
  });

  test('LostOn names the ranking keys a loser can lose on', () => {
    expect(LostOn.options).toEqual(['seasonPack', 'preparation', 'quality', 'score', 'tieBreak']);
  });
});
