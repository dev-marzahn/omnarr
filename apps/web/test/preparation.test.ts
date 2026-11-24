// The preparation wording: the "Prepare now" table, the Preparing row,
// "Prepare all", the Files tab and the timeline's preparation entries.
import type { Comparison, FileRow, PreparationPlan, TimelineStage, UnitRow } from '@omnarr/contracts';
import { describe, expect, test } from 'vite-plus/test';

import {
  entryHeader,
  fileRows,
  preparationEntries,
  originalAfterwards,
  planNotice,
  planRows,
  planSource,
  prepareAllDialog,
  prepareAllLabel,
  prepareAllToast,
  prepareTitle,
  preparingLine,
  stepTag,
  whileItRuns,
} from '../lib/preparation';

type Stream = Comparison['streams'][number];
const comparison = (streams: Stream[], container: Comparison['container'] = { from: 'mp4', to: 'mp4', change: false }): Comparison => ({
  fits: false,
  steps: [],
  streams,
  container,
});

describe("the Prepare now modal's text", () => {
  const plan = (overrides: Partial<PreparationPlan> = {}): PreparationPlan => ({
    fileName: 'Old Show - S01E01 - Pilot.mkv',
    origin: 'scan',
    comparison: { ...comparison([]), steps: ['video', 'audio', 'subtitle', 'remux'] },
    queued: false,
    ...overrides,
  });

  test('the title names the episode, or the movie', () => {
    expect(prepareTitle({ kind: 'episode', tmdbSeason: 1, tmdbEpisode: 1, title: 'Pilot' }, 'Old Show')).toBe('Prepare S01E01 "Pilot"?');
    expect(prepareTitle({ kind: 'episode', tmdbSeason: 2, tmdbEpisode: 10 }, 'Old Show')).toBe('Prepare S02E10?');
    expect(prepareTitle({ kind: 'movie', title: 'Northern Line' }, 'Northern Line')).toBe('Prepare "Northern Line"?');
  });

  test('where the file came from', () => {
    expect(planSource(plan())).toBe('File from the untracked-media scan');
    expect(planSource(plan({ origin: 'download' }))).toBe('Downloaded file');
    expect(planSource(plan({ origin: 'prepared' }))).toBe('Prepared file');
  });

  test('already queued', () => {
    expect(planNotice(plan({ queued: true }))).toEqual({
      color: 'warning',
      title: 'This file is already queued for preparation',
      description: 'Preparing now replaces that queued job with this one.',
    });
  });

  test('only cheap steps', () => {
    expect(planNotice(plan({ comparison: { ...comparison([]), steps: ['audio', 'remux'] } }))).toEqual({
      color: 'success',
      title: 'Video already fits',
      description: 'Steps: audio conversion and remux. No video transcode, so this takes minutes.',
    });
    expect(planNotice(plan())).toBeUndefined();
  });

  test('a file that already fits', () => {
    expect(planNotice(plan({ comparison: { ...comparison([]), fits: true, steps: [] } }))).toEqual({
      color: 'success',
      title: 'This file already fits the target',
      description: 'There is nothing to prepare.',
    });
  });

  test('while it runs, with or without a video transcode', () => {
    expect(whileItRuns(plan(), 'episode')).toBe(
      'The episode shows "Preparing". The current file stays in the library and plays as it is until the new file passes the ffprobe check. The video transcode is the slow step; preparation runs one file at a time.',
    );
    expect(whileItRuns(plan({ comparison: { ...comparison([]), steps: ['remux'] } }), 'movie')).toBe(
      'The movie shows "Preparing". The current file stays in the library and plays as it is until the new file passes the ffprobe check. Preparation runs one file at a time.',
    );
  });

  // "Keep the original" moves it out of the library; otherwise the prepared file replaces it.
  test('what happens to the original afterwards', () => {
    expect(originalAfterwards('scan', false)).toBe('Afterwards your scanned file is deleted: the prepared copy replaces it once it passes the check.');
    expect(originalAfterwards('download', false)).toBe('Afterwards the prepared file replaces the original.');
    expect(originalAfterwards('scan', true)).toBe('Afterwards the original is kept outside the library for re-preparation.');
  });
});

// The Work page's Preparing row: the worker's detail and progress, else the steps.
describe('the Preparing row', () => {
  const renditionId = 'r1' as NonNullable<UnitRow['preparation']>['renditionId'];

  test('queued: waiting for the worker', () => {
    expect(preparingLine({ renditionId, steps: ['video', 'remux'] })).toEqual({ text: 'Waiting for the worker' });
  });

  test("running: the worker's detail and the percentage", () => {
    expect(preparingLine({ renditionId, steps: ['video'], fraction: 0.184, detail: 'Video transcode HEVC → H.264' })).toEqual({
      text: 'Video transcode HEVC → H.264',
      percent: 18,
    });
  });

  test('running without a detail: the steps', () => {
    expect(preparingLine({ renditionId, steps: ['audio', 'remux'], fraction: 0.62 })).toEqual({ text: 'Audio conversion and remux', percent: 62 });
  });
});

// "Prepare all (N)" when N > 0, with a confirm dialog.
describe('Prepare all', () => {
  test('the button', () => {
    expect(prepareAllLabel(12)).toBe('Prepare all (12)');
  });

  test('the dialog, with "Keep the original" off: scanned files are replaced', () => {
    expect(prepareAllDialog({ count: 12, workTitle: 'Old Show', keepOriginal: false })).toEqual({
      title: 'Prepare all 12 files?',
      lines: [
        "12 files of Old Show aren't in the target format.",
        "They are prepared one at a time, after new downloads' preparations. Each plays as it is until its prepared copy passes the check.",
        'Scanned files are replaced by their prepared copies: each is deleted once its copy passes the check.',
      ],
      confirm: 'Prepare all (12)',
    });
  });

  test('the dialog for one file, with "Keep the original" on', () => {
    expect(prepareAllDialog({ count: 1, workTitle: 'Northern Line', keepOriginal: true })).toEqual({
      title: 'Prepare 1 file?',
      lines: [
        "1 file of Northern Line isn't in the target format.",
        "It is prepared after new downloads' preparations. It plays as it is until its prepared copy passes the check.",
        'Originals are kept outside the library for re-preparation.',
      ],
      confirm: 'Prepare all (1)',
    });
  });

  test('the toast', () => {
    expect(prepareAllToast(12)).toEqual({ title: 'Queued 12 files for preparation' });
    expect(prepareAllToast(1)).toEqual({ title: 'Queued 1 file for preparation' });
    expect(prepareAllToast(0)).toEqual({ title: 'Nothing to prepare', description: 'Every file fits or is already queued.' });
  });
});

// The item page's Files tab: versions, fit, steps, sidecars, kept original.
describe('the Files tab', () => {
  const file = (overrides: Partial<FileRow>): FileRow => ({
    fileId: 'f1' as FileRow['fileId'],
    path: '/data/library/series/Old Show (2015)/Season 01/Old Show - S01E01 - Pilot.mkv',
    origin: 'scan',
    kind: 'primary',
    fits: false,
    steps: ['audio', 'remux'],
    sidecars: [],
    ...overrides,
  });

  test('a version that needs preparing', () => {
    expect(fileRows([file({})])).toEqual([
      {
        fileId: 'f1',
        name: 'Old Show - S01E01 - Pilot.mkv',
        folder: '/data/library/series/Old Show (2015)/Season 01',
        kind: 'In the library',
        origin: 'Scanned',
        fit: { text: 'Needs audio conversion and remux', fits: false },
        sidecars: [],
      },
    ]);
  });

  test('a primary the tracked-file check found gone says so', () => {
    expect(fileRows([file({ missingSince: 1 })])[0]!.kind).toBe('Missing from disk');
  });

  test('a prepared file waiting for Jellyfin, with its sidecars, and the kept original, in that order', () => {
    const rows = fileRows([
      file({ fileId: 'f2' as FileRow['fileId'], path: '/data/originals/series/Old Show (2015)/Season 01/a.mkv', kind: 'original', origin: 'download' }),
      file({
        fileId: 'f3' as FileRow['fileId'],
        path: '/data/library/series/Old Show (2015)/Season 01/a.mp4',
        kind: 'staged',
        origin: 'prepared',
        fits: true,
        steps: [],
        sidecars: [
          { path: 'a.en.srt', language: 'en', forced: false, sdh: false, format: 'srt' },
          { path: 'a.en.forced.srt', language: 'en', forced: true, sdh: false, format: 'srt' },
          { path: 'a.de.sdh.ass', language: 'de', forced: false, sdh: true, format: 'ass' },
          { path: 'a.srt', forced: false, sdh: false, format: 'srt' },
        ],
      }),
    ]);
    expect(rows.map((row) => [row.kind, row.origin, row.fit])).toEqual([
      ['Prepared · waiting for Jellyfin', 'Prepared', { text: 'Fits the target', fits: true }],
      ['Kept original', 'Downloaded', { text: 'Kept outside the library for re-preparation', fits: false }],
    ]);
    expect(rows[0]?.sidecars).toEqual(['English · SRT', 'English forced · SRT', 'German SDH · ASS', 'Unknown language · SRT']);
  });

  test("a version that doesn't fit, with no probe to say why", () => {
    expect(fileRows([file({ steps: [] })])[0]?.fit).toEqual({ text: "Doesn't fit the target", fits: false });
  });
});

// On the timeline, each Rendition is its own "Preparation" entry outside the runs, with its notes.
describe('the timeline: preparation entries', () => {
  const event = (overrides: Partial<TimelineStage>): TimelineStage => ({ stage: 'prepare', kind: 'decision', message: '', at: 0, ...overrides });
  const queued = event({ kind: 'stageStarted', message: 'Preparation queued after import', at: 10, to: 'pending' });
  const note = event({ message: 'Dropped 2 image subtitle tracks (English, English forced): OCR comes later', at: 20 });
  const done = event({ kind: 'stageFinished', message: 'Prepared', at: 30, from: 'pending', to: 'done' });
  const published = event({ stage: 'publish', kind: 'stageFinished', message: 'Jellyfin refreshed', at: 40 });
  const search = event({ stage: 'search', kind: 'stageFinished', message: 'Search finished', at: 5 });

  test("a Rendition's events, with the dropped-track note and the publish after it", () => {
    expect(preparationEntries([published, done, note, queued, search])).toEqual({
      entries: [{ state: 'done', startedAt: 10, endedAt: 40, events: [queued, note, done, published] }],
      others: [search],
    });
  });

  test('newest first; a failed one, then a retry still running', () => {
    const failed = event({ kind: 'stageFailed', message: 'Preparation failed', at: 30, from: 'pending', to: 'failed', failureCode: 'transcodeFailed' });
    const retry = event({ kind: 'stageStarted', message: 'Preparation queued: retry', at: 50, to: 'pending' });
    const attempt = event({ kind: 'stageStarted', message: 'Attempt 2', at: 60 });
    expect(preparationEntries([queued, failed, retry, attempt]).entries).toEqual([
      { state: 'pending', startedAt: 50, events: [retry, attempt] },
      { state: 'failed', startedAt: 10, endedAt: 30, events: [queued, failed] },
    ]);
  });

  test("an entry's header", () => {
    expect(entryHeader({ state: 'pending', startedAt: 0, events: [] })).toEqual({ state: 'Preparing', color: 'secondary' });
    expect(entryHeader({ state: 'done', startedAt: 0, events: [] })).toEqual({ state: 'Done', color: 'success' });
    expect(entryHeader({ state: 'failed', startedAt: 0, events: [] })).toEqual({ state: 'Failed', color: 'error' });
    expect(entryHeader({ state: 'cancelled', startedAt: 0, events: [] })).toEqual({ state: 'Cancelled', color: 'neutral' });
  });
});

describe('the Prepare now table: one row per stream, then the container', () => {
  test('a video transcode, an audio conversion, a text subtitle, a dropped image subtitle and a remux', () => {
    const plan = comparison(
      [
        { index: 0, kind: 'video', action: 'transcode', from: 'hevc', to: 'h264', reason: 'codec' },
        { index: 1, kind: 'audio', action: 'transcode', from: 'eac3', to: 'aac', reason: 'codec' },
        { index: 2, kind: 'subtitle', action: 'extract', from: 'subrip', to: 'srt', reason: 'embeddedSubtitle' },
        { index: 3, kind: 'subtitle', action: 'drop', from: 'hdmv_pgs_subtitle', reason: 'imageSubtitle' },
      ],
      { from: 'matroska', to: 'mp4', change: true },
    );
    expect(planRows(plan)).toEqual([
      { text: 'Video transcode HEVC → H.264', step: 'video' },
      { text: 'Audio E-AC-3 → AAC', step: 'audio' },
      { text: 'Subtitle SubRip → sidecar .srt', step: 'subtitle' },
      { text: 'PGS (image) → dropped (OCR comes later)', step: 'subtitle' },
      { text: 'Remux Matroska → MP4', step: 'remux' },
    ]);
  });

  test("the Step column's tags", () => {
    expect(stepTag('video')).toBe('Full video transcode (CPU)');
    expect(stepTag('audio')).toBe('Audio conversion');
    expect(stepTag('subtitle')).toBe('Subtitle conversion');
    expect(stepTag('remux')).toBe('Remux');
  });

  test('streams that are copied, and a container that stays', () => {
    const plan = comparison([
      { index: 0, kind: 'video', action: 'copy', from: 'h264' },
      { index: 1, kind: 'audio', action: 'copy', from: 'aac' },
      { index: 2, kind: 'subtitle', action: 'copy', from: 'subrip' },
    ]);
    expect(planRows(plan)).toEqual([
      { text: 'Video H.264 · copied' },
      { text: 'Audio AAC · copied' },
      { text: 'Subtitle SubRip · kept in the file' },
      { text: 'Container MP4 · kept' },
    ]);
  });

  test('why a video is transcoded when its codec already fits', () => {
    const video = (reason: Stream['reason']): Stream => ({ index: 0, kind: 'video', action: 'transcode', from: 'h264', to: 'h264', ...(reason && { reason }) });
    expect(planRows(comparison([video('resolution')]))[0]?.text).toBe('Video transcode H.264 · above the resolution cap');
    expect(planRows(comparison([video('bitrate')]))[0]?.text).toBe('Video transcode H.264 · above the bit-rate cap');
    expect(planRows(comparison([video('hdr')]))[0]?.text).toBe('Video transcode H.264 · HDR to SDR');
    expect(planRows(comparison([video('bitDepth')]))[0]?.text).toBe('Video transcode H.264 · bit depth above the target');
    expect(planRows(comparison([video('interlaced')]))[0]?.text).toBe('Video transcode H.264 · deinterlaced');
    expect(planRows(comparison([video(undefined)]))[0]?.text).toBe('Video transcode H.264 · to burn in subtitles');
    expect(planRows(comparison([{ ...video('dvNoFallback'), from: 'hevc' }]))[0]?.text).toBe(
      "Video transcode HEVC → H.264 · Dolby Vision without an HDR10 base layer can't be converted on CPU",
    );
  });

  test('an extra video stream, downmixed audio, ASS kept, and the other subtitle plans', () => {
    expect(
      planRows(
        comparison([
          { index: 1, kind: 'video', action: 'drop', from: 'mjpeg', reason: 'extraVideo' },
          { index: 2, kind: 'audio', action: 'transcode', from: 'aac', to: 'aac', reason: 'channels' },
          { index: 3, kind: 'subtitle', action: 'extract', from: 'ass', to: 'ass', reason: 'embeddedSubtitle' },
          { index: 4, kind: 'subtitle', action: 'drop', from: 'hdmv_pgs_subtitle', reason: 'textTwin' },
          { index: 5, kind: 'subtitle', action: 'drop', from: 'dvd_subtitle', reason: 'noOcrLanguage' },
          { index: 6, kind: 'subtitle', action: 'ocr', from: 'hdmv_pgs_subtitle', to: 'srt' },
          { index: 7, kind: 'subtitle', action: 'burnIn', from: 'subrip' },
        ]),
      ).map((row) => row.text),
    ).toEqual([
      'Video mjpeg · dropped (extra video stream)',
      'Audio AAC · downmixed',
      'Subtitle ASS → sidecar .ass',
      'PGS (image) → dropped (a text track has the same language)',
      'VobSub (image) → dropped (no OCR for its language)',
      'PGS (image) → text by OCR',
      'Subtitle SubRip → burned into the video',
      'Container MP4 · kept',
    ]);
  });
});
