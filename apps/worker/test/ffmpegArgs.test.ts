// The ffmpeg argument sets for extraction and the transcode: pure, so each
// case is the exact argument list. Comparisons are written by
// hand, as `compare` would give them.
import type { AudioStream, Comparison, ProbeSummary, SubtitleStream, TargetFormat, VideoStream } from '@omnarr/contracts';
import { describe, expect, test } from 'vite-plus/test';

import { mainArgs, outputContainer, subtitleArgs, videoEncoder } from '../src/media/ffmpegArgs.ts';

const SRC = '/data/library/series/Show (2021)/Season 01/Show (2021) - S01E01.mkv';
const OUT_MP4 = '/data/staging/job1/out.mp4';
const OUT_MKV = '/data/staging/job1/out.mkv';
const HEAD = ['-hide_banner', '-nostdin', '-nostats', '-progress', 'pipe:1', '-y', '-i', SRC];
const META = ['-map_metadata', '0', '-map_chapters', '0'];
const MP4 = ['-movflags', '+faststart', '-f', 'mp4', OUT_MP4];
const MKV = ['-f', 'matroska', OUT_MKV];
const X264 = ['-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-profile:v', 'high', '-pix_fmt', 'yuv420p'];
const BT709 = ['-color_primaries', 'bt709', '-color_trc', 'bt709', '-colorspace', 'bt709'];
const TONEMAP = 'zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p';

/** The default target: Chrome and the Jellyfin Android app. */
const DEFAULT_TARGET: TargetFormat = {
  containers: ['mp4'],
  video: { codecs: ['h264'], maxHeight: 1080, maxBitrateKbps: null, hdr: 'sdrOnly', maxBitDepth: { h264: 8, hevc: 8, av1: 10 } },
  audio: { codecs: ['aac', 'mp3', 'opus', 'flac'], maxChannels: 2 },
  subtitles: { mode: 'text', textFormats: ['srt', 'ass'] },
};
/** Fire TV alone: MP4 or Matroska, H.264 or HEVC 10-bit, HDR10, 5.1. */
const FIRE_TV: TargetFormat = {
  containers: ['mp4', 'mkv'],
  video: { codecs: ['h264', 'hevc'], maxHeight: 2160, maxBitrateKbps: null, hdr: 'hdr10', maxBitDepth: { h264: 8, hevc: 10, av1: 8 } },
  audio: { codecs: ['aac', 'ac3', 'eac3', 'mp3', 'opus', 'flac'], maxChannels: 6 },
  subtitles: { mode: 'text', textFormats: ['srt'] },
};

const flags = { default: false, forced: false, hearingImpaired: false };
const h264 = (over: Partial<VideoStream> = {}): VideoStream => ({
  kind: 'video',
  index: 0,
  codec: 'h264',
  language: 'und',
  ...flags,
  default: true,
  width: 1920,
  height: 1080,
  bitDepth: 8,
  pixFmt: 'yuv420p',
  interlaced: false,
  frameRate: 24,
  hdr: 'sdr',
  ...over,
});
const hevcHdr10 = (over: Partial<VideoStream> = {}): VideoStream =>
  h264({
    codec: 'hevc',
    width: 3840,
    height: 2160,
    bitDepth: 10,
    pixFmt: 'yuv420p10le',
    colorPrimaries: 'bt2020',
    colorTransfer: 'smpte2084',
    colorSpace: 'bt2020nc',
    hdr: 'hdr10',
    masteringDisplay: 'G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50)',
    contentLight: { maxCll: 1000, maxFall: 400 },
    ...over,
  });
const audio = (index: number, codec: string, channels: number, over: Partial<AudioStream> = {}): AudioStream => ({
  kind: 'audio',
  index,
  codec,
  language: 'en',
  ...flags,
  channels,
  ...over,
});
const subtitle = (index: number, codec: string, over: Partial<SubtitleStream> = {}): SubtitleStream => ({
  kind: 'subtitle',
  index,
  codec,
  language: 'en',
  ...flags,
  format: ['subrip', 'ass'].includes(codec) ? 'text' : 'image',
  ...over,
});
const probeOf = (container: ProbeSummary['container'], ...streams: ProbeSummary['streams']): ProbeSummary => ({ container, durationMs: 1_320_000, streams });

type Row = Comparison['streams'][number];
const copyVideo = (from = 'h264'): Row => ({ index: 0, kind: 'video', action: 'copy', from });
const transcodeVideo = (reason: Row['reason'], to = 'h264', from = 'hevc'): Row => ({ index: 0, kind: 'video', action: 'transcode', from, to, reason });
const copyAudio = (index: number, from = 'aac'): Row => ({ index, kind: 'audio', action: 'copy', from });
const plan = (streams: Row[], container: Comparison['container'] = { from: 'matroska', to: 'mp4', change: true }): Comparison => ({
  fits: false,
  steps: ['video'],
  streams,
  container,
});

describe('mainArgs', () => {
  test("a WEB-DL's plan: video copied, E-AC-3 5.1 → AAC 2.0, the two SubRip tracks left for sidecars, MKV → MP4", () => {
    const source = probeOf('matroska', h264(), audio(1, 'eac3', 6, { default: true }), subtitle(2, 'subrip'), subtitle(3, 'subrip', { language: 'de' }));
    const comparison: Comparison = {
      fits: false,
      steps: ['audio', 'subtitle', 'remux'],
      streams: [
        copyVideo(),
        { index: 1, kind: 'audio', action: 'transcode', from: 'eac3', to: 'aac', reason: 'codec' },
        { index: 2, kind: 'subtitle', action: 'extract', from: 'subrip', to: 'srt', reason: 'embeddedSubtitle' },
        { index: 3, kind: 'subtitle', action: 'extract', from: 'subrip', to: 'srt', reason: 'embeddedSubtitle' },
      ],
      container: { from: 'matroska', to: 'mp4', change: true },
    };
    expect(mainArgs(SRC, comparison, DEFAULT_TARGET, { output: OUT_MP4, sourceProbe: source })).toEqual([
      ...HEAD,
      ...META,
      '-map', '0:0', '-c:v', 'copy',
      '-map', '0:1', '-c:a:0', 'aac', '-ac:a:0', '2', '-b:a:0', '160k',
      '-sn',
      '-disposition:a:0', 'default',
      ...MP4,
    ]); // prettier-ignore
  });

  test('video copy: HEVC into MP4 adds -tag:v hvc1', () => {
    const source = probeOf('matroska', hevcHdr10({ width: 1920, height: 1080 }), audio(1, 'aac', 2, { default: true }));
    const comparison = plan([copyVideo('hevc'), copyAudio(1)]);
    expect(mainArgs(SRC, comparison, FIRE_TV, { output: OUT_MP4, sourceProbe: source })).toEqual([
      ...HEAD,
      ...META,
      '-map', '0:0', '-c:v', 'copy', '-tag:v', 'hvc1',
      '-map', '0:1', '-c:a:0', 'copy',
      '-sn',
      '-disposition:a:0', 'default',
      ...MP4,
    ]); // prettier-ignore
  });

  test('video copy: HEVC into Matroska has no tag', () => {
    const source = probeOf('matroska', hevcHdr10({ width: 1920, height: 1080 }));
    const args = mainArgs(SRC, plan([copyVideo('hevc')], { from: 'matroska', to: 'mkv', change: false }), FIRE_TV, { output: OUT_MKV, sourceProbe: source });
    expect(args).toEqual([...HEAD, ...META, '-map', '0:0', '-c:v', 'copy', '-sn', '-map', '0:t?', '-c:t', 'copy', ...MKV]);
  });

  test('video → H.264 from an HD source: libx264 with BT.709 tags', () => {
    const source = probeOf('matroska', h264({ codec: 'vc1' }));
    const args = mainArgs(SRC, plan([transcodeVideo('codec', 'h264', 'vc1')]), DEFAULT_TARGET, { output: OUT_MP4, sourceProbe: source });
    expect(args).toEqual([...HEAD, ...META, '-map', '0:0', ...X264, ...BT709, '-sn', ...MP4]);
  });

  test('video → H.264 from an SD source tagged BT.601 keeps its tags', () => {
    const sd = h264({ codec: 'mpeg4', width: 720, height: 480, colorPrimaries: 'smpte170m', colorTransfer: 'bt709', colorSpace: 'smpte170m' });
    const args = mainArgs(SRC, plan([transcodeVideo('codec', 'h264', 'mpeg4')]), DEFAULT_TARGET, { output: OUT_MP4, sourceProbe: probeOf('avi', sd) });
    expect(args).toEqual([
      ...HEAD,
      ...META,
      '-map',
      '0:0',
      ...X264,
      '-color_primaries',
      'smpte170m',
      '-color_trc',
      'bt709',
      '-colorspace',
      'smpte170m',
      '-sn',
      ...MP4,
    ]);
  });

  test('video → H.264 from an untagged SD source sets no colour tags', () => {
    const sd = h264({ codec: 'mpeg4', width: 720, height: 480 });
    const args = mainArgs(SRC, plan([transcodeVideo('codec', 'h264', 'mpeg4')]), DEFAULT_TARGET, { output: OUT_MP4, sourceProbe: probeOf('avi', sd) });
    expect(args).toEqual([...HEAD, ...META, '-map', '0:0', ...X264, '-sn', ...MP4]);
  });

  test('video → HEVC from an HDR10 source kept as HDR10: x265 HDR10 parameters with the mastering and light values', () => {
    const target: TargetFormat = { ...FIRE_TV, video: { ...FIRE_TV.video, codecs: ['hevc'] } };
    const source = probeOf('matroska', hevcHdr10({ codec: 'av1' }));
    const args = mainArgs(SRC, plan([transcodeVideo('codec', 'hevc', 'av1')], { from: 'matroska', to: 'mkv', change: false }), target, {
      output: OUT_MKV,
      sourceProbe: source,
    });
    expect(args).toEqual([
      ...HEAD,
      ...META,
      '-map', '0:0',
      '-c:v', 'libx265', '-preset', 'medium', '-crf', '22', '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1',
      '-x265-params', 'hdr10=1:repeat-headers=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:master-display=G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50):max-cll=1000,400',
      '-sn', '-map', '0:t?', '-c:t', 'copy',
      ...MKV,
    ]); // prettier-ignore
  });

  test('video → HEVC from an HDR10 source without mastering or light values leaves those keys out', () => {
    const target: TargetFormat = { ...FIRE_TV, video: { ...FIRE_TV.video, codecs: ['hevc'] } };
    const source = probeOf('matroska', hevcHdr10({ codec: 'av1', masteringDisplay: undefined, contentLight: undefined }));
    const args = mainArgs(SRC, plan([transcodeVideo('codec', 'hevc', 'av1')]), target, { output: OUT_MP4, sourceProbe: source });
    expect(args).toEqual([
      ...HEAD,
      ...META,
      '-map', '0:0',
      '-c:v', 'libx265', '-preset', 'medium', '-crf', '22', '-pix_fmt', 'yuv420p10le', '-tag:v', 'hvc1',
      '-x265-params', 'hdr10=1:repeat-headers=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc',
      '-sn',
      ...MP4,
    ]); // prettier-ignore
  });

  test('video → AV1: libsvtav1', () => {
    const target: TargetFormat = { ...DEFAULT_TARGET, video: { ...DEFAULT_TARGET.video, codecs: ['av1'] } };
    const args = mainArgs(SRC, plan([transcodeVideo('codec', 'av1', 'mpeg2video')]), target, {
      output: OUT_MP4,
      sourceProbe: probeOf('mpegts', h264({ codec: 'mpeg2video' })),
    });
    expect(args).toEqual([...HEAD, ...META, '-map', '0:0', '-c:v', 'libsvtav1', '-preset', '8', '-crf', '32', '-pix_fmt', 'yuv420p10le', '-sn', ...MP4]);
  });

  test('a bit-rate cap: -maxrate and twice the cap as -bufsize', () => {
    const target: TargetFormat = { ...DEFAULT_TARGET, video: { ...DEFAULT_TARGET.video, maxBitrateKbps: 8000 } };
    const args = mainArgs(SRC, plan([transcodeVideo('bitrate', 'h264', 'h264')]), target, { output: OUT_MP4, sourceProbe: probeOf('matroska', h264()) });
    expect(args).toEqual([...HEAD, ...META, '-map', '0:0', ...X264, ...BT709, '-maxrate', '8000k', '-bufsize', '16000k', '-sn', ...MP4]);
  });

  test('filters in order: deinterlace, HDR to SDR, the resolution cap, then the text burn-in', () => {
    const source = probeOf('matroska', hevcHdr10({ interlaced: true }), subtitle(1, 'subrip', { forced: true }));
    const comparison = plan([transcodeVideo('hdr'), { index: 1, kind: 'subtitle', action: 'burnIn', from: 'subrip' }]);
    const burn = { path: '/data/staging/job1/subs/burn.srt', kind: 'text' as const };
    expect(mainArgs(SRC, comparison, DEFAULT_TARGET, { output: OUT_MP4, sourceProbe: source, burn })).toEqual([
      ...HEAD,
      ...META,
      '-map', '0:0',
      '-vf', `bwdif=mode=send_frame,${TONEMAP},scale='min(iw,1920)':'min(ih,1080)':force_original_aspect_ratio=decrease:force_divisible_by=2,subtitles=filename=/data/staging/job1/subs/burn.srt`,
      ...X264, ...BT709,
      '-sn',
      ...MP4,
    ]); // prettier-ignore
  });

  test('the resolution cap alone, for a 4K SDR source and a 720 cap', () => {
    const target: TargetFormat = { ...DEFAULT_TARGET, video: { ...DEFAULT_TARGET.video, maxHeight: 720 } };
    const source = probeOf('matroska', h264({ width: 3840, height: 2160 }));
    const args = mainArgs(SRC, plan([transcodeVideo('resolution', 'h264', 'h264')]), target, { output: OUT_MP4, sourceProbe: source });
    expect(args).toEqual([
      ...HEAD,
      ...META,
      '-map', '0:0',
      '-vf', "scale='min(iw,1280)':'min(ih,720)':force_original_aspect_ratio=decrease:force_divisible_by=2",
      ...X264, ...BT709,
      '-sn',
      ...MP4,
    ]); // prettier-ignore
  });

  test('an image burn-in: the .sup as input 1, scale2ref and overlay in a filter graph, and -map [v]', () => {
    const source = probeOf(
      'matroska',
      hevcHdr10({ width: 1920, height: 1080 }),
      audio(1, 'aac', 2, { default: true }),
      subtitle(2, 'hdmv_pgs_subtitle', { forced: true }),
    );
    const comparison = plan([transcodeVideo('hdr'), copyAudio(1), { index: 2, kind: 'subtitle', action: 'burnIn', from: 'hdmv_pgs_subtitle' }]);
    const burn = { path: '/data/staging/job1/subs/burn.sup', kind: 'image' as const };
    expect(mainArgs(SRC, comparison, DEFAULT_TARGET, { output: OUT_MP4, sourceProbe: source, burn })).toEqual([
      ...HEAD,
      '-i', '/data/staging/job1/subs/burn.sup',
      ...META,
      '-filter_complex', `[0:v:0]${TONEMAP}[base];[1:s:0][base]scale2ref[sub][base2];[base2][sub]overlay=eof_action=pass[v]`,
      '-map', '[v]',
      ...X264, ...BT709,
      '-map', '0:1', '-c:a:0', 'copy',
      '-sn',
      '-disposition:a:0', 'default',
      ...MP4,
    ]); // prettier-ignore
  });

  test('an image burn-in onto an SDR video without other filters passes it through with null', () => {
    const source = probeOf('matroska', h264(), subtitle(1, 'hdmv_pgs_subtitle', { forced: true }));
    const comparison = plan([copyVideo(), { index: 1, kind: 'subtitle', action: 'burnIn', from: 'hdmv_pgs_subtitle' }]);
    const args = mainArgs(SRC, comparison, DEFAULT_TARGET, {
      output: OUT_MP4,
      sourceProbe: source,
      burn: { path: '/data/staging/job1/subs/burn.sup', kind: 'image' },
    });
    expect(args).toContain('[0:v:0]null[base];[1:s:0][base]scale2ref[sub][base2];[base2][sub]overlay=eof_action=pass[v]');
    expect(args.slice(args.indexOf('-map', 10), args.indexOf('-map', 10) + 4)).toEqual(['-map', '[v]', '-c:v', 'libx264']);
  });

  test('audio: copy, or encode with the channels capped and 96k / 160k / 384k by channel count, in source order', () => {
    const target: TargetFormat = { ...FIRE_TV, audio: { codecs: ['ac3'], maxChannels: 6 } };
    const source = probeOf('matroska', h264(), audio(1, 'truehd', 8, { default: true }), audio(2, 'opus', 1), audio(3, 'dts', 2), audio(4, 'ac3', 6));
    const comparison = plan(
      [
        copyVideo(),
        { index: 1, kind: 'audio', action: 'transcode', from: 'truehd', to: 'ac3', reason: 'codec' },
        { index: 2, kind: 'audio', action: 'transcode', from: 'opus', to: 'ac3', reason: 'codec' },
        { index: 3, kind: 'audio', action: 'transcode', from: 'dts', to: 'ac3', reason: 'codec' },
        copyAudio(4, 'ac3'),
      ],
      { from: 'matroska', to: 'mkv', change: false },
    );
    expect(mainArgs(SRC, comparison, target, { output: OUT_MKV, sourceProbe: source })).toEqual([
      ...HEAD,
      ...META,
      '-map', '0:0', '-c:v', 'copy',
      '-map', '0:1', '-c:a:0', 'ac3', '-ac:a:0', '6', '-b:a:0', '384k',
      '-map', '0:2', '-c:a:1', 'ac3', '-ac:a:1', '1', '-b:a:1', '96k',
      '-map', '0:3', '-c:a:2', 'ac3', '-ac:a:2', '2', '-b:a:2', '160k',
      '-map', '0:4', '-c:a:3', 'copy',
      '-sn',
      '-map', '0:t?', '-c:t', 'copy',
      '-disposition:a:0', 'default', '-disposition:a:1', '0', '-disposition:a:2', '0', '-disposition:a:3', '0',
      ...MKV,
    ]); // prettier-ignore
  });

  test.each([
    ['aac', 'aac'],
    ['ac3', 'ac3'],
    ['eac3', 'eac3'],
    ['opus', 'libopus'],
    ['flac', 'flac'],
    ['mp3', 'libmp3lame'],
  ] as const)('audio → %s uses the %s encoder', (codec, encoder) => {
    const target: TargetFormat = { ...DEFAULT_TARGET, audio: { codecs: [codec], maxChannels: 2 } };
    const source = probeOf('mp4', h264(), audio(1, 'dts', 2, { default: true }));
    const comparison = plan([copyVideo(), { index: 1, kind: 'audio', action: 'transcode', from: 'dts', to: codec, reason: 'codec' }]);
    expect(mainArgs(SRC, comparison, target, { output: OUT_MP4, sourceProbe: source })).toContain(encoder);
  });

  test("the output made from the source's default audio stream is the default; the others are 0", () => {
    const source = probeOf('mp4', h264(), audio(1, 'aac', 2, { language: 'de' }), audio(2, 'aac', 2, { default: true }));
    const args = mainArgs(SRC, plan([copyVideo(), copyAudio(1), copyAudio(2)], { from: 'mp4', to: 'mp4', change: false }), DEFAULT_TARGET, {
      output: OUT_MP4,
      sourceProbe: source,
    });
    expect(args.slice(-10, -5)).toEqual(['-sn', '-disposition:a:0', '0', '-disposition:a:1', 'default']);
  });

  test('keep mode into Matroska: the subtitles copied, attachments kept', () => {
    const target: TargetFormat = { ...FIRE_TV, containers: ['mkv'], subtitles: { mode: 'keep', textFormats: ['srt'] } };
    const source = probeOf('matroska', h264(), audio(1, 'dts', 6, { default: true }), subtitle(2, 'ass'), subtitle(3, 'hdmv_pgs_subtitle'));
    const comparison = plan(
      [
        copyVideo(),
        { index: 1, kind: 'audio', action: 'transcode', from: 'dts', to: 'aac', reason: 'codec' },
        { index: 2, kind: 'subtitle', action: 'copy', from: 'ass' },
        { index: 3, kind: 'subtitle', action: 'copy', from: 'hdmv_pgs_subtitle' },
      ],
      { from: 'matroska', to: 'mkv', change: false },
    );
    expect(mainArgs(SRC, comparison, target, { output: OUT_MKV, sourceProbe: source })).toEqual([
      ...HEAD,
      ...META,
      '-map', '0:0', '-c:v', 'copy',
      '-map', '0:1', '-c:a:0', 'aac', '-ac:a:0', '6', '-b:a:0', '384k',
      '-map', '0:s', '-c:s', 'copy',
      '-map', '0:t?', '-c:t', 'copy',
      '-disposition:a:0', 'default',
      ...MKV,
    ]); // prettier-ignore
  });

  test("a source path with ', : and , is only ever the -i argument, never part of a filter graph", () => {
    const src = "/data/library/series/It's: A Show, Really (2020)/Season 01/It's: A Show, Really - S01E01 [a,b].mkv";
    const source = probeOf(
      'matroska',
      hevcHdr10({ interlaced: true }),
      subtitle(1, 'subrip', { forced: true }),
      subtitle(2, 'hdmv_pgs_subtitle', { forced: true }),
    );
    const text = mainArgs(src, plan([transcodeVideo('hdr'), { index: 1, kind: 'subtitle', action: 'burnIn', from: 'subrip' }]), DEFAULT_TARGET, {
      output: OUT_MP4,
      sourceProbe: source,
      burn: { path: '/data/staging/job1/subs/burn.srt', kind: 'text' },
    });
    const image = mainArgs(src, plan([transcodeVideo('hdr'), { index: 2, kind: 'subtitle', action: 'burnIn', from: 'hdmv_pgs_subtitle' }]), DEFAULT_TARGET, {
      output: OUT_MP4,
      sourceProbe: source,
      burn: { path: '/data/staging/job1/subs/burn.sup', kind: 'image' },
    });
    for (const args of [text, image]) {
      expect(args.filter((arg) => arg === src)).toHaveLength(1);
      expect(args[args.indexOf(src) - 1]).toBe('-i');
      const graph = args[Math.max(args.indexOf('-vf'), args.indexOf('-filter_complex')) + 1]!;
      expect(graph).not.toContain('Show');
      expect(graph).not.toContain("'s");
    }
  });

  test('a burn-in path that is not a plain staging path is refused', () => {
    const source = probeOf('matroska', h264(), subtitle(1, 'subrip', { forced: true }));
    const comparison = plan([copyVideo(), { index: 1, kind: 'subtitle', action: 'burnIn', from: 'subrip' }]);
    const burn = { path: "/data/staging/job1/subs/it's,burn.srt", kind: 'text' as const };
    expect(() => mainArgs(SRC, comparison, DEFAULT_TARGET, { output: OUT_MP4, sourceProbe: source, burn })).toThrow(/staging path/);
  });
});

describe('outputContainer and videoEncoder', () => {
  test('a container change goes to the target’s first container; otherwise the source’s stays', () => {
    expect(outputContainer(plan([], { from: 'matroska', to: 'mp4', change: true }), FIRE_TV)).toBe('mp4');
    expect(outputContainer(plan([], { from: 'matroska', to: 'matroska', change: false }), FIRE_TV)).toBe('mkv');
    expect(outputContainer(plan([], { from: 'mp4', to: 'mp4', change: false }), FIRE_TV)).toBe('mp4');
  });

  test('the encoder is the target’s first codec’s for a video transcode or a burn-in, else copy', () => {
    expect(videoEncoder(plan([copyVideo()]), DEFAULT_TARGET)).toBe('copy');
    expect(videoEncoder(plan([transcodeVideo('codec')]), DEFAULT_TARGET)).toBe('libx264');
    expect(videoEncoder(plan([copyVideo(), { index: 1, kind: 'subtitle', action: 'burnIn', from: 'subrip' }]), FIRE_TV)).toBe('libx264');
    expect(videoEncoder(plan([transcodeVideo('codec')]), { ...FIRE_TV, video: { ...FIRE_TV.video, codecs: ['hevc'] } })).toBe('libx265');
    expect(videoEncoder(plan([transcodeVideo('codec')]), { ...FIRE_TV, video: { ...FIRE_TV.video, codecs: ['av1'] } })).toBe('libsvtav1');
  });
});

describe('subtitleArgs', () => {
  test('one run, one output per track: SubRip converted, ASS and PGS copied, VobSub copied into Matroska', () => {
    const tracks = [
      { index: 2, name: '1', format: 'srt' as const },
      { index: 4, name: '2', format: 'ass' as const },
      { index: 5, name: 'burn', format: 'sup' as const },
    ];
    expect(subtitleArgs(SRC, tracks, '/data/staging/job1/subs')).toEqual([
      '-hide_banner', '-nostdin', '-nostats', '-progress', 'pipe:1', '-y', '-i', SRC,
      '-map', '0:2', '-c:s', 'srt', '/data/staging/job1/subs/1.srt',
      '-map', '0:4', '-c:s', 'copy', '/data/staging/job1/subs/2.ass',
      '-map', '0:5', '-c:s', 'copy', '/data/staging/job1/subs/burn.sup',
    ]); // prettier-ignore
    expect(subtitleArgs(SRC, [{ index: 6, name: 'burn', format: 'mkv' }], '/data/staging/job1/subs').slice(8)).toEqual([
      '-map',
      '0:6',
      '-c:s',
      'copy',
      '/data/staging/job1/subs/burn.mkv',
    ]);
  });
});
