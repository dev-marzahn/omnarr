// The import handler: the download's videos are listed (RAR
// sets extracted first), the backend says which Units each holds, the
// assignment rules pick a file per expected Unit, and each file goes through
// staging/<jobId> into the library under its TRaSH name. On a real temporary
// /data tree, with a fake `resolveFiles` and a fake probe; the RAR tests run
// the real `lsar` and `unar` (skipped with a notice when they are missing).
import { copyFile, mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';

import { DEFAULT_DEVICES, type ExpectedUnit, type ImportPayload, type JobResult, type LeasedJob, type ProbeSummary, targetForDevices } from '@omnarr/contracts';
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';

import { dataLayout, type DataLayout } from '../src/fs/layout.ts';
import { type ImportDeps, importHandler } from '../src/jobs/import.ts';
import { JobFailure } from '../src/runtime/lease.ts';
import { FakeBackend } from './fakeBackend.ts';
import { MEDIA, mediaTools } from './fixtures/media/tools.ts';
import { IMPORT_PAYLOAD, MOVIE_NAMING } from './payloads.ts';

/** The WEB-DL source: H.264 1080p SDR with E-AC-3 5.1. */
const PROBE: ProbeSummary = {
  container: 'matroska',
  durationMs: 2000,
  streams: [
    {
      index: 0,
      kind: 'video',
      codec: 'h264',
      default: true,
      forced: false,
      hearingImpaired: false,
      width: 1920,
      height: 1080,
      bitDepth: 8,
      pixFmt: 'yuv420p',
      interlaced: false,
      hdr: 'sdr',
    },
    { index: 1, kind: 'audio', codec: 'eac3', channels: 6, default: true, forced: false, hearingImpaired: false },
  ],
};
const WORK = 'Show (2019) [tmdbid-123]';
const WEBDL_RELEASE = 'Show.S01E02.1080p.AMZN.WEB-DL.DDP5.1.H.264-GRP.mkv';
const WEBDL_LIBRARY_NAME = 'Show (2019) - S01E02 - Pilot [AMZN][WEBDL-1080p][EAC3 5.1][h264]-GRP.mkv';

let root: string;
let layout: DataLayout;
let backend: FakeBackend;
let probed: string[];
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'omnarr-import-'));
  layout = dataLayout(root);
  backend = new FakeBackend();
  probed = [];
});
afterEach(() => rm(root, { recursive: true, force: true }));

const handler = (deps: Partial<ImportDeps> = {}) =>
  importHandler({
    layout,
    backend,
    probe: async (path) => {
      probed.push(path);
      return PROBE;
    },
    ...deps,
  });
const ctx = { signal: new AbortController().signal, progress: () => {} };

/** A finished download under downloads/<kind>/ with these files (relative name → size). */
async function download(files: Record<string, number>, kind: 'usenet' | 'torrents' = 'usenet'): Promise<string> {
  const dir = join(kind === 'usenet' ? layout.usenetDownloads : layout.torrentDownloads, 'platform-series', 'Show.S01');
  await mkdir(dir, { recursive: true });
  for (const [name, size] of Object.entries(files)) {
    await mkdir(join(dir, name, '..'), { recursive: true });
    await writeFile(join(dir, name), Buffer.alloc(size, name.length));
  }
  return dir;
}

const workFolder = () => join(layout.series, WORK);
const season = (n = 1) => join(workFolder(), `Season ${String(n).padStart(2, '0')}`);

const toData = (local: string) => `/data/${relative(root, local)}`;
const job = (contentPath: string, expectedUnits: ExpectedUnit[], overrides: Partial<ImportPayload> = {}): LeasedJob =>
  backend.lease({ ...IMPORT_PAYLOAD, contentPath: toData(contentPath), workFolderPath: `/data/library/series/${WORK}`, expectedUnits, ...overrides }, 'job1');

const e = (episode: number, title?: string): ExpectedUnit => ({ unitId: `u${episode}` as never, season: 1, episode, ...(title ? { title } : {}) });

const filesOf = (result: JobResult) => (result.class === 'import' ? result.files : []);
const placed = (result: JobResult) => filesOf(result).map((file) => [relative(workFolder(), file.path), file.unitIds]);
const resolveRequest = () => backend.calls.find((call) => call.fn === 'resolveFiles')?.args as { files: { relPath: string; sizeBytes: number }[] } | undefined;

async function failure(promise: Promise<unknown>): Promise<JobFailure> {
  const error = await promise.catch((e: unknown) => e);
  expect(error).toBeInstanceOf(JobFailure);
  return error as JobFailure;
}

/** What is left in staging/ (which a job that failed early never made). */
const stagingLeft = () => readdir(layout.staging).catch(() => []);

/** Every entry under `dir` with its size and modification time: what "nothing written" compares. */
async function snapshot(dir: string) {
  const entries = (await readdir(dir, { recursive: true })).sort();
  return Promise.all(entries.map(async (entry) => ({ entry, ...(await stat(join(dir, entry)).then((s) => ({ size: s.size, mtimeMs: s.mtimeMs }))) })));
}

describe('import', () => {
  test('the episode is hard-linked into its Season folder under its TRaSH name, probed in staging, and staging is removed', async () => {
    const dir = await download({ [WEBDL_RELEASE]: 3000, 'Show.S01E02.nfo': 10, 'Sample/sample.mkv': 200 });
    backend.resolved = { [WEBDL_RELEASE]: ['u2'] };
    const result = await handler()(job(dir, [e(2, 'Pilot')]), ctx);

    const path = join(season(1), WEBDL_LIBRARY_NAME);
    const info = await stat(path);
    expect(result).toEqual({ class: 'import', files: [{ path, sizeBytes: 3000, inode: `${info.dev}:${info.ino}`, probe: PROBE, unitIds: ['u2'] }] });
    expect(info.nlink).toBe(2);
    expect(probed).toEqual([join(layout.staging, 'job1', '1.mkv')]);
    expect(resolveRequest()).toEqual({ jobId: 'job1', leaseEpoch: 1, files: [{ relPath: WEBDL_RELEASE, sizeBytes: 3000 }] });
    expect(await stagingLeft()).toEqual([]);
  });

  test('the library file stays whole when the download is deleted with its data after seeding', async () => {
    const dir = await download({ [WEBDL_RELEASE]: 3000 });
    backend.resolved = { [WEBDL_RELEASE]: ['u2'] };
    await handler()(job(dir, [e(2, 'Pilot')]), ctx);
    const path = join(season(1), WEBDL_LIBRARY_NAME);
    const before = await readFile(path);

    await rm(dir, { recursive: true, force: true });

    const info = await stat(path);
    expect(info.nlink).toBe(1);
    expect(info.size).toBe(3000);
    expect(await readFile(path)).toEqual(before);
  });

  test("an upgrade file that doesn't fit the target is held under staging/held/<jobId>/, never placed beside the primary", async () => {
    const dir = await download({ [WEBDL_RELEASE]: 3000 });
    backend.resolved = { [WEBDL_RELEASE]: ['u2'] };
    const result = await handler()(job(dir, [e(2, 'Pilot')], { holdUnlessFits: targetForDevices(DEFAULT_DEVICES) }), ctx);

    const held = join(layout.held, 'job1', '1.mkv');
    expect(filesOf(result)).toEqual([expect.objectContaining({ path: held, sizeBytes: 3000, unitIds: ['u2'] })]);
    expect((await stat(held)).nlink).toBe(2);
    expect(await readdir(workFolder()).catch(() => [])).toEqual([]);
    expect(await stagingLeft()).toEqual(['held']);
  });

  test('an upgrade file that fits goes into the library as any import does', async () => {
    const dir = await download({ [WEBDL_RELEASE]: 3000 });
    backend.resolved = { [WEBDL_RELEASE]: ['u2'] };
    const fitting: ProbeSummary = { ...PROBE, container: 'mp4', streams: [PROBE.streams[0]!, { ...PROBE.streams[1]!, codec: 'aac', channels: 2 }] as never };
    const result = await handler({ probe: async () => fitting })(job(dir, [e(2, 'Pilot')], { holdUnlessFits: targetForDevices(DEFAULT_DEVICES) }), ctx);
    expect(placed(result)).toEqual([[expect.stringMatching(/^Season 01\//), ['u2']]]);
    expect(await stagingLeft()).toEqual([]);
  });

  test('the listing skips samples, Jellyfin extras folders, unfinished files and non-videos', async () => {
    const dir = await download({
      'Show.S01E01.mkv': 1000,
      'Show.S01E01.sample.mkv': 100,
      'Samples/a.mkv': 100,
      'Featurettes/Making Of.mkv': 100,
      'Behind The Scenes/b.mp4': 100,
      'deleted scenes/c.mkv': 100,
      'Trailers/t.mp4': 100,
      'Other/o.mkv': 100,
      'Show.S01E02.mkv.!qB': 1000,
      'Show.S01E03.mkv.partial': 1000,
      'Show.S01E01.srt': 10,
    });
    backend.resolved = { 'Show.S01E01.mkv': ['u1'] };
    await handler()(job(dir, [e(1)]), ctx);
    expect(resolveRequest()?.files).toEqual([{ relPath: 'Show.S01E01.mkv', sizeBytes: 1000 }]);
  });

  test('a download with no video fails as noMediaFile', async () => {
    const dir = await download({ 'Show.S01E01.nfo': 10, 'readme.txt': 10 });
    expect(await failure(handler()(job(dir, [e(1)]), ctx))).toMatchObject({ code: 'noMediaFile' });
    expect(backend.count('resolveFiles')).toBe(0);
  });

  describe('assignment', () => {
    test('a season pack: each file takes the expected Units it holds', async () => {
      const dir = await download({ 'E1/Show.S01E01.mkv': 1000, 'E2/Show.S01E02.mkv': 1000 });
      backend.resolved = { 'E1/Show.S01E01.mkv': ['u1'], 'E2/Show.S01E02.mkv': ['u2'] };
      expect(placed(await handler()(job(dir, [e(1), e(2)]), ctx))).toEqual([
        ['Season 01/Show (2019) - S01E01 [AMZN][WEBDL-1080p][EAC3 5.1][h264]-GRP.mkv', ['u1']],
        ['Season 01/Show (2019) - S01E02 [AMZN][WEBDL-1080p][EAC3 5.1][h264]-GRP.mkv', ['u2']],
      ]);
    });

    test('a multi-episode file whose Units are all expected links each of them, and is named for both', async () => {
      const dir = await download({ 'Show.S01E01E02.mkv': 2000 });
      backend.resolved = { 'Show.S01E01E02.mkv': ['u1', 'u2'] };
      expect(placed(await handler()(job(dir, [e(1, 'Pilot'), e(2, 'Second')]), ctx))).toEqual([
        ['Season 01/Show (2019) - S01E01-E02 - Pilot + Second [AMZN][WEBDL-1080p][EAC3 5.1][h264]-GRP.mkv', ['u1', 'u2']],
      ]);
    });

    test('a file holding an expected Unit and one outside the Grab links only the expected one', async () => {
      const dir = await download({ 'Show.S01E01E02.mkv': 2000 });
      backend.resolved = { 'Show.S01E01E02.mkv': ['u1', 'u2'] };
      expect(placed(await handler()(job(dir, [e(1)]), ctx))).toEqual([['Season 01/Show (2019) - S01E01 [AMZN][WEBDL-1080p][EAC3 5.1][h264]-GRP.mkv', ['u1']]]);
    });

    test('a file whose Units are all outside the expected set is skipped', async () => {
      const dir = await download({ 'Show.S01E01.mkv': 1000, 'Show.S01E09.mkv': 1000 });
      backend.resolved = { 'Show.S01E01.mkv': ['u1'], 'Show.S01E09.mkv': ['u9'] };
      expect(placed(await handler()(job(dir, [e(1)]), ctx))).toEqual([['Season 01/Show (2019) - S01E01 [AMZN][WEBDL-1080p][EAC3 5.1][h264]-GRP.mkv', ['u1']]]);
      expect(probed).toHaveLength(1);
    });

    test('two files for one Unit of the same revision: the larger is taken', async () => {
      const dir = await download({ 'Show.S01E01.720p.mkv': 1000, 'Show.S01E01.1080p.mkv': 3000 });
      backend.resolved = { 'Show.S01E01.720p.mkv': ['u1'], 'Show.S01E01.1080p.mkv': ['u1'] };
      const result = await handler()(job(dir, [e(1)]), ctx);
      expect(filesOf(result).map((file) => [file.sizeBytes, file.unitIds])).toEqual([[3000, ['u1']]]);
    });

    test('two files for one Unit: the higher revision is taken, even when it is smaller', async () => {
      const dir = await download({ 'Show.S01E01.mkv': 3000, 'Show.S01E01.PROPER.mkv': 1000 });
      backend.resolved = { 'Show.S01E01.mkv': ['u1'], 'Show.S01E01.PROPER.mkv': ['u1'] };
      backend.revisions = { 'Show.S01E01.PROPER.mkv': { version: 2, real: 0 } };
      const result = await handler()(job(dir, [e(1)]), ctx);
      expect(filesOf(result).map((file) => [file.sizeBytes, file.unitIds])).toEqual([[1000, ['u1']]]);
    });

    test('one expected Unit without a file and one video that resolved to nothing: that video is taken', async () => {
      const dir = await download({ 'Show.S01E01.mkv': 1000, 'abc123.mkv': 1500 });
      backend.resolved = { 'Show.S01E01.mkv': ['u1'] };
      expect(placed(await handler()(job(dir, [e(1), e(2)]), ctx))).toEqual([
        ['Season 01/Show (2019) - S01E01 [AMZN][WEBDL-1080p][EAC3 5.1][h264]-GRP.mkv', ['u1']],
        ['Season 01/Show (2019) - S01E02 [AMZN][WEBDL-1080p][EAC3 5.1][h264]-GRP.mkv', ['u2']],
      ]);
    });

    test('an expected Unit still without a file fails as importMismatch, naming the expected Units and the files found', async () => {
      const dir = await download({ 'Show.S01E01.mkv': 1000, 'Show.S01E02.mkv': 1000 });
      backend.resolved = { 'Show.S01E01.mkv': ['u1'], 'Show.S01E02.mkv': ['u2'] };
      const error = await failure(handler()(job(dir, [e(1), e(3)]), ctx));
      expect(error.code).toBe('importMismatch');
      expect(error.detail).toBe('No file for S01E03 in the download (expected S01E01, S01E03); found: Show.S01E01.mkv, Show.S01E02.mkv.');
      expect(await readdir(workFolder()).catch(() => [])).toEqual([]);
      expect(await stagingLeft()).toEqual([]);
    });

    test("an optional Unit (a pack's other episode) the download lacks is no mismatch, and an unresolved video isn't guessed for it", async () => {
      const dir = await download({ 'Show.S01E01.mkv': 1000, 'Show.S01E02.mkv': 1000, 'abc123.mkv': 1500 });
      backend.resolved = { 'Show.S01E01.mkv': ['u1'], 'Show.S01E02.mkv': ['u2'] };
      expect(placed(await handler()(job(dir, [e(1), { ...e(2), optional: true }, { ...e(3), optional: true }]), ctx))).toEqual([
        ['Season 01/Show (2019) - S01E01 [AMZN][WEBDL-1080p][EAC3 5.1][h264]-GRP.mkv', ['u1']],
        ['Season 01/Show (2019) - S01E02 [AMZN][WEBDL-1080p][EAC3 5.1][h264]-GRP.mkv', ['u2']],
      ]);
    });

    test('the one unresolved video still goes to the one missing required Unit when an optional one is missing too', async () => {
      const dir = await download({ 'abc123.mkv': 1500 });
      backend.resolved = {};
      expect(placed(await handler()(job(dir, [e(1), { ...e(2), optional: true }]), ctx))).toEqual([
        ['Season 01/Show (2019) - S01E01 [AMZN][WEBDL-1080p][EAC3 5.1][h264]-GRP.mkv', ['u1']],
      ]);
    });

    test('a movie takes its largest video without asking the backend, named after its folder', async () => {
      const dir = await download({ 'Film.2020.1080p.BluRay.x264-GRP.mkv': 5000, 'extra.mkv': 100 });
      const movieFolder = join(layout.movies, 'Film (2020) [tmdbid-9]');
      const result = await handler()(
        job(dir, [{ unitId: 'm1' as never }], { workFolderPath: '/data/library/movies/Film (2020) [tmdbid-9]', naming: MOVIE_NAMING }),
        ctx,
      );
      expect(filesOf(result).map((file) => [file.path, file.sizeBytes, file.unitIds])).toEqual([
        [join(movieFolder, 'Film (2020) [tmdbid-9] - [Bluray-1080p][EAC3 5.1][h264]-GRP.mkv'), 5000, ['m1']],
      ]);
      expect(backend.count('resolveFiles')).toBe(0);
    });
  });

  describe('a manual grab imported as the Unit the user chose', () => {
    const UNCLEAR = '[Kaze] Show - Storm Run - 02 (1080p) [B1C2D3E4].mkv';

    test('its one video is imported as the chosen Unit without asking the backend, whatever its name says', async () => {
      const dir = await download({ [UNCLEAR]: 3000, 'Sample/sample.mkv': 200, 'Featurettes/Making Of.mkv': 100 });
      expect(placed(await handler()(job(dir, [e(2, 'Pilot')], { importAs: ['u2' as never] }), ctx))).toEqual([
        ['Season 01/Show (2019) - S01E02 - Pilot [AMZN][WEBDL-1080p][EAC3 5.1][h264]-GRP.mkv', ['u2']],
      ]);
      expect(backend.count('resolveFiles')).toBe(0);
    });

    test('several videos fail as importMismatch: omnarr cannot tell which one was wanted', async () => {
      const dir = await download({ 'Show - 02.mkv': 1000, 'Show - 03.mkv': 1000 });
      const error = await failure(handler()(job(dir, [e(2)], { importAs: ['u2' as never] }), ctx));
      expect(error.code).toBe('importMismatch');
      expect(error.detail).toBe("This release has several episodes; omnarr can't tell which one you wanted.");
      expect(await readdir(workFolder()).catch(() => [])).toEqual([]);
    });
  });

  describe('placing', () => {
    test("the Work folder's own season folder under another spelling is reused", async () => {
      await mkdir(join(workFolder(), 'Season 1'), { recursive: true });
      const dir = await download({ [WEBDL_RELEASE]: 1000 });
      backend.resolved = { [WEBDL_RELEASE]: ['u2'] };
      expect(placed(await handler()(job(dir, [e(2, 'Pilot')]), ctx))).toEqual([[`Season 1/${WEBDL_LIBRARY_NAME}`, ['u2']]]);
      expect(await readdir(workFolder())).toEqual(['Season 1']);
    });

    test('a different file already at the name stays, and the new one gets " (1)" before its extension', async () => {
      await mkdir(season(1), { recursive: true });
      await writeFile(join(season(1), WEBDL_LIBRARY_NAME), 'not ours');
      const dir = await download({ [WEBDL_RELEASE]: 1000 });
      backend.resolved = { [WEBDL_RELEASE]: ['u2'] };
      expect(placed(await handler()(job(dir, [e(2, 'Pilot')]), ctx))).toEqual([
        ['Season 01/Show (2019) - S01E02 - Pilot [AMZN][WEBDL-1080p][EAC3 5.1][h264]-GRP (1).mkv', ['u2']],
      ]);
      expect(await readFile(join(season(1), WEBDL_LIBRARY_NAME), 'utf8')).toBe('not ours');
    });

    test('a re-run finds its own hard link at the name and returns the same file', async () => {
      const dir = await download({ [WEBDL_RELEASE]: 1000 });
      backend.resolved = { [WEBDL_RELEASE]: ['u2'] };
      const first = await handler()(job(dir, [e(2, 'Pilot')]), ctx);
      expect(await handler()(job(dir, [e(2, 'Pilot')]), ctx)).toEqual(first);
      expect(await readdir(season(1))).toEqual([WEBDL_LIBRARY_NAME]);
    });

    test('across filesystems (EXDEV) the file is copied after the free-space check; the download is untouched', async () => {
      const dir = await download({ [WEBDL_RELEASE]: 1000 });
      backend.resolved = { [WEBDL_RELEASE]: ['u2'] };
      const before = await snapshot(layout.downloads);
      const exdev = async () => {
        throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
      };
      const result = await handler({ link: exdev, freeBytes: async () => 2 * 1024 ** 3 })(job(dir, [e(2, 'Pilot')]), ctx);
      const [file] = filesOf(result);
      expect((await stat(file!.path)).nlink).toBe(1);
      expect(await readFile(file!.path)).toEqual(await readFile(join(dir, WEBDL_RELEASE)));
      expect(await snapshot(layout.downloads)).toEqual(before);
      expect(await stagingLeft()).toEqual([]);
    });

    test('a copied library file stays whole when the download is deleted with its data after seeding', async () => {
      const dir = await download({ [WEBDL_RELEASE]: 1000 });
      backend.resolved = { [WEBDL_RELEASE]: ['u2'] };
      const exdev = async () => {
        throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
      };
      const [file] = filesOf(await handler({ link: exdev, freeBytes: async () => 2 * 1024 ** 3 })(job(dir, [e(2, 'Pilot')]), ctx));
      const before = await readFile(file!.path);

      await rm(dir, { recursive: true, force: true });

      expect((await stat(file!.path)).size).toBe(1000);
      expect(await readFile(file!.path)).toEqual(before);
    });

    test('a re-run of a copied import finds its earlier copy at the name instead of adding " (1)"', async () => {
      const dir = await download({ [WEBDL_RELEASE]: 1000 });
      backend.resolved = { [WEBDL_RELEASE]: ['u2'] };
      const eperm = async () => {
        throw Object.assign(new Error('not permitted'), { code: 'EPERM' });
      };
      const deps = { link: eperm, freeBytes: async () => 2 * 1024 ** 3 };
      const first = await handler(deps)(job(dir, [e(2, 'Pilot')]), ctx);
      expect(await handler(deps)(job(dir, [e(2, 'Pilot')]), ctx)).toEqual(first);
      expect(await readdir(season(1))).toEqual([WEBDL_LIBRARY_NAME]);
    });

    test('a copy without room in staging fails as diskFull and writes nothing', async () => {
      const dir = await download({ [WEBDL_RELEASE]: 1000 });
      backend.resolved = { [WEBDL_RELEASE]: ['u2'] };
      const exdev = async () => {
        throw Object.assign(new Error('cross-device link'), { code: 'EXDEV' });
      };
      const error = await failure(handler({ link: exdev, freeBytes: async () => 1024 ** 3 })(job(dir, [e(2, 'Pilot')]), ctx));
      expect(error.code).toBe('diskFull');
      expect(await stagingLeft()).toEqual([]);
      expect(await readdir(workFolder()).catch(() => [])).toEqual([]);
    });

    test('nothing is ever written under downloads/, and staging is removed after a failure too', async () => {
      const dir = await download({ 'Show.S01E01.mkv': 1000, 'Show.S01E02.mkv': 1000 });
      backend.resolved = { 'Show.S01E01.mkv': ['u1'], 'Show.S01E02.mkv': ['u2'] };
      const before = await snapshot(layout.downloads);
      await handler()(job(dir, [e(1), e(2)]), ctx);
      await failure(handler()(job(dir, [e(1), e(3)]), ctx));
      expect(await snapshot(layout.downloads)).toEqual(before);
      expect(await stagingLeft()).toEqual([]);
    });
  });
});

describe.runIf(mediaTools('lsar', 'unar'))('a torrent of RAR parts (real unar)', () => {
  /** A torrent download holding one of the fixture sets. */
  async function rarTorrent(set: string): Promise<string> {
    const dir = await download({}, 'torrents');
    for (const name of await readdir(join(MEDIA, 'rar', set))) await copyFile(join(MEDIA, 'rar', set, name), join(dir, name));
    return dir;
  }

  test('the set is extracted into staging/<jobId>/extract/ and its video imported from there; the archives stay as they were', async () => {
    const dir = await rarTorrent('rar5');
    const before = await snapshot(layout.downloads);
    backend.resolved = { 'Show.S01E02.mp4': ['u2'] };
    const result = await handler({ freeBytes: async () => 2 * 1024 ** 3 })(job(dir, [e(2, 'Pilot')]), ctx);
    expect(placed(result)).toEqual([['Season 01/Show (2019) - S01E02 - Pilot [AMZN][WEBDL-1080p][EAC3 5.1][h264]-GRP.mp4', ['u2']]]);
    expect(filesOf(result)[0]!.sizeBytes).toBe(112_323);
    expect(probed).toEqual([join(layout.staging, 'job1', 'extract', '1', 'Show.S01E02.mp4')]);
    expect(await snapshot(layout.downloads)).toEqual(before);
    expect(await stagingLeft()).toEqual([]);
  });

  test('an encrypted set fails as passwordProtected', async () => {
    const dir = await rarTorrent('encrypted');
    expect(await failure(handler({ freeBytes: async () => 2 * 1024 ** 3 })(job(dir, [e(3)]), ctx))).toMatchObject({ code: 'passwordProtected' });
    expect(await stagingLeft()).toEqual([]);
  });

  test('a set larger than staging has room for fails as diskFull before extracting', async () => {
    const dir = await rarTorrent('rar4');
    expect(await failure(handler({ freeBytes: async () => 1024 ** 3 })(job(dir, [e(1)]), ctx))).toMatchObject({ code: 'diskFull' });
    expect(await stagingLeft()).toEqual([]);
  });
});
