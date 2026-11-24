// The library scan on the real stack: a Sonarr-named series that the
// platform didn't import sits in the series library; "Scan now" reads it,
// the backend matches the folder to TMDB's "Old Show (2015)", and the import
// tracks it without monitoring, moving, renaming or preparing anything.
// Jellyfin then lists the episodes where they already were.
//
// Beside it, two folders Jellyfin 12.4 would misread: an
// anime folder with absolute numbers (`Star Lantern - 013`, TMDB's S02E01)
// and a loose clip matched by hand to Old Show S01E25. The import moves both
// to library naming in their Work folders, and Jellyfin's season and episode
// numbers then match each Unit.
import { join } from 'node:path';

import { makeFunctionReference } from 'convex/server';
import { afterAll, beforeAll, expect, test } from 'vite-plus/test';

import {
  after,
  compose,
  dataFiles,
  dataFolders,
  down,
  jellyfinSeriesItems,
  rows,
  runInternal,
  setUpJellyfinThroughProduct,
  up,
  waitFor,
  type Deployment,
} from './stack.ts';

// The backend's generated API isn't a dependency of this package, so calls go by name.
// oxlint-disable-next-line typescript/no-explicit-any
type Any = any;
let d: Deployment;
const query = (name: string, args: object = {}): Promise<Any> => d.admin.query(makeFunctionReference<'query'>(name), args);
const mutation = (name: string, args: object = {}): Promise<Any> => d.admin.mutation(makeFunctionReference<'mutation'>(name), args);
const action = (name: string, args: object): Promise<Any> => d.admin.action(makeFunctionReference<'action'>(name), args);

const MEDIA = join(import.meta.dirname, '..', 'apps/worker/test/fixtures/media');
const ROOT = '/data/library/series';
const FOLDER = `${ROOT}/Old Show (2015)`;
/**
 * The Sonarr library: S01E01–S01E24, the odd episodes the pipeline's WEB-DL
 * (H.264, E-AC-3 5.1 and SubRip in Matroska, which doesn't fit) and the even
 * ones a fitting H.264 and AAC MP4. TMDB lists 26 episodes, so two are missing.
 */
const EPISODES = Array.from({ length: 24 }, (_, i) => {
  const n = i + 1;
  const title = n === 1 ? 'Pilot' : n === 2 ? 'Second' : `Episode ${n}`;
  const fits = n % 2 === 0;
  return {
    n,
    fits,
    source: join(MEDIA, fits ? 'fits.mp4' : 'webdl.mkv'),
    relPath: `Season 1/Old Show - S01E${String(n).padStart(2, '0')} - ${title}.${fits ? 'mp4' : 'mkv'}`,
  };
});
/** Star Lantern (2022): two seasons of 12, so absolute 13 is S02E01. Unrecognised naming, read in absolute numbering. */
const ANIME = { folder: 'Star Lantern (2022)', file: 'Star Lantern - 013.mp4', workFolder: 'Star Lantern (2022) [tmdbid-900002]' };
/** A loose clip whose name says nothing, with an English subtitle beside it; matched by hand to Old Show S01E25. */
const CLIP = { folder: 'Holiday Footage 2019', file: 'clip_0001.mp4', subtitle: 'clip_0001.en.srt' };

const SECOND_MISS_CONFIRMS_AFTER_MS = 1_000;

beforeAll(async () => {
  d = await up({ limits: { fileMissingConfirmMs: SECOND_MISS_CONFIRMS_AFTER_MS } });
}, 600_000);
afterAll(() => {
  if (process.env.E2E_KEEP !== '1') return down();
});

test('a Sonarr library is scanned, matched to TMDB and tracked where it is; files Jellyfin would misread move to library naming', async () => {
  await setUpJellyfinThroughProduct(d);
  for (const folder of [`${FOLDER}/Season 1`, `${ROOT}/${ANIME.folder}`, `${ROOT}/${CLIP.folder}`])
    compose(['exec', '-T', 'worker', 'mkdir', '-p', folder], ['test', 'worker']);
  for (const episode of EPISODES) compose(['cp', episode.source, `worker:${FOLDER}/${episode.relPath}`], ['test', 'worker']);
  compose(['cp', join(MEDIA, 'fits.mp4'), `worker:${ROOT}/${ANIME.folder}/${ANIME.file}`], ['test', 'worker']);
  compose(['cp', join(MEDIA, 'fits.mp4'), `worker:${ROOT}/${CLIP.folder}/${CLIP.file}`], ['test', 'worker']);
  const srt = '1\\n00:00:01,000 --> 00:00:02,000\\nHello.\\n';
  compose(['exec', '-T', 'worker', 'sh', '-c', `printf '${srt}' > "${ROOT}/${CLIP.folder}/${CLIP.subtitle}"`], ['test', 'worker']);
  const before = dataFiles(FOLDER);
  expect(before).toEqual(EPISODES.map((e) => e.relPath).sort());

  // "Scan now": the worker reads both roots, then the backend matches.
  const { scanRunId } = await mutation('api/scan:start', { trigger: 'manual' });
  const status = await waitFor(
    'the scan to be ready',
    async () => {
      const s = await query('api/scan:status');
      if (s.run?.state === 'failed') throw new Error('the scan failed');
      return s.run?.state === 'ready' ? s : undefined;
    },
    300_000,
    500,
  );
  expect(status.run.counts).toMatchObject({ read: 26, tracked: 0, matched: 25, unmatched: 1 });

  // The matched tab: Old Show (2015), the single exact title-and-year result, read as Sonarr naming; Star Lantern read in absolute numbering.
  const { groups } = await query('api/scan:groups', { scanRunId, tab: 'matched', cursor: null });
  const groupOf = (folder: string) => groups.find((g: Any) => g.folder === folder);
  expect(groups).toHaveLength(2);
  expect(groupOf('Old Show (2015)')).toMatchObject({
    match: { tmdbId: '900008', title: 'Old Show', year: 2015, ordering: 'tmdb', readAs: 'sonarr' },
    counts: { files: 24, matched: 24, notFit: 12 },
  });
  expect(groupOf(ANIME.folder)).toMatchObject({ match: { tmdbId: '900002', ordering: 'absolute', readAs: 'unknown' }, counts: { matched: 1 } });

  // "Match by hand": the clip is Old Show S01E25.
  const { library } = await query('api/library:list', { kind: 'series' });
  const clipFolder = await query('api/scan:folder', { scanRunId, libraryId: library.libraryId, folder: CLIP.folder });
  await mutation('api/scan:matchFolder', {
    scanRunId,
    libraryId: library.libraryId,
    folder: CLIP.folder,
    title: { tmdbId: '900008', kind: 'series', title: 'Old Show', year: 2015 },
    files: [{ scanItemId: clipFolder.files[0].scanItemId, season: 1, episode: 25 }],
  });

  // Import the three folders with the library's default release profile, "Tracked, not monitored".
  const imported = await action('api/scan:import', {
    scanRunId,
    folders: [CLIP.folder, 'Old Show (2015)', ANIME.folder].map((folder) => ({ libraryId: library.libraryId, folder })),
    releaseProfileId: library.defaultReleaseProfileId,
    monitor: false,
  });
  expect(imported).toEqual({ imported: 26, works: 2, failed: [] });

  const works = rows<{ _id: string; title: string; folder?: string; monitorNewUnits: boolean; releaseProfileId: string }>(d.env, 'works');
  const oldShow = works.find((w) => w.title === 'Old Show')!;
  expect(oldShow).toMatchObject({ folder: 'Old Show (2015)', monitorNewUnits: false, releaseProfileId: library.defaultReleaseProfileId });
  expect(works.find((w) => w.title === 'Star Lantern')).toMatchObject({ folder: ANIME.workFolder });

  // Jellyfin lists every file, and the Units show whether they fit; no Unit is monitored.
  // waitFor retries a probe that throws, so a failed Publication ends the wait as a value.
  const published = await waitFor(
    'every Publication to be visible or one to fail',
    async () => {
      const publications = rows<{ state: string }>(d.env, 'publications');
      if (publications.some((p) => p.state === 'failed')) return 'failed';
      return publications.length === 26 && publications.every((p) => p.state === 'visible') ? 'visible' : undefined;
    },
    300_000,
    1_000,
  );
  const openIssues = () => rows<{ state: string; detail?: string }>(d.env, 'issues').filter((i) => i.state === 'open');
  expect(published === 'visible' ? [] : openIssues().map((i) => i.detail)).toEqual([]);

  // The Sonarr files stay where they are; the anime file and the clip were moved to library naming.
  const files = rows<{ _id: string; path: string; origin: string; role: string; keepsName?: boolean; sidecars?: { path: string; language?: string }[] }>(
    d.env,
    'files',
  );
  const kept = files.filter((f) => f.keepsName === true);
  expect(kept.map((f) => f.path).sort()).toEqual(EPISODES.map((e) => `${FOLDER}/${e.relPath}`).sort());
  const moved = files.filter((f) => f.keepsName !== true);
  const placedIn = (path: string) =>
    path
      .slice(ROOT.length + 1)
      .split('/')
      .slice(0, 2);
  expect(moved.map((f) => placedIn(f.path)).sort((a, b) => a.join('/').localeCompare(b.join('/')))).toEqual([
    ['Old Show (2015)', 'Season 1'],
    [ANIME.workFolder, 'Season 02'],
  ]);
  expect(files.every((f) => f.origin === 'scan' && f.role === 'source')).toBe(true);
  // The emptied folders are gone (`.omnarr/` is the worker's write check).
  expect(dataFolders(ROOT).filter((f) => !f.startsWith('.'))).toEqual(['Old Show (2015)', ANIME.workFolder]);
  // The clip's subtitle moved with it, under the library's sidecar name, and is recorded on the file.
  const clip = moved.find((f) => f.path.startsWith(`${FOLDER}/`))!;
  const subtitle = clip.path.replace(/\.mp4$/, '.en.srt');
  expect(clip.sidecars).toEqual([{ path: subtitle, language: 'en', forced: false, sdh: false, format: 'srt' }]);
  expect(dataFiles(FOLDER)).toEqual([...before, clip.path, subtitle].map((p) => p.replace(`${FOLDER}/`, '')).sort());

  // Jellyfin's own reading: each file's season and episode are its Unit's, under its Work folder's series.
  const units = rows<{ _id: string; workId: string; tmdbSeason?: number; tmdbEpisode?: number }>(d.env, 'units');
  const links = rows<{ fileId: string; unitId: string }>(d.env, 'fileUnits');
  const { series, episodes } = await jellyfinSeriesItems(d);
  for (const file of files) {
    const unit = units.find((u) => u._id === links.find((l) => l.fileId === file._id)!.unitId)!;
    const work = works.find((w) => w._id === unit.workId)!;
    const item = episodes.find((e) => e.Path === file.path);
    expect(item, file.path).toBeDefined();
    expect([item!.ParentIndexNumber, item!.IndexNumber], file.path).toEqual([unit.tmdbSeason, unit.tmdbEpisode]);
    expect(item!.SeriesId, file.path).toBe(series.find((s) => s.Path === `${ROOT}/${work.folder}`)!.Id);
  }
  expect(openIssues()).toEqual([]);

  // Jellyfin plays the clip with its subtitle: an external stream at the sidecar's path.
  const [server] = rows<{ apiKey?: string }>(d.env, 'jellyfinServer');
  const clipItem = episodes.find((e) => e.Path === clip.path)!;
  const withStreams = (await (
    await fetch(`${d.jellyfinUrl}/Items?Ids=${clipItem.Id}&Fields=MediaStreams`, { headers: { authorization: `MediaBrowser Token="${server?.apiKey}"` } })
  ).json()) as { Items: { MediaStreams?: { Type: string; IsExternal?: boolean; Path?: string }[] }[] };
  expect(withStreams.Items[0]!.MediaStreams?.filter((s) => s.Type === 'Subtitle').map((s) => [s.IsExternal, s.Path])).toEqual([[true, subtitle]]);

  const detail = await query('api/library:detail', { workId: oldShow._id });
  expect(detail.units.filter((u: Any) => u.monitored)).toEqual([]);
  const stateOf = (n: number) => detail.units.find((u: Any) => u.tmdbSeason === 1 && u.tmdbEpisode === n)?.state;
  expect([stateOf(1), stateOf(2), stateOf(25), stateOf(26)]).toEqual(['notInTargetFormat', 'ready', 'ready', 'notMonitored']);

  // Nothing was prepared, and nothing was searched.
  expect(rows<{ class: string }>(d.env, 'jobs').filter((j) => j.class === 'prepare')).toEqual([]);
  expect(rows(d.env, 'searchAttempts')).toEqual([]);
}, 1_200_000);

type CheckJob = { _id: string; status: string; idempotencyKey: string };
const checkJobsByKeySinceDoneJobsDropTheirPayload = () => rows<CheckJob>(d.env, 'jobs').filter((j) => j.idempotencyKey.startsWith('checkLibraryFiles:'));
const checkJobs = checkJobsByKeySinceDoneJobsDropTheirPayload;
const waitPastTheConfirmWindow = () => new Promise((resolve) => setTimeout(resolve, SECOND_MISS_CONFIRMS_AFTER_MS));

async function runCheckAsTheCronStartsIt(): Promise<void> {
  const known = new Set(checkJobs().map((j) => j._id));
  await waitFor(
    'no check to be running',
    async () => (checkJobs().every((j) => ['done', 'failed', 'cancelled'].includes(j.status)) ? true : undefined),
    60_000,
    250,
  );
  runInternal(d, 'library/missingFiles:scheduledCheck');
  const job = await waitFor(
    'the check to end',
    async () => checkJobs().find((j) => !known.has(j._id) && ['done', 'failed', 'cancelled'].includes(j.status)),
    60_000,
    250,
  );
  expect(job.status).toBe('done');
}

test('a tracked file that disappears stops playing with an Issue; a library root that is gone marks nothing; the file coming back clears it', async (ctx) => {
  after(ctx, 'a Sonarr library is scanned');
  const readyFittingS01E02 = EPISODES[1]!;
  const path = `${FOLDER}/${readyFittingS01E02.relPath}`;
  const fileRow = () => rows<{ path: string; missingSeenAt?: number; missingSince?: number }>(d.env, 'files').find((f) => f.path === path)!;
  const issues = () => rows<{ failureCode: string; state: string; detail?: string }>(d.env, 'issues');
  const open = (code: string) => issues().filter((i) => i.failureCode === code && i.state === 'open');
  const oldShowId = rows<{ _id: string; title: string }>(d.env, 'works').find((w) => w.title === 'Old Show')!._id;
  const stateOf2 = async () =>
    (await query('api/library:detail', { workId: oldShowId })).units.find((u: Any) => u.tmdbSeason === 1 && u.tmdbEpisode === 2)?.state;
  const sh = (command: string) => compose(['exec', '-T', 'worker', 'sh', '-c', command], ['test', 'worker']);

  const theSeriesRootGoneMarksNothingAndRaisesOneStorageIssue = async () => {
    sh(`mv "${ROOT}" "${ROOT}.unmounted"`);
    try {
      await runCheckAsTheCronStartsIt();
      await waitPastTheConfirmWindow();
      await runCheckAsTheCronStartsIt();
      expect(rows<{ missingSeenAt?: number; missingSince?: number }>(d.env, 'files').filter((f) => f.missingSeenAt || f.missingSince)).toEqual([]);
      expect(open('libraryUnavailable').map((i) => i.detail)).toEqual([expect.stringContaining(`The Series folder ${ROOT} is missing.`)]);
      expect(open('fileMissing')).toEqual([]);
    } finally {
      sh(`mv "${ROOT}.unmounted" "${ROOT}"`);
    }
    await runCheckAsTheCronStartsIt();
    expect(open('libraryUnavailable')).toEqual([]);
  };

  const oneFileGoneIsMissingOnTheSecondMissAndItsIssueOffersASearch = async () => {
    sh(`mv "${path}" /data/staging/aside.mp4`);
    await runCheckAsTheCronStartsIt();
    expect(fileRow().missingSeenAt).toBeTypeOf('number');
    await waitPastTheConfirmWindow();
    await runCheckAsTheCronStartsIt();
    expect(fileRow().missingSince).toBeTypeOf('number');
    expect(open('fileMissing').map((i) => i.detail)).toEqual([expect.stringContaining(path)]);
    const unmonitoredSoNoLongerReadyReadsAs = 'notMonitored';
    expect(await stateOf2()).toBe(unmonitoredSoNoLongerReadyReadsAs);
    const list = await query('api/issues:list');
    const row = [...list.needsAction, ...list.inProgress].find((i: Any) => i.failureCode === 'fileMissing');
    expect(row?.fixActions).toEqual(['tryNextBest', 'searchAndPick', 'dismiss']);
  };

  await theSeriesRootGoneMarksNothingAndRaisesOneStorageIssue();
  await oneFileGoneIsMissingOnTheSecondMissAndItsIssueOffersASearch();

  sh(`mv /data/staging/aside.mp4 "${path}"`);
  await runCheckAsTheCronStartsIt();
  expect(fileRow().missingSince).toBeUndefined();
  expect(open('fileMissing')).toEqual([]);
  await waitFor(
    'the file to be visible in Jellyfin again',
    async () => (rows<{ state: string }>(d.env, 'publications').every((p) => p.state === 'visible') ? true : undefined),
    120_000,
    1_000,
  );
  expect(await stateOf2()).toBe('ready');
}, 600_000);
