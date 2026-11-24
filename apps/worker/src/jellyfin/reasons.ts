// Jellyfin's play method and transcode reasons in platform terms. The names
// are Jellyfin 12.4's `PlayMethod` and `TranscodeReason` enums
// (test/fixtures/jellyfin/README.md). A name a later release adds is
// `other`; `rawReasons` keeps Jellyfin's names.
import type { PlayMethod, TranscodeReason } from '@omnarr/contracts';

/**
 * What the client reported, read only when Jellyfin runs no transcode job:
 * a DirectStream without one serves the file as it is, which Jellyfin's
 * dashboard shows as a direct play too.
 */
const REPORTED: Record<string, PlayMethod> = {
  DirectPlay: 'directPlay',
  DirectStream: 'directPlay',
  Transcode: 'transcode',
};

const REASONS: Record<string, TranscodeReason> = {
  ContainerNotSupported: 'container',
  VideoCodecNotSupported: 'videoCodec',
  VideoProfileNotSupported: 'videoProfile',
  VideoLevelNotSupported: 'videoLevel',
  VideoResolutionNotSupported: 'videoResolution',
  VideoBitDepthNotSupported: 'videoBitDepth',
  VideoRangeTypeNotSupported: 'videoRange',
  VideoFramerateNotSupported: 'videoFramerate',
  AudioCodecNotSupported: 'audioCodec',
  AudioChannelsNotSupported: 'audioChannels',
  AudioProfileNotSupported: 'audioProfile',
  SubtitleCodecNotSupported: 'subtitle',
  ContainerBitrateExceedsLimit: 'bitrate',
  VideoBitrateNotSupported: 'bitrate',
  AudioBitrateNotSupported: 'bitrate',
  AudioIsExternal: 'externalAudio',
  SecondaryAudioNotSupported: 'secondaryAudio',
  RefFramesNotSupported: 'refFrames',
  AnamorphicVideoNotSupported: 'anamorphic',
  InterlacedVideoNotSupported: 'interlaced',
  AudioSampleRateNotSupported: 'audioSampleRate',
  AudioBitDepthNotSupported: 'audioBitDepth',
  UnknownVideoStreamInfo: 'unknownStream',
  UnknownAudioStreamInfo: 'unknownStream',
  DirectPlayError: 'directPlayFailed',
  VideoCodecTagNotSupported: 'videoCodecTag',
  StreamCountExceedsLimit: 'streamCount',
  VideoRotationNotSupported: 'videoRotation',
};

export type TranscodingInfo = { IsVideoDirect?: boolean; IsAudioDirect?: boolean; VideoCodec?: string };

/**
 * How a session plays, decided as Jellyfin's dashboard decides it: a
 * transcode job (`TranscodingInfo`) is what the server really runs, so it
 * wins over `PlayState.PlayMethod`, which is only what the client reported.
 * The Android app reports DirectPlay after it falls back to a stream copy.
 * With a job, copied video (or none) and copied audio is a `remux`,
 * anything else a transcode. Without one, the client's
 * report; undefined for a name 12.4 doesn't have.
 */
export function playMethod(reported: string | undefined, info: TranscodingInfo | undefined): PlayMethod | undefined {
  if (info) return (info.IsVideoDirect || !info.VideoCodec) && info.IsAudioDirect ? 'remux' : 'transcode';
  return reported !== undefined && Object.hasOwn(REPORTED, reported) ? REPORTED[reported] : undefined;
}

/** `TranscodingInfo.TranscodeReasons`, in Jellyfin's order, each platform reason once. */
export function transcodeReasons(names: readonly string[] | undefined): { reasons: TranscodeReason[]; rawReasons: string[] } {
  const rawReasons = [...(names ?? [])];
  const reasons = [...new Set(rawReasons.map((name) => (Object.hasOwn(REASONS, name) ? REASONS[name]! : 'other')))];
  return { reasons, rawReasons };
}
