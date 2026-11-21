// ffprobe's JSON summarised as the ProbeSummary contract.
// The JSON under fixtures/media/probe/ was recorded with ffprobe from the
// generated fixtures, except the `handwritten-*` files (DV and HDR10+), which
// are written in ffprobe's shape (fixtures/media/README.md).
import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { ProbeSummary, VideoStream } from '@omnarr/contracts';
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';

import { type FfprobeSideData, probe, summarize } from '../src/media/probe.ts';
import { JobFailure } from '../src/runtime/lease.ts';
import { MEDIA, mediaTools } from './fixtures/media/tools.ts';

const json = async (name: string) => JSON.parse(await readFile(join(MEDIA, 'probe', name), 'utf8')) as Parameters<typeof summarize>[0];
const frameSideData = async (name: string) => ((await json(name)) as { frames: { side_data_list: FfprobeSideData[] }[] }).frames[0]!.side_data_list;
const videoOf = (summary: ProbeSummary) => summary.streams.find((stream): stream is VideoStream => stream.kind === 'video')!;

const flags = { default: false, forced: false, hearingImpaired: false };

describe('summarize', () => {
  test('H.264 with E-AC-3 5.1 and two SubRip tracks in Matroska', async () => {
    expect(summarize(await json('webdl.mkv.json'))).toEqual({
      container: 'matroska',
      durationMs: 2000,
      bitRateKbps: 2195,
      streams: [
        {
          kind: 'video',
          index: 0,
          codec: 'h264',
          profile: 'High',
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
        },
        {
          kind: 'audio',
          index: 1,
          codec: 'eac3',
          language: 'en',
          ...flags,
          default: true,
          channels: 6,
          channelLayout: '5.1(side)',
          sampleRate: 48000,
          bitRateKbps: 384,
        },
        { kind: 'subtitle', index: 2, codec: 'subrip', language: 'en', ...flags, format: 'text' },
        { kind: 'subtitle', index: 3, codec: 'subrip', language: 'de', ...flags, format: 'text' },
      ],
    });
  });

  test('HEVC 10-bit HDR10: colour tags, and the mastering display in x265 form from the stream side data', async () => {
    expect(videoOf(summarize(await json('hevc-hdr10.mkv.json')))).toEqual({
      kind: 'video',
      index: 0,
      codec: 'hevc',
      profile: 'Main 10',
      language: 'und',
      ...flags,
      default: true,
      width: 640,
      height: 360,
      bitDepth: 10,
      pixFmt: 'yuv420p10le',
      interlaced: false,
      frameRate: 24,
      colorPrimaries: 'bt2020',
      colorTransfer: 'smpte2084',
      colorSpace: 'bt2020nc',
      hdr: 'hdr10',
      masteringDisplay: 'G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50)',
      contentLight: { maxCll: 1000, maxFall: 400 },
    });
  });

  test('HDR10 values only in the first frame’s side data are read from there', async () => {
    const output = await json('hevc-hdr10.mkv.json');
    const [video] = output.streams!;
    const withoutStreamSideData = { ...output, streams: [{ ...video, side_data_list: undefined }] };
    const summary = summarize(withoutStreamSideData, await frameSideData('hevc-hdr10.mkv.frames.json'));
    expect(videoOf(summary)).toMatchObject({
      hdr: 'hdr10',
      masteringDisplay: 'G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50)',
      contentLight: { maxCll: 1000, maxFall: 400 },
    });
  });

  test('HDR10+: SMPTE 2094-40 in the first frame’s side data; without the frame read it is HDR10', async () => {
    const output = await json('handwritten-hdr10plus.mkv.json');
    expect(videoOf(summarize(output, await frameSideData('handwritten-hdr10plus.mkv.frames.json')))).toMatchObject({
      hdr: 'hdr10plus',
      frameRate: 23.976,
      masteringDisplay: 'G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(40000000,50)',
      contentLight: { maxCll: 1500, maxFall: 300 },
    });
    expect(videoOf(summarize(output)).hdr).toBe('hdr10');
  });

  test('Dolby Vision profile 8.1: dv with its profile and the HDR10 base layer, the bit rate from the BPS tag', async () => {
    expect(videoOf(summarize(await json('handwritten-dv-p8.1.mkv.json')))).toEqual({
      kind: 'video',
      index: 0,
      codec: 'hevc',
      profile: 'Main 10',
      language: 'en',
      ...flags,
      default: true,
      width: 3840,
      height: 2160,
      bitDepth: 10,
      pixFmt: 'yuv420p10le',
      interlaced: false,
      frameRate: 23.976,
      bitRateKbps: 15873,
      colorPrimaries: 'bt2020',
      colorTransfer: 'smpte2084',
      colorSpace: 'bt2020nc',
      hdr: 'dv',
      dv: { profile: 8, compatibility: 1 },
      masteringDisplay: 'G(8500,39850)B(6550,2300)R(35400,14600)WP(15635,16450)L(10000000,1)',
      contentLight: { maxCll: 0, maxFall: 0 },
    });
  });

  test('Dolby Vision profile 5: no base-layer compatibility, no colour tags, in MP4', async () => {
    const summary = summarize(await json('handwritten-dv-p5.mp4.json'));
    expect(summary.container).toBe('mp4');
    const video = videoOf(summary);
    expect(video).toMatchObject({ hdr: 'dv', dv: { profile: 5, compatibility: 0 }, bitRateKbps: 12998 });
    expect(video.colorTransfer).toBeUndefined();
    expect(video.masteringDisplay).toBeUndefined();
  });

  test('an interlaced MPEG-2 broadcast in MPEG-TS', async () => {
    const summary = summarize(await json('interlaced.m2ts.json'));
    expect(summary).toMatchObject({ container: 'mpegts', durationMs: 2010, bitRateKbps: 3057 });
    expect(summary.streams).toEqual([
      {
        kind: 'video',
        index: 0,
        codec: 'mpeg2video',
        profile: 'Main',
        language: 'und',
        ...flags,
        width: 720,
        height: 576,
        bitDepth: 8,
        pixFmt: 'yuv420p',
        interlaced: true,
        frameRate: 25,
        hdr: 'sdr',
      },
      { kind: 'audio', index: 1, codec: 'mp2', language: 'de', ...flags, channels: 1, channelLayout: 'mono', sampleRate: 48000, bitRateKbps: 192 },
    ]);
  });

  test('cover art (an attached picture) is left out', async () => {
    const summary = summarize(await json('cover-art.mp4.json'));
    expect(summary.container).toBe('mp4');
    expect(summary.streams.map((stream) => [stream.index, stream.kind, stream.codec])).toEqual([
      [0, 'video', 'h264'],
      [1, 'audio', 'aac'],
    ]);
  });

  test('subtitles: SubRip and ASS are text, PGS and VobSub are images, with dispositions, titles and languages', async () => {
    const summary = summarize(await json('subtitles.mkv.json'));
    expect(summary.streams.filter((stream) => stream.kind === 'subtitle')).toEqual([
      { kind: 'subtitle', index: 2, codec: 'subrip', language: 'en', ...flags, default: true, format: 'text' },
      { kind: 'subtitle', index: 3, codec: 'subrip', language: 'de', title: 'Signs', ...flags, forced: true, format: 'text' },
      { kind: 'subtitle', index: 4, codec: 'ass', language: 'ja', ...flags, format: 'text' },
      { kind: 'subtitle', index: 5, codec: 'hdmv_pgs_subtitle', language: 'en', ...flags, format: 'image' },
      { kind: 'subtitle', index: 6, codec: 'dvd_subtitle', language: 'fr', ...flags, format: 'image' },
    ]);
  });

  test('HLG is hlg; hearing-impaired is read; an unknown language is und; an unknown subtitle codec counts as an image', () => {
    const summary = summarize({
      format: { filename: '/data/x.mkv', format_name: 'matroska,webm' },
      streams: [
        {
          index: 0,
          codec_type: 'video',
          codec_name: 'hevc',
          width: 1920,
          height: 1080,
          pix_fmt: 'yuv420p10le',
          color_transfer: 'arib-std-b67',
          avg_frame_rate: '0/0',
          r_frame_rate: '50/1',
        },
        { index: 1, codec_type: 'subtitle', codec_name: 'subrip', disposition: { hearing_impaired: 1 }, tags: { language: 'xyz' } },
        { index: 2, codec_type: 'subtitle', codec_name: 'dvb_teletext', tags: { language: 'ger' } },
        { index: 3, codec_type: 'attachment', codec_name: 'ttf' },
      ],
    });
    expect(summary.streams).toEqual([
      expect.objectContaining({ kind: 'video', hdr: 'hlg', bitDepth: 10, frameRate: 50 }),
      { kind: 'subtitle', index: 1, codec: 'subrip', language: 'und', ...flags, hearingImpaired: true, format: 'text' },
      { kind: 'subtitle', index: 2, codec: 'dvb_teletext', language: 'de', ...flags, format: 'image' },
    ]);
  });

  test.each([
    ['matroska,webm', 'a.webm', 'webm'],
    ['matroska,webm', 'a.mkv', 'matroska'],
    ['mov,mp4,m4a,3gp,3g2,mj2', 'a.m4v', 'mp4'],
    ['mov,mp4,m4a,3gp,3g2,mj2', 'a.mov', 'other'],
    ['mpegts', 'a.m2ts', 'mpegts'],
    ['avi', 'a.avi', 'avi'],
    ['asf', 'a.wmv', 'other'],
  ])('container %s with %s is %s', (formatName, filename, container) => {
    expect(summarize({ format: { format_name: formatName, filename }, streams: [] }).container).toBe(container);
  });

  test('a file without a duration leaves it out', () => {
    expect(summarize({ format: { format_name: 'mpegts', filename: 'a.ts' }, streams: [] })).toEqual({ container: 'mpegts', streams: [] });
  });
});

describe('probe with a stand-in ffprobe', () => {
  let dir: string;
  let path: string | undefined;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'omnarr-probe-'));
    path = process.env.PATH;
  });
  afterEach(async () => {
    process.env.PATH = path;
    await rm(dir, { recursive: true, force: true });
  });

  /** An `ffprobe` on the PATH that logs its arguments and prints the given JSON (or never answers). */
  async function fakeFfprobe(streams: string, frames?: string, hang = false): Promise<string> {
    const log = join(dir, 'calls.log');
    const script = `#!/usr/bin/env node
const fs = require('fs');
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)) + '\\n');
if (${hang}) setTimeout(() => {}, 60000);
else process.stdout.write(fs.readFileSync(process.argv.includes('-show_frames') ? ${JSON.stringify(frames ?? '')} : ${JSON.stringify(streams)}));
`;
    await writeFile(join(dir, 'ffprobe'), script);
    await chmod(join(dir, 'ffprobe'), 0o755);
    process.env.PATH = `${dir}:${path}`;
    return log;
  }
  const calls = async (log: string) =>
    (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[]);

  test('a smpte2084 video adds the first-frame side-data read, which tells HDR10+ from HDR10', async () => {
    const log = await fakeFfprobe(join(MEDIA, 'probe', 'handwritten-hdr10plus.mkv.json'), join(MEDIA, 'probe', 'handwritten-hdr10plus.mkv.frames.json'));
    const summary = await probe('/data/staging/job1/1.mkv', new AbortController().signal);
    expect(videoOf(summary).hdr).toBe('hdr10plus');
    expect(await calls(log)).toEqual([
      ['-v', 'error', '-print_format', 'json', '-show_format', '-show_streams', '/data/staging/job1/1.mkv'],
      [
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
        '/data/staging/job1/1.mkv',
      ],
    ]);
  });

  test('an SDR video is read once', async () => {
    const log = await fakeFfprobe(join(MEDIA, 'probe', 'webdl.mkv.json'));
    await probe('/data/staging/job1/1.mkv', new AbortController().signal);
    expect(await calls(log)).toHaveLength(1);
  });

  test('an ffprobe that never answers times out as fakeOrWrongContent', async () => {
    await fakeFfprobe(join(MEDIA, 'probe', 'webdl.mkv.json'), undefined, true);
    const error = await probe('/data/x.mkv', new AbortController().signal, { timeoutMs: 300 }).catch((e: unknown) => e);
    expect(error).toEqual(new JobFailure('fakeOrWrongContent', "ffprobe can't read /data/x.mkv."));
  });

  test('a missing ffprobe is pipelineError', async () => {
    process.env.PATH = dir;
    const error = await probe('/data/x.mkv', new AbortController().signal).catch((e: unknown) => e);
    expect(error).toEqual(new JobFailure('pipelineError', 'ffprobe is not installed in the worker.'));
  });
});

describe.skipIf(!mediaTools('ffprobe'))('probe with the real ffprobe', () => {
  test('reads the HDR10 fixture', async () => {
    const video = videoOf(await probe(join(MEDIA, 'hevc-hdr10.mkv'), new AbortController().signal));
    expect(video).toMatchObject({
      codec: 'hevc',
      bitDepth: 10,
      hdr: 'hdr10',
      masteringDisplay: 'G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50)',
    });
  });

  test('a file that isn’t media is fakeOrWrongContent', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'omnarr-probe-'));
    try {
      await writeFile(join(dir, 'fake.mkv'), 'this is not a video');
      const error = await probe(join(dir, 'fake.mkv'), new AbortController().signal).catch((e: unknown) => e);
      expect(error).toEqual(new JobFailure('fakeOrWrongContent', `ffprobe can't read ${join(dir, 'fake.mkv')}.`));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
