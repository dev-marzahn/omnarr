// The pipeline on the real stack: backend image,
// worker image, NZBGet downloading from the NNTP fake, and Jellyfin 12.4,
// which the product sets up.
//
//   - an old worker is refused, keeps retrying, and no job moves;
//   - Harbour Lights S01E01 is searched through the real search path,
//     downloaded, imported, prepared to an MP4 with two sidecar subtitles
//     at its TRaSH path, and visible in Jellyfin;
//   - S01E02's best release is damaged: it fails repair, is blocklisted,
//     and the next-best release is grabbed in a new run, with no Issue;
//   - a second indexer answers with its API limit: the search still
//     succeeds through the first, and no Issue opens;
//   - NZBGet starts from the stock image with only setup-clients' control
//     keys, the reconciler applies the saved provider, the worker uploads
//     each NZB, and no indexer key reaches NZBGet;
//   - the worker is killed during S02E01's video transcode and starts
//     again: the job runs again from the start, with one Rendition and one
//     output, and the original stays published;
//   - S02E02's transcode fails its output check on both attempts: the
//     Rendition fails, the Issue and the ffmpeg.log artifact are there,
//     and the library is unchanged;
//   - the tick fetches Sonarr's scene mappings from the fake, and Harbour
//     Lights gets its all-seasons names;
//   - "Search and pick" for S01E03 offers a release whose numbering the
//     metadata can't settle; grabbed by hand, it is imported as S01E03;
//   - no planted secret is in the support bundle, the worker's or the
//     backend's output, or any public function output the run read.
import { gunzipSync } from 'node:zlib';

import { PROTOCOL_VERSION } from '@omnarr/contracts';
import { makeFunctionReference } from 'convex/server';
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test';

import { GENERATED_MEDIA } from './fakes/usenet/catalogue.ts';
import {
  after,
  dataFiles,
  dataFolders,
  down,
  exec,
  jellyfinItems,
  jellyfinSeriesItems,
  killWorker,
  limitSecondIndexer,
  logs,
  NEWZNAB_KEY,
  NNTP_BACKUP_PASS,
  NNTP_BACKUP_USER,
  NNTP_PASS,
  NNTP_USER,
  plantedSecrets,
  nzbgetRpc,
  rows,
  runInternal,
  sceneMappingRequests,
  setUpJellyfinThroughProduct,
  startWorker,
  stopWorker,
  supervise,
  timestampedLogs,
  up,
  waitFor,
  type Deployment,
} from './stack.ts';

// The backend's generated API isn't a dependency of this package (the backend depends on it), so calls go by name.
// oxlint-disable-next-line typescript/no-explicit-any
type Any = any;
/** Every public function output the run read, for the planted-secrets check. */
const outputs: string[] = [];
const seen = <T>(value: T): T => {
  outputs.push(JSON.stringify(value) ?? '');
  return value;
};
const query = (name: string, args: object = {}): Promise<Any> => d.admin.query(makeFunctionReference<'query'>(name), args).then(seen);
const mutation = (name: string, args: object): Promise<Any> => d.admin.mutation(makeFunctionReference<'mutation'>(name), args).then(seen);
const action = (name: string, args: object): Promise<Any> => d.admin.action(makeFunctionReference<'action'>(name), args).then(seen);

type UnitRow = { unitId: string; tmdbSeason?: number; tmdbEpisode?: number; state: string; openIssue?: { failureCode: string } };
type FileRow = { _id: string; path: string; origin: string; role: string; sidecars?: { path: string; language?: string }[] };
type RenditionRow = { _id: string; sourceFileId: string; jobId: string; state: string; steps: string[]; outputFileId?: string; encoder?: string };
type JobRow = { _id: string; class: string; status: string; attempt: number; failureCode?: string; lastError?: string; artifactStorageId?: string };
type PublicationRow = { _id: string; unitId: string; fileVersionId: string; state: string; targetItemRef?: string };

/** The Work folder's name, `{Title} ({Year}) [tmdbid-{tmdbId}]`, Harbour Lights being TMDB 900001, first aired 2021. */
const WORK_FOLDER = '/data/library/series/Harbour Lights (2021) [tmdbid-900001]';

/** The files of a Unit, through its `fileUnits` rows. */
function filesOf(unitId: string): FileRow[] {
  const fileIds = new Set(rows<{ fileId: string; unitId: string }>(d.env, 'fileUnits').flatMap((row) => (row.unitId === unitId ? [row.fileId] : [])));
  return rows<FileRow>(d.env, 'files').filter((file) => fileIds.has(file._id));
}

/** A measurement, straight to stderr: the runner doesn't show a passing test's console output. */
const measured = (line: string) => process.stderr.write(`MEASURED: ${line}\n`);

/** A job's runs as the worker logged them ("started", then "done" or "failed: …"), with Docker's timestamps. */
function jobRuns(jobId: string): { startedAt: number; endedAt?: number; end?: string }[] {
  const runs: { startedAt: number; endedAt?: number; end?: string }[] = [];
  for (const line of timestampedLogs('worker').split('\n')) {
    const match = new RegExp(`(\\S+) \\[worker\\] job ${jobId} (?:\\(\\S+\\) )?(started|done|failed.*|lost its lease.*|cancelled)$`).exec(
      line.replace(/^\S+\s+\|\s+/, ''),
    );
    if (!match) continue;
    // Docker writes nanoseconds; Date.parse reads milliseconds.
    const at = Date.parse(match[1]!.replace(/(\.\d{3})\d*/, '$1'));
    if (match[2] === 'started') runs.push({ startedAt: at });
    else if (runs.length > 0) Object.assign(runs.at(-1)!, { endedAt: at, end: match[2] });
  }
  return runs;
}
type SystemStatus = {
  banner?: string;
  worker?: { accepted: boolean; connected: boolean; protocolVersion: number; expectedVersion: number };
  jobCounts: { class: string; queued: number; leased: number }[];
  clients: { clientKind: string; enabled: boolean; reachable: boolean; clientVersion?: string; config: string }[];
};

let d: Deployment;
let workId: string;

const status = (): Promise<SystemStatus> => query('api/system:status');
const units = async (): Promise<UnitRow[]> => (await query('api/library:detail', { workId })).units;
const unitAt = async (season: number, episode: number) => (await units()).find((row) => row.tmdbSeason === season && row.tmdbEpisode === episode)!;
const unit = (episode: number) => unitAt(1, episode);

/** For a wait on a season 1 Unit that times out (waitFor's `explain`): the Unit, the jobs not done, the Renditions and the Publications. */
const stuckAt = async (episode: number) =>
  JSON.stringify({
    unit: await unit(episode),
    jobs: rows<JobRow & { idempotencyKey: string }>(d.env, 'jobs')
      .filter((job) => job.status !== 'done')
      .map(({ class: cls, status, attempt, failureCode, lastError, idempotencyKey }) => ({ cls, status, attempt, failureCode, lastError, idempotencyKey })),
    renditions: rows<RenditionRow>(d.env, 'renditions').map(({ state, steps }) => ({ state, steps })),
    publications: rows<PublicationRow>(d.env, 'publications').map(({ unitId, state }) => ({ unitId, state })),
  });

// Timeouts are about twice the slowest passing time on CI, so a failure ends the scenario in minutes; a test
// whose state an earlier one makes skips once that one fails (after()).
beforeAll(async () => {
  d = await up();
  // The slowest passing start: 175 s.
}, 360_000);
afterAll(() => {
  if (process.env.E2E_KEEP !== '1') return down();
});

describe('the pipeline on the real stack', () => {
  test('setup: two indexers, one of them rate-limited, and a subscription to season 1 of Harbour Lights', async () => {
    await action('api/indexers:create', { name: 'Newznab Main', url: 'http://newznab:4120/api', apiKey: NEWZNAB_KEY, priority: 10 });
    await action('api/indexers:create', { name: 'Newznab Limited', url: 'http://newznab-limited:4121/api', apiKey: NEWZNAB_KEY, priority: 20 });
    limitSecondIndexer();
    const { library } = await query('api/library:list', { kind: 'series' });
    ({ workId } = await action('api/library:subscribe', {
      tmdbId: '900001',
      kind: 'series',
      libraryId: library.libraryId,
      releaseProfileId: library.defaultReleaseProfileId,
      seasons: [1],
    }));
    // The picks: S01E01's release, and S01E02's damaged one, the newest.
    await waitFor('the picks', async () => ((await unit(1)).state === 'grabbed' && (await unit(2)).state === 'grabbed' ? true : undefined));
  });

  test("the metadata tick fetches Sonarr's scene mappings from the fake, and Harbour Lights gets its names, the one for a season TMDB doesn't list left out", async () => {
    runInternal(d, 'metadata/schedule:tick');
    const names = await waitFor("Harbour Lights' scene-mapping aliases", async () => {
      const info = await query('api/metadata:workInfo', { workId });
      const titles = (info?.aliases ?? []).filter((a: { source: string }) => a.source === 'sceneMapping').map((a: { title: string }) => a.title);
      return titles.length > 0 ? titles : undefined;
    });
    expect(names.sort()).toEqual(['Harbour', 'Harbour Lights Next Chapter', 'Harbour Lights UK', 'Harbour Lights Winter Tales', 'The Harbour Lights']);
    expect(sceneMappingRequests()).toContainEqual({ at: expect.any(Number), path: '/v1/scenemapping', userAgent: expect.stringMatching(/^omnarr\//) });
  });

  // The retry is 60 s in production; E2E_LIMITS' handshakeRetryMs makes it 2 s.
  test('an old worker is refused with the expected version, keeps retrying, and no job moves', async () => {
    startWorker('worker-old');
    const refused = await waitFor('the mismatch banner', async () => {
      const s = await status();
      return s.banner === 'protocolMismatch' ? s : undefined;
    });
    expect(refused.worker).toMatchObject({ accepted: false, protocolVersion: 0, expectedVersion: PROTOCOL_VERSION });
    await waitFor('a second handshake', async () => ((logs('worker-old').match(/protocol version mismatch/g) ?? []).length >= 2 ? true : undefined), 90_000);
    const submits = (await status()).jobCounts.find((row) => row.class === 'download.submit')!;
    expect(submits).toMatchObject({ queued: 2, leased: 0 });
    expect((await unit(1)).state).toBe('grabbed');
    stopWorker('worker-old');
  });

  test('a matching worker connects: the mismatch banner goes, and it sets Jellyfin 12.4 up through the product', async () => {
    const jellyfin = await setUpJellyfinThroughProduct(d);
    expect(jellyfin.version).toBe('12.4.0');
    await waitFor('the banner to clear', async () => ((await status()).banner === undefined && (await status()).worker?.connected ? true : undefined));
  });

  test('S01E01 is downloaded, imported, prepared to an MP4 with two sidecars at its TRaSH path, and ready in Jellyfin', async (ctx) => {
    after(ctx, 'setup:', 'a matching worker connects');
    const e1 = await waitFor(
      'S01E01 to be ready',
      async () => {
        const row = await unit(1);
        return row.state === 'ready' ? row : undefined;
      },
      // The slowest passing run: 23 s.
      60_000,
      1_000,
      () => stuckAt(1),
    );
    const timeline = await query('api/units:timeline', { unitId: e1.unitId });
    expect(timeline.runs.map((run: { state: string }) => run.state)).toEqual(['done']);
    expect(timeline.runs[0].stages.map((s: { stage: string }) => s.stage)).toEqual(expect.arrayContaining(['grab', 'download', 'import', 'publish']));

    // The library name for the prepared file: the placeholder title "Episode 1" left out, the quality and group
    // from the release, AAC 2.0 and h264 from the MP4's own probe. The MKV is gone (Keep the original is off).
    const base = 'Harbour Lights (2021) - S01E01 [WEBDL-1080p][AAC 2.0][h264]-GRPB';
    const season = `${WORK_FOLDER}/Season 01`;
    expect(dataFiles(season).filter((name) => name.startsWith('Harbour Lights (2021) - S01E01'))).toEqual([`${base}.de.srt`, `${base}.en.srt`, `${base}.mp4`]);
    const [file, ...others] = filesOf(e1.unitId);
    expect(others).toEqual([]);
    expect(file).toMatchObject({ path: `${season}/${base}.mp4`, origin: 'prepared', role: 'rendition' });
    expect(file!.sidecars?.map((sidecar) => sidecar.path).sort()).toEqual([`${season}/${base}.de.srt`, `${season}/${base}.en.srt`]);
    const [rendition, ...moreRenditions] = rows<RenditionRow>(d.env, 'renditions').filter((row) => row.outputFileId === file!._id);
    expect(moreRenditions).toEqual([]);
    expect(rendition).toMatchObject({ state: 'done', encoder: 'copy' });
    expect(rendition!.steps).toEqual(expect.arrayContaining(['audio', 'subtitle', 'remux']));
    const [run] = jobRuns(rendition!.jobId);
    measured(`the remux and audio prepare job took ${(run!.endedAt! - run!.startedAt) / 1000} s (worker log)`);

    // The Publication's targetItemRef is Jellyfin's item for the prepared file's path.
    const item = (await jellyfinItems(d)).find((row) => row.Path === file!.path);
    expect(item).toBeDefined();
    const publications = rows<PublicationRow>(d.env, 'publications').filter((p) => p.unitId === e1.unitId);
    expect(publications).toEqual([expect.objectContaining({ state: 'visible', targetItemRef: item!.Id })]);
    // The Work page's "Open in Jellyfin" opens the series' own item.
    const seriesId = (await jellyfinSeriesItems(d)).episodes.find((row) => row.Id === item!.Id)?.SeriesId;
    expect(seriesId).toBeDefined();
    expect((await query('api/library:detail', { workId })).work.jellyfinItemPath).toMatch(new RegExp(`^/web/#/details\\?id=${seriesId}&serverId=`));
    // NZBGet names the item after the release, so its deobfuscation runs.
    expect(logs('nzbget')).toContain('Harbour.Lights.S01E01.1080p.WEB-DL.DDP5.1.H.264-GRPB');
  });

  test("NZBGet started with only setup-clients' control keys, and runs the config the reconciler applied from the saved provider", async () => {
    const options = new Map(nzbgetRpc<{ Name: string; Value: string }[]>('loadconfig').map((option) => [option.Name, option.Value]));
    expect(
      Object.fromEntries(
        ['ControlUsername', 'MainDir', 'Server1.Host', 'Server1.Port', 'Server1.Encryption', 'HealthCheck', 'Category1.Name'].map((key) => [
          key,
          options.get(key),
        ]),
      ),
    ).toEqual({
      ControlUsername: 'omnarr',
      MainDir: '/data/downloads/usenet',
      'Server1.Host': 'nntp',
      'Server1.Port': '119',
      'Server1.Encryption': 'no',
      HealthCheck: 'delete',
      'Category1.Name': 'platform-series',
    });
    expect([...options.keys()].filter((key) => /^Server[2-9]\./.test(key))).toEqual([]);
    const nzbget = (await status()).clients.find((client) => client.clientKind === 'nzbget');
    expect(nzbget).toMatchObject({ enabled: true, reachable: true, clientVersion: '26.3', config: 'applied' });
  });

  test('S01E02 fails repair on missing articles, is blocklisted, and recovers through the next-best release, with no Issue', async (ctx) => {
    // S01E02 goes through the same download and import as S01E01, at the same time.
    after(ctx, 'S01E01 is downloaded');
    const e2 = await waitFor(
      'S01E02 to be playable',
      async () => {
        const row = await unit(2);
        return row.state === 'notInTargetFormat' || row.state === 'ready' ? row : undefined;
      },
      60_000,
    );
    const timeline = await query('api/units:timeline', { unitId: e2.unitId });
    expect(timeline.runs.map((run: { state: string; failureCode?: string; title: string }) => [run.state, run.failureCode, run.title])).toEqual([
      ['done', undefined, 'Harbour.Lights.S01E02.1080p.WEB-DL.AAC2.0.H.264-GRPF'],
      ['failed', 'missingArticles', 'Harbour.Lights.S01E02.1080p.WEB-DL.AAC2.0.H.264-GRPB'],
    ]);
    expect(timeline.runs[0].search.trigger).toBe('nextBest');
    expect(e2.openIssue).toBeUndefined();
  });

  test('the rate-limited indexer is recorded on the attempt, the other one served the search, and no Issue opened', async (ctx) => {
    after(ctx, 'S01E01 is downloaded');
    const e1 = await unit(1);
    const timeline = await query('api/units:timeline', { unitId: e1.unitId });
    const indexers: string[] = timeline.runs[0].search.candidates.map((c: { indexerName: string }) => c.indexerName);
    expect(new Set(indexers)).toEqual(new Set(['Newznab Main']));
    const health = await query('api/indexers:list');
    expect(health.find((row: { name: string }) => row.name === 'Newznab Limited')).toMatchObject({ health: { status: 'rateLimited' } });
    expect((await units()).filter((row) => row.openIssue)).toEqual([]);
  });

  test("NZBGet's log, queue and history hold no indexer API key, since the worker uploads the NZB itself", () => {
    expect(logs('nzbget')).not.toContain(NEWZNAB_KEY);
    expect(JSON.stringify(nzbgetRpc('listgroups', [0]))).not.toContain(NEWZNAB_KEY);
    expect(JSON.stringify(nzbgetRpc('history', [true]))).not.toContain(NEWZNAB_KEY);
    expect(JSON.stringify(nzbgetRpc('history', [true]))).not.toContain('/getnzb/');
  });

  /** Monitors one season 2 episode and searches for it: season 1's subscription left season 2 unmonitored. */
  async function grab(episode: number): Promise<UnitRow> {
    const row = await unitAt(2, episode);
    await mutation('api/units:setMonitored', { target: { kind: 'units', unitIds: [row.unitId] }, monitored: true });
    await mutation('api/units:searchNow', { unitIds: [row.unitId] });
    return row;
  }

  /** The Unit's imported source file and its published Publication, once both exist. */
  const published = (unitId: string) =>
    waitFor(
      'the episode to be imported and published',
      async () => {
        const publication = rows<PublicationRow>(d.env, 'publications').find((p) => p.unitId === unitId && p.state === 'visible');
        const source = filesOf(unitId).find((file) => file.origin === 'download');
        return publication && source ? { publication, source } : undefined;
      },
      120_000,
      2_000,
    );

  const renditionsOf = (sourceFileId: string) => rows<RenditionRow>(d.env, 'renditions').filter((row) => row.sourceFileId === sourceFileId);

  test('the worker is killed during a video transcode and restarts; the job runs again from the start, with one Rendition and one output', async (ctx) => {
    // The same download, import and publish as S01E01's, for a season 2 episode.
    after(ctx, 'S01E01 is downloaded');
    // The test kills the worker: a failure before it starts one again leaves the later tests none.
    ctx.onTestFailed(() => void startWorker('worker'));
    const e = await grab(1);
    const { publication, source } = await published(e.unitId);
    expect(source.path).toBe(`${WORK_FOLDER}/Season 02/Harbour Lights (2021) - S02E01 [WEBDL-1080p][EAC3 5.1][h265]-GRPB.mkv`);
    const rendition = await waitFor('the Rendition', async () => renditionsOf(source._id)[0], 60_000);
    expect(rendition.steps).toContain('video');

    // The first progress above 0 of the transcode, then the kill.
    const progress = await waitFor(
      'the transcode to report progress',
      async () =>
        rows<{ jobId: string; fraction: number; detail?: string }>(d.env, 'jobProgress').find(
          (row) => row.jobId === rendition.jobId && row.detail === 'Video conversion HEVC → H.264' && row.fraction > 0,
        ),
      120_000,
      250,
    );
    killWorker();
    measured(`killed the worker at ${Math.round(progress.fraction * 100)} % (${progress.detail})`);
    expect(progress.fraction).toBeLessThan(1);
    // The worker died with the job unfinished: still leased to it, and the original still published.
    const leased = rows<JobRow & { leaseExpiresAt?: number }>(d.env, 'jobs').find((job) => job._id === rendition.jobId);
    expect(leased).toMatchObject({ status: 'leased' });

    // Until the Rendition is done, the original stays published and Jellyfin lists it. The Publications
    // are read before the Rendition, so a pending Rendition means the Publication read saw it pending too.
    let unpublished = 0;
    let listed = 0;
    const check = async () => {
      const visible = rows<PublicationRow>(d.env, 'publications').some((p) => p._id === publication._id && p.state === 'visible');
      const inJellyfin = (await jellyfinItems(d)).some((item) => item.Path === source.path);
      const [current] = renditionsOf(source._id);
      if (current?.state !== 'pending') return current;
      if (!visible || !inJellyfin) unpublished++;
      else listed++;
      return undefined;
    };
    // One check while no worker runs, so the Rendition is surely pending: the second run can finish before
    // the first poll below, which left `listed` at 0.
    expect(await check()).toBeUndefined();

    startWorker('worker');
    // The lease runs out (E2E_LIMITS' leaseMs after the dead worker's last beat), and the supervision pass,
    // the cron's every 30 s, returns the job to the queue for the new session.
    await new Promise((resolve) => setTimeout(resolve, Math.max(0, leased!.leaseExpiresAt! - Date.now() + 500)));
    supervise(d);
    // The second run took up to 172 s on CI.
    const done = await waitFor('the transcode to run again and finish', check, 360_000, 2_000);
    expect(unpublished).toBe(0);
    expect(listed).toBeGreaterThan(0);
    expect(done.state).toBe('done');
    expect(renditionsOf(source._id)).toHaveLength(1);
    expect(done.encoder).toBe('libx264');

    // The re-claimed job ran ffmpeg from the start: two runs in the worker's log, the second one complete.
    const runs = jobRuns(rendition.jobId);
    expect(runs.map((run) => run.end)).toEqual([undefined, 'done']);
    const seconds = (runs[1]!.endedAt! - runs[1]!.startedAt) / 1000;
    const length = GENERATED_MEDIA.durationS;
    measured(`the ${length} s 1080p HEVC → H.264 transcode took ${seconds} s on its second run (${(length / seconds).toFixed(1)}× real time)`);

    // One output in the library and staging/<jobId> gone.
    const ready = await waitFor('S02E01 to be ready', async () => ((await unitAt(2, 1)).state === 'ready' ? true : undefined), 300_000, 2_000);
    expect(ready).toBe(true);
    expect(dataFiles(`${WORK_FOLDER}/Season 02`)).toEqual(['Harbour Lights (2021) - S02E01 [WEBDL-1080p][AAC 2.0][h264]-GRPB.mp4']);
    expect(filesOf(e.unitId).map((file) => [file.origin, file.path])).toEqual([
      ['prepared', `${WORK_FOLDER}/Season 02/Harbour Lights (2021) - S02E01 [WEBDL-1080p][AAC 2.0][h264]-GRPB.mp4`],
    ]);
    expect(dataFolders('/data/staging')).not.toContain(rendition.jobId);
    // The slowest passing run: 234 s.
  }, 480_000);

  test('a transcode whose output fails the check fails its Rendition, raises transcodeFailed with its log, and leaves the library unchanged', async (ctx) => {
    after(ctx, 'S01E01 is downloaded');
    const e = await grab(2);
    const { publication, source } = await published(e.unitId);
    const name = 'Harbour Lights (2021) - S02E02 [WEBDL-1080p][AAC 2.0][h265]-GRPB.mkv';
    expect(source.path).toBe(`${WORK_FOLDER}/Season 02/${name}`);

    // Two attempts (the preparation class's limit), with backoff between them (30 s in production, E2E_LIMITS' backoffBaseMs here).
    const failed = await waitFor(
      'the Rendition to fail',
      async () => renditionsOf(source._id).find((row) => row.state === 'failed' || row.state === 'done'),
      60_000,
      1_000,
    );
    expect(failed.state).toBe('failed');
    expect(renditionsOf(source._id)).toHaveLength(1);
    const job = rows<JobRow>(d.env, 'jobs').find((row) => row._id === failed.jobId)!;
    expect(job).toMatchObject({ status: 'failed', failureCode: 'transcodeFailed', attempt: 2 });
    expect(jobRuns(failed.jobId).map((run) => run.end)).toEqual(['failed: transcodeFailed', 'failed: transcodeFailed']);

    // The ffmpeg.log is stored as the job's artifact.
    expect(job.artifactStorageId).toBeDefined();
    const stored = rows<{ _id: string; size: number }>(d.env, '_storage').find((file) => file._id === job.artifactStorageId);
    expect(stored?.size).toBeGreaterThan(0);

    // The Issue, with the failed check.
    const issue = rows<{ unitId?: string; failureCode: string; state: string; detail?: string }>(d.env, 'issues').find(
      (row) => row.unitId === e.unitId && row.state === 'open',
    );
    expect(issue).toMatchObject({ failureCode: 'transcodeFailed' });
    expect(issue!.detail).toMatch(/Output check failed: its duration is [\d.]+ s, the source's 8 s\./);

    // Nothing in the library changed: the original is there and published, and the Unit is playable with the Issue.
    expect(dataFiles(`${WORK_FOLDER}/Season 02`)).toContain(name);
    expect(dataFiles(`${WORK_FOLDER}/Season 02`).filter((file) => file.includes('S02E02'))).toEqual([name]);
    expect(rows<PublicationRow>(d.env, 'publications').find((p) => p._id === publication._id)).toMatchObject({ state: 'visible' });
    expect((await jellyfinItems(d)).some((item) => item.Path === source.path)).toBe(true);
    expect(await unitAt(2, 2)).toMatchObject({ state: 'notInTargetFormat', openIssue: { failureCode: 'transcodeFailed' } });
    expect(dataFolders('/data/staging')).not.toContain(failed.jobId);
    // The slowest passing run: 26 s.
  }, 180_000);

  /** The catalogue's release of unclear numbering: an absolute number on a standard series, listed under every query. */
  const UNCLEAR = '[Kaze] Harbour Lights - 03 (1080p) [B1C2D3E4]';

  test('Search and pick offers S01E03 a release of unclear numbering; grabbed by hand, it is imported as S01E03', async (ctx) => {
    after(ctx, 'S01E01 is downloaded');
    const e3 = await unit(3);
    const { searchAttemptId } = await mutation('api/units:searchInteractive', { unitIds: [e3.unitId] });
    const offered = await waitFor(
      'the offered results',
      async () => {
        const { lastSearch } = await query('api/units:timeline', { unitId: e3.unitId });
        return lastSearch?.searchAttemptId === searchAttemptId && lastSearch.state === 'offered' ? lastSearch : undefined;
      },
      120_000,
      500,
      async () => JSON.stringify((await query('api/units:timeline', { unitId: e3.unitId })).lastSearch),
    );
    const row = offered.candidates.find((candidate: { title: string }) => candidate.title === UNCLEAR);
    expect(row).toMatchObject({
      outcome: 'rejected',
      reason: 'wrongTitleOrEpisode',
      matchDetail: 'episode',
      matchProblem: 'schemeMismatch',
      covers: [{ unitId: e3.unitId, tmdbSeason: 1, tmdbEpisode: 3 }],
    });
    // Nothing is grabbed by itself.
    expect((await unit(3)).state).toBe('wanted');

    expect(await mutation('api/units:grabCandidate', { candidateId: row.candidateId, confirmReason: 'wrongTitleOrEpisode' })).toMatchObject({
      outcome: 'grabbed',
    });
    await waitFor(
      'S01E03 to be ready',
      async () => ((await unit(3)).state === 'ready' ? true : undefined),
      60_000,
      1_000,
      () => stuckAt(3),
    );

    expect(filesOf(e3.unitId).map((file) => file.path)).toEqual([expect.stringMatching(/\/Season 01\/Harbour Lights \(2021\) - S01E03 /)]);
    const { runs } = await query('api/units:timeline', { unitId: e3.unitId });
    expect(runs[0]).toMatchObject({ pickedBy: 'user', state: 'done', search: { trigger: 'interactive' } });
    expect(runs[0].stages.map((stage: { message: string }) => stage.message)).toContain('Imported as S01E03, as you chose.');
    // Jellyfin reads the file as S01E03 (the check at publish): no Issue.
    expect(rows<{ unitId?: string; state: string }>(d.env, 'issues').filter((issue) => issue.unitId === e3.unitId && issue.state === 'open')).toEqual([]);
    // The slowest passing run: 18 s.
  }, 240_000);

  /** The config applied since `before`, as the card shows it. */
  const applied = (before: number) =>
    waitFor(
      'the Usenet config applied',
      async () => {
        const { usenet } = await query('api/downloadClients:get');
        return usenet.configVersion > before && usenet.config === 'applied' ? usenet : undefined;
      },
      120_000,
      1_000,
    );
  /** The author's "Bonus" server: a separate Usenet system that still has the articles the provider lost. */
  const BONUS = { host: 'nntp-backup', port: 119, ssl: false, username: NNTP_BACKUP_USER, connections: 2 };

  test("the backup servers, the author's setup: the main server at Level 0, the provider's other region at 1, the Bonus server at 2", async () => {
    const before = (await query('api/downloadClients:get')).usenet.configVersion;
    // The other region: the same provider (the NNTP fake), under the main login.
    await mutation('api/downloadClients:saveUsenetBackup', {
      backupId: 'region',
      input: { host: 'nntp', port: 119, ssl: false, username: NNTP_USER, password: NNTP_PASS, connections: 2 },
      priority: 1,
    });
    await mutation('api/downloadClients:saveUsenetBackup', { backupId: 'bonus', input: { ...BONUS, password: NNTP_BACKUP_PASS }, priority: 2 });
    await applied(before);
    // `config` is what the running NZBGet loaded, not the file.
    const loaded = new Map(nzbgetRpc<{ Name: string; Value: string }[]>('config').map((option) => [option.Name.toLowerCase(), option.Value]));
    const fields = ['Host', 'Level', 'Optional', 'Active', 'CertVerification'];
    const of = (n: number) => Object.fromEntries(fields.map((field) => [field, loaded.get(`server${n}.${field}`.toLowerCase())]));
    expect([of(1), of(2), of(3)]).toEqual([
      { Host: 'nntp', Level: '0', Optional: undefined, Active: 'yes', CertVerification: 'strict' },
      { Host: 'nntp', Level: '1', Optional: 'yes', Active: 'yes', CertVerification: 'strict' },
      { Host: 'nntp-backup', Level: '2', Optional: 'yes', Active: 'yes', CertVerification: 'strict' },
    ]);
    expect(loaded.get('certcheck')).toBe('yes');
    expect([...loaded.keys()].filter((key) => /^server[4-9]\./.test(key))).toEqual([]);
    // The card shows the backup servers without their passwords; the planted-secrets check below covers the rest.
    const { usenet } = await query('api/downloadClients:get');
    expect(usenet.backupServers.map((server: Any) => [server.id, server.host, server.priority, server.hasPassword])).toEqual([
      ['region', 'nntp', 1, true],
      ['bonus', 'nntp-backup', 2, true],
    ]);
  });

  test('the backup servers: the Bonus server fills what Levels 0 and 1 lack; at its monthly limit it alone pauses, and downloads go on through them', async () => {
    const active = () => new Map(nzbgetRpc<{ NewsServers: { ID: number; Active: boolean }[] }>('status').NewsServers.map((s) => [s.ID, s.Active]));
    const volume = (id: number) => {
      const entry = nzbgetRpc<{ ServerID: number; BytesPerDays: { SizeLo: number; SizeHi: number }[] }[]>('servervolumes').find((v) => v.ServerID === id);
      return (entry?.BytesPerDays ?? []).reduce((sum, day) => sum + day.SizeHi * 2 ** 32 + day.SizeLo, 0);
    };
    /** A catalogue release given to NZBGet directly, outside the platform, and its history entry once it ends. */
    const download = async (guid: string) => {
      const nzb = exec('worker', [
        'node',
        '-e',
        `fetch('http://newznab:4120/getnzb/${guid}.nzb?apikey=${NEWZNAB_KEY}').then((r) => r.arrayBuffer()).then((b) => process.stdout.write(Buffer.from(b).toString('base64')))`,
      ]);
      const id = nzbgetRpc<number>('append', [`levels-${guid}.nzb`, nzb, '', 0, false, false, '', 0, 'FORCE', []]);
      expect(id).toBeGreaterThan(0);
      const done = await waitFor(
        `the ${guid} download`,
        async () => nzbgetRpc<{ NZBID: number; Status: string }[]>('history', [false]).find((entry) => entry.NZBID === id),
        180_000,
        1_000,
      );
      nzbgetRpc('editqueue', ['HistoryFinalDelete', '', [id]]);
      return done.Status;
    };

    // The damaged S01E02 lacks every other part on the provider (Levels 0 and 1); the Bonus server has them all.
    const bonusBefore = volume(3);
    expect(await download('hl-s01e02-bad')).toMatch(/^SUCCESS/);
    expect(volume(3)).toBeGreaterThan(bonusBefore);

    // A limit exactly the Bonus server's traffic today (the few KB of that fill): at it, only Server3 pauses.
    const used = volume(3);
    const limit = { monthlyLimitGb: used / 1e9, resetDay: 1 };
    let before = (await query('api/downloadClients:get')).usenet.configVersion;
    await mutation('api/downloadClients:saveUsenetBackup', { backupId: 'bonus', input: { ...BONUS, limit }, priority: 2 });
    await applied(before);
    const bonus = await waitFor(
      'the Bonus server paused at its limit',
      async () => (await query('api/downloadClients:get')).usenet.backupServers.find((server: Any) => server.id === 'bonus' && server.usage?.limitReached),
      120_000,
      1_000,
    );
    expect(bonus.usage.usedBytes).toBe(used);
    expect(bonus.limit).toEqual(limit);
    expect(active()).toEqual(
      new Map([
        [1, true],
        [2, true],
        [3, false],
      ]),
    );

    // A complete release goes on through Level 0; the paused Bonus server carries nothing.
    const [mainBefore, pausedBefore] = [volume(1), volume(3)];
    expect(await download('hl-s01e02')).toMatch(/^SUCCESS/);
    expect(volume(1)).toBeGreaterThan(mainBefore);
    expect(volume(3)).toBe(pausedBefore);

    // The limit removed: the apply resumes Server3, though no option in the file changed.
    before = (await query('api/downloadClients:get')).usenet.configVersion;
    await mutation('api/downloadClients:saveUsenetBackup', { backupId: 'bonus', input: BONUS, priority: 2 });
    await applied(before);
    await waitFor('Server3 active again', async () => (active().get(3) === true ? true : undefined), 120_000, 1_000);
    const { usenet } = await query('api/downloadClients:get');
    expect(usenet.backupServers.find((server: Any) => server.id === 'bonus')).not.toHaveProperty('usage');
    expect(active()).toEqual(
      new Map([
        [1, true],
        [2, true],
        [3, true],
      ]),
    );
  });

  test('no planted secret is in the support bundle, the worker or backend output, or any public function output the run read', async (ctx) => {
    // The bundle holds the failed transcode's Issue.
    after(ctx, 'a transcode whose output fails the check');
    const before = (await status()) as SystemStatus & { supportBundle?: { builtAt: number; url: string } };
    await mutation('api/system:buildSupportBundle', {});
    const bundle = await waitFor(
      'the support bundle',
      async () => {
        const { supportBundle } = (await status()) as SystemStatus & { supportBundle?: { builtAt: number; url: string } };
        return supportBundle && supportBundle.builtAt !== before.supportBundle?.builtAt ? supportBundle : undefined;
      },
      120_000,
      500,
      // Its maintenance job, if it hasn't ended.
      () =>
        JSON.stringify(
          rows<JobRow & { idempotencyKey: string }>(d.env, 'jobs')
            .filter((job) => job.class === 'maintenance' && job.status !== 'done')
            .map(({ status, attempt, failureCode, lastError, idempotencyKey }) => ({ status, attempt, failureCode, lastError, idempotencyKey })),
        ),
    );
    // The storage URL may carry the backend's own origin; the test reaches the backend at the deployment's URL.
    const stored = new URL(bundle.url, d.url);
    const response = await fetch(new URL(`${stored.pathname}${stored.search}`, d.url));
    expect(response.status).toBe(200);
    const text = gunzipSync(Buffer.from(await response.arrayBuffer())).toString('utf8');
    const content = JSON.parse(text);
    expect(content).toMatchObject({ format: 'omnarr-support-bundle/1', worker: { logs: expect.any(Array) }, backend: { events: expect.any(Array) } });
    // It holds what the run went through: the failed transcode, and the jobs without their payloads.
    expect(JSON.stringify(content.backend.issues)).toContain('transcodeFailed');
    expect(content.backend.jobs.length).toBeGreaterThan(0);

    const controlSecrets = exec('worker', ['sh', '-c', 'for f in /run/omnarr/secrets/*; do cat "$f"; echo; done'])
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length >= 8);
    const jellyfinKey = rows<{ apiKey?: string }>(d.env, 'jellyfinServer')[0]?.apiKey;
    expect(jellyfinKey).toBeDefined();
    // The one list, which the failure dump scrubs too (stack.ts).
    const planted = plantedSecrets(d.env);
    expect(planted).toEqual(expect.arrayContaining([jellyfinKey!, ...controlSecrets]));
    expect(controlSecrets.length).toBeGreaterThanOrEqual(2);

    const places: [string, string][] = [
      ['the support bundle', text],
      ["the worker's output", logs('worker')],
      ["the backend's output", logs('backend')],
      ['the public function outputs', outputs.join('\n')],
    ];
    const found = places.flatMap(([place, body]) => planted.filter((value) => body.includes(value)).map((value) => `${place}: ${value.slice(0, 4)}…`));
    expect(found).toEqual([]);
  }, 180_000);
});
