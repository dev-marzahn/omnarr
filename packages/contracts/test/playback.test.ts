import { describe, expect, test } from 'vite-plus/test';

import { DEFAULT_DEVICES, targetForDevices } from '../src/devices.ts';
import {
  type AudioStream,
  compare,
  mostExpensive,
  type ProbeSummary,
  type SubtitleStream,
  subtitleFormatOf,
  type TargetFormat,
  type VideoStream,
} from '../src/playback.ts';

/** First run's target for both libraries: MP4, H.264 8-bit, 1080p, SDR, AAC/MP3/Opus/FLAC up to 2.0, srt and ass sidecars. */
const DEFAULT = targetForDevices(DEFAULT_DEVICES);

const flags = { default: false, forced: false, hearingImpaired: false };

/** H.264 8-bit 1080p SDR, progressive. */
const video = (overrides: Partial<VideoStream> = {}): VideoStream => ({
  index: 0,
  kind: 'video',
  codec: 'h264',
  width: 1920,
  height: 1080,
  bitDepth: 8,
  pixFmt: 'yuv420p',
  interlaced: false,
  hdr: 'sdr',
  ...flags,
  default: true,
  ...overrides,
});

/** AAC stereo. */
const audio = (overrides: Partial<AudioStream> = {}): AudioStream => ({
  index: 1,
  kind: 'audio',
  codec: 'aac',
  channels: 2,
  language: 'en',
  ...flags,
  default: true,
  ...overrides,
});

/** An English SubRip track. */
const subtitle = (overrides: Partial<SubtitleStream> = {}): SubtitleStream => ({
  index: 2,
  kind: 'subtitle',
  codec: 'subrip',
  format: 'text',
  language: 'en',
  ...flags,
  ...overrides,
});

const probe = (streams: ProbeSummary['streams'], overrides: Partial<ProbeSummary> = {}): ProbeSummary => ({
  container: 'mp4',
  durationMs: 2_640_000,
  streams,
  ...overrides,
});

/** A target edited directly (`custom`), for the rules the default target can't reach. */
const custom = (overrides: {
  containers?: TargetFormat['containers'];
  video?: Partial<TargetFormat['video']>;
  audio?: Partial<TargetFormat['audio']>;
  subtitles?: Partial<TargetFormat['subtitles']>;
}): TargetFormat => ({
  containers: overrides.containers ?? DEFAULT.containers,
  video: { ...DEFAULT.video, ...overrides.video },
  audio: { ...DEFAULT.audio, ...overrides.audio },
  subtitles: { ...DEFAULT.subtitles, ...overrides.subtitles },
});

const streamOf = (probeSummary: ProbeSummary, target: TargetFormat, index: number) =>
  compare(probeSummary, target).streams.find((stream) => stream.index === index);

describe('compare', () => {
  test('a prepared output (MP4, H.264 8-bit, AAC 2.0, no subtitle streams) fits', () => {
    expect(compare(probe([video(), audio()]), DEFAULT)).toEqual({
      fits: true,
      steps: [],
      streams: [
        { index: 0, kind: 'video', action: 'copy', from: 'h264' },
        { index: 1, kind: 'audio', action: 'copy', from: 'aac' },
      ],
      container: { from: 'mp4', to: 'mp4', change: false },
    });
  });

  describe('video (the first video stream)', () => {
    /** Fire TV's kind of target: H.264 and HEVC 10-bit, 2160p, HDR10. */
    const hdr10 = custom({ video: { codecs: ['h264', 'hevc'], maxHeight: 2160, hdr: 'hdr10', maxBitDepth: { h264: 8, hevc: 10, av1: 8 } } });
    const hevc10 = (overrides: Partial<VideoStream> = {}) =>
      video({ codec: 'hevc', bitDepth: 10, pixFmt: 'yuv420p10le', width: 3840, height: 2160, ...overrides });
    const videoPlan = (stream: VideoStream, target: TargetFormat, overrides: Partial<ProbeSummary> = {}) => {
      const result = compare(probe([stream, audio()], overrides), target);
      return { steps: result.steps, video: result.streams[0] };
    };

    test('a codec not in the list is transcoded to the first codec', () => {
      expect(videoPlan(video({ codec: 'hevc' }), DEFAULT)).toEqual({
        steps: ['video'],
        video: { index: 0, kind: 'video', action: 'transcode', from: 'hevc', to: 'h264', reason: 'codec' },
      });
    });

    test('a height above the cap', () => {
      expect(videoPlan(video({ width: 3840, height: 2160 }), DEFAULT).video).toMatchObject({ action: 'transcode', to: 'h264', reason: 'resolution' });
    });

    test('a width above the cap × 16/9, with the height under it (2048×858 against 1080 → 1920)', () => {
      expect(videoPlan(video({ width: 2048, height: 858 }), DEFAULT).video).toMatchObject({ action: 'transcode', reason: 'resolution' });
      expect(videoPlan(video({ width: 1920, height: 800 }), DEFAULT).video).toMatchObject({ action: 'copy' });
    });

    test('no height cap: 2160p fits', () => {
      expect(videoPlan(video({ width: 3840, height: 2160 }), custom({ video: { maxHeight: null } })).steps).toEqual([]);
    });

    test("a bit rate above the cap, from the stream's own rate", () => {
      const capped = custom({ video: { maxBitrateKbps: 8000 } });
      expect(videoPlan(video({ bitRateKbps: 12_000 }), capped).video).toMatchObject({ action: 'transcode', reason: 'bitrate' });
      // The stream's rate wins over the file's.
      expect(videoPlan(video({ bitRateKbps: 5000 }), capped, { bitRateKbps: 20_000 }).video).toMatchObject({ action: 'copy' });
    });

    test("without the stream's rate, the file's minus its audio (10,000 − 640 = 9,360 kb/s)", () => {
      const stream = video();
      const withAudio = (cap: number) =>
        compare(probe([stream, audio({ bitRateKbps: 640 })], { bitRateKbps: 10_000 }), custom({ video: { maxBitrateKbps: cap } })).streams[0];
      expect(withAudio(9000)).toMatchObject({ action: 'transcode', reason: 'bitrate' });
      expect(withAudio(9500)).toMatchObject({ action: 'copy' });
    });

    test('no bit-rate cap, or no bit rate known: no bitrate reason', () => {
      expect(videoPlan(video({ bitRateKbps: 80_000 }), DEFAULT).steps).toEqual([]);
      expect(videoPlan(video(), custom({ video: { maxBitrateKbps: 8000 } })).steps).toEqual([]);
    });

    test('a bit depth above the cap for its codec', () => {
      expect(videoPlan(video({ bitDepth: 10, pixFmt: 'yuv420p10le' }), DEFAULT).video).toMatchObject({ action: 'transcode', reason: 'bitDepth' });
      const hevc8 = custom({ video: { codecs: ['hevc'], maxHeight: null, maxBitDepth: { h264: 8, hevc: 8, av1: 8 } } });
      expect(videoPlan(hevc10(), hevc8).video).toMatchObject({ action: 'transcode', to: 'hevc', reason: 'bitDepth' });
      expect(videoPlan(hevc10(), hdr10).steps).toEqual([]);
    });

    test('HDR for an SDR-only target', () => {
      const sdrHevc = custom({ video: { codecs: ['h264', 'hevc'], maxHeight: null, maxBitDepth: { h264: 8, hevc: 10, av1: 8 } } });
      for (const hdr of ['hdr10', 'hdr10plus', 'hlg'] as const)
        expect(videoPlan(hevc10({ hdr }), sdrHevc).video, hdr).toMatchObject({ action: 'transcode', reason: 'hdr' });
    });

    test('HLG for an HDR10 target; HDR10 and HDR10+ fit it', () => {
      expect(videoPlan(hevc10({ hdr: 'hlg' }), hdr10).video).toMatchObject({ action: 'transcode', reason: 'hdr' });
      expect(videoPlan(hevc10({ hdr: 'hdr10' }), hdr10).steps).toEqual([]);
      expect(videoPlan(hevc10({ hdr: 'hdr10plus' }), hdr10).steps).toEqual([]);
    });

    test('Dolby Vision without an HDR10 base layer, unless the target is dv (dvNoFallback)', () => {
      const profile5 = hevc10({ hdr: 'dv', dv: { profile: 5, compatibility: 0 } });
      expect(videoPlan(profile5, hdr10).video).toMatchObject({ action: 'transcode', reason: 'dvNoFallback' });
      expect(videoPlan(profile5, custom({ video: { ...hdr10.video, hdr: 'dv' } })).steps).toEqual([]);
    });

    test('dvNoFallback wins over every other reason, so the worker refuses it', () => {
      const profile5 = hevc10({ hdr: 'dv', dv: { profile: 5, compatibility: 0 } });
      expect(videoPlan(profile5, DEFAULT).video).toMatchObject({ action: 'transcode', reason: 'dvNoFallback' });
    });

    test('Dolby Vision with an HDR10 base layer (compatibility 1) plays as HDR10, and is tonemapped for SDR', () => {
      const profile81 = hevc10({ hdr: 'dv', dv: { profile: 8, compatibility: 1 } });
      expect(videoPlan(profile81, hdr10).steps).toEqual([]);
      const sdrHevc = custom({ video: { codecs: ['hevc'], maxHeight: null, maxBitDepth: { h264: 8, hevc: 10, av1: 8 } } });
      expect(videoPlan(profile81, sdrHevc).video).toMatchObject({ action: 'transcode', reason: 'hdr' });
    });

    test('interlaced video', () => {
      expect(videoPlan(video({ interlaced: true }), DEFAULT)).toEqual({
        steps: ['video'],
        video: { index: 0, kind: 'video', action: 'transcode', from: 'h264', to: 'h264', reason: 'interlaced' },
      });
    });

    test('further video streams are dropped (extraVideo); only the first decides the video step', () => {
      const result = compare(probe([video(), audio(), video({ index: 2, codec: 'hevc', width: 3840, height: 2160, default: false })]), DEFAULT);
      expect(result.streams[2]).toEqual({ index: 2, kind: 'video', action: 'drop', from: 'hevc', reason: 'extraVideo' });
      expect(result.steps).toEqual([]);
    });
  });

  describe('audio (each stream)', () => {
    test('a codec not in the list is transcoded to the first codec', () => {
      const result = compare(probe([video(), audio({ codec: 'eac3' })]), DEFAULT);
      expect(result.steps).toEqual(['audio']);
      expect(result.streams[1]).toEqual({ index: 1, kind: 'audio', action: 'transcode', from: 'eac3', to: 'aac', reason: 'codec' });
    });

    test('more channels than the cap is transcoded, even in a listed codec', () => {
      const result = compare(probe([video(), audio({ codec: 'aac', channels: 6 })]), DEFAULT);
      expect(result.steps).toEqual(['audio']);
      expect(result.streams[1]).toEqual({ index: 1, kind: 'audio', action: 'transcode', from: 'aac', to: 'aac', reason: 'channels' });
    });

    test('a listed codec within the cap is copied, and each stream is decided on its own', () => {
      const result = compare(probe([video(), audio({ codec: 'opus' }), audio({ index: 2, codec: 'dts', channels: 6, default: false })]), DEFAULT);
      expect(result.streams.slice(1)).toEqual([
        { index: 1, kind: 'audio', action: 'copy', from: 'opus' },
        { index: 2, kind: 'audio', action: 'transcode', from: 'dts', to: 'aac', reason: 'codec' },
      ]);
    });
  });

  describe('subtitles in text mode (each stream)', () => {
    const pgs = (overrides: Partial<SubtitleStream> = {}) => subtitle({ codec: 'hdmv_pgs_subtitle', format: 'image', ...overrides });

    test('a text stream is extracted to srt, and adds the subtitle step', () => {
      const result = compare(probe([video(), audio(), subtitle()]), DEFAULT);
      expect(result.steps).toEqual(['subtitle']);
      expect(result.streams[2]).toEqual({ index: 2, kind: 'subtitle', action: 'extract', from: 'subrip', to: 'srt', reason: 'embeddedSubtitle' });
    });

    test.each(['mov_text', 'webvtt'])('%s is extracted to srt', (codec) => {
      expect(streamOf(probe([video(), audio(), subtitle({ codec })]), DEFAULT, 2)).toMatchObject({ action: 'extract', to: 'srt' });
    });

    test.each(['ass', 'ssa'])('%s is kept as ass when the target lists ass, else made srt', (codec) => {
      const stream = probe([video(), audio(), subtitle({ codec })]);
      expect(streamOf(stream, DEFAULT, 2)).toMatchObject({ action: 'extract', from: codec, to: 'ass' });
      expect(streamOf(stream, custom({ subtitles: { textFormats: ['srt'] } }), 2)).toMatchObject({ action: 'extract', to: 'srt' });
    });

    test('an image stream with a text twin (same language and forced flag) is dropped (textTwin)', () => {
      const result = compare(probe([video(), audio(), subtitle(), pgs({ index: 3 })]), DEFAULT);
      expect(result.streams[3]).toEqual({ index: 3, kind: 'subtitle', action: 'drop', from: 'hdmv_pgs_subtitle', reason: 'textTwin' });
    });

    test('an image stream without a text twin is dropped (imageSubtitle)', () => {
      // German text is no twin for English, nor is unforced text for a forced track.
      const result = compare(
        probe([video(), audio(), subtitle({ language: 'de' }), pgs({ index: 3 }), subtitle({ index: 4 }), pgs({ index: 5, forced: true })]),
        DEFAULT,
      );
      expect(result.streams[3]).toEqual({ index: 3, kind: 'subtitle', action: 'drop', from: 'hdmv_pgs_subtitle', reason: 'textTwin' });
      expect(result.streams[5]).toEqual({ index: 5, kind: 'subtitle', action: 'drop', from: 'hdmv_pgs_subtitle', reason: 'imageSubtitle' });
      const alone = compare(probe([video(), audio(), subtitle({ language: 'de' }), pgs({ index: 3 })]), DEFAULT);
      expect(alone.streams[3]).toMatchObject({ action: 'drop', reason: 'imageSubtitle' });
    });

    test('a subtitle stream that is only dropped still adds the subtitle step', () => {
      expect(compare(probe([video(), audio(), pgs()]), DEFAULT).steps).toEqual(['subtitle']);
    });
  });

  test('keep mode (Matroska first) copies every subtitle stream and adds no step', () => {
    const keep = custom({ containers: ['mkv'], subtitles: { mode: 'keep' } });
    const result = compare(
      probe([video(), audio(), subtitle(), subtitle({ index: 3, codec: 'hdmv_pgs_subtitle', format: 'image', language: 'de' })], { container: 'matroska' }),
      keep,
    );
    expect(result.fits).toBe(true);
    expect(result.steps).toEqual([]);
    expect(result.streams.slice(2)).toEqual([
      { index: 2, kind: 'subtitle', action: 'copy', from: 'subrip' },
      { index: 3, kind: 'subtitle', action: 'copy', from: 'hdmv_pgs_subtitle' },
    ]);
  });

  describe('burnIn mode', () => {
    const burnIn = custom({ subtitles: { mode: 'burnIn' } });

    test('the forced stream in the default audio language is burned in (adding video); the rest follow text', () => {
      const result = compare(
        probe([
          video(),
          audio({ language: 'de', default: false }),
          audio({ index: 2, language: 'en', default: true }),
          subtitle({ index: 3, language: 'de', forced: true }),
          subtitle({ index: 4, language: 'en', forced: true }),
          subtitle({ index: 5, language: 'en' }),
        ]),
        burnIn,
      );
      expect(result.steps).toEqual(['video', 'subtitle']);
      // A burn-in re-encodes the picture, so the video row is a transcode to the first codec.
      expect(result.streams[0]).toEqual({ index: 0, kind: 'video', action: 'transcode', from: 'h264', to: 'h264' });
      expect(result.streams.slice(3)).toEqual([
        { index: 3, kind: 'subtitle', action: 'extract', from: 'subrip', to: 'srt', reason: 'embeddedSubtitle' },
        { index: 4, kind: 'subtitle', action: 'burnIn', from: 'subrip' },
        { index: 5, kind: 'subtitle', action: 'extract', from: 'subrip', to: 'srt', reason: 'embeddedSubtitle' },
      ]);
    });

    test('with no forced stream in that language, the first forced stream is burned in, image or text', () => {
      const result = compare(
        probe([
          video(),
          audio({ language: 'ja' }),
          subtitle({ index: 2, language: 'en' }),
          subtitle({ index: 3, codec: 'hdmv_pgs_subtitle', format: 'image', language: 'en', forced: true }),
          subtitle({ index: 4, language: 'de', forced: true }),
        ]),
        burnIn,
      );
      expect(result.streams.filter((stream) => stream.action === 'burnIn')).toEqual([
        { index: 3, kind: 'subtitle', action: 'burnIn', from: 'hdmv_pgs_subtitle' },
      ]);
      expect(result.steps).toEqual(['video', 'subtitle']);
    });

    test('a video stream that needs a transcode anyway keeps its reason', () => {
      const result = compare(probe([video({ codec: 'hevc' }), audio(), subtitle({ forced: true })]), burnIn);
      expect(result.streams[0]).toEqual({ index: 0, kind: 'video', action: 'transcode', from: 'hevc', to: 'h264', reason: 'codec' });
    });

    test('with no forced stream, burnIn behaves as text', () => {
      const streams = [video(), audio(), subtitle(), subtitle({ index: 3, language: 'de' })];
      expect(compare(probe(streams), burnIn)).toEqual(compare(probe(streams), DEFAULT));
      expect(compare(probe(streams), burnIn).steps).toEqual(['subtitle']);
    });
  });

  test('H.264 8-bit 1080p, E-AC-3 5.1 and SubRip en and de in Matroska need audio, subtitle and remux, in that order', () => {
    const webdl = probe(
      [
        video(),
        audio({ codec: 'eac3', channels: 6, channelLayout: '5.1(side)' }),
        subtitle({ index: 2, language: 'en' }),
        subtitle({ index: 3, language: 'de' }),
      ],
      { container: 'matroska' },
    );
    expect(compare(webdl, DEFAULT)).toEqual({
      fits: false,
      steps: ['audio', 'subtitle', 'remux'],
      streams: [
        { index: 0, kind: 'video', action: 'copy', from: 'h264' },
        { index: 1, kind: 'audio', action: 'transcode', from: 'eac3', to: 'aac', reason: 'codec' },
        { index: 2, kind: 'subtitle', action: 'extract', from: 'subrip', to: 'srt', reason: 'embeddedSubtitle' },
        { index: 3, kind: 'subtitle', action: 'extract', from: 'subrip', to: 'srt', reason: 'embeddedSubtitle' },
      ],
      container: { from: 'matroska', to: 'mp4', change: true },
    });
  });

  test('English PGS, full and forced, with no text track, are both dropped (imageSubtitle)', () => {
    const imageSubtitles = probe(
      [
        video(),
        audio(),
        subtitle({ index: 2, codec: 'hdmv_pgs_subtitle', format: 'image' }),
        subtitle({ index: 3, codec: 'hdmv_pgs_subtitle', format: 'image', forced: true }),
      ],
      { container: 'matroska' },
    );
    const result = compare(imageSubtitles, DEFAULT);
    expect(result.streams.filter((stream) => stream.kind === 'subtitle')).toEqual([
      { index: 2, kind: 'subtitle', action: 'drop', from: 'hdmv_pgs_subtitle', reason: 'imageSubtitle' },
      { index: 3, kind: 'subtitle', action: 'drop', from: 'hdmv_pgs_subtitle', reason: 'imageSubtitle' },
    ]);
    expect(result.steps).toEqual(['subtitle', 'remux']);
  });

  test('is total: a probe with no streams in an unknown container needs only a remux', () => {
    expect(compare(probe([], { container: 'other' }), DEFAULT)).toEqual({
      fits: false,
      steps: ['remux'],
      streams: [],
      container: { from: 'other', to: 'mp4', change: true },
    });
  });

  test('steps never holds none, and fits is exactly an empty plan', () => {
    const probes = [
      probe([video(), audio()]),
      probe([video({ codec: 'hevc', interlaced: true }), audio({ codec: 'dts', channels: 8 }), subtitle()], { container: 'matroska' }),
      probe([video(), audio(), subtitle({ codec: 'dvd_subtitle', format: 'image' })], { container: 'avi' }),
      probe([], { container: 'mp4' }),
    ];
    for (const target of [DEFAULT, custom({ subtitles: { mode: 'burnIn' } }), custom({ containers: ['mkv'], subtitles: { mode: 'keep' } })]) {
      for (const summary of probes) {
        const result = compare(summary, target);
        expect(result.steps).not.toContain('none');
        expect(result.fits).toBe(result.steps.length === 0);
      }
    }
  });

  describe('container', () => {
    test('a container not in the list adds remux to the first one', () => {
      const result = compare(probe([video(), audio()], { container: 'matroska' }), DEFAULT);
      expect(result.steps).toEqual(['remux']);
      expect(result.fits).toBe(false);
      expect(result.container).toEqual({ from: 'matroska', to: 'mp4', change: true });
    });

    test('the first container is what a remux produces', () => {
      const result = compare(probe([video(), audio()], { container: 'avi' }), custom({ containers: ['mkv', 'mp4'] }));
      expect(result.container).toEqual({ from: 'avi', to: 'mkv', change: true });
    });

    test('Matroska in a list with mkv anywhere needs no remux', () => {
      const result = compare(probe([video(), audio()], { container: 'matroska' }), custom({ containers: ['mp4', 'mkv'] }));
      expect(result.steps).toEqual([]);
      expect(result.container).toEqual({ from: 'matroska', to: 'mkv', change: false });
    });

    test('WebM is not Matroska for a target', () => {
      expect(compare(probe([video(), audio()], { container: 'webm' }), custom({ containers: ['mkv'] })).container).toEqual({
        from: 'webm',
        to: 'mkv',
        change: true,
      });
    });
  });
});

describe('subtitleFormatOf', () => {
  test.each(['subrip', 'ass', 'ssa', 'webvtt', 'mov_text', 'text'])('%s is text', (codec) => {
    expect(subtitleFormatOf(codec)).toBe('text');
  });

  test.each(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle', 'xsub'])('%s is image', (codec) => {
    expect(subtitleFormatOf(codec)).toBe('image');
  });

  test('a codec neither list names is neither', () => {
    expect(subtitleFormatOf('eia_608')).toBeUndefined();
  });
});

describe('mostExpensive', () => {
  test('video > audio > subtitle > remux, whatever the order', () => {
    expect(mostExpensive(['remux', 'subtitle', 'audio', 'video'])).toBe('video');
    expect(mostExpensive(['remux', 'audio', 'subtitle'])).toBe('audio');
    expect(mostExpensive(['remux', 'subtitle'])).toBe('subtitle');
    expect(mostExpensive(['remux'])).toBe('remux');
  });

  test('an empty plan is none', () => {
    expect(mostExpensive([])).toBe('none');
  });
});
