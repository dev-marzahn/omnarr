// Jellyfin's play method and transcode reasons in platform terms. The names
// are 12.4's OpenAPI enums (fixtures/jellyfin/README.md).
import { describe, expect, test } from 'vite-plus/test';

import { playMethod, transcodeReasons } from '../src/jellyfin/reasons.ts';

describe('playMethod', () => {
  test.each([
    ['DirectPlay', 'directPlay'],
    ['DirectStream', 'directStream'],
    ['Transcode', 'transcode'],
  ])('%s is %s', (name, method) => {
    expect(playMethod(name)).toBe(method);
  });

  test('an unknown or missing name is no method', () => {
    expect(playMethod('Teleport')).toBeUndefined();
    expect(playMethod(undefined)).toBeUndefined();
  });
});

describe('transcodeReasons', () => {
  test.each([
    ['ContainerNotSupported', 'container'],
    ['VideoCodecNotSupported', 'videoCodec'],
    ['VideoProfileNotSupported', 'videoProfile'],
    ['VideoLevelNotSupported', 'videoLevel'],
    ['VideoResolutionNotSupported', 'videoResolution'],
    ['VideoBitDepthNotSupported', 'videoBitDepth'],
    ['VideoRangeTypeNotSupported', 'videoRange'],
    ['VideoFramerateNotSupported', 'videoFramerate'],
    ['AudioCodecNotSupported', 'audioCodec'],
    ['AudioChannelsNotSupported', 'audioChannels'],
    ['AudioProfileNotSupported', 'audioProfile'],
    ['SubtitleCodecNotSupported', 'subtitle'],
    ['ContainerBitrateExceedsLimit', 'bitrate'],
    ['VideoBitrateNotSupported', 'bitrate'],
    ['AudioBitrateNotSupported', 'bitrate'],
    // 12.4's names with no platform term of their own.
    ['AudioIsExternal', 'other'],
    ['SecondaryAudioNotSupported', 'other'],
    ['RefFramesNotSupported', 'other'],
    ['AnamorphicVideoNotSupported', 'other'],
    ['InterlacedVideoNotSupported', 'other'],
    ['AudioSampleRateNotSupported', 'other'],
    ['AudioBitDepthNotSupported', 'other'],
    ['UnknownVideoStreamInfo', 'other'],
    ['UnknownAudioStreamInfo', 'other'],
    ['DirectPlayError', 'other'],
    ['VideoCodecTagNotSupported', 'other'],
    ['StreamCountExceedsLimit', 'other'],
    ['VideoRotationNotSupported', 'other'],
  ])('%s is %s', (name, reason) => {
    expect(transcodeReasons([name])).toEqual({ reasons: [reason], rawReasons: [name] });
  });

  test('an unknown name is other, and rawReasons keeps it', () => {
    expect(transcodeReasons(['SomethingNewIn13'])).toEqual({ reasons: ['other'], rawReasons: ['SomethingNewIn13'] });
  });

  test("keeps Jellyfin's order, and names each platform reason once", () => {
    expect(transcodeReasons(['ContainerNotSupported', 'AudioCodecNotSupported', 'VideoBitrateNotSupported', 'ContainerBitrateExceedsLimit'])).toEqual({
      reasons: ['container', 'audioCodec', 'bitrate'],
      rawReasons: ['ContainerNotSupported', 'AudioCodecNotSupported', 'VideoBitrateNotSupported', 'ContainerBitrateExceedsLimit'],
    });
  });

  test('no TranscodingInfo is no reasons', () => {
    expect(transcodeReasons(undefined)).toEqual({ reasons: [], rawReasons: [] });
  });
});
