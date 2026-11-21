import { describe, expect, test } from 'vite-plus/test';

import { DEFAULT_DEVICES, DEVICE_TABLE, targetForDevices } from '../src/devices.ts';
import { TargetFormat } from '../src/playback.ts';

// The brief's default: MP4, H.264 8-bit, 1080p, SDR, AAC (and MP3,
// Opus, FLAC) up to 2.0, text sidecar files.
const BRIEF_DEFAULT: TargetFormat = {
  containers: ['mp4'],
  video: { codecs: ['h264'], maxHeight: 1080, maxBitrateKbps: null, hdr: 'sdrOnly', maxBitDepth: { h264: 8, hevc: 8, av1: 8 } },
  audio: { codecs: ['aac', 'mp3', 'opus', 'flac'], maxChannels: 2 },
  subtitles: { mode: 'text', textFormats: ['srt', 'ass'] },
};

describe('targetForDevices', () => {
  test("the default devices, Chrome and the Android app, give the brief's target with a 1080p cap", () => {
    expect(DEFAULT_DEVICES).toEqual(['chrome', 'jellyfinAndroid']);
    const target = targetForDevices(DEFAULT_DEVICES);
    expect(target).toEqual(BRIEF_DEFAULT);
    expect(TargetFormat.parse(target)).toEqual(target);
  });

  test('maxHeightOverride replaces the derived cap, and null removes it', () => {
    expect(targetForDevices(DEFAULT_DEVICES, 720).video.maxHeight).toBe(720);
    expect(targetForDevices(DEFAULT_DEVICES, null).video.maxHeight).toBeNull();
    expect(targetForDevices(DEFAULT_DEVICES, undefined).video.maxHeight).toBe(1080);
  });

  test('Fire TV alone gives MP4 and Matroska, HEVC 10-bit, HDR10, E-AC-3 and 6 channels', () => {
    expect(targetForDevices(['jellyfinFireTv'])).toEqual({
      containers: ['mp4', 'mkv'],
      video: { codecs: ['h264', 'hevc'], maxHeight: 2160, maxBitrateKbps: null, hdr: 'hdr10', maxBitDepth: { h264: 8, hevc: 10, av1: 8 } },
      audio: { codecs: ['aac', 'ac3', 'eac3', 'mp3', 'opus', 'flac'], maxChannels: 6 },
      subtitles: { mode: 'text', textFormats: ['srt'] },
    });
  });

  test("intersections keep the first ticked device's order, and take the lowest cap, channel count and HDR level", () => {
    const target = targetForDevices(['jellyfinFireTv', 'chrome']);
    expect(target.containers).toEqual(['mp4']);
    expect(target.video.codecs).toEqual(['h264']);
    expect(target.video.maxHeight).toBe(2160);
    expect(target.video.hdr).toBe('sdrOnly');
    expect(target.audio).toEqual({ codecs: ['aac', 'mp3', 'opus', 'flac'], maxChannels: 2 });
    expect(target.subtitles.textFormats).toEqual(['srt']);
  });

  test('an empty container intersection falls back to MP4, and an empty text-format one to SRT', () => {
    const table = {
      ...DEVICE_TABLE,
      chrome: { ...DEVICE_TABLE.chrome, containers: ['mkv' as const], textSubtitles: ['ass' as const] },
      jellyfinAndroid: { ...DEVICE_TABLE.jellyfinAndroid, containers: ['mp4' as const], textSubtitles: [] },
    };
    const target = targetForDevices(DEFAULT_DEVICES, undefined, table);
    expect(target.containers).toEqual(['mp4']);
    expect(target.subtitles.textFormats).toEqual(['srt']);
  });

  test('Chrome alone has no height cap and plays AV1 10-bit', () => {
    const target = targetForDevices(['chrome']);
    expect(target.video.maxHeight).toBeNull();
    expect(target.video.codecs).toEqual(['h264', 'av1']);
    expect(target.video.maxBitDepth).toEqual({ h264: 8, hevc: 8, av1: 10 });
  });
});
