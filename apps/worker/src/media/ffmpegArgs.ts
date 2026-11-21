// The ffmpeg argument sets for extraction and the transcode, pure. The
// source path is only ever an `-i` argument: filter arguments hold only
// paths under staging/<jobId>, built from the job ID and digits, so no file
// name reaches a filter graph.
import { isAbsolute } from 'node:path';

import type { AudioStream, Comparison, ProbeSummary, TargetAudioCodec, TargetFormat, TargetVideoCodec, VideoStream } from '@omnarr/contracts';

/** The extracted forced track to burn in: SubRip (`subs/burn.srt`) or an image track (`subs/burn.sup`, or `burn.mkv` for VobSub). */
export type BurnInput = { path: string; kind: 'text' | 'image' };

export type MainOptions = {
  /** `staging/<jobId>/out.<mp4|mkv>`. */
  output: string;
  /** The source's probe: geometry, HDR, interlacing, channels and the default audio stream. */
  sourceProbe: ProbeSummary;
  burn?: BurnInput;
};

/** One subtitle track for the one-pass extraction: `srt` converts, the others copy (`ass` kept, `sup` PGS, `mkv` VobSub). */
export type SubtitleTrack = { index: number; name: string; format: 'srt' | 'ass' | 'sup' | 'mkv' };

const VIDEO_ENCODERS: Record<TargetVideoCodec, string> = { h264: 'libx264', hevc: 'libx265', av1: 'libsvtav1' };
const AUDIO_ENCODERS: Record<TargetAudioCodec, string> = { aac: 'aac', ac3: 'ac3', eac3: 'eac3', opus: 'libopus', flac: 'flac', mp3: 'libmp3lame' };
const TONEMAP = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';
const BT601 = new Set(['bt470bg', 'smpte170m']);
/** A path a filter graph may hold: letters, digits, `_`, `-`, `.` and `/`, absolute, no `..`. */
const PLAIN_PATH = /^\/(?:[\w.-]+\/)*[\w.-]+$/;

const mainVideo = (comparison: Comparison) => comparison.streams.find((stream) => stream.kind === 'video' && stream.action !== 'drop');
const burning = (comparison: Comparison) => comparison.streams.some((stream) => stream.action === 'burnIn');
const encodesVideo = (comparison: Comparison) => mainVideo(comparison)?.action === 'transcode' || burning(comparison);

/** What the prepared file's container is: the target's first on a change, else the source's. */
export function outputContainer(comparison: Comparison, target: TargetFormat): 'mp4' | 'mkv' {
  if (comparison.container.change) return target.containers[0]!;
  const from = comparison.container.to;
  return from === 'mp4' ? 'mp4' : from === 'mkv' || from === 'matroska' || from === 'webm' ? 'mkv' : target.containers[0]!;
}

/** `PrepareResult.encoder`: the video encoder, or `copy`. */
export function videoEncoder(comparison: Comparison, target: TargetFormat): string {
  return encodesVideo(comparison) ? VIDEO_ENCODERS[target.video.codecs[0]!] : 'copy';
}

const isHdr = (video: VideoStream) => video.hdr !== 'sdr';

function videoArgs(comparison: Comparison, target: TargetFormat, source: VideoStream, container: 'mp4' | 'mkv', burn: BurnInput | undefined): string[] {
  const row = mainVideo(comparison)!;
  if (!encodesVideo(comparison))
    return ['-map', `0:${row.index}`, '-c:v', 'copy', ...(source.codec === 'hevc' && container === 'mp4' ? ['-tag:v', 'hvc1'] : [])];

  const codec = target.video.codecs[0]!;
  const tenBit = codec !== 'h264' && target.video.maxBitDepth[codec] === 10;
  // HDR goes to SDR when the target or the output's bit depth can't hold it;
  // HLG has no conversion to an HDR10 target, so it goes to SDR too.
  const tonemap = isHdr(source) && (target.video.hdr === 'sdrOnly' || !tenBit || (source.hdr === 'hlg' && target.video.hdr === 'hdr10'));

  const filters: string[] = [];
  if (source.interlaced) filters.push('bwdif=mode=send_frame');
  if (tonemap) filters.push(TONEMAP);
  const cap = target.video.maxHeight;
  if (cap !== null) {
    const width = Math.round((cap * 16) / 9);
    if (source.height > cap || source.width > width)
      filters.push(`scale='min(iw,${width})':'min(ih,${cap})':force_original_aspect_ratio=decrease:force_divisible_by=2`);
  }
  if (burn?.kind === 'text') filters.push(`subtitles=filename=${burn.path}`);

  const out: string[] = [];
  if (burn?.kind === 'image') {
    // `eof_action=pass`: with overlay's default, the image track's last event
    // gives a frame past the video's end that the MP4 muxer refuses.
    out.push(
      '-filter_complex',
      `[0:v:0]${filters.join(',') || 'null'}[base];[1:s:0][base]scale2ref[sub][base2];[base2][sub]overlay=eof_action=pass[v]`,
      '-map',
      '[v]',
    );
  } else {
    out.push('-map', `0:${row.index}`);
    if (filters.length > 0) out.push('-vf', filters.join(','));
  }

  if (codec === 'h264') {
    out.push('-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-profile:v', 'high', '-pix_fmt', 'yuv420p');
    const tagged601 = BT601.has(source.colorPrimaries ?? '') || BT601.has(source.colorSpace ?? '');
    if (tonemap || (!tagged601 && source.height >= 720)) out.push('-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709');
    else if (tagged601) {
      if (source.colorPrimaries) out.push('-color_primaries', source.colorPrimaries);
      if (source.colorTransfer) out.push('-color_trc', source.colorTransfer);
      if (source.colorSpace) out.push('-colorspace', source.colorSpace);
    }
  } else if (codec === 'hevc') {
    out.push('-c:v', 'libx265', '-preset', 'medium', '-crf', '22', '-pix_fmt', tenBit ? 'yuv420p10le' : 'yuv420p', '-tag:v', 'hvc1');
    const keepsHdr10 = !tonemap && (source.hdr === 'hdr10' || source.hdr === 'hdr10plus' || source.hdr === 'dv');
    if (keepsHdr10) {
      const params = ['hdr10=1', 'repeat-headers=1', 'colorprim=bt2020', 'transfer=smpte2084', 'colormatrix=bt2020nc'];
      if (source.masteringDisplay) params.push(`master-display=${source.masteringDisplay}`);
      if (source.contentLight) params.push(`max-cll=${source.contentLight.maxCll},${source.contentLight.maxFall}`);
      out.push('-x265-params', params.join(':'));
    }
  } else {
    out.push('-c:v', 'libsvtav1', '-preset', '8', '-crf', '32', '-pix_fmt', tenBit ? 'yuv420p10le' : 'yuv420p');
  }

  const bitrate = target.video.maxBitrateKbps;
  if (bitrate !== null) out.push('-maxrate', `${bitrate}k`, '-bufsize', `${bitrate * 2}k`);
  return out;
}

const audioBitrate = (channels: number) => (channels <= 1 ? '96k' : channels === 2 ? '160k' : '384k');

/**
 * The main ffmpeg run, without the program name; the runner
 * adds `nice -n 10 ffmpeg`. Streams are mapped explicitly: the planned video,
 * then each kept audio stream in source order.
 */
export function mainArgs(source: string, comparison: Comparison, target: TargetFormat, options: MainOptions): string[] {
  if (!isAbsolute(source)) throw new Error('mainArgs: the source path must be absolute.');
  if (options.burn && !PLAIN_PATH.test(options.burn.path)) throw new Error('mainArgs: the burn-in track must be a plain staging path.');
  const container = outputContainer(comparison, target);
  const probed = new Map(options.sourceProbe.streams.map((stream) => [stream.index, stream]));
  const video = mainVideo(comparison);

  const args = ['-hide_banner', '-nostdin', '-nostats', '-progress', 'pipe:1', '-y', '-i', source];
  if (options.burn?.kind === 'image') args.push('-i', options.burn.path);
  args.push('-map_metadata', '0', '-map_chapters', '0');
  if (video) args.push(...videoArgs(comparison, target, probed.get(video.index) as VideoStream, container, options.burn));

  const audio = comparison.streams.filter((stream) => stream.kind === 'audio' && stream.action !== 'drop').sort((a, b) => a.index - b.index);
  audio.forEach((row, n) => {
    args.push('-map', `0:${row.index}`);
    if (row.action !== 'transcode') {
      args.push(`-c:a:${n}`, 'copy');
      return;
    }
    const channels = Math.min((probed.get(row.index) as AudioStream | undefined)?.channels ?? 2, target.audio.maxChannels);
    args.push(`-c:a:${n}`, AUDIO_ENCODERS[target.audio.codecs[0]!], `-ac:a:${n}`, String(channels), `-b:a:${n}`, audioBitrate(channels));
  });

  const keepSubtitles = target.subtitles.mode === 'keep' && comparison.streams.some((stream) => stream.kind === 'subtitle' && stream.action === 'copy');
  args.push(...(keepSubtitles ? ['-map', '0:s', '-c:s', 'copy'] : ['-sn']));
  if (container === 'mkv') args.push('-map', '0:t?', '-c:t', 'copy');

  // The output made from the source's default stream is the default; with no
  // default in the source, the first output stream is.
  const defaultIndex = audio.find((row) => probed.get(row.index)?.default)?.index ?? audio[0]?.index;
  audio.forEach((row, n) => args.push(`-disposition:a:${n}`, row.index === defaultIndex ? 'default' : '0'));

  args.push(...(container === 'mp4' ? ['-movflags', '+faststart', '-f', 'mp4'] : ['-f', 'matroska']), options.output);
  return args;
}

/**
 * The one-pass subtitle extraction, without the program name:
 * one output per track, so the source is read once. `-progress` lets the
 * runner's stall watchdog see it advance.
 */
export function subtitleArgs(source: string, tracks: SubtitleTrack[], outDir: string): string[] {
  if (!isAbsolute(source)) throw new Error('subtitleArgs: the source path must be absolute.');
  const args = ['-hide_banner', '-nostdin', '-nostats', '-progress', 'pipe:1', '-y', '-i', source];
  for (const track of tracks) args.push('-map', `0:${track.index}`, '-c:s', track.format === 'srt' ? 'srt' : 'copy', `${outDir}/${track.name}.${track.format}`);
  return args;
}
