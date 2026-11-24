// The one-pass subtitle extraction, with
// real ffmpeg on fixtures/media/subtitles.mkv: SubRip English (default) at 2,
// SubRip German (forced, "Signs") at 3, ASS Japanese at 4, PGS English at 5
// and VobSub French at 6.
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { Comparison, ProbeSummary } from '@omnarr/contracts';
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';

import { summarize } from '../src/media/probe.ts';
import { extractSubtitles } from '../src/media/subtitles.ts';
import { MEDIA, mediaTools } from './fixtures/media/tools.ts';

const SOURCE = join(MEDIA, 'subtitles.mkv');

let dir: string;
let sourceProbe: ProbeSummary;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'omnarr-subs-'));
  sourceProbe = summarize(JSON.parse(await readFile(join(MEDIA, 'probe', 'subtitles.mkv.json'), 'utf8')));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

type Row = Comparison['streams'][number];
const comparisonOf = (...rows: Row[]): Comparison => ({
  fits: false,
  steps: ['subtitle'],
  streams: [{ index: 0, kind: 'video', action: 'copy', from: 'h264' }, { index: 1, kind: 'audio', action: 'copy', from: 'aac' }, ...rows],
  container: { from: 'matroska', to: 'mp4', change: true },
});
const extract = (index: number, from: string, to: 'srt' | 'ass' = 'srt'): Row => ({
  index,
  kind: 'subtitle',
  action: 'extract',
  from,
  to,
  reason: 'embeddedSubtitle',
});

const run = (comparison: Comparison, extra: { onProgress?: (fraction: number) => void; sourceProbe?: ProbeSummary } = {}) =>
  extractSubtitles({
    source: SOURCE,
    comparison,
    sourceProbe,
    outDir: join(dir, 'subs'),
    logPath: join(dir, 'ffmpeg.log'),
    signal: new AbortController().signal,
    ...extra,
  });
const ffmpegRuns = async () => (await readFile(join(dir, 'ffmpeg.log'), 'utf8')).match(/^\$ ffmpeg /gm)?.length ?? 0;

describe.skipIf(!mediaTools('ffmpeg'))('extractSubtitles', () => {
  test('every kept text track in one ffmpeg run, one SubRip sidecar each, with its language and flags', async () => {
    const result = await run(comparisonOf(extract(2, 'subrip'), extract(3, 'subrip'), extract(4, 'ass')));
    expect(result).toEqual({
      sidecars: [
        { path: join(dir, 'subs', '1.srt'), language: 'en', forced: false, sdh: false, format: 'srt' },
        { path: join(dir, 'subs', '2.srt'), language: 'de', forced: true, sdh: false, format: 'srt' },
        { path: join(dir, 'subs', '3.srt'), language: 'ja', forced: false, sdh: false, format: 'srt' },
      ],
      dropped: [],
    });
    expect(await ffmpegRuns()).toBe(1);
    expect(await readFile(join(dir, 'subs', '1.srt'), 'utf8')).toContain('Hello there.');
    expect(await readFile(join(dir, 'subs', '2.srt'), 'utf8')).toContain('Hallo.');
    expect(await readFile(join(dir, 'subs', '3.srt'), 'utf8')).toContain('Konnichiwa');
  });

  test('an ASS track the target keeps as ASS is copied as it is', async () => {
    const result = await run(comparisonOf(extract(4, 'ass', 'ass')));
    expect(result.sidecars).toEqual([{ path: join(dir, 'subs', '1.ass'), language: 'ja', forced: false, sdh: false, format: 'ass' }]);
    const ass = await readFile(join(dir, 'subs', '1.ass'), 'utf8');
    expect(ass).toContain('Style: Sign,Arial,16');
    expect(ass).toContain('{\\pos(160,20)}Station');
  });

  test('an image track with a text twin is dropped without a note; one without a twin is dropped with its note', async () => {
    const result = await run(
      comparisonOf(
        extract(2, 'subrip'),
        { index: 5, kind: 'subtitle', action: 'drop', from: 'hdmv_pgs_subtitle', reason: 'textTwin' },
        { index: 6, kind: 'subtitle', action: 'drop', from: 'dvd_subtitle', reason: 'imageSubtitle' },
      ),
    );
    expect(result).toEqual({
      sidecars: [{ path: join(dir, 'subs', '1.srt'), language: 'en', forced: false, sdh: false, format: 'srt' }],
      dropped: [{ language: 'fr', forced: false }],
    });
  });

  test('a forced text track to burn in is extracted as burn.srt in the same run', async () => {
    const result = await run(comparisonOf(extract(2, 'subrip'), { index: 3, kind: 'subtitle', action: 'burnIn', from: 'subrip' }));
    expect(result.burn).toEqual({ path: join(dir, 'subs', 'burn.srt'), kind: 'text' });
    expect(result.sidecars.map((sidecar) => sidecar.path)).toEqual([join(dir, 'subs', '1.srt')]);
    expect(await readFile(join(dir, 'subs', 'burn.srt'), 'utf8')).toContain('Tschüss.');
    expect(await ffmpegRuns()).toBe(1);
  });

  test('a PGS track to burn in is copied to burn.sup; a VobSub one into burn.mkv', async () => {
    const pgs = await run(comparisonOf({ index: 5, kind: 'subtitle', action: 'burnIn', from: 'hdmv_pgs_subtitle' }));
    expect(pgs.burn).toEqual({ path: join(dir, 'subs', 'burn.sup'), kind: 'image' });
    expect((await readFile(join(dir, 'subs', 'burn.sup'))).subarray(0, 2).toString('latin1')).toBe('PG');

    const vobsub = await run(comparisonOf({ index: 6, kind: 'subtitle', action: 'burnIn', from: 'dvd_subtitle' }));
    expect(vobsub.burn).toEqual({ path: join(dir, 'subs', 'burn.mkv'), kind: 'image' });
  });

  test('the extraction reports 0 at its start, then fractions of the source duration', async () => {
    const fractions: number[] = [];
    await run(comparisonOf(extract(2, 'subrip'), extract(3, 'subrip')), { onProgress: (fraction) => fractions.push(fraction) });
    expect(fractions[0]).toBe(0);
    expect(fractions.slice(1).some((fraction) => fraction > 0 && fraction <= 1)).toBe(true);
    expect(fractions).toEqual([...fractions].sort((a, b) => a - b));
  });

  test('without a source duration the extraction reports only its start, at 0', async () => {
    const { durationMs: _unknown, ...withoutDuration } = sourceProbe;
    const fractions: number[] = [];
    await run(comparisonOf(extract(2, 'subrip')), { onProgress: (fraction) => fractions.push(fraction), sourceProbe: withoutDuration });
    expect(fractions).toEqual([0]);
  });

  test('nothing to extract runs nothing', async () => {
    const fractions: number[] = [];
    const result = await run(comparisonOf({ index: 6, kind: 'subtitle', action: 'drop', from: 'dvd_subtitle', reason: 'imageSubtitle' }), {
      onProgress: (fraction) => fractions.push(fraction),
    });
    expect(result).toEqual({ sidecars: [], dropped: [{ language: 'fr', forced: false }] });
    expect(fractions).toEqual([]);
    await expect(readFile(join(dir, 'ffmpeg.log'), 'utf8')).rejects.toThrow();
  });
});
