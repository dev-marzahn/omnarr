// The prepare job and its output check (`checkOutput`, item
// 31), with real ffmpeg on fixtures/media/ and a real temporary /data tree:
// free space, the resume rules, probe and compare, subtitles, the main run,
// the check, the swap for both dispositions, the result, and on failure the
// `ffmpeg.log` upload. The tests that run ffmpeg skip with a notice when it
// is missing (fixtures/media/tools.ts).
import { copyFile, link, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import {
  compare,
  DEFAULT_DEVICES,
  type JobResult,
  type LeasedJob,
  type PreparePayload,
  type PrepareResult,
  type ProbeSummary,
  targetForDevices,
} from '@omnarr/contracts';
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';

import { dataLayout, type DataLayout } from '../src/fs/layout.ts';
import { inodeOf } from '../src/fs/space.ts';
import { mainRunDetail, type PrepareDeps, prepareHandler } from '../src/jobs/prepare.ts';
import { checkOutput, runChild } from '../src/media/prepare.ts';
import { probe, summarize } from '../src/media/probe.ts';
import { JobFailure } from '../src/runtime/lease.ts';
import { FakeBackend } from './fakeBackend.ts';
import { MEDIA, mediaTools } from './fixtures/media/tools.ts';
import { MOVIE_NAMING, SERIES_NAMING } from './payloads.ts';

/** Chrome and the Jellyfin Android app: H.264, AAC up to 2.0, MP4, text subtitles as sidecars. */
const TARGET = targetForDevices(DEFAULT_DEVICES);
const WORK = 'Show (2019) [tmdbid-123]';
const SOURCE_NAME = 'Show (2019) - S01E02 - Pilot [AMZN][WEBDL-1080p][EAC3 5.1][h264]-GRP.mkv';
const OUTPUT = 'Show (2019) - S01E02 - Pilot [AMZN][WEBDL-1080p][AAC 2.0][h264]-GRP';
const FILM = 'Film (2020) [tmdbid-9]';
const FILM_SOURCE = 'Film (2020) [tmdbid-9] - [Bluray-1080p][EAC3 5.1][h264]-GRP.mkv';
const FILM_OUTPUT = 'Film (2020) [tmdbid-9] - [Bluray-1080p][AAC 2.0][h264]-GRP';

let root: string;
let layout: DataLayout;
let backend: FakeBackend;
let uploads: { url: string; body: string }[];
let runs: string[][];
let progressed: [number, string | undefined][];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'omnarr-prepare-'));
  layout = dataLayout(root);
  backend = new FakeBackend();
  uploads = [];
  runs = [];
  progressed = [];
});
afterEach(() => rm(root, { recursive: true, force: true }));

const season = () => join(layout.series, WORK, 'Season 01');
const originalsSeason = () => join(layout.originals, 'series', WORK, 'Season 01');
const toData = (local: string) => `/data/${relative(root, local)}`;

/** Convex's upload endpoint: takes the POSTed body, answers with a storage ID. */
const fakeFetch: typeof fetch = async (url, init) => {
  uploads.push({ url: url as string, body: Buffer.from(init?.body as Uint8Array).toString('utf8') });
  return Response.json({ storageId: `storage-${uploads.length}` });
};

const handler = (deps: Partial<PrepareDeps> = {}) =>
  prepareHandler({
    layout,
    probe,
    run: async (options) => {
      runs.push(options.args);
      return runChild(options);
    },
    backend,
    fetch: fakeFetch,
    freeBytes: async () => 1e12,
    ...deps,
  });
const ctx = (signal = new AbortController().signal) => ({ signal, progress: (fraction: number, detail?: string) => void progressed.push([fraction, detail]) });

const stepsReported = () => progressed.map(([, detail]) => detail).filter((detail, i, all) => detail !== all[i - 1]);

/** A fixture copied into the library (or anywhere) under a name. */
async function place(fixture: string, folder: string, name: string): Promise<string> {
  await mkdir(folder, { recursive: true });
  const path = join(folder, name);
  await copyFile(join(MEDIA, fixture), path);
  return path;
}

async function job(sourcePath: string, overrides: Partial<PreparePayload> = {}): Promise<LeasedJob> {
  const payload: PreparePayload = {
    class: 'prepare',
    renditionId: 'r1' as never,
    sourceFileId: 'f1' as never,
    sourcePath: toData(sourcePath),
    sourceInode: inodeOf(await stat(sourcePath)),
    targetProfileId: 'p1' as never,
    target: TARGET,
    disposition: 'replace',
    naming: SERIES_NAMING,
    units: [{ season: 1, episode: 2, title: 'Pilot' }],
    outputFolder: toData(season()),
    originalsFolder: toData(originalsSeason()),
    ...overrides,
  };
  return backend.lease(payload, 'job1');
}

const ls = async (dir: string) => (await readdir(dir).catch(() => [])).sort((a, b) => a.localeCompare(b));
const stagingLeft = () => ls(layout.staging);

async function failure(promise: Promise<unknown>): Promise<JobFailure> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(JobFailure);
  return error as JobFailure;
}

const full = (result: JobResult): Extract<PrepareResult, { noChange: false }> => {
  if (result.class !== 'prepare' || result.noChange) throw new Error('expected a prepared file');
  return result;
};

const sidecar = (path: string, language: 'en' | 'de') => ({ path, language, forced: false, sdh: false, format: 'srt' as const });

describe('checkOutput', () => {
  const video = {
    index: 0,
    kind: 'video' as const,
    codec: 'h264',
    default: true,
    forced: false,
    hearingImpaired: false,
    width: 1920,
    height: 1080,
    bitDepth: 8 as const,
    pixFmt: 'yuv420p',
    interlaced: false,
    hdr: 'sdr' as const,
  };
  const audio = (codec: string, channels: number) => ({
    index: 1,
    kind: 'audio' as const,
    codec,
    channels,
    default: true,
    forced: false,
    hearingImpaired: false,
  });
  const SOURCE: ProbeSummary = { container: 'matroska', durationMs: 600_000, streams: [video, audio('eac3', 6)] };
  const out = (overrides: Partial<ProbeSummary> = {}): ProbeSummary => ({
    container: 'mp4',
    durationMs: 600_000,
    streams: [video, audio('aac', 2)],
    ...overrides,
  });
  const plan = compare(SOURCE, TARGET);
  const check = (output: ProbeSummary) => {
    try {
      checkOutput(SOURCE, output, TARGET, plan);
      return undefined;
    } catch (error) {
      return error;
    }
  };

  test('an output that fits, with the planned streams and the duration, passes', () => {
    expect(check(out())).toBeUndefined();
    // 0.2 % of 10 min is 1.2 s, so the 2 s tolerance applies.
    expect(check(out({ durationMs: 598_000 }))).toBeUndefined();
  });

  test('a duration off by more than 2 s or 0.2 %, whichever is larger, fails as transcodeFailed', () => {
    expect(check(out({ durationMs: 597_900 }))).toMatchObject({
      code: 'transcodeFailed',
      detail: "Output check failed: its duration is 597.9 s, the source's 600 s.",
    });
    const long: ProbeSummary = { ...SOURCE, durationMs: 3_600_000 };
    // 0.2 % of an hour is 7.2 s.
    expect(() => checkOutput(long, out({ durationMs: 3_593_000 }), TARGET, compare(long, TARGET))).not.toThrow();
  });

  test("an output that doesn't fit the target fails, naming its steps", () => {
    expect(check(out({ container: 'matroska' }))).toMatchObject({ code: 'transcodeFailed', detail: "Output check failed: it doesn't fit the target (remux)." });
  });

  test("the main run's detail names the plan's most expensive step", () => {
    expect(mainRunDetail(plan)).toBe('Audio conversion E-AC-3 → AAC');
    expect(mainRunDetail(compare({ ...SOURCE, streams: [video, audio('aac', 2)] }, TARGET))).toBe('Remux Matroska → MP4');
    expect(mainRunDetail(compare({ ...SOURCE, streams: [{ ...video, codec: 'hevc' }] }, TARGET))).toBe('Video conversion HEVC → H.264');
  });

  test('an output without the planned audio stream fails', () => {
    expect(check(out({ streams: [video] }))).toMatchObject({ code: 'transcodeFailed', detail: 'Output check failed: it has 0 audio streams; the plan has 1.' });
    expect(check(out({ streams: [audio('aac', 2)] }))).toMatchObject({ detail: 'Output check failed: it has no video stream.' });
  });
});

test('a Dolby Vision source without an HDR10 base layer is refused at once as transcodeFailed', async () => {
  const dv = summarize(JSON.parse(await readFile(join(MEDIA, 'probe', 'handwritten-dv-p5.mp4.json'), 'utf8')));
  const source = await place('fits.mp4', season(), 'Show (2019) - S01E02 - Pilot [AMZN][WEBDL-1080p][AAC 2.0][DV][h265]-GRP.mp4');
  const error = await failure(handler({ probe: async () => dv })(await job(source), ctx()));
  expect(error).toMatchObject({ code: 'transcodeFailed', detail: "Dolby Vision without an HDR10 base layer can't be converted on CPU." });
  expect(runs).toEqual([]);
  expect(await stagingLeft()).toEqual([]);
});

test('a source missing everywhere fails as pipelineError', async () => {
  const source = await place('webdl.mkv', season(), SOURCE_NAME);
  const prepared = await job(source, { disposition: 'keep' });
  await rm(source);
  expect(await failure(handler()(prepared, ctx()))).toMatchObject({ code: 'pipelineError', detail: `Source file missing: ${SOURCE_NAME}.` });
});

describe.runIf(mediaTools('ffmpeg', 'ffprobe'))('the prepare job (real ffmpeg)', () => {
  test('the MKV becomes an MP4 with AAC 2.0 and two .srt sidecars that fits, and replaces the source', async () => {
    const source = await place('webdl.mkv', season(), SOURCE_NAME);
    const result = full(await handler()(await job(source), ctx()));

    const output = join(season(), `${OUTPUT}.mp4`);
    const info = await stat(output);
    expect(result).toEqual({
      class: 'prepare',
      noChange: false,
      outputPath: output,
      sizeBytes: info.size,
      inode: inodeOf(info),
      probe: result.probe,
      encoder: 'copy',
      steps: ['audio', 'subtitle', 'remux'],
      sidecars: [sidecar(join(season(), `${OUTPUT}.de.srt`), 'de'), sidecar(join(season(), `${OUTPUT}.en.srt`), 'en')],
      droppedTracks: [],
      sourceRemoved: true,
    });
    expect(compare(result.probe, TARGET).fits).toBe(true);
    expect(result.probe.streams.filter((s) => s.kind === 'audio').map((s) => s.kind === 'audio' && [s.codec, s.channels])).toEqual([['aac', 2]]);
    expect(await ls(season())).toEqual([`${OUTPUT}.de.srt`, `${OUTPUT}.en.srt`, `${OUTPUT}.mp4`]);
    expect((await readFile(join(season(), `${OUTPUT}.en.srt`), 'utf8')).length).toBeGreaterThan(0);
    expect(runs[0]!.slice(0, 2)).toEqual(['-hide_banner', '-nostdin']);
    expect(await stagingLeft()).toEqual([]);
  });

  test('every step reports its detail, in order, each starting at 0', async () => {
    const source = await place('webdl.mkv', season(), SOURCE_NAME);
    full(await handler()(await job(source), ctx()));
    expect(stepsReported()).toEqual([
      'Checking the file',
      'Subtitle extraction',
      'Audio conversion E-AC-3 → AAC',
      'Checking the new file',
      'Moving into the library',
    ]);
    for (const step of stepsReported()) expect(progressed.find(([, detail]) => detail === step)).toEqual([0, step]);
    const fractionsOf = (step: string) => progressed.filter(([, detail]) => detail === step).map(([fraction]) => fraction);
    expect(fractionsOf('Subtitle extraction').some((fraction) => fraction > 0)).toBe(true);
    expect(fractionsOf('Audio conversion E-AC-3 → AAC').some((fraction) => fraction > 0)).toBe(true);
  });

  test('without a source duration every step stays at 0', async () => {
    const source = await place('webdl.mkv', season(), SOURCE_NAME);
    const withoutDuration: PrepareDeps['probe'] = async (path, signal) => {
      const { durationMs: _unknown, ...summary } = await probe(path, signal);
      return summary;
    };
    full(await handler({ probe: withoutDuration })(await job(source), ctx()));
    expect(stepsReported()).toHaveLength(5);
    expect(progressed.every(([fraction]) => fraction === 0)).toBe(true);
  });

  test('an output that fails the check is transcodeFailed, its ffmpeg.log is uploaded, and the library is unchanged', async () => {
    const name = 'Show (2019) - S01E02 - Pilot [AMZN][WEBDL-1080p][AAC 2.0][h265]-GRP.mkv';
    const source = await place('cut-short.mkv', season(), name);
    // The cut fixture's header says 8.02 s, and a transcode of what is left gives about 4 s.
    const error = await failure(handler()(await job(source), ctx()));
    expect(error.code).toBe('transcodeFailed');
    expect(error.detail).toMatch(/^Output check failed: its duration is [\d.]+ s, the source's 8 s\.$/);
    expect(error.artifactStorageId).toBe('storage-1');
    expect(stepsReported()).toEqual(['Checking the file', 'Video conversion HEVC → H.264', 'Checking the new file']);
    expect(backend.calls.find((call) => call.fn === 'artifactUploadUrl')?.args).toEqual({ jobId: 'job1', leaseEpoch: 1 });
    expect(uploads).toHaveLength(1);
    expect(uploads[0]!.url).toBe('http://convex.invalid/upload/1');
    expect(uploads[0]!.body).toMatch(/^\$ ffmpeg -hide_banner/m);
    expect(await ls(season())).toEqual([name]);
    expect(await stagingLeft()).toEqual([]);
  });

  test('an abort stops the run and removes staging; the source stays', async () => {
    const source = await place('webdl.mkv', season(), SOURCE_NAME);
    const controller = new AbortController();
    const run: PrepareDeps['run'] = async (options) => {
      controller.abort('cancelled');
      return runChild(options);
    };
    await expect(handler({ run })(await job(source), ctx(controller.signal))).rejects.toBe('cancelled');
    expect(await ls(season())).toEqual([SOURCE_NAME]);
    expect(await stagingLeft()).toEqual([]);
    expect(uploads).toEqual([]);
  });

  test('a source that already fits completes with noChange, and nothing runs', async () => {
    const source = await place('fits.mp4', season(), 'Show (2019) - S01E02 - Pilot [AMZN][WEBDL-1080p][AAC 2.0][h264]-GRP.mp4');
    expect(await handler()(await job(source), ctx())).toEqual({ class: 'prepare', noChange: true });
    expect(runs).toEqual([]);
    expect(progressed).toEqual([[0, 'Checking the file']]);
  });

  test('keep moves the source and its sidecars to originals/ first, and the prepared file takes its place', async () => {
    const library = join(layout.movies, FILM);
    const originals = join(layout.originals, 'movies', FILM);
    const source = await place('webdl.mkv', library, FILM_SOURCE);
    await writeFile(join(library, FILM_SOURCE.replace('.mkv', '.en.srt')), '1\n00:00:00,000 --> 00:00:01,000\nHello\n');
    const prepared = await job(source, {
      disposition: 'keep',
      naming: MOVIE_NAMING,
      units: [{}],
      outputFolder: toData(library),
      originalsFolder: toData(originals),
    });
    const result = full(await handler()(prepared, ctx()));

    expect(await ls(originals)).toEqual([FILM_SOURCE.replace('.mkv', '.en.srt'), FILM_SOURCE]);
    expect(await ls(library)).toEqual([`${FILM_OUTPUT}.de.srt`, `${FILM_OUTPUT}.en.srt`, `${FILM_OUTPUT}.mp4`]);
    expect(result).toMatchObject({
      outputPath: join(library, `${FILM_OUTPUT}.mp4`),
      sourceRemoved: true,
      originalPath: join(originals, FILM_SOURCE),
      originalSidecars: [sidecar(join(originals, FILM_SOURCE.replace('.mkv', '.en.srt')), 'en')],
    });
  });

  test("a hard-linked torrent source loses only the library's link; the client's copy keeps seeding", async () => {
    const seeding = await place('webdl.mkv', join(layout.torrentDownloads, 'Show.S01E02'), 'Show.S01E02.1080p.AMZN.WEB-DL.DDP5.1.H.264-GRP.mkv');
    await mkdir(season(), { recursive: true });
    const source = join(season(), SOURCE_NAME);
    await link(seeding, source);
    full(await handler()(await job(source), ctx()));
    expect(await ls(season())).toEqual([`${OUTPUT}.de.srt`, `${OUTPUT}.en.srt`, `${OUTPUT}.mp4`]);
    expect((await stat(seeding)).nlink).toBe(1);
  });

  describe('resuming', () => {
    test('the output already in place under its planned name, the source gone: a full result at once', async () => {
      const source = await place('webdl.mkv', season(), SOURCE_NAME);
      const prepared = await job(source);
      const first = full(await handler()(prepared, ctx()));
      runs = [];
      progressed = [];
      const again = full(await handler()(prepared, ctx()));
      expect(runs).toEqual([]);
      expect(again).toEqual({ ...first, steps: [], encoder: 'unknown' });
      expect(stepsReported()).toEqual(['Checking the file', 'Moving into the library']);
    });

    test('the output in place and the source still there (a crash before its removal): the swap is finished, nothing runs', async () => {
      const source = await place('webdl.mkv', season(), SOURCE_NAME);
      const first = full(await handler()(await job(source), ctx()));
      await place('webdl.mkv', season(), SOURCE_NAME);
      runs = [];
      const again = full(await handler()(await job(source), ctx()));
      expect(runs).toEqual([]);
      expect(again).toEqual(first);
      expect(await ls(season())).toEqual([`${OUTPUT}.de.srt`, `${OUTPUT}.en.srt`, `${OUTPUT}.mp4`]);
    });

    test('a file at sourcePath with another inode that fits is the output: a full result at once', async () => {
      const path = await place('fits.mp4', season(), 'Show S01E02.mp4');
      const result = full(await handler()(await job(path, { sourceInode: '1:1', naming: { keepBaseName: 'Show S01E02' } }), ctx()));
      expect(runs).toEqual([]);
      expect(result).toMatchObject({ outputPath: path, sidecars: [], sourceRemoved: true });
    });

    test('keep: a source already under originalsFolder is prepared from there', async () => {
      const original = await place('webdl.mkv', originalsSeason(), SOURCE_NAME);
      const prepared = await job(original, { disposition: 'keep', sourcePath: toData(join(season(), SOURCE_NAME)) });
      const result = full(await handler()(prepared, ctx()));
      expect(result).toMatchObject({ outputPath: join(season(), `${OUTPUT}.mp4`), originalPath: original, originalSidecars: [], sourceRemoved: true });
      expect(await ls(originalsSeason())).toEqual([SOURCE_NAME]);
      expect(await ls(season())).toEqual([`${OUTPUT}.de.srt`, `${OUTPUT}.en.srt`, `${OUTPUT}.mp4`]);
    });
  });

  describe('a kept original that fits is restored', () => {
    /** The original's name from its import, before a retitle: the restore names it anew. */
    const ORIGINAL = 'Show (2019) - S01E02 [AMZN][WEBDL-1080p][AAC 2.0][h264]-GRP';
    /** The prepared primary it replaces, for an earlier target. */
    const OLD = 'Show (2019) - S01E02 - Pilot [AMZN][WEBDL-1080p][AAC 2.0][h265]-GRP';
    const SRT = '1\n00:00:00,000 --> 00:00:01,000\nHello\n';

    /** fits.mp4 kept under originals/ with an English sidecar, and an old prepared primary with two sidecars in the library. */
    async function keptOriginal() {
      const original = await place('fits.mp4', originalsSeason(), `${ORIGINAL}.mp4`);
      await writeFile(join(originalsSeason(), `${ORIGINAL}.en.srt`), SRT);
      await mkdir(season(), { recursive: true });
      const old = join(season(), `${OLD}.mp4`);
      await writeFile(old, 'an earlier prepared file');
      await writeFile(join(season(), `${OLD}.en.srt`), SRT);
      await writeFile(join(season(), `${OLD}.de.srt`), SRT);
      const originalInode = inodeOf(await stat(original));
      const restoring = await job(original, { disposition: 'keep', replacesPath: toData(old) });
      return { original, old, originalInode, restoring };
    }

    const restoredResult = async (originalInode?: string) => {
      const outputPath = join(season(), `${OUTPUT}.mp4`);
      const info = await stat(outputPath);
      if (originalInode) expect(inodeOf(info)).toBe(originalInode);
      return {
        class: 'prepare',
        noChange: false,
        restored: true,
        outputPath,
        sizeBytes: info.size,
        inode: inodeOf(info),
        probe: await probe(outputPath, new AbortController().signal),
        encoder: 'copy',
        steps: [],
        sidecars: [sidecar(join(season(), `${OUTPUT}.en.srt`), 'en')],
        droppedTracks: [],
        sourceRemoved: true,
      };
    };

    test('on one filesystem: the original is renamed to its library name with its sidecars, the old primary and its sidecars go', async () => {
      const { originalInode, restoring } = await keptOriginal();
      const result = await handler()(restoring, ctx());
      expect(result).toEqual(await restoredResult(originalInode));
      expect(await ls(season())).toEqual([`${OUTPUT}.en.srt`, `${OUTPUT}.mp4`]);
      expect(await ls(originalsSeason())).toEqual([]);
      expect(runs).toEqual([]);
      expect(await stagingLeft()).toEqual([]);
      expect(progressed).toEqual([
        [0, 'Checking the file'],
        [0, 'Moving into the library'],
      ]);
    });

    test('across filesystems (EXDEV): copied into place, then the original deleted; no .partial is left', async () => {
      const { originalInode, restoring } = await keptOriginal();
      const crossing: PrepareDeps['rename'] = async (from, to) => {
        if (from.startsWith(layout.originals)) throw Object.assign(new Error('EXDEV: cross-device link not permitted'), { code: 'EXDEV' });
        await rename(from, to);
      };
      const result = full(await handler({ rename: crossing })(restoring, ctx()));
      expect(result).toEqual(await restoredResult());
      expect(result.inode).not.toBe(originalInode);
      expect(await ls(season())).toEqual([`${OUTPUT}.en.srt`, `${OUTPUT}.mp4`]);
      expect(await ls(originalsSeason())).toEqual([]);
    });

    test('resumed with the original already moved and the old primary still there: the swap is finished, with the same result', async () => {
      const { original, originalInode, restoring } = await keptOriginal();
      await rename(join(originalsSeason(), `${ORIGINAL}.en.srt`), join(season(), `${OUTPUT}.en.srt`));
      await rename(original, join(season(), `${OUTPUT}.mp4`));
      const result = await handler()(restoring, ctx());
      expect(result).toEqual(await restoredResult(originalInode));
      expect(await ls(season())).toEqual([`${OUTPUT}.en.srt`, `${OUTPUT}.mp4`]);
    });

    test('resumed with the copy in place but the original not yet deleted (EXDEV): the restore runs again', async () => {
      const { originalInode, restoring } = await keptOriginal();
      await place('fits.mp4', season(), `${OUTPUT}.mp4`);
      await writeFile(join(season(), `${OUTPUT}.en.srt`), SRT);
      const result = await handler()(restoring, ctx());
      expect(result).toEqual(await restoredResult(originalInode));
      expect(await ls(season())).toEqual([`${OUTPUT}.en.srt`, `${OUTPUT}.mp4`]);
      expect(await ls(originalsSeason())).toEqual([]);
    });

    test('re-preparing from a kept original that does not fit replaces the old primary named in replacesPath', async () => {
      const original = await place('webdl.mkv', originalsSeason(), SOURCE_NAME);
      await mkdir(season(), { recursive: true });
      const old = join(season(), `${OLD}.mp4`);
      await writeFile(old, 'an earlier prepared file');
      await writeFile(join(season(), `${OLD}.en.srt`), SRT);
      const result = full(await handler()(await job(original, { disposition: 'keep', replacesPath: toData(old) }), ctx()));
      expect(result.restored).toBeUndefined();
      expect(result).toMatchObject({ outputPath: join(season(), `${OUTPUT}.mp4`), originalPath: original, steps: ['audio', 'subtitle', 'remux'] });
      expect(await ls(season())).toEqual([`${OUTPUT}.de.srt`, `${OUTPUT}.en.srt`, `${OUTPUT}.mp4`]);
      expect(await ls(originalsSeason())).toEqual([SOURCE_NAME]);
    });
  });

  describe('a held upgrade file', () => {
    async function heldUpgrade() {
      const source = await place('webdl.mkv', join(layout.held, 'import1'), '1.mkv');
      await mkdir(season(), { recursive: true });
      const old = join(season(), 'Show (2019) - S01E02 - Pilot [WEBDL-1080p][AAC 2.0][h264]-OLDGRP.mp4');
      await writeFile(old, 'the primary that plays now');
      return { source, old };
    }

    test('replace: the output goes into the old primary’s folder, the old primary and the held file go, and so does the held folder', async () => {
      const { source, old } = await heldUpgrade();
      const result = full(await handler()(await job(source, { replacesPath: toData(old) }), ctx()));
      expect(result.outputPath).toBe(join(season(), `${OUTPUT}.mp4`));
      expect(await ls(season())).toEqual([`${OUTPUT}.de.srt`, `${OUTPUT}.en.srt`, `${OUTPUT}.mp4`]);
      expect(await ls(layout.held)).toEqual([]);
    });

    test('keep: the held file becomes the original under originals/, and the held folder goes', async () => {
      const { source, old } = await heldUpgrade();
      const result = full(await handler()(await job(source, { disposition: 'keep', replacesPath: toData(old) }), ctx()));
      expect(result.originalPath).toBe(join(originalsSeason(), '1.mkv'));
      expect(await ls(originalsSeason())).toEqual(['1.mkv']);
      expect(await ls(layout.held)).toEqual([]);
    });
  });

  test('without room in staging it fails as diskFull before anything runs', async () => {
    const source = await place('webdl.mkv', season(), SOURCE_NAME);
    const error = await failure(handler({ freeBytes: async () => 1024 ** 3 })(await job(source), ctx()));
    expect(error.code).toBe('diskFull');
    expect(runs).toEqual([]);
    expect(await ls(season())).toEqual([SOURCE_NAME]);
    expect(await stagingLeft()).toEqual([]);
  });
});
