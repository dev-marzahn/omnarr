// What ffprobe found in a file (`ProbeSummary`), a library's target format
// (`TargetFormat`), and the pure comparison of the two (`compare`), which
// decides `fits` at import and at a profile edit, builds the preparation plan
// and checks the prepared output. Also what the session poller reports about
// a play.
import { z } from 'zod';

import { LanguageCode } from './release.ts';

/** `none` is "no step"; it never appears inside a list of steps. */
export const PreparationStep = z.enum(['none', 'remux', 'audio', 'subtitle', 'video']);
export type PreparationStep = z.infer<typeof PreparationStep>;

/** A real step, as a plan lists them. */
export const PlanStep = PreparationStep.exclude(['none']);
export type PlanStep = z.infer<typeof PlanStep>;

export const ProbeContainer = z.enum(['matroska', 'mp4', 'webm', 'mpegts', 'avi', 'other']);
export type ProbeContainer = z.infer<typeof ProbeContainer>;

export const HdrFormat = z.enum(['sdr', 'hdr10', 'hdr10plus', 'hlg', 'dv']);
export type HdrFormat = z.infer<typeof HdrFormat>;

const streamBase = {
  index: z.number(),
  codec: z.string(),
  profile: z.string().optional(),
  language: z.union([LanguageCode, z.literal('und')]).optional(),
  title: z.string().optional(),
  default: z.boolean(),
  forced: z.boolean(),
  hearingImpaired: z.boolean(),
};

export const VideoStream = z.object({
  ...streamBase,
  kind: z.literal('video'),
  width: z.number(),
  height: z.number(),
  bitDepth: z.union([z.literal(8), z.literal(10), z.literal(12)]),
  pixFmt: z.string(),
  interlaced: z.boolean(),
  frameRate: z.number().optional(),
  bitRateKbps: z.number().optional(),
  colorPrimaries: z.string().optional(),
  colorTransfer: z.string().optional(),
  colorSpace: z.string().optional(),
  hdr: HdrFormat,
  /** `compatibility` 1 is an HDR10 base layer. */
  dv: z.object({ profile: z.number(), compatibility: z.number() }).optional(),
  /** x265's form: `G(x,y)B(x,y)R(x,y)WP(x,y)L(max,min)`. */
  masteringDisplay: z.string().optional(),
  contentLight: z.object({ maxCll: z.number(), maxFall: z.number() }).optional(),
});
export type VideoStream = z.infer<typeof VideoStream>;

export const AudioStream = z.object({
  ...streamBase,
  kind: z.literal('audio'),
  channels: z.number(),
  channelLayout: z.string().optional(),
  sampleRate: z.number().optional(),
  bitRateKbps: z.number().optional(),
});
export type AudioStream = z.infer<typeof AudioStream>;

export const SubtitleStream = z.object({ ...streamBase, kind: z.literal('subtitle'), format: z.enum(['text', 'image']) });
export type SubtitleStream = z.infer<typeof SubtitleStream>;

export const ProbeStream = z.discriminatedUnion('kind', [VideoStream, AudioStream, SubtitleStream]);
export type ProbeStream = z.infer<typeof ProbeStream>;

/** ffprobe's `-show_format -show_streams`, summarised. Cover art (`attached_pic`) is left out. */
export const ProbeSummary = z.object({
  container: ProbeContainer,
  durationMs: z.number().optional(),
  bitRateKbps: z.number().optional(),
  streams: z.array(ProbeStream),
});
export type ProbeSummary = z.infer<typeof ProbeSummary>;

export const TargetContainer = z.enum(['mp4', 'mkv']);
export type TargetContainer = z.infer<typeof TargetContainer>;
export const TargetVideoCodec = z.enum(['h264', 'hevc', 'av1']);
export type TargetVideoCodec = z.infer<typeof TargetVideoCodec>;
export const TargetAudioCodec = z.enum(['aac', 'ac3', 'eac3', 'opus', 'flac', 'mp3']);
export type TargetAudioCodec = z.infer<typeof TargetAudioCodec>;
export const TargetHdr = z.enum(['sdrOnly', 'hdr10', 'dv']);
export type TargetHdr = z.infer<typeof TargetHdr>;
export const SubtitleMode = z.enum(['text', 'keep', 'burnIn']);
export type SubtitleMode = z.infer<typeof SubtitleMode>;
export const TextSubtitleFormat = z.enum(['srt', 'ass']);
export type TextSubtitleFormat = z.infer<typeof TextSubtitleFormat>;

const eightOrTen = z.union([z.literal(8), z.literal(10)]);

/** A library's target format. In each list, the first entry is what a remux or transcode produces. */
export const TargetFormat = z.object({
  containers: z.array(TargetContainer).min(1),
  video: z.object({
    codecs: z.array(TargetVideoCodec).min(1),
    /** null: no cap. */
    maxHeight: z.number().nullable(),
    maxBitrateKbps: z.number().nullable(),
    hdr: TargetHdr,
    maxBitDepth: z.object({ h264: z.literal(8), hevc: eightOrTen, av1: eightOrTen }),
  }),
  audio: z.object({ codecs: z.array(TargetAudioCodec).min(1), maxChannels: z.number() }),
  subtitles: z.object({ mode: SubtitleMode, textFormats: z.array(TextSubtitleFormat) }),
});
export type TargetFormat = z.infer<typeof TargetFormat>;

export const StreamAction = z.enum(['copy', 'transcode', 'extract', 'ocr', 'drop', 'burnIn']);
export type StreamAction = z.infer<typeof StreamAction>;

export const StreamReason = z.enum([
  'codec',
  'resolution',
  'bitrate',
  'hdr',
  'dvNoFallback',
  'bitDepth',
  'interlaced',
  'channels',
  'embeddedSubtitle',
  'textTwin',
  'imageSubtitle',
  'noOcrLanguage',
  'extraVideo',
]);
export type StreamReason = z.infer<typeof StreamReason>;

/** `compare(probe, target)`: the steps, most expensive first, and what happens to each stream. */
export const Comparison = z.object({
  /** `steps` is empty. */
  fits: z.boolean(),
  /** Most expensive first: video, audio, subtitle, remux; never `none`. */
  steps: z.array(PlanStep),
  streams: z.array(
    z.object({
      index: z.number(),
      kind: z.enum(['video', 'audio', 'subtitle']),
      action: StreamAction,
      from: z.string(),
      to: z.string().optional(),
      reason: StreamReason.optional(),
    }),
  ),
  container: z.object({ from: z.string(), to: z.string(), change: z.boolean() }),
});
export type Comparison = z.infer<typeof Comparison>;

/** Subtitle codecs ffprobe names, by what they hold. */
export const TEXT_SUBTITLE_CODECS: readonly string[] = ['subrip', 'ass', 'ssa', 'webvtt', 'mov_text', 'text'];
export const IMAGE_SUBTITLE_CODECS: readonly string[] = ['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub'];

/** Whether a subtitle codec holds text or images; undefined for a codec neither list names. */
export function subtitleFormatOf(codec: string): 'text' | 'image' | undefined {
  if (TEXT_SUBTITLE_CODECS.includes(codec)) return 'text';
  if (IMAGE_SUBTITLE_CODECS.includes(codec)) return 'image';
  return undefined;
}

/** Most expensive first: the order of `Comparison.steps`. */
const STEP_ORDER: readonly PlanStep[] = ['video', 'audio', 'subtitle', 'remux'];

/** The most expensive step of a plan (`video` > `audio` > `subtitle` > `remux`), `none` for an empty one. */
export function mostExpensive(steps: readonly PreparationStep[]): PreparationStep {
  return STEP_ORDER.find((step) => steps.includes(step)) ?? 'none';
}

type StreamPlan = Comparison['streams'][number];

/** The target's name for a probed container; undefined for one no target lists. */
const TARGET_CONTAINER: Partial<Record<ProbeContainer, TargetContainer>> = { mp4: 'mp4', matroska: 'mkv' };

const copy = (stream: ProbeStream): StreamPlan => ({ index: stream.index, kind: stream.kind, action: 'copy', from: stream.codec });

/** Audio (each stream): transcoded to the first codec when its codec isn't listed or it has too many channels. */
function planAudio(stream: AudioStream, target: TargetFormat): StreamPlan {
  const reason = !(target.audio.codecs as string[]).includes(stream.codec) ? 'codec' : stream.channels > target.audio.maxChannels ? 'channels' : undefined;
  return reason ? { ...copy(stream), action: 'transcode', to: target.audio.codecs[0], reason } : copy(stream);
}

/**
 * Why the first video stream needs a transcode, if it does. `dvNoFallback`
 * comes first: the worker refuses any plan that has it, so
 * no other reason may hide it.
 */
function videoReason(stream: VideoStream, probe: ProbeSummary, target: TargetFormat): StreamReason | undefined {
  const { codecs, maxHeight, maxBitrateKbps, hdr, maxBitDepth } = target.video;
  const audioKbps = probe.streams.reduce((sum, other) => sum + (other.kind === 'audio' ? (other.bitRateKbps ?? 0) : 0), 0);
  const bitRate = stream.bitRateKbps ?? (probe.bitRateKbps === undefined ? undefined : probe.bitRateKbps - audioKbps);
  const depthCap = (maxBitDepth as Record<string, number>)[stream.codec];

  if (stream.hdr === 'dv' && stream.dv?.compatibility !== 1 && hdr !== 'dv') return 'dvNoFallback';
  if (!(codecs as string[]).includes(stream.codec)) return 'codec';
  if (maxHeight !== null && (stream.height > maxHeight || stream.width > (maxHeight * 16) / 9)) return 'resolution';
  if (maxBitrateKbps !== null && bitRate !== undefined && bitRate > maxBitrateKbps) return 'bitrate';
  if (depthCap !== undefined && stream.bitDepth > depthCap) return 'bitDepth';
  if ((stream.hdr !== 'sdr' && hdr === 'sdrOnly') || (stream.hdr === 'hlg' && hdr === 'hdr10')) return 'hdr';
  if (stream.interlaced) return 'interlaced';
  return undefined;
}

/**
 * A subtitle stream in `text` mode: text is extracted to a sidecar (`ass`
 * stays ASS when the target lists it), an image track is dropped. An image
 * track without a text twin is dropped too: OCR comes later.
 */
function planTextSubtitle(stream: SubtitleStream, probe: ProbeSummary, target: TargetFormat): StreamPlan {
  if (stream.format === 'text') {
    const keepAss = (stream.codec === 'ass' || stream.codec === 'ssa') && target.subtitles.textFormats.includes('ass');
    return { ...copy(stream), action: 'extract', to: keepAss ? 'ass' : 'srt', reason: 'embeddedSubtitle' };
  }
  const twin = probe.streams.some(
    (other) =>
      other.kind === 'subtitle' && other.format === 'text' && (other.language ?? 'und') === (stream.language ?? 'und') && other.forced === stream.forced,
  );
  return { ...copy(stream), action: 'drop', reason: twin ? 'textTwin' : 'imageSubtitle' };
}

/**
 * In `burnIn` mode, the forced stream in the default audio stream's language
 * (the first audio stream when none is marked default), else the first forced
 * stream; none when no stream is forced.
 */
function burnInStream(probe: ProbeSummary, target: TargetFormat): ProbeStream | undefined {
  if (target.subtitles.mode !== 'burnIn') return undefined;
  const audio = probe.streams.filter((stream) => stream.kind === 'audio');
  const language = (audio.find((stream) => stream.default) ?? audio[0])?.language;
  const forced = probe.streams.filter((stream) => stream.kind === 'subtitle' && stream.forced);
  return forced.find((stream) => language !== undefined && stream.language === language) ?? forced[0];
}

/** A probe against a target: pure and total. */
export function compare(probe: ProbeSummary, target: TargetFormat): Comparison {
  const steps = new Set<PlanStep>();
  const firstVideo = probe.streams.find((stream) => stream.kind === 'video');
  const burned = burnInStream(probe, target);
  const streams = probe.streams.map((stream): StreamPlan => {
    if (stream.kind === 'video') {
      // Further video streams are dropped; only the first decides the video step.
      if (stream !== firstVideo) return { ...copy(stream), action: 'drop', reason: 'extraVideo' };
      const reason = videoReason(stream, probe, target);
      // A burn-in re-encodes the picture: a transcode without a reason of its own.
      if (!reason && !burned) return copy(stream);
      steps.add('video');
      return { ...copy(stream), action: 'transcode', to: target.video.codecs[0], ...(reason && { reason }) };
    }
    if (stream.kind === 'audio') {
      const plan = planAudio(stream, target);
      if (plan.action === 'transcode') steps.add('audio');
      return plan;
    }
    // `keep` leaves them in the container; otherwise any subtitle stream adds the subtitle step.
    if (target.subtitles.mode === 'keep') return copy(stream);
    steps.add('subtitle');
    if (stream === burned) return { ...copy(stream), action: 'burnIn' };
    // In `burnIn` mode, every stream but the burned one follows `text`.
    return planTextSubtitle(stream, probe, target);
  });

  const asTarget = TARGET_CONTAINER[probe.container];
  const change = !asTarget || !target.containers.includes(asTarget);
  if (change) steps.add('remux');
  return {
    fits: steps.size === 0,
    steps: STEP_ORDER.filter((step) => steps.has(step)),
    streams,
    container: { from: probe.container, to: change ? target.containers[0]! : asTarget, change },
  };
}

/**
 * The timeline events of a restored kept original:
 * the backend writes them, and the item page titles their entry "Original
 * restored" instead of a preparation (the DTO carries no Rendition reason).
 */
export const RESTORE_QUEUED = "Restore queued: the kept original fits the library's target.";
export const ORIGINAL_RESTORED = "Original restored: the kept original fits the library's target.";

// Plays.

/**
 * How Jellyfin plays a file: as it is, a `remux` (video and audio copied into
 * a new container) or a `transcode` (any stream converted).
 */
export const PlayMethod = z.enum(['directPlay', 'remux', 'transcode']);
export type PlayMethod = z.infer<typeof PlayMethod>;

/**
 * A stored play's method: the live enum plus `directStream`, what the client
 * reported as DirectStream before the method came from Jellyfin's transcode
 * job. Such a play may have converted the audio, so it isn't a `remux`.
 */
export const StoredPlayMethod = z.union([PlayMethod, z.literal('directStream')]);
export type StoredPlayMethod = z.infer<typeof StoredPlayMethod>;

/** Why a play wasn't a direct play, in platform terms. `other` is a name Jellyfin 12.4 doesn't have. */
export const TranscodeReason = z.enum([
  'container',
  'videoCodec',
  'videoProfile',
  'videoLevel',
  'videoResolution',
  'videoBitDepth',
  'videoRange',
  'videoFramerate',
  'audioCodec',
  'audioChannels',
  'audioProfile',
  'subtitle',
  'bitrate',
  'other',
  'externalAudio',
  'secondaryAudio',
  'refFrames',
  'anamorphic',
  'interlaced',
  'audioSampleRate',
  'audioBitDepth',
  'unknownStream',
  'directPlayFailed',
  'videoCodecTag',
  'streamCount',
  'videoRotation',
]);
export type TranscodeReason = z.infer<typeof TranscodeReason>;

/** One play the session poller sees. */
export const ActivePlay = z.object({
  deviceId: z.string(),
  deviceName: z.string(),
  client: z.string(),
  itemRef: z.string(),
  method: PlayMethod,
  reasons: z.array(TranscodeReason),
  /** Jellyfin's own names, for the support bundle. */
  rawReasons: z.array(z.string()),
});
export type ActivePlay = z.infer<typeof ActivePlay>;
