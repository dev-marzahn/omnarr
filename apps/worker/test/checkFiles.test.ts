import { chmod, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import type { JobPayload, LeasedJob } from '@omnarr/contracts';
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';

import { dataLayout, type DataLayout } from '../src/fs/layout.ts';
import { checkLibraryFiles, type CheckFilesPayload, massMisses, rootState } from '../src/scan/checkFiles.ts';
import { FakeBackend } from './fakeBackend.ts';

const SERIES = '/data/library/series';
const MOVIES = '/data/library/movies';
const EPISODE = `${SERIES}/Show (2019)/Season 01/Show - S01E01.mkv`;
const GONE = `${SERIES}/Show (2019)/Season 01/Show - S01E02.mkv`;
const MOVIE = `${MOVIES}/Film (2020)/Film (2020).mkv`;

let root: string;
let layout: DataLayout;
let backend: FakeBackend;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'omnarr-check-'));
  layout = dataLayout(root);
  await mkdir(layout.staging, { recursive: true });
  backend = new FakeBackend();
});
afterEach(async () => {
  await chmod(join(root, 'library/series/Show (2019)'), 0o755).catch(() => {});
  await rm(root, { recursive: true, force: true });
});

const local = (path: string) => join(root, path.slice('/data'.length));
const leftover4KMountPoint = () => local(`${MOVIES}/4K`);
const file = async (path: string) => {
  await mkdir(dirname(local(path)), { recursive: true });
  await writeFile(local(path), 'x');
};

const lease = (): LeasedJob =>
  backend.lease({
    class: 'maintenance',
    action: 'checkLibraryFiles',
    roots: [
      { libraryId: 'series' as never, path: SERIES },
      { libraryId: 'movies' as never, path: MOVIES },
    ],
  } as JobPayload);

const track = (rootPath: string, ...paths: string[]) => {
  backend.trackedFilesByRoot[rootPath] = paths.map((path, n) => ({ fileId: `f${rootPath}${n}` as never, path }));
};

const check = (job = lease()) => checkLibraryFiles(job, job.payload as CheckFilesPayload, { layout, backend }, { signal: new AbortController().signal });
const verdicts = () => Object.fromEntries(backend.fileVerdicts.map(({ path, verdict }) => [path, verdict]));

describe('checkLibraryFiles', () => {
  test('a present file is present and a gone one missing, over every page', async () => {
    await file(EPISODE);
    await file(MOVIE);
    track(SERIES, EPISODE, GONE);
    track(MOVIES, MOVIE);
    const result = await check();
    expect(verdicts()).toEqual({ [EPISODE]: 'present', [GONE]: 'missing', [MOVIE]: 'present' });
    expect(result).toEqual({
      checked: 3,
      missing: 1,
      roots: [
        { libraryId: 'series', state: 'available' },
        { libraryId: 'movies', state: 'available' },
      ],
    });
  });

  test('every tracked file of a folder gone at once, with sidecars left, reports no miss: the folder is named as gone', async () => {
    const episodes = [1, 2, 3].map((n) => `${SERIES}/Show (2019)/Season 01/Show - S01E0${n}.mkv`);
    for (const episode of episodes) await file(episode.replace('.mkv', '.en.srt'));
    track(SERIES, ...episodes);
    const result = await check();
    expect(backend.fileVerdicts).toEqual([]);
    expect(result.roots[0]).toEqual({ libraryId: 'series', state: 'available', goneFolders: [`${SERIES}/Show (2019)`] });
  });

  test('a folder deleted on purpose holds back only its own misses: a file lost elsewhere in the root is still found', async () => {
    const present = [1, 2, 3, 4, 5, 6].map((n) => `${SERIES}/Other (2020)/Season 01/Other - S01E0${n}.mkv`);
    const lost = `${SERIES}/Other (2020)/Season 01/Other - S01E07.mkv`;
    const gone = [1, 2, 3].map((n) => `${SERIES}/Show (2019)/Season 02/Show - S02E0${n}.mkv`);
    for (const path of present) await file(path);
    track(SERIES, ...present, lost, ...gone);
    const result = await check();
    expect(result.roots[0]).toEqual({ libraryId: 'series', state: 'available', goneFolders: [`${SERIES}/Show (2019)`] });
    expect(verdicts()).toEqual({ ...Object.fromEntries(present.map((path) => [path, 'present'])), [lost]: 'missing' });
  });

  test('four gone two-file folders, each below the floor, beside two present files leave the root mostMissing: no miss is reported', async () => {
    const gone = ['A', 'B', 'C', 'D'].flatMap((show) => [1, 2].map((n) => `${SERIES}/${show} (2019)/${show} - S01E0${n}.mkv`));
    const present = [`${SERIES}/Other (2020)/Other - S01E01.mkv`, `${SERIES}/Other (2020)/Other - S01E02.mkv`];
    for (const path of present) await file(path);
    track(SERIES, ...gone, ...present);
    const result = await check();
    expect(result.roots[0]).toEqual({ libraryId: 'series', state: 'mostMissing', checkedWhenMostMissing: 10, missingWhenMostMissing: 8 });
    expect(Object.values(verdicts())).toEqual(['present', 'present']);
  });

  test('fewer misses than the floor are judged one by one, so a movie whose only file is gone still is', async () => {
    await file(MOVIE.replace('.mkv', '.en.srt'));
    track(MOVIES, MOVIE);
    await file(EPISODE);
    const result = await check();
    expect(verdicts()).toEqual({ [MOVIE]: 'missing' });
    expect(result.roots[1]).toEqual({ libraryId: 'movies', state: 'available' });
  });

  test('a stat that hangs (a hard-mounted share gone) makes the root unreadable with no verdict; later passes skip it with no stat or page until it answers, then check it again', async () => {
    await file(EPISODE);
    await file(MOVIE);
    track(SERIES, EPISODE, GONE);
    track(MOVIES, MOVIE);
    let answer: () => void = () => {};
    const hanging = new Promise<void>((resolve) => {
      answer = resolve;
    });
    let seriesStats = 0;
    const pendingStats = new Map<string, Promise<unknown>>();
    const deps = {
      layout,
      backend,
      statTimeoutMs: 50,
      pendingStats,
      lstat: (path: string) => {
        if (!path.includes('/series/')) return Promise.resolve();
        seriesStats++;
        return hanging;
      },
    };
    const run = () => {
      const job = lease();
      return checkLibraryFiles(job, job.payload as CheckFilesPayload, deps, { signal: new AbortController().signal });
    };
    const result = await run();
    expect(result.roots).toEqual([
      { libraryId: 'series', state: 'unreadable' },
      { libraryId: 'movies', state: 'available' },
    ]);
    expect(verdicts()).toEqual({ [MOVIE]: 'present' });

    const pagesBefore = backend.calls.filter((call) => call.fn === 'fileCheckPage').length;
    expect((await run()).roots[0]).toEqual({ libraryId: 'series', state: 'unreadable' });
    expect(seriesStats).toBe(1);
    const onlyTheMoviesPage = pagesBefore + 1;
    expect(backend.calls.filter((call) => call.fn === 'fileCheckPage').length).toBe(onlyTheMoviesPage);

    answer();
    await hanging;
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(pendingStats.size).toBe(0);
    expect((await run()).roots[0]).toEqual({ libraryId: 'series', state: 'available' });
  });

  test('a dropped movies/4K/ mount of one-file folders, beside a larger local Movies root, is held back as one gone folder', async () => {
    const local = Array.from({ length: 10 }, (_, n) => `${MOVIES}/Film ${n} (2020)/Film ${n} (2020).mkv`);
    const fourK = Array.from({ length: 4 }, (_, n) => `${MOVIES}/4K/Big ${n} (2021)/Big ${n} (2021).mkv`);
    for (const path of local) await file(path);
    await mkdir(leftover4KMountPoint(), { recursive: true });
    track(MOVIES, ...local, ...fourK);
    const result = await check();
    expect(result.roots[1]).toEqual({ libraryId: 'movies', state: 'available', goneFolders: [`${MOVIES}/4K`] });
    expect(Object.values(verdicts()).every((verdict) => verdict === 'present')).toBe(true);
  });

  test('a show of two-episode seasons gone at once is held back by its show folder; a lost episode elsewhere is found', async () => {
    const others = Array.from({ length: 10 }, (_, n) => `${SERIES}/Other (2020)/Season 01/Other - S01E${String(n + 1).padStart(2, '0')}.mkv`);
    const show = [1, 2].flatMap((season) => [1, 2].map((episode) => `${SERIES}/Show (2019)/Season 0${season}/Show - S0${season}E0${episode}.mkv`));
    for (const path of others.slice(1)) await file(path);
    track(SERIES, ...others, ...show);
    const result = await check();
    expect(result.roots[0]).toEqual({ libraryId: 'series', state: 'available', goneFolders: [`${SERIES}/Show (2019)`] });
    expect(verdicts()[others[0]!]).toBe('missing');
    expect(show.some((path) => path in verdicts())).toBe(false);
  });

  test('a missing root (a share not mounted) and an empty one get no file looked at', async () => {
    await mkdir(local(MOVIES), { recursive: true });
    track(SERIES, EPISODE);
    track(MOVIES, MOVIE);
    const result = await check();
    expect(backend.fileVerdicts).toEqual([]);
    expect(backend.calls.some((call) => call.fn === 'fileCheckPage')).toBe(false);
    expect(result.roots).toEqual([
      { libraryId: 'series', state: 'missing' },
      { libraryId: 'movies', state: 'empty' },
    ]);
  });

  test('a file whose stat fails for another reason than ENOENT is left out', async () => {
    await file(EPISODE);
    track(SERIES, EPISODE);
    await chmod(join(root, 'library/series/Show (2019)'), 0o000);
    const result = await check();
    expect(backend.fileVerdicts).toEqual([]);
    expect(result).toMatchObject({ checked: 0, missing: 0 });
  });
});

describe('massMisses', () => {
  const v = (path: string, verdict: 'present' | 'missing') => ({ fileId: path as never, path, verdict });
  const none = { rootMostlyGone: false, goneFolders: [] };
  const present = Array.from({ length: 10 }, (_, n) => v(`/r/local/${n}/f`, 'present'));

  test('below the floor of misses, nothing is held back', () => {
    expect(massMisses('/r', [v('/r/a/1', 'missing'), v('/r/a/2', 'missing')])).toEqual(none);
  });

  test('three misses that are most of the root make it mostly gone', () => {
    const verdicts = [v('/r/a/1', 'missing'), v('/r/a/2', 'missing'), v('/r/b/3', 'missing'), v('/r/b/4', 'present')];
    expect(massMisses('/r', verdicts)).toEqual({ rootMostlyGone: true, goneFolders: [] });
  });

  test('three misses spread over folders that each still hold a file stay per-file', () => {
    const spread = ['/r/a', '/r/b', '/r/c'].flatMap((folder) => [v(`${folder}/1`, 'missing'), v(`${folder}/2`, 'present'), v(`${folder}/3`, 'present')]);
    expect(massMisses('/r', spread)).toEqual(none);
    expect(massMisses('/r', [...present, ...[1, 2, 3].flatMap((n) => [v(`/r/s${n}/a`, 'missing'), v(`/r/s${n}/b`, 'present')])])).toEqual(none);
  });

  test('three gone one-file folders under one parent name the parent, not each folder', () => {
    const gone = [1, 2, 3].map((n) => v(`/r/4K/${n}/f`, 'missing'));
    expect(massMisses('/r', [...present, ...gone])).toEqual({ rootMostlyGone: false, goneFolders: ['/r/4K'] });
  });
});

describe('rootState', () => {
  test('a root that is a file is missing; a folder on staging’s device with entries is available', async () => {
    await file(EPISODE);
    await writeFile(local(MOVIES), 'not a folder');
    expect(await rootState(local(SERIES), layout.staging)).toBe('available');
    expect(await rootState(local(MOVIES), layout.staging)).toBe('missing');
  });
});
