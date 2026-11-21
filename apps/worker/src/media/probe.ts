// ffprobe, summarised as the ProbeSummary contract: what the
// comparison, the file names and the output check read from a file.
import { execFile } from 'node:child_process';
import { extname } from 'node:path';
import { promisify } from 'node:util';

import {
  DEFAULT_LIMITS,
  IMAGE_SUBTITLE_CODECS,
  ISO639_2_TO_1,
  LanguageCode,
  type ProbeContainer,
  type ProbeStream,
  type ProbeSummary,
  TEXT_SUBTITLE_CODECS,
} from '@omnarr/contracts';

import { JobFailure } from '../runtime/lease.ts';

const run = promisify(execFile);

/** One entry of ffprobe's `side_data_list`, on a stream or a frame. */
export type FfprobeSideData = { side_data_type?: string } & Record<string, unknown>;

type FfprobeStream = {
  index?: number;
  codec_type?: string;
  codec_name?: string;
  profile?: string;
  width?: number;
  height?: number;
  pix_fmt?: string;
  bits_per_raw_sample?: string;
  field_order?: string;
  avg_frame_rate?: string;
  r_frame_rate?: string;
  bit_rate?: string;
  color_primaries?: string;
  color_transfer?: string;
  color_space?: string;
  channels?: number;
  channel_layout?: string;
  sample_rate?: string;
  disposition?: Record<string, number | undefined>;
  tags?: Record<string, string | undefined>;
  side_data_list?: FfprobeSideData[];
};

/** ffprobe's `-show_format -show_streams` JSON, the parts the summary reads. */
export type FfprobeOutput = {
  format?: { filename?: string; format_name?: string; duration?: string; bit_rate?: string };
  streams?: FfprobeStream[];
};

const STREAM_ARGS = ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams'];
const FRAME_ARGS = [
  '-v',
  'error',
  '-print_format',
  'json',
  '-select_streams',
  'v:0',
  '-read_intervals',
  '%+#1',
  '-show_frames',
  '-show_entries',
  'frame=side_data_list',
];

const number = (value: string | number | undefined) => {
  const n = Number(value);
  return value !== undefined && value !== '' && Number.isFinite(n) ? n : undefined;
};
const kbps = (bitsPerSecond: string | undefined) => {
  const n = number(bitsPerSecond);
  return n === undefined ? undefined : Math.round(n / 1000);
};
/** `num/den` as a number; undefined for `0/0` or garbage. */
const ratio = (value: unknown) => {
  if (typeof value !== 'string') return undefined;
  const [num, den] = value.split('/').map(Number);
  return num !== undefined && den ? num / den : undefined;
};
const defined = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;

function containerOf(formatName: string | undefined, filename: string | undefined): ProbeContainer {
  const names = (formatName ?? '').split(',');
  const ext = extname(filename ?? '').toLowerCase();
  if (names.includes('matroska')) return ext === '.webm' ? 'webm' : 'matroska';
  if (names.includes('mp4')) return filename === undefined || ['.mp4', '.m4v'].includes(ext) ? 'mp4' : 'other';
  if (names.includes('mpegts')) return 'mpegts';
  if (names.includes('avi')) return 'avi';
  return 'other';
}

function languageOf(tag: string | undefined): LanguageCode | 'und' {
  const code = tag?.toLowerCase();
  if (!code) return 'und';
  const mapped = ISO639_2_TO_1[code];
  if (mapped) return mapped;
  return code !== 'multi' && LanguageCode.safeParse(code).success ? (code as LanguageCode) : 'und';
}

function bitDepthOf(stream: FfprobeStream): 8 | 10 | 12 {
  const depth = number(stream.bits_per_raw_sample) ?? number(/p(\d+)(?:le|be)$/.exec(stream.pix_fmt ?? '')?.[1]) ?? 8;
  return depth >= 12 ? 12 : depth > 8 ? 10 : 8;
}

const INTERLACED = new Set(['tt', 'bb', 'tb', 'bt']);

const sideData = (list: FfprobeSideData[] | undefined, type: string) => list?.find((entry) => entry.side_data_type === type);

/** x265's `G(x,y)B(x,y)R(x,y)WP(x,y)L(max,min)`: chromaticity in 0.00002 units, luminance in 0.0001 cd/m². */
function masteringDisplayOf(entry: FfprobeSideData | undefined): string | undefined {
  if (!entry) return undefined;
  const chroma = (key: string) => ratio(entry[key]);
  const keys = ['green_x', 'green_y', 'blue_x', 'blue_y', 'red_x', 'red_y', 'white_point_x', 'white_point_y'];
  const values = keys.map(chroma);
  const max = ratio(entry.max_luminance);
  const min = ratio(entry.min_luminance);
  if (values.some((v) => v === undefined) || max === undefined || min === undefined) return undefined;
  const [gx, gy, bx, by, rx, ry, wx, wy] = values.map((v) => Math.round(v! * 50000));
  return `G(${gx},${gy})B(${bx},${by})R(${rx},${ry})WP(${wx},${wy})L(${Math.round(max * 10000)},${Math.round(min * 10000)})`;
}

function contentLightOf(entry: FfprobeSideData | undefined): { maxCll: number; maxFall: number } | undefined {
  const maxCll = number(entry?.max_content as number | undefined);
  const maxFall = number(entry?.max_average as number | undefined);
  return maxCll === undefined || maxFall === undefined ? undefined : { maxCll, maxFall };
}

const known = (value: string | undefined) => (value && value !== 'unknown' ? value : undefined);

function videoOf(stream: FfprobeStream, frameSideData: FfprobeSideData[] | undefined) {
  const dovi = sideData(stream.side_data_list, 'DOVI configuration record');
  const transfer = stream.color_transfer;
  const hdr10plus = frameSideData?.some((entry) => entry.side_data_type?.includes('SMPTE2094-40')) ?? false;
  const hdr = dovi ? 'dv' : transfer === 'smpte2084' ? (hdr10plus ? 'hdr10plus' : 'hdr10') : transfer === 'arib-std-b67' ? 'hlg' : 'sdr';
  const rate = ratio(stream.avg_frame_rate) ?? ratio(stream.r_frame_rate);
  const meta = (type: string) => sideData(stream.side_data_list, type) ?? sideData(frameSideData, type);
  return defined({
    kind: 'video' as const,
    width: stream.width ?? 0,
    height: stream.height ?? 0,
    bitDepth: bitDepthOf(stream),
    pixFmt: stream.pix_fmt ?? 'unknown',
    interlaced: INTERLACED.has(stream.field_order ?? ''),
    frameRate: rate === undefined ? undefined : Math.round(rate * 1000) / 1000,
    bitRateKbps: kbps(stream.bit_rate ?? stream.tags?.BPS),
    colorPrimaries: known(stream.color_primaries),
    colorTransfer: known(transfer),
    colorSpace: known(stream.color_space),
    hdr: hdr as 'sdr' | 'hdr10' | 'hdr10plus' | 'hlg' | 'dv',
    dv: dovi ? { profile: Number(dovi.dv_profile), compatibility: Number(dovi.dv_bl_signal_compatibility_id ?? 0) } : undefined,
    masteringDisplay: masteringDisplayOf(meta('Mastering display metadata')),
    contentLight: contentLightOf(meta('Content light level metadata')),
  });
}

function streamOf(stream: FfprobeStream, frameSideData: FfprobeSideData[] | undefined): ProbeStream | undefined {
  const disposition = stream.disposition ?? {};
  if (disposition.attached_pic === 1) return undefined;
  const codec = stream.codec_name ?? 'unknown';
  const base = defined({
    index: stream.index ?? 0,
    codec,
    profile: stream.profile,
    language: languageOf(stream.tags?.language),
    title: stream.tags?.title,
    default: disposition.default === 1,
    forced: disposition.forced === 1,
    hearingImpaired: disposition.hearing_impaired === 1,
  });
  switch (stream.codec_type) {
    case 'video':
      return { ...base, ...videoOf(stream, frameSideData) };
    case 'audio':
      return {
        ...base,
        ...defined({
          kind: 'audio' as const,
          channels: stream.channels ?? 0,
          channelLayout: stream.channel_layout,
          sampleRate: number(stream.sample_rate),
          bitRateKbps: kbps(stream.bit_rate ?? stream.tags?.BPS),
        }),
      };
    case 'subtitle':
      // A codec not named here (teletext, closed captions) can't become a
      // SubRip sidecar, so it counts as an image: dropped, never extracted.
      return { ...base, kind: 'subtitle', format: TEXT_SUBTITLE_CODECS.includes(codec) && !IMAGE_SUBTITLE_CODECS.includes(codec) ? 'text' : 'image' };
    default:
      return undefined;
  }
}

/**
 * ffprobe's `-show_format -show_streams` JSON, summarised. `frameSideData`
 * is the first video frame's `side_data_list`, which tells HDR10+ from HDR10;
 * mastering-display and content-light values come from the stream's side data,
 * else from the frame's.
 */
export function summarize(output: FfprobeOutput, frameSideData?: FfprobeSideData[]): ProbeSummary {
  const duration = number(output.format?.duration);
  return defined({
    container: containerOf(output.format?.format_name, output.format?.filename),
    durationMs: duration === undefined ? undefined : Math.round(duration * 1000),
    bitRateKbps: kbps(output.format?.bit_rate),
    streams: (output.streams ?? []).flatMap((stream) => streamOf(stream, frameSideData) ?? []),
  });
}

/**
 * Runs ffprobe on a local path, adding the first-frame side-data read when the
 * first video stream is `smpte2084`. A file ffprobe can't read in time is no
 * media, so a bad release; a missing ffprobe is the worker's. Errors name the
 * path, never a URL.
 */
export async function probe(path: string, signal: AbortSignal, options: { timeoutMs?: number } = {}): Promise<ProbeSummary> {
  const ffprobe = async (args: string[]) => {
    const { stdout } = await run('ffprobe', [...args, path], {
      signal,
      timeout: options.timeoutMs ?? DEFAULT_LIMITS.ffprobeTimeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024 * 1024,
    });
    return JSON.parse(stdout) as unknown;
  };
  try {
    const output = (await ffprobe(STREAM_ARGS)) as FfprobeOutput;
    const video = output.streams?.find((stream) => stream.codec_type === 'video' && stream.disposition?.attached_pic !== 1);
    if (video?.color_transfer !== 'smpte2084') return summarize(output);
    const frames = (await ffprobe(FRAME_ARGS)) as { frames?: { side_data_list?: FfprobeSideData[] }[] };
    return summarize(output, frames.frames?.[0]?.side_data_list ?? []);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw new JobFailure('pipelineError', 'ffprobe is not installed in the worker.');
    if (signal.aborted) throw error;
    throw new JobFailure('fakeOrWrongContent', `ffprobe can't read ${path}.`);
  }
}
