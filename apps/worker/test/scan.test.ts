// The untracked-media scan's read step: the walk's
// skip rules, the batches to `scan.reportBatch`, the probes of the untracked
// videos, and symlinks never followed. On a real temporary /data tree, with
// the fake backend and a fake probe.
import { mkdir, mkdtemp, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { JobPayload, LeasedJob, ProbeSummary } from '@omnarr/contracts';
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';

import { dataLayout, type DataLayout } from '../src/fs/layout.ts';
import { JobFailure } from '../src/runtime/lease.ts';
import { scanLibrary, type ScanDeps, type ScanLibraryPayload } from '../src/scan/walk.ts';
import { FakeBackend } from './fakeBackend.ts';

const PROBE: ProbeSummary = { container: 'matroska', durationMs: 2000, streams: [] };
const SERIES = '/data/library/series';
const MOVIES = '/data/library/movies';

let root: string;
let layout: DataLayout;
let backend: FakeBackend;
let probed: string[];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'omnarr-scan-'));
  layout = dataLayout(root);
  backend = new FakeBackend();
  probed = [];
});
afterEach(() => rm(root, { recursive: true, force: true }));

/** A file at a /data path, on the test's tree. */
const file = async (path: string, content = 'x') => {
  const local = join(root, path.slice('/data'.length));
  await mkdir(dirname(local), { recursive: true });
  await writeFile(local, content);
  return local;
};
const inodeAt = async (local: string) => {
  const info = await stat(local);
  return `${info.dev}:${info.ino}`;
};

const lease = (ignores: string[] = []): LeasedJob =>
  backend.lease({
    class: 'maintenance',
    action: 'scanLibrary',
    scanRunId: 'run1' as never,
    roots: [
      { libraryId: 'series' as never, path: SERIES },
      { libraryId: 'movies' as never, path: MOVIES },
    ],
    ignores,
  } as JobPayload);

const scan = (job: LeasedJob, deps: Partial<ScanDeps> = {}, ctx: Partial<Parameters<typeof scanLibrary>[3]> = {}) =>
  scanLibrary(
    job,
    job.payload as ScanLibraryPayload,
    {
      layout,
      backend,
      probe: async (path) => {
        probed.push(path);
        return PROBE;
      },
      ...deps,
    },
    { signal: new AbortController().signal, progress: () => {}, ...ctx },
  );

const reported = () => backend.scanBatches.flat().map((entry) => entry.path);

describe('the walk', () => {
  test('reports each video under the roots at its /data path, with its size and <device>:<inode>', async () => {
    const episode = await file(`${SERIES}/Show (2019)/Season 01/Show - S01E01.mkv`, 'episode');
    const film = await file(`${MOVIES}/Film (2001)/Film (2001).mp4`, 'film!');

    expect(await scan(lease())).toEqual({ found: 2, untracked: 2 });
    expect(backend.scanBatches.flat()).toEqual([
      { path: `${SERIES}/Show (2019)/Season 01/Show - S01E01.mkv`, sizeBytes: 7, inode: await inodeAt(episode) },
      { path: `${MOVIES}/Film (2001)/Film (2001).mp4`, sizeBytes: 5, inode: await inodeAt(film) },
    ]);
  });

  test('a root that is missing counts nothing and is not an error', async () => {
    await file(`${SERIES}/Show (2019)/Show - S01E01.mkv`);

    expect(await scan(lease())).toEqual({ found: 1, untracked: 1 });
    expect(reported()).toEqual([`${SERIES}/Show (2019)/Show - S01E01.mkv`]);
  });

  test('an empty library sends no batch', async () => {
    expect(await scan(lease())).toEqual({ found: 0, untracked: 0 });
    expect(backend.count('scanReportBatch')).toBe(0);
  });
});

describe('the batches', () => {
  test('sends the found videos in batches of scanBatchSize (100), across the roots', async () => {
    for (let n = 1; n <= 150; n++) await file(`${SERIES}/Show (2019)/Show - S01E${String(n).padStart(3, '0')}.mkv`);
    for (let n = 1; n <= 100; n++) await file(`${MOVIES}/Film ${String(n).padStart(3, '0')}/Film.mkv`);

    expect(await scan(lease())).toEqual({ found: 250, untracked: 250 });
    expect(backend.scanBatches.map((batch) => batch.length)).toEqual([100, 100, 50]);
    expect(backend.scanBatches[1]![49]!.path).toBe(`${SERIES}/Show (2019)/Show - S01E150.mkv`);
  });
});

describe('the probes', () => {
  test('probes only the videos the backend answers as untracked, and records each with its probe', async () => {
    await file(`${SERIES}/Show (2019)/Show - S01E01.mkv`);
    const second = await file(`${SERIES}/Show (2019)/Show - S01E02.mkv`, 'two');
    const linked = await file(`${SERIES}/Show (2019)/Show - S01E03.mkv`);
    backend.trackedPaths.add(`${SERIES}/Show (2019)/Show - S01E01.mkv`);
    backend.trackedInodes.add(await inodeAt(linked));

    expect(await scan(lease())).toEqual({ found: 3, untracked: 1 });
    expect(probed).toEqual([second]);
    expect(backend.scanProbes).toEqual([[{ path: `${SERIES}/Show (2019)/Show - S01E02.mkv`, sizeBytes: 3, inode: await inodeAt(second), probe: PROBE }]]);
  });

  test('runs scanProbeConcurrency (2) probes at a time, and records them in walk order', async () => {
    for (let n = 1; n <= 5; n++) await file(`${SERIES}/Show (2019)/Show - S01E0${n}.mkv`);
    let running = 0;
    let most = 0;
    const slow = async (path: string) => {
      running++;
      most = Math.max(most, running);
      // The later files finish first, so the record's order can't come from the finishing order.
      const episode = Number(/E0(\d)\.mkv$/.exec(path)![1]);
      await new Promise((resolve) => setTimeout(resolve, (6 - episode) * 5));
      running--;
      return PROBE;
    };

    expect(await scan(lease(), { probe: slow })).toEqual({ found: 5, untracked: 5 });
    expect(most).toBe(2);
    expect(backend.scanProbes.flat().map((entry) => entry.path)).toEqual([1, 2, 3, 4, 5].map((n) => `${SERIES}/Show (2019)/Show - S01E0${n}.mkv`));
  });

  test("a file ffprobe can't read is recorded without a probe", async () => {
    const broken = await file(`${MOVIES}/Film (2001)/Film (2001).mkv`, 'not a video');
    const unreadable = async () => {
      throw new JobFailure('fakeOrWrongContent', "ffprobe can't read it.");
    };

    expect(await scan(lease(), { probe: unreadable })).toEqual({ found: 1, untracked: 1 });
    expect(backend.scanProbes).toEqual([[{ path: `${MOVIES}/Film (2001)/Film (2001).mkv`, sizeBytes: 11, inode: await inodeAt(broken) }]]);
  });

  test('any other probe failure fails the job', async () => {
    await file(`${MOVIES}/Film (2001)/Film (2001).mkv`);
    const missing = async () => {
      throw new JobFailure('pipelineError', 'ffprobe is not installed in the worker.');
    };

    await expect(scan(lease(), { probe: missing })).rejects.toMatchObject({ code: 'pipelineError' });
    expect(backend.count('scanRecordProbes')).toBe(0);
  });
});

describe('the progress', () => {
  const capture = () => {
    const reports: [number, string | undefined][] = [];
    return { reports, progress: (fraction: number, detail?: string) => void reports.push([fraction, detail]) };
  };

  test('is the files handled over the files found so far: a tracked one when the backend answers, an untracked one when probed', async () => {
    for (let n = 1; n <= 3; n++) await file(`${SERIES}/Show (2019)/Show - S01E0${n}.mkv`);
    backend.trackedPaths.add(`${SERIES}/Show (2019)/Show - S01E01.mkv`);
    const { reports, progress } = capture();

    await scan(lease(), {}, { progress });
    expect(reports).toEqual([
      [1 / 3, '1 / 3 files'],
      [2 / 3, '2 / 3 files'],
      [1, '3 / 3 files'],
    ]);
  });

  test('writes the counts with thousands separators ("640 / 1,204")', async () => {
    for (let n = 1; n <= 1001; n++) await file(`${MOVIES}/Film/Film ${n}.mkv`);
    backend.trackedPaths = new Set(Array.from({ length: 1001 }, (_, n) => `${MOVIES}/Film/Film ${n + 1}.mkv`));
    const { reports, progress } = capture();

    await scan(lease(), {}, { progress });
    expect(reports.at(-1)).toEqual([1, '1,001 / 1,001 files']);
  });
});

describe('an abort', () => {
  test('stops the scan: nothing more is probed, recorded or sent', async () => {
    for (let n = 1; n <= 150; n++) await file(`${SERIES}/Show (2019)/Show - S01E${String(n).padStart(3, '0')}.mkv`);
    const controller = new AbortController();
    const answer = backend.scanReportBatch.bind(backend);
    // The user cancels while the first batch is with the backend.
    backend.scanReportBatch = async (args) => {
      const untracked = await answer(args);
      controller.abort('cancelled');
      return untracked;
    };

    await expect(scan(lease(), {}, { signal: controller.signal })).rejects.toBe('cancelled');
    expect(backend.count('scanReportBatch')).toBe(1);
    expect(probed).toEqual([]);
    expect(backend.count('scanRecordProbes')).toBe(0);
  });

  test('during the walk sends nothing', async () => {
    await file(`${SERIES}/Show (2019)/Show - S01E01.mkv`);
    const controller = new AbortController();
    controller.abort('shutdown');

    await expect(scan(lease(), {}, { signal: controller.signal })).rejects.toBe('shutdown');
    expect(backend.count('scanReportBatch')).toBe(0);
  });
});

describe('the skip rules', () => {
  const KEPT = `${SERIES}/Show (2019)/Season 01/Show - S01E01.mkv`;

  test('skips hidden files and folders (.omnarr/ among them), .trickplay, @eaDir and #recycle', async () => {
    await file(KEPT);
    await file(`${SERIES}/.omnarr/check.mkv`);
    await file(`${SERIES}/Show (2019)/.hidden/Show - S01E02.mkv`);
    await file(`${SERIES}/Show (2019)/Season 01/.Show - S01E03.mkv`);
    // Jellyfin keeps trickplay images in `<video name>.trickplay/` beside the video.
    await file(`${SERIES}/Show (2019)/Season 01/Show - S01E01.trickplay/320 - 10x10/x.mkv`);
    await file(`${SERIES}/Show (2019)/@eaDir/Show - S01E01.mkv/SYNOVIDEO.mkv`);
    await file(`${MOVIES}/#recycle/Film (2001)/Film (2001).mkv`);

    expect(await scan(lease())).toEqual({ found: 1, untracked: 1 });
    expect(reported()).toEqual([KEPT]);
  });

  test("skips Jellyfin's extras folders, whatever their case", async () => {
    await file(KEPT);
    for (const extras of ['Extras', 'featurettes', 'Behind The Scenes', 'deleted scenes', 'interviews', 'scenes', 'shorts', 'Trailers', 'other'])
      await file(`${SERIES}/Show (2019)/${extras}/Making of.mkv`);
    await file(`${MOVIES}/Film (2001)/trailers/Film (2001) - Trailer.mp4`);

    expect(await scan(lease())).toEqual({ found: 1, untracked: 1 });
    expect(reported()).toEqual([KEPT]);
  });

  test('skips unfinished files, samples and files that are not videos', async () => {
    await file(KEPT);
    await file(`${SERIES}/Show (2019)/Season 01/Show - S01E02.mkv.partial`);
    await file(`${SERIES}/Show (2019)/Season 01/Show - S01E03.mkv.!qB`);
    await file(`${SERIES}/Show (2019)/Season 01/Show - S01E01.en.srt`);
    await file(`${SERIES}/Show (2019)/Season 01/Show - S01E01.nfo`);
    await file(`${MOVIES}/Film (2001)/Film (2001).mkv`);
    await file(`${MOVIES}/Film (2001)/Film (2001)-sample.mkv`);
    await file(`${MOVIES}/Film (2001)/Sample/Film (2001).mkv`);

    expect(await scan(lease())).toEqual({ found: 2, untracked: 2 });
    expect(reported()).toEqual([KEPT, `${MOVIES}/Film (2001)/Film (2001).mkv`]);
  });

  test("skips the payload's ignored folders, and only those", async () => {
    await file(KEPT);
    await file(`${SERIES}/Old Show (1990)/Season 01/Old Show - S01E01.mkv`);
    await file(`${SERIES}/Old Show (1990) Remastered/Old Show - S01E01.mkv`);
    await file(`${MOVIES}/Home Videos/2004.mp4`);

    expect(await scan(lease([`${SERIES}/Old Show (1990)`, `${MOVIES}/Home Videos`]))).toEqual({ found: 2, untracked: 2 });
    expect(reported()).toEqual([`${SERIES}/Old Show (1990) Remastered/Old Show - S01E01.mkv`, KEPT]);
  });

  test('never follows a symlink: a linked folder or file is skipped, so the walk stays inside the root', async () => {
    await file(KEPT);
    const outside = await file('/data/downloads/usenet/Other.S01E01/Other.S01E01.mkv');
    await symlink(dirname(outside), join(root, 'library/series/Other (2020)'));
    await symlink(outside, join(root, 'library/series/Show (2019)/Season 01/Show - S01E02.mkv'));
    await symlink(join(root, 'library/series'), join(root, 'library/series/Show (2019)/loop'));

    expect(await scan(lease())).toEqual({ found: 1, untracked: 1 });
    expect(reported()).toEqual([KEPT]);
  });

  test('a Work folder whose title holds the word "sample" is still read', async () => {
    await file(`${MOVIES}/The Sample (2020)/The Sample (2020).mkv`);

    expect(await scan(lease())).toEqual({ found: 1, untracked: 1 });
  });
});
