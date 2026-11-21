// Makes the worker's media fixtures with ffmpeg's `testsrc2` and
// `sine` sources, and records their ffprobe JSON for apps/worker's probe tests.
// The outputs are committed; CI never runs this. Needs ffmpeg and ffprobe with
// libx264, libx265 and the eac3 encoder on the PATH.
//
//   node scripts/make-media-fixtures.ts               # the committed fixtures
//   node scripts/make-media-fixtures.ts --long <dir>  # also a 10-minute 1080p HEVC file, into <dir>
//
// The RAR sets are not made here: RARLAB's `rar` is non-free, so they were made
// once in a throwaway container (apps/worker/test/fixtures/media/README.md).
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, statSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

const OUT = join(dirname(fileURLToPath(import.meta.url)), '..', 'apps', 'worker', 'test', 'fixtures', 'media');
const PROBES = join(OUT, 'probe');

/**
 * An argument list: the literal text splits on whitespace; an interpolated
 * string joins the text it touches, so a path with spaces stays one argument,
 * and an interpolated array adds its items as they are. No shell is involved.
 */
function args(literals: TemplateStringsArray, ...values: (string | number | string[])[]): string[] {
  const out: string[] = [];
  let glue = false;
  const add = (text: string) => {
    if (glue) out[out.length - 1] += text;
    else out.push(text);
    glue = true;
  };
  literals.forEach((literal, i) => {
    for (const part of literal.split(/(\s+)/)) {
      if (/^\s+$/.test(part)) glue = false;
      else if (part) add(part);
    }
    if (i >= values.length) return;
    const value = values[i]!;
    if (Array.isArray(value)) {
      out.push(...value);
      glue = false;
    } else add(String(value));
  });
  return out;
}

const ffmpeg = (list: string[]) => execFileSync('ffmpeg', ['-hide_banner', '-loglevel', 'error', '-nostdin', '-y', ...list], { cwd: OUT, stdio: 'inherit' });

const video = (size: string, seconds: number, rate = 24) => args`-f lavfi -i testsrc2=size=${size}:rate=${rate}:duration=${seconds}`;
const tone = (seconds: number) => args`-f lavfi -i sine=frequency=440:sample_rate=48000:duration=${seconds}`;
const HDR10_TAGS = args`-color_primaries bt2020 -color_trc smpte2084 -colorspace bt2020nc`;
const MASTER_DISPLAY = 'G(13250,34500)B(7500,3000)R(34000,16000)WP(15635,16450)L(10000000,50)';

/**
 * ffprobe's JSON for a fixture, run from the fixtures folder so `filename` is
 * the bare name; re-indented to two spaces, the repository's JSON style.
 */
function record(name: string, frames = false): void {
  const ffprobe = (list: string[]) => `${JSON.stringify(JSON.parse(execFileSync('ffprobe', list, { cwd: OUT, encoding: 'utf8' })), null, 2)}\n`;
  writeFileSync(join(PROBES, `${name}.json`), ffprobe(args`-v error -print_format json -show_format -show_streams ${name}`));
  if (!frames) return;
  const read = args`-v error -print_format json -select_streams v:0 -read_intervals %+#1 -show_frames -show_entries frame=side_data_list ${name}`;
  writeFileSync(join(PROBES, `${name}.frames.json`), ffprobe(read));
}

function srt(lines: string[]): string {
  return lines.map((text, i) => `${i + 1}\n00:00:0${i},200 --> 00:00:0${i},900\n${text}\n`).join('\n');
}

const ASS = `[Script Info]
ScriptType: v4.00+
PlayResX: 320
PlayResY: 180

[V4+ Styles]
Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, Alignment, MarginL, MarginR, MarginV, Encoding
Style: Default,Arial,20,&H00FFFFFF,&H000000FF,&H00000000,&H00000000,0,0,0,0,100,100,0,0,1,1,0,2,10,10,10,1
Style: Sign,Arial,16,&H0000FFFF,&H000000FF,&H00000000,&H00000000,1,0,0,0,100,100,0,0,1,1,0,8,10,10,10,1

[Events]
Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text
Dialogue: 0,0:00:00.20,0:00:00.90,Default,,0,0,0,,Konnichiwa
Dialogue: 0,0:00:01.20,0:00:01.90,Sign,,0,0,0,,{\\pos(160,20)}Station
`;

/**
 * A two-event PGS (`.sup`) stream, written byte by byte: ffmpeg has no PGS
 * encoder, and it can't turn text subtitles into bitmaps. Each event shows a
 * white 100×20 box on a 320×180 canvas.
 */
function pgs(): Buffer {
  const segment = (pts: number, type: number, data: Buffer) => {
    const header = Buffer.alloc(13);
    header.write('PG', 0, 'latin1');
    header.writeUInt32BE(pts, 2);
    header.writeUInt32BE(0, 6);
    header.writeUInt8(type, 10);
    header.writeUInt16BE(data.length, 11);
    return Buffer.concat([header, data]);
  };
  const u16 = (n: number) => [n >> 8, n & 0xff];
  const [x, y, w, h] = [110, 150, 100, 20];
  const window = Buffer.from([1, 0, ...u16(x), ...u16(y), ...u16(w), ...u16(h)]);
  // Each line: one run of w pixels in palette entry 1, then end of line.
  const line = [0x00, 0xc0 | (w >> 8), w & 0xff, 0x01, 0x00, 0x00];
  const rle = Buffer.from(Array.from({ length: h }, () => line).flat());
  const objectLength = rle.length + 4;
  const ods = Buffer.concat([Buffer.from([0, 0, 0, 0xc0, objectLength >> 16, (objectLength >> 8) & 0xff, objectLength & 0xff, ...u16(w), ...u16(h)]), rle]);
  const palette = Buffer.from([0, 0, 0, 16, 128, 128, 0, 1, 235, 128, 128, 255]);
  const show = (pts: number, composition: number) => [
    segment(pts, 0x16, Buffer.from([...u16(320), ...u16(180), 0x10, ...u16(composition), 0x80, 0, 0, 1, 0, 0, 0, 0, ...u16(x), ...u16(y)])),
    segment(pts, 0x17, window),
    segment(pts, 0x14, palette),
    segment(pts, 0x15, ods),
    segment(pts, 0x80, Buffer.alloc(0)),
  ];
  const clear = (pts: number, composition: number) => [
    segment(pts, 0x16, Buffer.from([...u16(320), ...u16(180), 0x10, ...u16(composition), 0x00, 0, 0, 0])),
    segment(pts, 0x17, window),
    segment(pts, 0x80, Buffer.alloc(0)),
  ];
  const at = (ms: number) => ms * 90;
  return Buffer.concat([...show(at(200), 0), ...clear(at(900), 1), ...show(at(1200), 2), ...clear(at(1900), 3)]);
}

function main(): void {
  const { values } = parseArgs({ options: { long: { type: 'string' } } });
  mkdirSync(PROBES, { recursive: true });
  const work = mkdtempSync(join(tmpdir(), 'omnarr-media-fixtures-'));
  try {
    const en = join(work, 'en.srt');
    const de = join(work, 'de.srt');
    const ass = join(work, 'ja.ass');
    const sup = join(work, 'en.sup');
    writeFileSync(en, srt(['Hello there.', 'Goodbye.']));
    writeFileSync(de, srt(['Hallo.', 'Tschüss.']));
    writeFileSync(ass, ASS);
    writeFileSync(sup, pgs());
    const x264 = args`-c:v libx264 -preset veryfast -crf 30 -pix_fmt yuv420p`;

    // A 1080p WEB-DL episode: H.264, E-AC-3 5.1, English and German SubRip, in Matroska.
    ffmpeg(args`${video('1920x1080', 2)} ${tone(2)} -i ${en} -i ${de} -map 0 -map 1 -map 2 -map 3
      ${x264} -c:a eac3 -b:a 384k -ac 6 -c:s srt
      -metadata:s:a:0 language=eng -metadata:s:s:0 language=eng -metadata:s:s:1 language=ger
      -disposition:v:0 default -disposition:a:0 default -disposition:s:0 0 -disposition:s:1 0
      webdl.mkv`);
    record('webdl.mkv');

    // HEVC 10-bit tagged HDR10, with mastering-display and content-light values.
    // The first pass writes them as SEI; the second re-encodes from it, so
    // ffmpeg also stores them on the Matroska track (stream side data).
    const sei = join(work, 'hdr10-sei.mkv');
    const x265 = `log-level=error:hdr10=1:repeat-headers=1:colorprim=bt2020:transfer=smpte2084:colormatrix=bt2020nc:master-display=${MASTER_DISPLAY}:max-cll=1000,400`;
    const hevc10 = args`-c:v libx265 -pix_fmt yuv420p10le ${HDR10_TAGS} -x265-params ${x265}`;
    ffmpeg(args`${video('640x360', 1)} ${hevc10} ${sei}`);
    ffmpeg(args`-i ${sei} ${tone(1)} -map 0:v -map 1:a ${hevc10} -c:a aac -b:a 128k -metadata:s:a:0 language=eng
      -disposition:v:0 default -disposition:a:0 default hevc-hdr10.mkv`);
    record('hevc-hdr10.mkv', true);

    // An interlaced (top field first) MPEG-2 PAL broadcast in MPEG-TS. Named
    // .m2ts (ffmpeg then writes BDAV's 192-byte packets): a `.ts` file would be
    // read as TypeScript by the repository's checks.
    ffmpeg(args`${video('720x576', 2, 25)} ${tone(2)} -vf setfield=tff -c:v mpeg2video -flags +ilme+ildct -top 1 -b:v 2M
      -c:a mp2 -b:a 192k -metadata:s:a:0 language=ger interlaced.m2ts`);
    record('interlaced.m2ts');

    // An H.264 MP4 that already fits the default target: 640×360, 8-bit, AAC 2.0.
    ffmpeg(args`${video('640x360', 2)} ${tone(2)} ${x264} -profile:v high -c:a aac -b:a 128k -ac 2 -metadata:s:a:0 language=eng
      -movflags +faststart fits.mp4`);
    record('fits.mp4');

    // HEVC 10-bit that needs a video transcode, cut to half its bytes.
    // Matroska writes the duration at the start, so the probe still says 8 s;
    // a transcode makes about 4 s, more than the 2 s tolerance short, which
    // fails the output check.
    ffmpeg(args`${video('320x180', 8)} ${tone(8)} -c:v libx265 -preset ultrafast -pix_fmt yuv420p10le -x265-params log-level=error
      -c:a aac -b:a 96k -ac 2 -disposition:v:0 default -disposition:a:0 default cut-short.mkv`);
    truncateSync(join(OUT, 'cut-short.mkv'), Math.floor(statSync(join(OUT, 'cut-short.mkv')).size / 2));
    record('cut-short.mkv');

    // Subtitles: SubRip (English default, German forced), ASS (Japanese), PGS
    // (English, the SubRip track's image twin) and VobSub (French, made with
    // ffmpeg's dvdsub encoder from the PGS track; -fix_sub_duration gives its
    // clearing events an end).
    ffmpeg(args`${video('320x180', 2)} ${tone(2)} -i ${en} -i ${de} -i ${ass} -fix_sub_duration -i ${sup}
      -map 0 -map 1 -map 2 -map 3 -map 4 -map 5 -map 5
      ${x264} -c:a aac -b:a 96k -ac 2
      -c:s:0 srt -c:s:1 srt -c:s:2 copy -c:s:3 copy -c:s:4 dvdsub
      -metadata:s:a:0 language=eng
      -metadata:s:s:0 language=eng -metadata:s:s:1 language=ger -metadata:s:s:1 title=Signs -metadata:s:s:2 language=jpn
      -metadata:s:s:3 language=eng -metadata:s:s:4 language=fre
      -disposition:v:0 default -disposition:a:0 default
      -disposition:s:0 default -disposition:s:1 forced -disposition:s:2 0 -disposition:s:3 0 -disposition:s:4 0
      subtitles.mkv`);
    record('subtitles.mkv');

    // Cover art (an attached picture), which the probe leaves out.
    const cover = join(work, 'cover.png');
    ffmpeg(args`-f lavfi -i testsrc2=size=160x240:rate=1:duration=1 -frames:v 1 ${cover}`);
    ffmpeg(args`${video('320x180', 1)} ${tone(1)} -i ${cover} -map 0 -map 1 -map 2
      -c:v:0 libx264 -preset veryfast -pix_fmt yuv420p -c:v:1 png -disposition:v:1 attached_pic -c:a aac -b:a 96k cover-art.mp4`);
    record('cover-art.mp4');

    // The long e2e source: 10 minutes of 1080p HEVC, too big to commit.
    if (values.long) {
      const dir = resolve(values.long);
      mkdirSync(dir, { recursive: true });
      ffmpeg(args`${video('1920x1080', 600)} ${tone(600)} -c:v libx265 -preset ultrafast -b:v 1M -pix_fmt yuv420p10le -x265-params log-level=error
        -c:a eac3 -b:a 384k -ac 6 -metadata:s:a:0 language=eng -disposition:v:0 default -disposition:a:0 default ${join(dir, 'hevc-10min.mkv')}`);
    }
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

main();
