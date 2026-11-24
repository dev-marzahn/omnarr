// The untracked-media scan: a run
// started by the admin, read by the fake worker through the worker
// functions, matched by the backend with TMDB behind the fake, reviewed and
// imported through the public functions.
import type { LeasedJob, ProbeSummary, ScanEntry, TargetReading } from '@omnarr/contracts';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';

import { api, internal } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import { MKV_PROBE, PREPARED_PROBE, seedFile, seedShow, seedUnit } from './fakePrepare';
import { fakeWorker, type FakeWorker } from './fakeWorker';
import { asAdmin, drainPool, seedLibraries, setup, useMetadataFakes, worker, type Backend, type Libraries } from './setup';

let t: Backend;
let admin: Awaited<ReturnType<typeof asAdmin>>;
let libraries: Libraries;
let w: FakeWorker;

beforeEach(async () => {
  vi.useFakeTimers();
  t = setup();
  admin = await asAdmin(t);
  libraries = await seedLibraries(t);
  useMetadataFakes();
  w = await fakeWorker(t);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const SERIES_ROOT = '/data/library/series';
const MOVIES_ROOT = '/data/library/movies';
let inode = 1000;
const entry = (path: string, sizeBytes = 1_000_000_000): ScanEntry => ({ path, sizeBytes, inode: `2049:${inode++}` });

const startScan = async () => (await admin.mutation(api.api.scan.start, { trigger: 'manual' })).scanRunId;
const claimScan = async (): Promise<LeasedJob> => {
  const pastAnEarlierReadsQueuedFileCheck = 5;
  const job = (await w.claim('maintenance', pastAnEarlierReadsQueuedFileCheck)).find(
    (leased) => leased.payload.class === 'maintenance' && leased.payload.action === 'scanLibrary',
  );
  if (job?.payload.class !== 'maintenance' || job.payload.action !== 'scanLibrary') throw new Error('no scan job');
  return job;
};
const reportBatch = (job: LeasedJob, entries: ScanEntry[]) =>
  t.mutation(api.scan.report.reportBatch, { ...worker, jobId: job.jobId, leaseEpoch: job.leaseEpoch, scanRunId: scanRunOf(job), entries });
const recordProbes = (job: LeasedJob, probes: (ScanEntry & { probe?: ProbeSummary })[]) =>
  t.mutation(api.scan.report.recordProbes, { ...worker, jobId: job.jobId, leaseEpoch: job.leaseEpoch, scanRunId: scanRunOf(job), probes });
const scanRunOf = (job: LeasedJob) => {
  if (job.payload.class !== 'maintenance' || job.payload.action !== 'scanLibrary') throw new Error('no scan job');
  return job.payload.scanRunId;
};
const items = (scanRunId: Id<'scanRuns'>) =>
  t.run((ctx) =>
    ctx.db
      .query('scanItems')
      .withIndex('by_run_folder', (q) => q.eq('scanRunId', scanRunId))
      .collect(),
  );

describe('scan.start', () => {
  test('inserts a reading run and enqueues the worker read of both library roots, with the ignored folders', async () => {
    await admin.mutation(api.api.scan.ignoreFolder, { libraryId: libraries.series, folder: 'Home Videos' });
    const scanRunId = await startScan();
    const status = await admin.query(api.api.scan.status, {});
    expect(status.run).toMatchObject({ scanRunId, trigger: 'manual', state: 'reading', hasDecisions: false });
    const job = await claimScan();
    expect(job.payload).toEqual({
      class: 'maintenance',
      action: 'scanLibrary',
      scanRunId,
      roots: [
        { libraryId: libraries.series, path: SERIES_ROOT },
        { libraryId: libraries.movies, path: MOVIES_ROOT },
      ],
      ignores: [`${SERIES_ROOT}/Home Videos`],
    });
  });

  test('refuses while a run is reading or matching', async () => {
    await startScan();
    await expect(startScan()).rejects.toThrow(/scanRunning/);
  });

  test("deletes the previous run's items", async () => {
    const first = await startScan();
    const job = await claimScan();
    await recordProbes(job, [{ ...entry(`${SERIES_ROOT}/Old Show (2015)/Season 1/Old Show - S01E01 - Pilot.mkv`), probe: MKV_PROBE }]);
    await w.complete(job, { class: 'maintenance', action: 'scanLibrary', found: 1, untracked: 1 });
    await drainPool(t);
    expect(await items(first)).toHaveLength(1);
    await startScan();
    await drainPool(t);
    expect(await items(first)).toEqual([]);
  });

  test('the admin can still start a scan after a drain moved the clock a year on', async () => {
    // A drain moves the fake clock with real time (see asAdmin): on a slow
    // host by hours. The admin's session must not count that time.
    vi.advanceTimersByTime(365 * 86_400_000);
    await startScan();
  });

  test('only an admin can start a scan; a worker is refused', async () => {
    await expect(t.mutation(api.api.scan.start, { trigger: 'manual' })).rejects.toThrow();
  });
});

describe('scan.reportBatch and scan.recordProbes', () => {
  test('a batch answers the paths no files row holds, by path or by inode', async () => {
    const workId = await seedShow(t, libraries);
    const unitId = await seedUnit(t, workId, 1, 'Pilot');
    const { fileId } = await seedFile(t, { unitIds: [unitId], inode: '2049:7' });
    const tracked = await t.run(async (ctx) => (await ctx.db.get(fileId))!.path);
    await startScan();
    const job = await claimScan();
    const fresh = entry(`${SERIES_ROOT}/Old Show (2015)/Season 1/Old Show - S01E01 - Pilot.mkv`);
    const hardLinked = { path: `${SERIES_ROOT}/Show/Show.S01E01.mkv`, sizeBytes: 1, inode: '2049:7' };
    expect(await reportBatch(job, [entry(tracked), hardLinked, fresh])).toEqual([fresh.path]);
  });

  test('records each probed file under its library and Work folder; an unreadable one is unmatched', async () => {
    const scanRunId = await startScan();
    const job = await claimScan();
    await recordProbes(job, [
      { ...entry(`${SERIES_ROOT}/Old Show (2015)/Season 1/Old Show - S01E01 - Pilot.mkv`), probe: MKV_PROBE },
      entry(`${MOVIES_ROOT}/Some Film (2019)/Some Film (2019).mp4`),
      { ...entry(`${MOVIES_ROOT}/Loose.mp4`), probe: PREPARED_PROBE },
    ]);
    // A re-sent batch (a re-claimed job) doesn't add rows.
    await recordProbes(job, [{ ...entry(`${SERIES_ROOT}/Old Show (2015)/Season 1/Old Show - S01E01 - Pilot.mkv`), probe: MKV_PROBE }]);
    const rows = (await items(scanRunId)).map(({ libraryId, folder, status, unmatchedReason }) => ({ libraryId, folder, status, unmatchedReason }));
    expect(rows).toEqual(
      expect.arrayContaining([
        { libraryId: libraries.series, folder: 'Old Show (2015)', status: 'unmatched', unmatchedReason: undefined },
        { libraryId: libraries.movies, folder: 'Some Film (2019)', status: 'unmatched', unmatchedReason: 'unreadable' },
        { libraryId: libraries.movies, folder: '', status: 'unmatched', unmatchedReason: undefined },
      ]),
    );
    expect(rows).toHaveLength(3);
  });

  test('a stale lease is refused', async () => {
    await startScan();
    const job = await claimScan();
    await expect(reportBatch({ ...job, leaseEpoch: job.leaseEpoch + 1 }, [])).rejects.toThrow(/staleLease/);
    await expect(recordProbes({ ...job, leaseEpoch: job.leaseEpoch + 1 }, [])).rejects.toThrow(/staleLease/);
  });
});

// ── Matching, review and import ──────────────────────────────────────────

type ScanFile = { path: string; probe?: ProbeSummary; sizeBytes?: number };

/** A whole scan as the worker runs it over these untracked files, then the match step to its end. */
async function scan(files: ScanFile[]): Promise<Id<'scanRuns'>> {
  const scanRunId = await startScan();
  const job = await claimScan();
  const entries = files.map((file) => ({ ...entry(file.path, file.sizeBytes), probe: file.probe ?? MKV_PROBE }));
  const untracked = new Set(
    await reportBatch(
      job,
      entries.map(({ path, sizeBytes, inode }) => ({ path, sizeBytes, inode })),
    ),
  );
  await recordProbes(
    job,
    entries.filter((e) => untracked.has(e.path)),
  );
  await w.complete(job, { class: 'maintenance', action: 'scanLibrary', found: files.length, untracked: untracked.size });
  await drainPool(t);
  return scanRunId;
}

const OLD_SHOW = `${SERIES_ROOT}/Old Show (2015)`;
/** A Sonarr folder: S01E01–S01E24 of Old Show, every other one already fitting. */
const oldShowFiles = (count = 24): ScanFile[] =>
  Array.from({ length: count }, (_, i) => {
    const n = String(i + 1).padStart(2, '0');
    const title = i === 0 ? 'Pilot' : i === 1 ? 'Second' : `Episode ${i + 1}`;
    return { path: `${OLD_SHOW}/Season 1/Old Show - S01E${n} - ${title}.mkv`, probe: i % 2 === 0 ? MKV_PROBE : PREPARED_PROBE };
  });

const folderOf = (scanRunId: Id<'scanRuns'>, libraryId: Id<'libraries'>, folder: string) => admin.query(api.api.scan.folder, { scanRunId, libraryId, folder });

const subscribe = async (tmdbId: string, kind: 'series' | 'movie' = 'series') =>
  (
    await admin.action(api.api.library.subscribe, {
      tmdbId,
      kind,
      libraryId: kind === 'series' ? libraries.series : libraries.movies,
      releaseProfileId: libraries.releaseProfileId,
      seasons: kind === 'series' ? [1] : [],
    })
  ).workId;

const unitAt = (workId: Id<'works'>, season: number, episode: number) =>
  t.run(
    async (ctx) =>
      (await ctx.db
        .query('units')
        .withIndex('by_work_tmdb', (q) => q.eq('workId', workId).eq('tmdbSeason', season).eq('tmdbEpisode', episode))
        .unique())!._id,
  );

/** TVDB rows as XEM's would be: TVDB S01E<from> is TMDB S<season>E<to>. */
const tvdbRows = (workId: Id<'works'>, rows: [tvdbEpisode: number, season: number, episode: number][]) =>
  t.run(async (ctx) => {
    for (const [tvdbEpisode, season, episode] of rows) {
      const unit = await ctx.db
        .query('units')
        .withIndex('by_work_tmdb', (q) => q.eq('workId', workId).eq('tmdbSeason', season).eq('tmdbEpisode', episode))
        .unique();
      await ctx.db.insert('unitMappings', { unitId: unit!._id, workId, ordering: 'tvdb', season: 1, episode: tvdbEpisode, source: 'xem' });
    }
  });

describe('the match step', () => {
  test('a folder that is the single TMDB result with its exact title and year matches a new title, read with TMDB numbers', async () => {
    const scanRunId = await scan(oldShowFiles());
    const group = (await folderOf(scanRunId, libraries.series, 'Old Show (2015)'))!;
    expect(group.match).toEqual({ tmdbId: '900008', kind: 'series', title: 'Old Show', year: 2015, ordering: 'tmdb', readAs: 'sonarr' });
    expect(group.counts).toMatchObject({ files: 24, matched: 24, notFit: 12 });
    expect(group.files[0]).toMatchObject({ status: 'matched', units: [{ season: 1, episode: 1, title: 'Pilot' }], fits: false, step: 'remux' });
    expect(group.files[1]).toMatchObject({ units: [{ season: 1, episode: 2, title: 'Second' }], fits: true, step: 'none' });
    const status = await admin.query(api.api.scan.status, {});
    expect(status.run).toMatchObject({ state: 'ready', counts: { read: 24, tracked: 0, matched: 24, unmatched: 0 } });
    expect(status.untracked).toBe(24);
  });

  test('a folder without a year has no Work, and offers TMDB’s results as suggestions', async () => {
    const scanRunId = await scan([{ path: `${SERIES_ROOT}/Old Show/Season 1/Old Show - S01E01.mkv` }]);
    const group = (await folderOf(scanRunId, libraries.series, 'Old Show'))!;
    expect(group).toMatchObject({ reason: 'noWork', counts: { unmatched: 1 } });
    expect(group.suggestions).toEqual([{ tmdbId: '900008', kind: 'series', title: 'Old Show', year: 2015 }]);
  });

  test('ID tags look up the library, then TMDB: tmdbid, a TVDB tag and an IMDb tag through /find', async () => {
    const harbour = await subscribe('900001');
    const scanRunId = await scan([
      { path: `${SERIES_ROOT}/Elsewhere [tmdbid-900001]/Season 01/x.S01E02.mkv` },
      { path: `${SERIES_ROOT}/Signal {tvdb-7700003}/Season 01/x.S01E02.mkv` },
      { path: `${SERIES_ROOT}/Show [imdbid-tt9900008]/Season 01/x.S01E02.mkv` },
    ]);
    expect((await folderOf(scanRunId, libraries.series, 'Elsewhere [tmdbid-900001]'))!.match).toMatchObject({ workId: harbour, readAs: 'jellyfin' });
    expect((await folderOf(scanRunId, libraries.series, 'Signal {tvdb-7700003}'))!.match).toMatchObject({
      tmdbId: '900003',
      title: 'Northbound Signal',
      readAs: 'sonarr',
    });
    expect((await folderOf(scanRunId, libraries.series, 'Show [imdbid-tt9900008]'))!.match).toMatchObject({ tmdbId: '900008' });
  });

  test("a Work in the library: TMDB numbers, else TVDB's when only they place every file", async () => {
    const harbour = await subscribe('900001');
    // TVDB numbers TMDB's S02E01 and S02E02 as S01E07 and S01E08; TMDB's season 1 has 6.
    await tvdbRows(harbour, [
      [7, 2, 1],
      [8, 2, 2],
    ]);
    const scanRunId = await scan([
      { path: `${SERIES_ROOT}/Harbour Lights (2021)/Season 1/Harbour Lights - S01E01.mkv` },
      { path: `${SERIES_ROOT}/Harbour Lights [tvdbid-7700001]/Season 1/Harbour Lights - S01E07.mkv` },
      { path: `${SERIES_ROOT}/Harbour Lights [tvdbid-7700001]/Season 1/Harbour Lights - S01E08.mkv` },
    ]);
    const tmdb = (await folderOf(scanRunId, libraries.series, 'Harbour Lights (2021)'))!;
    expect(tmdb.match).toMatchObject({ workId: harbour, ordering: 'tmdb' });
    expect(tmdb.files[0]!.units).toEqual([{ season: 1, episode: 1, title: 'Episode 1' }]);
    const tvdb = (await folderOf(scanRunId, libraries.series, 'Harbour Lights [tvdbid-7700001]'))!;
    expect(tvdb.match).toMatchObject({ workId: harbour, ordering: 'tvdb' });
    expect(tvdb.files.map((f) => f.units)).toEqual([[{ season: 2, episode: 1, title: 'Episode 1' }], [{ season: 2, episode: 2, title: 'Episode 2' }]]);
  });

  test('two numberings that place every file on different Units make the folder ambiguous; the numbering choice settles it', async () => {
    const harbour = await subscribe('900001');
    // A TVDB S01E01 and S01E02 that are TMDB's S02E01 and S02E02.
    await tvdbRows(harbour, [
      [1, 2, 1],
      [2, 2, 2],
    ]);
    const folder = 'Harbour Lights (2021)';
    const scanRunId = await scan([1, 2].map((n) => ({ path: `${SERIES_ROOT}/${folder}/Season 1/Harbour Lights - S01E0${n}.mkv` })));
    expect(await folderOf(scanRunId, libraries.series, folder)).toMatchObject({ reason: 'ambiguous', counts: { unmatched: 2, matched: 0 } });

    await admin.mutation(api.api.scan.setNumbering, { scanRunId, libraryId: libraries.series, folder, ordering: 'tvdb' });
    const group = (await folderOf(scanRunId, libraries.series, folder))!;
    expect(group.match?.ordering).toBe('tvdb');
    expect(group.files.map((f) => [f.status, f.units[0]?.season, f.units[0]?.episode])).toEqual([
      ['matched', 2, 1],
      ['matched', 2, 2],
    ]);
    expect((await admin.query(api.api.scan.status, {})).run).toMatchObject({ hasDecisions: true, counts: { matched: 2, unmatched: 0 } });
  });

  test('a file for a Unit that already has a primary is a conflict', async () => {
    const harbour = await subscribe('900001');
    await seedFile(t, { unitIds: [await unitAt(harbour, 1, 1)], path: `${SERIES_ROOT}/Harbour Lights (2021) [tmdbid-900001]/Season 01/hl.mkv` });
    const folder = 'Harbour Lights (2021)';
    const scanRunId = await scan([1, 2].map((n) => ({ path: `${SERIES_ROOT}/${folder}/Season 1/Harbour Lights - S01E0${n}.mkv` })));
    const group = (await folderOf(scanRunId, libraries.series, folder))!;
    expect(group.files.map((f) => [f.relPath.split('/').at(-1), f.status])).toEqual([
      ['Harbour Lights - S01E02.mkv', 'matched'],
      ['Harbour Lights - S01E01.mkv', 'conflict'],
    ]);
  });

  test("a movie folder's largest video is the film; the other videos are unmatched", async () => {
    const folder = 'The Quiet Orchard (2020)';
    const scanRunId = await scan([
      { path: `${MOVIES_ROOT}/${folder}/The Quiet Orchard (2020).mkv`, sizeBytes: 20_000_000_000 },
      { path: `${MOVIES_ROOT}/${folder}/making-of.mkv`, sizeBytes: 500_000_000 },
    ]);
    const group = (await folderOf(scanRunId, libraries.movies, folder))!;
    expect(group.match).toMatchObject({ tmdbId: '900101', kind: 'movie', readAs: 'radarr' });
    expect(group.files.map((f) => [f.relPath, f.status, f.unmatchedReason])).toEqual([
      [`${folder}/The Quiet Orchard (2020).mkv`, 'matched', undefined],
      [`${folder}/making-of.mkv`, 'unmatched', 'unitNotFound'],
    ]);
  });

  test('a file without numbers in a matched folder is unmatched, and a loose file has no Work', async () => {
    const scanRunId = await scan([...oldShowFiles(1), { path: `${OLD_SHOW}/Season 1/bonus.mkv` }, { path: `${SERIES_ROOT}/loose.mkv` }]);
    const group = (await folderOf(scanRunId, libraries.series, 'Old Show (2015)'))!;
    expect(group.files.map((f) => [f.status, f.unmatchedReason])).toEqual([
      ['matched', undefined],
      ['unmatched', 'noNumbers'],
    ]);
    expect(await folderOf(scanRunId, libraries.series, '')).toMatchObject({ reason: 'noWork' });
  });

  test('more folders than one invocation handles are matched over several, and the review lists them', async () => {
    const files = Array.from({ length: 23 }, (_, i) => ({ path: `${SERIES_ROOT}/Folder ${String(i).padStart(2, '0')}/x.S01E01.mkv` }));
    const scanRunId = await scan(files);
    expect((await admin.query(api.api.scan.status, {})).run).toMatchObject({ state: 'ready', counts: { unmatched: 23 } });
    expect((await admin.query(api.api.scan.groups, { scanRunId, tab: 'unmatched', cursor: null })).groups).toHaveLength(23);
    expect((await admin.query(api.api.scan.groups, { scanRunId, tab: 'matched', cursor: null })).groups).toEqual([]);
  });
});

describe('the review', () => {
  test('match by hand: a title, then a season and episode per file; files left out stay unmatched', async () => {
    const folder = 'rips';
    const scanRunId = await scan([{ path: `${SERIES_ROOT}/${folder}/disc1_t03.mkv` }, { path: `${SERIES_ROOT}/${folder}/disc1_t04.mkv` }]);
    const [first, second] = (await folderOf(scanRunId, libraries.series, folder))!.files;
    await admin.mutation(api.api.scan.matchFolder, {
      scanRunId,
      libraryId: libraries.series,
      folder,
      title: { tmdbId: '900008', kind: 'series', title: 'Old Show', year: 2015 },
      files: [{ scanItemId: first!.scanItemId, season: 1, episode: 5 }],
    });
    const group = (await folderOf(scanRunId, libraries.series, folder))!;
    expect(group.match).toMatchObject({ tmdbId: '900008', ordering: 'manual' });
    expect(group.files.find((f) => f.scanItemId === first!.scanItemId)).toMatchObject({ status: 'matched', units: [{ season: 1, episode: 5 }] });
    expect(group.files.find((f) => f.scanItemId === second!.scanItemId)).toMatchObject({ status: 'unmatched' });
    expect((await admin.query(api.api.scan.status, {})).run?.hasDecisions).toBe(true);
  });

  test('match by hand with only a title reads the folder again against it', async () => {
    const folder = 'Old Show';
    const scanRunId = await scan([{ path: `${SERIES_ROOT}/${folder}/Season 1/Old Show - S01E03.mkv` }]);
    await admin.mutation(api.api.scan.matchFolder, {
      scanRunId,
      libraryId: libraries.series,
      folder,
      title: { tmdbId: '900008', kind: 'series', title: 'Old Show', year: 2015 },
    });
    await drainPool(t);
    expect((await folderOf(scanRunId, libraries.series, folder))!.files[0]).toMatchObject({ status: 'matched', units: [{ season: 1, episode: 3 }] });
  });

  test('ignoring a folder marks its files ignored now and skips it in later scans; unignoring reads it again', async () => {
    const scanRunId = await scan(oldShowFiles(2));
    await admin.mutation(api.api.scan.ignoreFolder, { scanRunId, libraryId: libraries.series, folder: 'Old Show (2015)' });
    expect((await folderOf(scanRunId, libraries.series, 'Old Show (2015)'))!.counts).toMatchObject({ ignored: 2, matched: 0 });
    expect((await admin.query(api.api.scan.status, {})).run?.counts).toMatchObject({ ignored: 2, matched: 0 });
    expect(await admin.query(api.api.scan.ignored, {})).toEqual([{ libraryId: libraries.series, folder: 'Old Show (2015)', path: OLD_SHOW }]);
    await startScan();
    expect((await claimScan()).payload).toMatchObject({ ignores: [OLD_SHOW] });
    await admin.mutation(api.api.scan.unignoreFolder, { libraryId: libraries.series, folder: 'Old Show (2015)' });
    expect(await admin.query(api.api.scan.ignored, {})).toEqual([]);
  });
});

describe('scan.import', () => {
  const importOldShow = (scanRunId: Id<'scanRuns'>, monitor: boolean) =>
    admin.action(api.api.scan.import, {
      scanRunId,
      folders: [{ libraryId: libraries.series, folder: 'Old Show (2015)' }],
      releaseProfileId: libraries.releaseProfileId,
      monitor,
    });

  test('tracked, not monitored: the Work keeps the folder, each file is recorded where it is, one publish, nothing prepared or searched', async () => {
    const scanRunId = await scan(oldShowFiles());
    expect(await importOldShow(scanRunId, false)).toEqual({ imported: 24, works: 1, failed: [] });
    await drainPool(t);

    const { work, files, versions, jobs, searches } = await t.run(async (ctx) => ({
      work: (await ctx.db.query('works').collect())[0]!,
      files: await ctx.db.query('files').collect(),
      versions: await ctx.db.query('fileVersions').collect(),
      jobs: await ctx.db.query('jobs').collect(),
      searches: await ctx.db.query('searchAttempts').collect(),
    }));
    expect(work).toMatchObject({ title: 'Old Show', folder: 'Old Show (2015)', monitorNewUnits: false, releaseProfileId: libraries.releaseProfileId });
    expect(files).toHaveLength(24);
    expect(files.every((f) => f.origin === 'scan' && f.role === 'source' && f.keepsName === true && f.path.startsWith(`${OLD_SHOW}/Season 1/`))).toBe(true);
    expect(versions.filter((v) => v.kind === 'primary' && !v.fits)).toHaveLength(12);
    expect(jobs.filter((j) => j.class === 'publish')).toHaveLength(1);
    expect(jobs.filter((j) => j.class === 'prepare')).toEqual([]);
    expect(searches).toEqual([]);

    await w.publishAll();
    const detail = (await admin.query(api.api.library.detail, { workId: work._id }))!;
    expect(detail.units.every((u) => !u.monitored)).toBe(true);
    const states = Object.fromEntries(detail.units.map((u) => [`${u.tmdbSeason}x${u.tmdbEpisode}`, u.state]));
    expect(states).toMatchObject({ '1x1': 'notInTargetFormat', '1x2': 'ready', '1x25': 'notMonitored' });
    expect((await admin.query(api.api.scan.status, {})).run?.counts).toMatchObject({ imported: 24, matched: 0 });
  });

  test('monitored: the aired Units are monitored and only the two without a file are searched', async () => {
    const scanRunId = await scan(oldShowFiles());
    await importOldShow(scanRunId, true);
    const searched = await t.run(async (ctx) => {
      const attempts = await ctx.db.query('searchAttempts').collect();
      return Promise.all(attempts.flatMap((s) => s.unitIds).map(async (id) => (await ctx.db.get(id))!.tmdbEpisode!));
    });
    expect(searched.sort((a, b) => a - b)).toEqual([25, 26]);
    expect(await t.run(async (ctx) => (await ctx.db.query('works').collect())[0]!.monitorNewUnits)).toBe(true);
  });

  test('a failed preparation of an unmonitored scanned file: the Issue is open, the Unit still shows its file, and Prepare now retries', async () => {
    const scanRunId = await scan(oldShowFiles(1));
    await importOldShow(scanRunId, false);
    await w.publishAll();
    const work = await t.run(async (ctx) => (await ctx.db.query('works').collect())[0]!);
    const unitId = await unitAt(work._id, 1, 1);
    expect(await admin.mutation(api.api.units.prepareNow, { unitId })).toEqual({ queued: 1 });
    for (let attempt = 0; attempt < 2; attempt++) {
      const [job] = await w.claim('prepare');
      await w.fail(job!, 'transcodeFailed', 'Output check failed: its duration is 4 s, the source’s 8 s.');
      if (attempt === 0) await t.mutation(internal.jobs.queue.wake, { jobId: job!.jobId });
    }
    const issues = await t.run((ctx) => ctx.db.query('issues').collect());
    expect(issues.map((issue) => [issue.unitId, issue.failureCode, issue.state])).toEqual([[unitId, 'transcodeFailed', 'open']]);
    const row = (await admin.query(api.api.library.detail, { workId: work._id }))!.units.find((u) => u.unitId === unitId)!;
    expect(row).toMatchObject({ monitored: false, state: 'notInTargetFormat', openIssue: { failureCode: 'transcodeFailed' } });
    const timeline = await admin.query(api.api.units.timeline, { unitId });
    expect(JSON.stringify(timeline)).toContain('transcodeFailed');
    // "Retry preparation" is reachable: Prepare now queues a retry.
    expect(await admin.mutation(api.api.units.prepareNow, { unitId })).toEqual({ queued: 1 });
  });

  test('a file an import recorded meanwhile is not added twice', async () => {
    const scanRunId = await scan(oldShowFiles(2));
    const group = (await folderOf(scanRunId, libraries.series, 'Old Show (2015)'))!;
    await t.run((ctx) => ctx.db.insert('files', { path: group.files[0]!.path, sizeBytes: 1, inode: '9:9', origin: 'download', role: 'source' }));
    expect(await importOldShow(scanRunId, false)).toMatchObject({ imported: 1 });
    expect(await t.run(async (ctx) => (await ctx.db.query('files').collect()).length)).toBe(2);
  });

  describe('files Jellyfin would misread are moved to library naming', () => {
    const STAR = `${SERIES_ROOT}/Star Lantern (2022)`;
    const HOLIDAY = 'Holiday Footage 2019';
    /** Old Show's Sonarr folder, Star Lantern's absolute-numbered files, and a clip matched by hand to Old Show S01E25. */
    async function mixedScan() {
      const scanRunId = await scan([
        ...oldShowFiles(2),
        { path: `${STAR}/Star Lantern - 013.mkv` },
        { path: `${STAR}/Star Lantern - 014.mkv` },
        { path: `${SERIES_ROOT}/${HOLIDAY}/clip_0001.mp4`, probe: PREPARED_PROBE },
      ]);
      const [clip] = (await folderOf(scanRunId, libraries.series, HOLIDAY))!.files;
      await admin.mutation(api.api.scan.matchFolder, {
        scanRunId,
        libraryId: libraries.series,
        folder: HOLIDAY,
        title: { tmdbId: '900008', kind: 'series', title: 'Old Show', year: 2015 },
        files: [{ scanItemId: clip!.scanItemId, season: 1, episode: 25 }],
      });
      return scanRunId;
    }
    // The hand-matched folder comes first in the request: the import still lets Old Show's own folder name the Work.
    const importAll = (scanRunId: Id<'scanRuns'>) =>
      admin.action(api.api.scan.import, {
        scanRunId,
        folders: [HOLIDAY, 'Old Show (2015)', 'Star Lantern (2022)'].map((folder) => ({ libraryId: libraries.series, folder })),
        releaseProfileId: libraries.releaseProfileId,
        monitor: false,
      });
    const state = () =>
      t.run(async (ctx) => ({
        works: await ctx.db.query('works').collect(),
        files: await ctx.db.query('files').collect(),
        publications: await ctx.db.query('publications').collect(),
        jobs: await ctx.db.query('jobs').collect(),
      }));

    test('Sonarr-named files keep their path; unrecognised, absolute-numbered and hand-matched ones get a move into their Work folder', async () => {
      const scanRunId = await mixedScan();
      expect((await folderOf(scanRunId, libraries.series, 'Star Lantern (2022)'))!.match).toMatchObject({ ordering: 'absolute', readAs: 'unknown' });
      expect(await importAll(scanRunId)).toEqual({ imported: 5, works: 2, failed: [] });

      const { works, files, publications, jobs } = await state();
      const oldShow = works.find((w) => w.title === 'Old Show')!;
      const star = works.find((w) => w.title === 'Star Lantern')!;
      // A folder whose files move doesn't name the Work: its Work gets the library's folder name.
      expect([oldShow.folder, star.folder]).toEqual(['Old Show (2015)', 'Star Lantern (2022) [tmdbid-900002]']);

      const kept = files.filter((f) => f.path.startsWith(`${OLD_SHOW}/`));
      expect(kept.map((f) => f.keepsName)).toEqual([true, true]);
      const publishes = jobs.filter((j) => j.class === 'publish');
      expect(publishes.map((j) => j.payload?.class === 'publish' && j.payload.items.map((i) => i.path).sort())).toEqual([kept.map((f) => f.path).sort()]);

      const moves = jobs.flatMap((j) => (j.payload?.class === 'maintenance' && j.payload.action === 'moveLibraryFile' ? [j.payload] : []));
      moves.sort((a, b) => a.from.localeCompare(b.from));
      expect(moves.map((m) => [m.from, m.workFolderPath, m.units.map((u) => [u.season, u.episode])])).toEqual([
        [`${SERIES_ROOT}/${HOLIDAY}/clip_0001.mp4`, OLD_SHOW, [[1, 25]]],
        [`${STAR}/Star Lantern - 013.mkv`, `${SERIES_ROOT}/Star Lantern (2022) [tmdbid-900002]`, [[2, 1]]],
        [`${STAR}/Star Lantern - 014.mkv`, `${SERIES_ROOT}/Star Lantern (2022) [tmdbid-900002]`, [[2, 2]]],
      ]);
      expect(moves.find((m) => m.from.endsWith('clip_0001.mp4'))).toMatchObject({
        naming: { kind: 'series', title: 'Old Show', year: 2015 },
        probe: PREPARED_PROBE,
        inode: files.find((f) => f.path.endsWith('clip_0001.mp4'))!.inode,
      });
      // The moved files' Publications wait for the move: pending, with no publish job yet.
      const moved = files.filter((f) => moves.some((m) => m.fileId === f._id));
      const versions = await t.run((ctx) => ctx.db.query('fileVersions').collect());
      const waiting = publications.filter((p) => moved.some((f) => versions.find((v) => v._id === p.fileVersionId)?.fileId === f._id));
      expect(waiting.map((p) => [p.state, p.jobId])).toEqual([
        ['pending', undefined],
        ['pending', undefined],
        ['pending', undefined],
      ]);
    });

    test("a finished move records the file's library path, and its Publication is published from the Work folder", async () => {
      await importAll(await mixedScan());
      const NEW = `${OLD_SHOW}/Season 1/Old Show (2015) - S01E25 - Episode 25.mp4`;
      const jobs = await w.claim('maintenance');
      const move = jobs.find((j) => j.payload.class === 'maintenance' && j.payload.action === 'moveLibraryFile' && j.payload.from.endsWith('clip_0001.mp4'))!;
      const sidecar = { path: NEW.replace(/\.mp4$/, '.en.srt'), language: 'en' as const, forced: false, sdh: false, format: 'srt' as const };
      await w.complete(move, { class: 'maintenance', action: 'moveLibraryFile', path: NEW, sidecars: [sidecar] });

      const { files, jobs: all } = await state();
      const clip = files.find((f) => f.path === NEW)!;
      // Now library-named: later title changes rename it and its sidecars.
      expect([clip.origin, clip.keepsName, clip.sidecars]).toEqual(['scan', undefined, [sidecar]]);
      const publish = all.find((j) => j.payload?.class === 'publish' && j.payload.items.some((i) => i.path === NEW))!;
      expect(publish.payload).toMatchObject({ workFolderPath: OLD_SHOW, items: [{ path: NEW }] });

      await w.publishAll();
      const oldShow = (await state()).works.find((w) => w.title === 'Old Show')!;
      const unitId = await unitAt(oldShow._id, 1, 25);
      const row = (await admin.query(api.api.library.detail, { workId: oldShow._id }))!.units.find((u) => u.unitId === unitId)!;
      expect(row).toMatchObject({ monitored: false, state: 'ready' });
    });

    test("a Sonarr folder outside its Work's folder moves into it at import: one Work, one folder", async () => {
      const workId = await subscribe('900008');
      await t.run((ctx) => ctx.db.patch(workId, { folder: 'Old Show (2015) [tmdbid-900008]' }));
      const scanRunId = await scan(oldShowFiles(2));
      // The panel knows the Work's folder, so it can say the files are renamed.
      expect((await folderOf(scanRunId, libraries.series, 'Old Show (2015)'))!.match).toMatchObject({
        readAs: 'sonarr',
        workFolder: 'Old Show (2015) [tmdbid-900008]',
      });
      expect(await importOldShow(scanRunId, false)).toEqual({ imported: 2, works: 0, failed: [] });
      const { works, jobs } = await state();
      expect(works.map((w) => w.folder)).toEqual(['Old Show (2015) [tmdbid-900008]']);
      expect(jobs.filter((j) => j.class === 'publish')).toEqual([]);
      const moves = jobs.flatMap((j) => (j.payload?.class === 'maintenance' && j.payload.action === 'moveLibraryFile' ? [j.payload] : []));
      expect(moves.map((m) => m.workFolderPath)).toEqual([`${SERIES_ROOT}/Old Show (2015) [tmdbid-900008]`, `${SERIES_ROOT}/Old Show (2015) [tmdbid-900008]`]);
    });

    test("a kept file Jellyfin numbers wrong: the Issue's fix moves it to library naming, and Jellyfin's right reading resolves it", async () => {
      const workId = await subscribe('900008');
      const scanRunId = await scan(oldShowFiles(1));
      await importOldShow(scanRunId, false);
      const [publish] = await w.claim('publish');
      const ids = publish!.payload.class === 'publish' ? publish!.payload.publicationIds : [];
      expect(publish!.payload).toMatchObject({ workFolderPath: OLD_SHOW });
      const reading = (r: TargetReading) => Object.fromEntries(ids.map((id) => [id, r]));
      await w.complete(publish!, {
        class: 'publish',
        targetItemRefs: Object.fromEntries(ids.map((id) => [id, 'jf-0'])),
        readings: reading({ kind: 'episode', season: 1, episode: 13 }),
      });
      const unitId = await unitAt(workId, 1, 1);
      const [issue] = await t.run((ctx) => ctx.db.query('issues').collect());
      expect(issue).toMatchObject({ unitId, failureCode: 'jellyfinMisread', state: 'open' });

      // The fix action issues.act runs.
      expect(await t.mutation(internal.library.naming.moveUnitToLibraryNaming, { unitId })).toEqual({ queued: 1 });
      const [move] = (await w.claim('maintenance')).filter((j) => j.payload.class === 'maintenance' && j.payload.action === 'moveLibraryFile');
      expect(move!.payload).toMatchObject({ workFolderPath: OLD_SHOW });
      const NEW = `${OLD_SHOW}/Season 1/Old Show (2015) - S01E01 - Pilot [h264].mkv`;
      await w.complete(move!, { class: 'maintenance', action: 'moveLibraryFile', path: NEW });
      const [again] = await w.claim('publish');
      expect(again!.payload).toMatchObject({ items: [{ path: NEW }] });
      await w.complete(again!, {
        class: 'publish',
        targetItemRefs: Object.fromEntries(ids.map((id) => [id, 'jf-1'])),
        readings: reading({ kind: 'episode', season: 1, episode: 1 }),
      });
      const after = await t.run(async (ctx) => ({
        issues: await ctx.db.query('issues').collect(),
        publications: await ctx.db.query('publications').collect(),
      }));
      expect(after.issues.map((i) => i.state)).toEqual(['resolved']);
      expect(after.publications.map((p) => [p.state, p.generation])).toEqual([['visible', 1]]);
      // A library-named file has nothing to move.
      expect(await t.mutation(internal.library.naming.moveUnitToLibraryNaming, { unitId })).toEqual({ queued: 0 });
    });
  });

  test('a folder whose Work is already in the library is imported into it, and the Work takes the folder', async () => {
    const workId = await subscribe('900008');
    const scanRunId = await scan(oldShowFiles(3));
    expect(await importOldShow(scanRunId, false)).toEqual({ imported: 3, works: 0, failed: [] });
    expect(await t.run(async (ctx) => (await ctx.db.get(workId))!.folder)).toBe('Old Show (2015)');
  });
});

describe('run states, the repeat setting and access', () => {
  test('cancelling a reading run cancels its job; a new scan can start', async () => {
    const scanRunId = await startScan();
    await admin.mutation(api.api.scan.cancel, { scanRunId });
    expect((await admin.query(api.api.scan.status, {})).run).toMatchObject({ state: 'cancelled' });
    expect(await w.claim('maintenance')).toEqual([]);
    await startScan();
  });

  test('a read that fails for good fails the run', async () => {
    await startScan();
    const job = await claimScan();
    for (let attempt = 0; attempt < 3; attempt++) {
      const [leased] = attempt === 0 ? [job] : await w.claim('maintenance');
      if (leased) await w.fail(leased, 'pipelineError', 'The library root could not be read.');
      vi.advanceTimersByTime(3_600_000);
      await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(60_000));
    }
    expect((await admin.query(api.api.scan.status, {})).run).toMatchObject({ state: 'failed' });
  });

  test('the daily check starts a periodic run when the schedule is due, never over a review in progress', async () => {
    const check = () => t.mutation(internal.scan.start.checkSchedule, {});
    const runs = () => t.run(async (ctx) => (await ctx.db.query('scanRuns').collect()).map((run) => run.trigger));
    await check();
    expect(await runs()).toEqual([]);
    await admin.mutation(api.api.scan.updateSettings, { schedule: 'daily' });
    expect(await admin.query(api.api.scan.settings, {})).toMatchObject({ schedule: 'daily' });
    await check();
    expect(await runs()).toEqual(['periodic']);

    // The run reads and matches, then the user makes a decision in its review.
    const job = await claimScan();
    await recordProbes(job, [{ ...entry(`${SERIES_ROOT}/Show/x.S01E01.mkv`), probe: MKV_PROBE }]);
    await w.complete(job, { class: 'maintenance', action: 'scanLibrary', found: 1, untracked: 1 });
    await drainPool(t);
    const scanRunId = (await admin.query(api.api.scan.status, {})).run!.scanRunId;
    await admin.mutation(api.api.scan.matchFolder, {
      scanRunId,
      libraryId: libraries.series,
      folder: 'Show',
      title: { tmdbId: '900008', kind: 'series', title: 'Old Show', year: 2015 },
      files: [],
    });
    vi.advanceTimersByTime(2 * 86_400_000);
    await check();
    expect(await runs()).toEqual(['periodic']);
  });

  test('searchTitle gives TMDB results of one kind, with the Work a title is in the library as', async () => {
    const workId = await subscribe('900008');
    expect(await admin.action(api.api.scan.searchTitle, { query: 'old', kind: 'series' })).toEqual([
      { tmdbId: '900008', kind: 'series', title: 'Old Show', year: 2015, workId },
    ]);
  });

  test('only an admin can call the scan functions; the worker token is refused', async () => {
    await expect(t.query(api.api.scan.status, { ...worker } as never)).rejects.toThrow();
    await expect(t.mutation(api.api.scan.start, { ...worker, trigger: 'manual' } as never)).rejects.toThrow();
    await expect(t.mutation(api.api.scan.ignoreFolder, { libraryId: libraries.series, folder: 'x' })).rejects.toThrow(/unauthorized/);
  });
});
