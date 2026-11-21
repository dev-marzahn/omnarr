// Jellyfin's play method and transcode reasons in platform terms. The names
// are Jellyfin 12.4's `PlayMethod` and `TranscodeReason` enums
// (test/fixtures/jellyfin/README.md). A name with no platform term of
// its own, or one a later release adds, is `other`; `rawReasons` keeps
// Jellyfin's names for the support bundle.
import type { PlayMethod, TranscodeReason } from '@omnarr/contracts';

const METHODS: Record<string, PlayMethod> = {
  DirectPlay: 'directPlay',
  DirectStream: 'directStream',
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
};

/** `PlayState.PlayMethod`; undefined for a name 12.4 doesn't have. */
export const playMethod = (name: string | undefined): PlayMethod | undefined =>
  name !== undefined && Object.hasOwn(METHODS, name) ? METHODS[name] : undefined;

/** `TranscodingInfo.TranscodeReasons`, in Jellyfin's order, each platform reason once. */
export function transcodeReasons(names: readonly string[] | undefined): { reasons: TranscodeReason[]; rawReasons: string[] } {
  const rawReasons = [...(names ?? [])];
  const reasons = [...new Set(rawReasons.map((name) => (Object.hasOwn(REASONS, name) ? REASONS[name]! : 'other')))];
  return { reasons, rawReasons };
}
