// Subtitles for preparation: one ffmpeg run extracts every kept text track
// and the forced track to burn in, so the source is read once. Image tracks
// without a text twin are dropped, and named for the Rendition's timeline
// entry. There is no OCR yet.
import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { type Comparison, type LanguageCode, type ProbeSummary, type Sidecar, TEXT_SUBTITLE_CODECS } from '@omnarr/contracts';

import { type BurnInput, subtitleArgs, type SubtitleTrack } from './ffmpegArgs.ts';
import { runChild } from './prepare.ts';

export type DroppedTrack = { language?: LanguageCode | 'und'; forced: boolean };

export type ExtractedSubtitles = {
  /** In staging (`<outDir>/<n>.srt|ass`), with the source track's language and flags; the job renames them beside the output. */
  sidecars: Sidecar[];
  /** The track to burn in, for `mainArgs`. */
  burn?: BurnInput;
  /** Image tracks dropped without a text twin. */
  dropped: DroppedTrack[];
};

export type ExtractRequest = {
  source: string;
  comparison: Comparison;
  sourceProbe: ProbeSummary;
  /** `staging/<jobId>/subs`. */
  outDir: string;
  /** The job's `ffmpeg.log`. */
  logPath: string;
  signal: AbortSignal;
  stallMs?: number;
  onProgress?: (fraction: number) => void;
};

const ASS_CODECS = new Set(['ass', 'ssa']);

/** Runs the extraction for a Comparison's subtitle actions. A failed run rejects as `runChild` does. */
export async function extractSubtitles(request: ExtractRequest): Promise<ExtractedSubtitles> {
  const probed = new Map(request.sourceProbe.streams.map((stream) => [stream.index, stream]));
  const tracks: SubtitleTrack[] = [];
  const sidecars: Sidecar[] = [];
  const dropped: DroppedTrack[] = [];
  let burn: BurnInput | undefined;

  for (const row of request.comparison.streams) {
    if (row.kind !== 'subtitle') continue;
    const stream = probed.get(row.index);
    const forced = stream?.forced ?? false;
    const language = stream?.language;
    if (row.action === 'extract') {
      const format = row.to === 'ass' && ASS_CODECS.has(row.from) ? 'ass' : 'srt';
      const name = String(sidecars.length + 1);
      tracks.push({ index: row.index, name, format });
      sidecars.push({
        path: join(request.outDir, `${name}.${format}`),
        ...(language && language !== 'und' ? { language } : {}),
        forced,
        sdh: stream?.hearingImpaired ?? false,
        format,
      });
    } else if (row.action === 'burnIn') {
      const image = stream?.kind === 'subtitle' ? stream.format === 'image' : !TEXT_SUBTITLE_CODECS.includes(row.from);
      const format = !image ? 'srt' : row.from === 'hdmv_pgs_subtitle' ? 'sup' : 'mkv';
      tracks.push({ index: row.index, name: 'burn', format });
      burn = { path: join(request.outDir, `burn.${format}`), kind: image ? 'image' : 'text' };
    } else if ((row.action === 'drop' && row.reason !== 'textTwin') || row.action === 'ocr') {
      // There is no OCR yet: such a track is dropped like the others.
      dropped.push({ ...(language ? { language } : {}), forced });
    }
  }

  if (tracks.length > 0) {
    await mkdir(request.outDir, { recursive: true });
    request.onProgress?.(0);
    const { durationMs } = request.sourceProbe;
    await runChild({
      command: 'ffmpeg',
      args: subtitleArgs(request.source, tracks, request.outDir),
      signal: request.signal,
      logPath: request.logPath,
      ...(request.stallMs === undefined ? {} : { stallMs: request.stallMs }),
      ...(durationMs === undefined ? {} : { durationMs }),
      ...(request.onProgress ? { onProgress: request.onProgress } : {}),
    });
  }
  return { sidecars, ...(burn ? { burn } : {}), dropped };
}
