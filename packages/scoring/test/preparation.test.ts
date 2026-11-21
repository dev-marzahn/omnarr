import { DEFAULT_DEVICES, QualityId, type ReleaseProfileContent, type TargetFormat, targetForDevices } from '@omnarr/contracts';
import { describe, expect, test } from 'vite-plus/test';

import { DEFAULT_PREPARATION_TARGET, predictPreparation, type PreparationTarget, toPreparationTarget, wouldNeedTranscode } from '../src/preparation.ts';
import { release } from './release.ts';

const T = DEFAULT_PREPARATION_TARGET;
/** A release that fits the default target exactly: no assumption, no step. */
const fitting = { source: 'webdl', resolution: 1080, videoCodec: 'h264', audioCodec: 'aac', audioChannels: '2.0', container: 'mp4' } as const;
const step = (overrides = {}, target: PreparationTarget = T) => predictPreparation(release({ ...fitting, ...overrides }), target);

describe('predictPreparation', () => {
  test('the default target is H.264, 1080, SDR, AAC stereo in MP4', () => {
    expect(T).toEqual({ videoCodecs: ['h264'], maxResolution: 1080, hdr: 'sdrOnly', audioCodecs: ['aac'], maxChannels: 2, container: 'mp4' });
  });

  test('a release that fits needs nothing', () => {
    expect(step()).toEqual({ step: 'none', assumed: false });
  });

  describe('video', () => {
    test.each([
      ['a codec the target lacks', { videoCodec: 'h265' }],
      ['a resolution above the target', { resolution: 2160 }],
      ['HDR for an SDR-only target', { hdr: ['hdr10'] }],
      ['HLG', { hdr: ['hlg'] }],
    ])('%s', (_name, overrides) => {
      expect(step(overrides)).toEqual({ step: 'video', assumed: false });
    });

    test('Dolby Vision without an HDR10 fallback, unless the target is dv', () => {
      const hdr10Target: PreparationTarget = { ...T, videoCodecs: ['h265'], hdr: 'hdr10' };
      expect(step({ videoCodec: 'h265', hdr: ['dv'] }, hdr10Target).step).toBe('video');
      expect(step({ videoCodec: 'h265', hdr: ['dv', 'hdr10'] }, hdr10Target).step).toBe('none');
      expect(step({ videoCodec: 'h265', hdr: ['dv'] }, { ...hdr10Target, hdr: 'dv' }).step).toBe('none');
    });

    test('an hdr10 target accepts HDR10+, whose base layer is HDR10', () => {
      expect(step({ videoCodec: 'h265', hdr: ['hdr10plus'] }, { ...T, videoCodecs: ['h265'], hdr: 'hdr10' }).step).toBe('none');
    });

    test('HLG fits a dv target (every Dolby Vision device plays HLG); hdr10 and sdrOnly still need a transcode', () => {
      const hevc: PreparationTarget = { ...T, videoCodecs: ['h265'] };
      expect(step({ videoCodec: 'h265', hdr: ['hlg'] }, { ...hevc, hdr: 'dv' })).toEqual({ step: 'none', assumed: false });
      expect(step({ videoCodec: 'h265', hdr: ['hlg'] }, { ...hevc, hdr: 'hdr10' }).step).toBe('video');
      expect(step({ videoCodec: 'h265', hdr: ['hlg'] }, { ...hevc, hdr: 'sdrOnly' }).step).toBe('video');
    });
  });

  describe('audio', () => {
    test.each([
      ['a codec the target lacks', { audioCodec: 'eac3' }],
      ['more channels than the target', { audioChannels: '5.1' }],
    ])('%s', (_name, overrides) => {
      expect(step(overrides)).toEqual({ step: 'audio', assumed: false });
    });

    test('counts 7.1 as 8 channels', () => {
      expect(step({ audioChannels: '7.1' }, { ...T, maxChannels: 6 }).step).toBe('audio');
      expect(step({ audioChannels: '5.1' }, { ...T, maxChannels: 6 }).step).toBe('none');
    });
  });

  describe('remux', () => {
    test('a container other than the target', () => {
      expect(step({ container: 'mkv' })).toEqual({ step: 'remux', assumed: false });
    });

    test('no extension counts as MKV', () => {
      expect(step({ container: undefined })).toEqual({ step: 'remux', assumed: false });
      expect(step({ container: undefined }, { ...T, container: 'mkv' })).toEqual({ step: 'none', assumed: false });
    });
  });

  test('the most expensive step wins', () => {
    expect(step({ videoCodec: 'h265', audioCodec: 'eac3', container: 'mkv' }).step).toBe('video');
    expect(step({ audioCodec: 'eac3', container: 'mkv' }).step).toBe('audio');
  });

  describe('assumptions', () => {
    test('no codec at or below 1080p without HDR is assumed H.264', () => {
      expect(step({ videoCodec: undefined })).toEqual({ step: 'none', assumed: true });
    });

    test('no codec above 1080p, or with HDR, is assumed HEVC', () => {
      const uhd = { ...T, maxResolution: 2160, videoCodecs: ['h264'] as const };
      expect(step({ videoCodec: undefined, resolution: 2160 }, { ...uhd, videoCodecs: ['h264'] })).toEqual({ step: 'video', assumed: true });
      expect(step({ videoCodec: undefined, resolution: 2160 }, { ...uhd, videoCodecs: ['h265'] })).toEqual({ step: 'none', assumed: true });
      expect(step({ videoCodec: undefined, hdr: ['hdr10'] }, { ...T, videoCodecs: ['h265'], hdr: 'hdr10' })).toEqual({ step: 'none', assumed: true });
    });

    test('no resolution counts as 1080', () => {
      expect(step({ resolution: undefined })).toEqual({ step: 'none', assumed: true });
      expect(step({ resolution: undefined }, { ...T, maxResolution: 720 })).toEqual({ step: 'video', assumed: true });
    });

    test.each([
      ['webdl', 'eac3', 'audio'],
      ['webrip', 'eac3', 'audio'],
      ['bluray', 'dts', 'audio'],
      ['hdtv', 'aac', 'none'],
      [undefined, 'aac', 'none'],
    ] as const)('no audio codec on %s is assumed %s', (source, _codec, expected) => {
      expect(step({ audioCodec: undefined, source })).toEqual({ step: expected, assumed: true });
    });

    test('an assumption that decides nothing is not reported', () => {
      expect(step({ videoCodec: 'h265', audioCodec: undefined })).toEqual({ step: 'video', assumed: false });
      expect(step({ resolution: 2160, videoCodec: undefined })).toEqual({ step: 'video', assumed: false });
    });
  });
});

describe('wouldNeedTranscode', () => {
  const profile = (allowed: QualityId[]): ReleaseProfileContent => ({
    name: 'p',
    qualities: QualityId.options.map((quality, i) => ({ quality, allowed: allowed.includes(quality), rank: i + 1 })),
    minimumScore: 0,
    cutoff: { quality: allowed[0]!, score: 0 },
    minimumUpgradeStep: 10,
    languages: [],
    formatScores: [],
    userFormats: [],
    groupTiers: [],
    sizeLimits: [],
    protocols: ['usenet'],
  });

  test('false when at most half of the allowed qualities would need a video transcode', () => {
    expect(wouldNeedTranscode(profile(['webdl-1080p', 'bluray-1080p', 'webrip-1080p', 'webdl-720p']), T)).toBe(false);
    expect(wouldNeedTranscode(profile(['webdl-1080p', 'webdl-2160p']), T)).toBe(false);
  });

  test('true when more than half would', () => {
    expect(wouldNeedTranscode(profile(['webdl-2160p', 'bluray-2160p', 'webrip-2160p']), T)).toBe(true);
    expect(wouldNeedTranscode(profile(['webdl-2160p', 'bluray-2160p', 'webdl-1080p']), T)).toBe(true);
  });

  test('a 2160p profile fits a 2160p HEVC HDR10 target', () => {
    const uhd: PreparationTarget = { ...T, videoCodecs: ['h265'], maxResolution: 2160, hdr: 'hdr10' };
    expect(wouldNeedTranscode(profile(['webdl-2160p', 'bluray-2160p', 'webrip-2160p']), uhd)).toBe(false);
  });
});

describe("toPreparationTarget: scoring's target from a library's TargetFormat", () => {
  test('the default devices give the brief target with all four audio codecs', () => {
    expect(toPreparationTarget(targetForDevices(DEFAULT_DEVICES))).toEqual({
      videoCodecs: ['h264'],
      maxResolution: 1080,
      hdr: 'sdrOnly',
      audioCodecs: ['aac', 'mp3', 'opus', 'flac'],
      maxChannels: 2,
      container: 'mp4',
    });
  });

  test('hevc is h265, the first container is the one a remux produces, and HDR and channels pass through', () => {
    expect(toPreparationTarget(targetForDevices(['jellyfinFireTv']))).toEqual({
      videoCodecs: ['h264', 'h265'],
      maxResolution: 2160,
      hdr: 'hdr10',
      audioCodecs: ['aac', 'ac3', 'eac3', 'mp3', 'opus', 'flac'],
      maxChannels: 6,
      container: 'mp4',
    });
  });

  test('no height cap is 4320', () => {
    const uncapped: TargetFormat = { ...targetForDevices(DEFAULT_DEVICES, null), containers: ['mkv', 'mp4'] };
    expect(toPreparationTarget(uncapped)).toMatchObject({ maxResolution: 4320, container: 'mkv' });
  });
});
