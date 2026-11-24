// Jellyfin's play method and transcode reasons in platform terms. The names
// are 12.4's OpenAPI enums (fixtures/jellyfin/README.md).
import { describe, expect, test } from 'vite-plus/test';

import { playMethod, transcodeReasons } from '../src/jellyfin/reasons.ts';

describe('playMethod', () => {
  // Without a transcode job, what the client reported; Jellyfin's dashboard
  // shows a DirectStream with no job as a direct play too.
  test.each([
    ['DirectPlay', 'directPlay'],
    ['DirectStream', 'directPlay'],
    ['Transcode', 'transcode'],
  ])('%s with no TranscodingInfo is %s', (name, method) => {
    expect(playMethod(name, undefined)).toBe(method);
  });

  // With one, what the server runs, whatever the client reported.
  test.each([
    ['video and audio copied', { IsVideoDirect: true, IsAudioDirect: true, VideoCodec: 'h264' }, 'remux'],
    ['audio copied, no video stream', { IsVideoDirect: false, IsAudioDirect: true }, 'remux'],
    ['video copied, audio converted', { IsVideoDirect: true, IsAudioDirect: false, VideoCodec: 'h264' }, 'transcode'],
    ['video converted', { IsVideoDirect: false, IsAudioDirect: true, VideoCodec: 'h264' }, 'transcode'],
  ])('%s is %s', (_, info, method) => {
    for (const name of ['DirectPlay', 'DirectStream', 'Transcode']) expect(playMethod(name, info)).toBe(method);
  });

  test("a client that reports DirectPlay while Jellyfin stream-copies to HLS is a remux (the Android app's fallback)", () => {
    expect(playMethod('DirectPlay', { IsVideoDirect: true, IsAudioDirect: true, VideoCodec: 'h264' })).toBe('remux');
  });

  test('an unknown or missing name with no TranscodingInfo is no method', () => {
    expect(playMethod('Teleport', undefined)).toBeUndefined();
    expect(playMethod(undefined, undefined)).toBeUndefined();
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
    ['AudioIsExternal', 'externalAudio'],
    ['SecondaryAudioNotSupported', 'secondaryAudio'],
    ['RefFramesNotSupported', 'refFrames'],
    ['AnamorphicVideoNotSupported', 'anamorphic'],
    ['InterlacedVideoNotSupported', 'interlaced'],
    ['AudioSampleRateNotSupported', 'audioSampleRate'],
    ['AudioBitDepthNotSupported', 'audioBitDepth'],
    ['UnknownVideoStreamInfo', 'unknownStream'],
    ['UnknownAudioStreamInfo', 'unknownStream'],
    ['DirectPlayError', 'directPlayFailed'],
    ['VideoCodecTagNotSupported', 'videoCodecTag'],
    ['StreamCountExceedsLimit', 'streamCount'],
    ['VideoRotationNotSupported', 'videoRotation'],
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
