// What a job's end and a download report do to the entities they serve
//. Each handler applies its transitions through
// `transition()`; the job's event is sent after it, by queue.ts.
import { sendEvent } from '@dev-marzahn/convex-workflow-migrations';
import { compare, downloadEventName, type DownloadReport, type FailureCode, type JobEventValue, type JobResult, type TargetReading } from '@omnarr/contracts';

import { components, internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { recordProviderTest } from '../downloadClients/store';
import { applySetupResult } from '../jellyfin/setup';
import { recomputeUnits } from '../lib/derivedState';
import { appendEvent } from '../lib/events';
import { workerError } from '../lib/functions';
import { raiseIssue, resolveIssuesForUnit, resolveSystemIssue } from '../lib/issues';
import { transition, unitsOfGrab } from '../lib/stateMachine';
import { checked, enqueueFileCheck, resolveFileMissingOnceAFileOfItPlays } from '../library/missingFiles';
import { moved, renamed } from '../library/naming';
import { metadataPool } from '../metadata/pool';
import { prepared, prepareEnded, retireOldVersions } from '../pipeline/preparation';
import { targetOf } from '../playback/target';
import { enqueueJob } from './queue';

type ResultOf<C extends JobResult['class']> = Extract<JobResult, { class: C }>;

/** The client accepted the release: the Grab is `downloading`, and the Download knows the client's reference. */
export async function downloadSubmitted(ctx: MutationCtx, job: Doc<'jobs'>, result: ResultOf<'download.submit'>): Promise<void> {
  if (!job.grabId) return;
  const download = await ctx.db
    .query('downloads')
    .withIndex('by_grab', (q) => q.eq('grabId', job.grabId!))
    .filter((q) => q.eq(q.field('jobId'), job._id))
    .first();
  if (download) await ctx.db.patch(download._id, { clientRef: result.clientRef });
  const grab = await ctx.db.get(job.grabId);
  if (grab?.state === 'submitting')
    await transition(ctx, 'grab', grab._id, 'downloading', { kind: 'stageFinished', message: 'The download client accepted the release.' });
}

const STAGE_TEXT = { queued: 'Queued in the download client.', downloading: 'Downloading.', postProcessing: 'Repairing and unpacking.' } as const;

/**
 * A new client stage: no state change, but a `download` event, so repair and
 * unpack have start and end times on the timeline, and the Units follow it.
 */
export async function downloadProgress(ctx: MutationCtx, download: Doc<'downloads'>, report: DownloadReport[number]): Promise<void> {
  if (report.clientStage === undefined || report.clientStage === download.clientStage) {
    await ctx.db.patch(download._id, { clientStatus: report.clientStatus });
    return;
  }
  await ctx.db.patch(download._id, { clientStage: report.clientStage, clientStatus: report.clientStatus });
  await appendEvent(ctx, {
    grabId: download.grabId,
    stage: 'download',
    kind: 'stageStarted',
    message: STAGE_TEXT[report.clientStage],
    data: { entity: 'download', entityId: download._id, from: download.clientStage, to: report.clientStage },
  });
  await recomputeUnits(ctx, await unitsOfGrab(ctx, download.grabId));
}

const CLIENT_NAME = { nzbget: 'NZBGet', qbittorrent: 'qBittorrent' } as const;

/**
 * What an `unknownClientFailure` says: the client's raw status,
 * or that the item went missing (the reconciler reports the stage `missing`).
 */
export function unknownFailureDetail(download: Pick<Doc<'downloads'>, 'clientKind' | 'clientStatus'>): string {
  const client = CLIENT_NAME[download.clientKind];
  const stage = download.clientStatus?.stage;
  if (stage === undefined || stage === 'missing') return `The download is no longer listed in ${client}.`;
  return `${client} ended the download with status ${stage}.`;
}

/**
 * The download ended in its client. A completed one moves the Grab on to
 * importing; one deleted in the client ends the run as a cancel would.
 * Either way the run's download event is sent, once, and only while the
 * Grab still waits for it. A failure the worker has no code for is
 * `unknownClientFailure`, never a bad release, with the client's raw status
 * in the event.
 */
export async function downloadDone(
  ctx: MutationCtx,
  download: Doc<'downloads'>,
  report: DownloadReport[number] & { outcome: 'completed' | 'failed' | 'stalled' | 'removed' },
): Promise<void> {
  const grab = await ctx.db.get(download.grabId);
  if (download.state !== 'active') return;
  await ctx.db.patch(download._id, {
    clientStatus: report.clientStatus,
    ...(report.contentPath ? { contentPath: report.contentPath } : {}),
    // A completed torrent's private flag decides whether a failed Grab still seeds it out.
    ...(report.outcome === 'completed' && report.private !== undefined ? { private: report.private } : {}),
  });
  const failed = report.outcome === 'failed' || report.outcome === 'stalled';
  const failureCode: FailureCode | undefined = !failed
    ? undefined
    : (report.failureCode ?? (report.outcome === 'stalled' ? 'torrentStalled' : 'unknownClientFailure'));
  const unknown = failureCode === 'unknownClientFailure';
  const MESSAGES = {
    completed: 'The download finished.',
    failed: 'The download failed in the client.',
    stalled: 'The download stalled.',
    removed: 'The download was deleted in the client.',
  };
  await transition(ctx, 'download', download._id, report.outcome, {
    kind: report.outcome === 'completed' ? 'stageFinished' : report.outcome === 'removed' ? 'cancelled' : 'stageFailed',
    message: MESSAGES[report.outcome],
    ...(failureCode ? { failureCode } : {}),
    ...(unknown ? { detail: unknownFailureDetail({ clientKind: download.clientKind, clientStatus: report.clientStatus }) } : {}),
  });
  // A cancel already sent the download event.
  if (grab?.state !== 'downloading' || grab.cancelRequested || !grab.workflowId || !download.jobId) return;
  if (report.outcome === 'completed') await transition(ctx, 'grab', grab._id, 'importing', { kind: 'stageStarted', message: 'Importing the download.' });
  const outcome = report.outcome === 'completed' ? 'done' : report.outcome === 'removed' ? 'cancelled' : 'failed';
  const value: JobEventValue = { outcome, jobId: download.jobId, ...(failureCode ? { failureCode } : {}) };
  await sendEvent(ctx, components.workflow, { workflowId: grab.workflowId, name: downloadEventName(download._id), value });
}

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const plural = (n: number, unit: string) => `${n} ${unit}${n === 1 ? '' : 's'}`;

/** "14 days", "5 hours", "1 minute": the largest whole unit, for the seeding event. */
export function seedTimeText(ms: number): string {
  if (ms >= DAY) return plural(Math.floor(ms / DAY), 'day');
  if (ms >= HOUR) return plural(Math.floor(ms / HOUR), 'hour');
  return plural(Math.max(1, Math.floor(ms / MINUTE)), 'minute');
}

const FINAL_GRAB = new Set(['done', 'failed', 'cancelled']);

/**
 * A completed torrent's seeding ended: its goal was met
 * (`seedingDone`), or qBittorrent lost its files or the torrent
 * (`seedingLost`). Only once its Grab has ended, so import never loses its
 * source; while the Grab runs, the report is ignored and comes again on the
 * next pass. Then the torrent leaves the client under one key, so a
 * repeated report is harmless. Its data goes with it when the goal was met,
 * or when its Grab is `done`: a lost torrent in error can still have every
 * file on disk, and once it leaves the client nothing would remove them,
 * while a done Grab's library keeps its own hard link or copy. A lost
 * torrent of a failed or cancelled Grab keeps its data: a Grab that failed
 * on a system error (a share that dropped, which qBittorrent then reports as
 * missing files) was never imported, and "Retry this release" imports it
 * from there. No unit-scope Issue: every Unit already has its file. A
 * deleted Work changes nothing here.
 */
export async function seedingEnded(
  ctx: MutationCtx,
  download: Doc<'downloads'>,
  report: DownloadReport[number] & { outcome: 'seedingDone' | 'seedingLost' },
): Promise<void> {
  const grab = await ctx.db.get(download.grabId);
  if (grab && !FINAL_GRAB.has(grab.state)) return;
  const idempotencyKey = `removeDownload:${download._id}`;
  const asked = await ctx.db
    .query('jobs')
    .withIndex('by_idempotency_key', (q) => q.eq('idempotencyKey', idempotencyKey))
    .first();
  if (asked) return;
  const met = report.outcome === 'seedingDone';
  await ctx.db.patch(download._id, { clientStatus: report.clientStatus, ...(met ? { seedingDoneAt: Date.now() } : {}) });
  const message = met
    ? `Seeding goal met: ratio ${Number((report.seedRatio ?? 0).toFixed(2))}, ${seedTimeText(report.seedTimeMs ?? 0)}`
    : 'Seeding stopped: files missing';
  await appendEvent(ctx, { grabId: download.grabId, stage: 'download', kind: 'stageFinished', message, data: { entity: 'download', entityId: download._id } });
  if (!download.clientRef) return;
  await enqueueJob(ctx, {
    payload: {
      class: 'maintenance',
      action: 'removeDownload',
      downloadId: download._id,
      clientKind: download.clientKind,
      clientRef: download.clientRef,
      deleteData: met || grab?.state === 'done',
      correlationTag: download.correlationTag,
    },
    idempotencyKey,
    grabId: download.grabId,
  });
}

/** `S03E02`, or `the movie`, as the timeline names a Unit. */
const episodeLabel = (unit: { season?: number; episode?: number }) =>
  unit.season !== undefined && unit.episode !== undefined ? `S${pad(unit.season)}E${pad(unit.episode)}` : 'the movie';

/**
 * The import recorded its files: a source file per path with the release it
 * came from, its Units, and a primary version per Unit whose `fits` is the
 * file's own probe compared with the library's target; the Grab
 * moves on to publishing.
 */
export async function imported(ctx: MutationCtx, job: Doc<'jobs'>, result: ResultOf<'import'>): Promise<void> {
  if (!job.grabId || job.payload?.class !== 'import') return;
  const grab = (await ctx.db.get(job.grabId))!;
  const candidate = (await ctx.db.get(grab.candidateId))!;
  const attempt = (await ctx.db.get(candidate.searchAttemptId))!;
  const work = (await ctx.db.get(attempt.workId))!;
  const library = (await ctx.db.get(work.libraryId))!;
  const target = await targetOf(ctx, library._id);

  // An upgrade's file is `staged` beside the primary that plays: published if it fits, else prepared from staging/held/.
  const kind = grab.kind === 'upgrade' ? 'staged' : 'primary';
  const importedUnits = new Set<Id<'units'>>();
  for (const file of result.files) {
    const fits = compare(file.probe, target).fits;
    const fileId = await ctx.db.insert('files', {
      path: file.path,
      sizeBytes: file.sizeBytes,
      inode: file.inode,
      probe: file.probe,
      origin: 'download',
      role: 'source',
      release: candidate.parsed,
      candidateId: candidate._id,
    });
    for (const [part, unitId] of file.unitIds.entries()) {
      await ctx.db.insert('fileUnits', { fileId, unitId, ...(file.unitIds.length > 1 ? { part: part + 1 } : {}) });
      await ctx.db.insert('fileVersions', { unitId, fileId, kind, playbackProfileId: library.playbackProfileId, fits });
      importedUnits.add(unitId);
    }
  }

  // An optional Unit the download didn't hold is skipped too: the run's end frees it, wanted again.
  const expected = new Set(job.payload.expectedUnits.filter((unit) => !unit.optional).map((unit) => unit.unitId));
  const rows = await ctx.db
    .query('grabUnits')
    .withIndex('by_grab', (q) => q.eq('grabId', grab._id))
    .collect();
  for (const row of rows) {
    if (row.outcome !== 'pending') continue;
    // A Unit unmonitored before import stays in the Grab and is skipped.
    if (importedUnits.has(row.unitId)) await ctx.db.patch(row._id, { outcome: 'imported' });
    else if (!expected.has(row.unitId)) await ctx.db.patch(row._id, { outcome: 'skipped' });
  }

  const importJob = await ctx.db.get(job.payload.importJobId);
  // A file the user chose the Unit for says so.
  const importAs = new Set<string>(job.payload.importAs ?? []);
  const chosen = job.payload.expectedUnits.filter((unit) => importAs.has(unit.unitId));
  if (importJob?.state === 'pending')
    await transition(ctx, 'importJob', importJob._id, 'recorded', {
      kind: 'stageFinished',
      message:
        chosen.length > 0
          ? `Imported as ${chosen.map(episodeLabel).join(', ')}, as you chose.`
          : `Imported ${result.files.length} file${result.files.length === 1 ? '' : 's'}.`,
    });
  if (grab.state === 'importing') await transition(ctx, 'grab', grab._id, 'publishing', { kind: 'stageStarted', message: 'Publishing to Jellyfin.' });
  // Every `fits` write recomputes the Units.
  await recomputeUnits(ctx, [...importedUnits]);
}

const pad = (n: number | undefined) => (n === undefined ? '??' : String(n).padStart(2, '0'));

/**
 * The check at publish: why Jellyfin's reading of
 * the file isn't the Unit, as the Issue says it, or undefined when it is. An
 * episode must be one with the Unit's season and episode (a double episode's
 * range holds it), under the Work folder's series; a movie a Movie in the
 * Movies library.
 */
export function misreadOf(unit: Doc<'units'>, work: Doc<'works'>, reading: TargetReading): string | undefined {
  const fix = 'rename it to library naming.';
  if (work.kind === 'movie') return reading.kind === 'movie' ? undefined : `Jellyfin doesn't list this file as a movie in the Movies library; ${fix}`;
  if (reading.kind !== 'episode') return `Jellyfin doesn't list this file as an episode; ${fix}`;
  if (reading.otherSeries) return `Jellyfin files this file under another series than ${work.title}; ${fix}`;
  const last = reading.episodeEnd ?? reading.episode;
  const holds =
    reading.season === unit.tmdbSeason &&
    reading.episode !== undefined &&
    unit.tmdbEpisode !== undefined &&
    reading.episode <= unit.tmdbEpisode &&
    unit.tmdbEpisode <= last!;
  if (holds) return undefined;
  const read = `S${pad(reading.season)}E${pad(reading.episode)}${reading.episodeEnd === undefined ? '' : `-E${pad(reading.episodeEnd)}`}`;
  return `Jellyfin reads this file as ${read}, not S${pad(unit.tmdbSeason)}E${pad(unit.tmdbEpisode)}; ${fix}`;
}

/**
 * Whether Jellyfin may list a file version: a Publication of it is visible,
 * pending (its publish isn't settled), or has an item; or a timeline records
 * one becoming visible or misread (a misread file is in Jellyfin's library
 * under the wrong episode). A run's Publications write to its Grab's
 * timeline, others to the Unit's, so both are read: the Unit's, and those
 * of the Unit's Grabs of the file's release. Only a version whose every
 * Publication failed without either, or that has none, never played.
 */
async function everListed(ctx: MutationCtx, version: Doc<'fileVersions'>, file: Doc<'files'>): Promise<boolean> {
  const publications = (
    await ctx.db
      .query('publications')
      .withIndex('by_unit', (q) => q.eq('unitId', version.unitId))
      .collect()
  ).filter((publication) => publication.fileVersionId === version._id);
  if (publications.some((publication) => publication.state !== 'failed' || publication.targetItemRef !== undefined)) return true;
  const ids = new Set<string>(publications.map((publication) => publication._id));
  if (ids.size === 0) return false;
  // Timelines only grow, so each is read capped; past a cap the file counts as listed, which retires nothing.
  const listed = (events: Doc<'events'>[]) =>
    events.length === LISTED_READ_CAP ||
    events.some(
      (event) =>
        event.data?.entity === 'publication' &&
        ids.has(event.data.entityId ?? '') &&
        (event.data.to === 'visible' || event.data.failureCode === 'jellyfinMisread'),
    );
  const unitEvents = await ctx.db
    .query('events')
    .withIndex('by_unit_at', (q) => q.eq('unitId', version.unitId))
    .order('desc')
    .take(LISTED_READ_CAP);
  if (listed(unitEvents)) return true;
  const rows = await ctx.db
    .query('grabUnits')
    .withIndex('by_unit', (q) => q.eq('unitId', version.unitId))
    .order('desc')
    .take(LISTED_READ_CAP);
  if (rows.length === LISTED_READ_CAP) return true;
  for (const row of rows) {
    if ((await ctx.db.get(row.grabId))?.candidateId !== file.candidateId) continue;
    const grabEvents = await ctx.db
      .query('events')
      .withIndex('by_grab_at', (q) => q.eq('grabId', row.grabId))
      .order('desc')
      .take(LISTED_READ_CAP);
    if (listed(grabEvents)) return true;
  }
  return false;
}

/** How many rows `everListed` reads from each timeline and from the Unit's Grabs. */
const LISTED_READ_CAP = 500;

/**
 * Also-contained Units: a Grab's file that Jellyfin now lists
 * for the Unit retires the Unit's earlier files, but only when every one of
 * them is a primary from a download of another release that Jellyfin never
 * listed. A Unit with any `original` or `staged` version keeps everything:
 * preparation deletes a kept original's Publications, so whether it played
 * can't be read. So does a scanned file, one of the same release, or one
 * that was ever visible or misread: nothing is retired.
 */
async function retireNeverPlayed(ctx: MutationCtx, unitId: Id<'units'>, fileId: Id<'files'>): Promise<void> {
  const current = await ctx.db.get(fileId);
  const versions = await ctx.db
    .query('fileVersions')
    .withIndex('by_unit', (q) => q.eq('unitId', unitId))
    .collect();
  if (versions.some((version) => version.kind === 'original' || version.kind === 'staged')) return;
  const earlier = versions.filter((version) => version.fileId !== fileId && version.kind === 'primary');
  if (earlier.length === 0) return;
  for (const version of earlier) {
    const file = await ctx.db.get(version.fileId);
    if (!file || file.origin === 'scan' || file.candidateId === undefined || file.candidateId === current?.candidateId) return;
    if (await everListed(ctx, version, file)) return;
  }
  await retireOldVersions(ctx, unitId, fileId);
}

/**
 * Jellyfin sees the files: each Publication is visible with the item Jellyfin
 * gave it (a re-publish's new item replaces the old one), and a `staged`
 * version, a prepared file, becomes the primary. Outside a run, it also
 * resolves `jellyfinUnavailable`.
 * A file Jellyfin read as something other than its Unit isn't visible: its
 * Publication fails and `jellyfinMisread` is raised, which a later publish
 * that Jellyfin reads right resolves.
 */
export async function published(ctx: MutationCtx, job: Doc<'jobs'>, result: ResultOf<'publish'>): Promise<void> {
  if (job.payload?.class !== 'publish') return;
  const units: Id<'units'>[] = [];
  for (const publicationId of job.payload.publicationIds) {
    const publication = await ctx.db.get(publicationId);
    if (publication?.state !== 'pending') continue;
    const version = await ctx.db.get(publication.fileVersionId);
    if (version?.kind === 'staged') {
      await ctx.db.patch(version._id, { kind: 'primary' });
      // An upgrade's file replaces the release before it, with any kept original of it.
      await retireOldVersions(ctx, publication.unitId, version.fileId);
    }
    units.push(publication.unitId);
    const reading = result.readings?.[publicationId];
    const unit = reading && (await ctx.db.get(publication.unitId));
    const work = unit && (await ctx.db.get(unit.workId));
    const misread = reading && unit && work ? misreadOf(unit, work, reading) : undefined;
    if (misread) {
      await ctx.db.patch(publicationId, { targetItemRef: undefined });
      await transition(ctx, 'publication', publicationId, 'failed', { kind: 'stageFailed', failureCode: 'jellyfinMisread', message: misread });
      await raiseIssue(ctx, {
        code: 'jellyfinMisread',
        unitId: publication.unitId,
        jobId: job._id,
        ...(job.grabId ? { grabId: job.grabId } : {}),
        detail: misread,
      });
      continue;
    }
    const targetItemRef = result.targetItemRefs[publicationId];
    if (targetItemRef) await ctx.db.patch(publicationId, { targetItemRef });
    // The Work's own item, for its "Open in Jellyfin"; a re-publish's item replaces it.
    const seriesItemRef = result.seriesItemRefs?.[publicationId];
    if (seriesItemRef) {
      const owner = unit ?? (await ctx.db.get(publication.unitId));
      const ownerWork = owner && (await ctx.db.get(owner.workId));
      if (ownerWork && ownerWork.jellyfinItemRef !== seriesItemRef) await ctx.db.patch(ownerWork._id, { jellyfinItemRef: seriesItemRef });
    }
    await transition(ctx, 'publication', publicationId, 'visible', { kind: 'stageFinished', message: 'Visible in Jellyfin.' });
    // A Grab's file, once Jellyfin lists it, replaces the Unit's earlier files that never played.
    if (job.grabId && version?.kind === 'primary') await retireNeverPlayed(ctx, publication.unitId, version.fileId);
    if (version?.kind === 'primary' || version?.kind === 'staged') await resolveFileMissingOnceAFileOfItPlays(ctx, publication.unitId, version.fileId);
    await resolveIssuesForUnit(ctx, publication.unitId, job.grabId ? ['jellyfinMisread'] : ['jellyfinUnavailable', 'jellyfinMisread']);
  }
  await recomputeUnits(ctx, units);
}

/**
 * A maintenance job's effect on its subject: a removed download is
 * `removed`; a provider test writes its outcome; a successful setup
 * goes into `jellyfinServer`, and a pushed password resolves
 * `jellyfinPasswordNotPushed`.
 */
export async function maintenance(ctx: MutationCtx, job: Doc<'jobs'>, result: ResultOf<'maintenance'>): Promise<void> {
  if (result.action === 'testUsenetServer') return await recordProviderTest(ctx, job._id, result.outcome);
  if (job.payload?.class !== 'maintenance' || job.payload.action !== result.action) return;
  switch (job.payload.action) {
    case 'removeDownload': {
      const downloadId = job.payload.downloadId;
      const download = downloadId && (await ctx.db.get(downloadId));
      if (download && download.state !== 'removed')
        await transition(ctx, 'download', download._id, 'removed', { kind: 'stageFinished', message: 'Removed from the download client.' });
      return;
    }
    case 'pushJellyfinPassword':
      await resolveSystemIssue(ctx, 'jellyfinPasswordNotPushed');
      return;
    // The bundle is the job's artifact: System links the newest one, and the artifact TTL deletes it after 14 days.
    case 'buildSupportBundle':
      if (result.action === 'buildSupportBundle') await ctx.db.patch(job._id, { artifactStorageId: result.storageId });
      return;
    case 'setupJellyfin':
      if (result.action === 'setupJellyfin') await applySetupResult(ctx, result);
      return;
    case 'renameLibraryFile':
      if (result.action === 'renameLibraryFile') await renamed(ctx, job, result);
      return;
    case 'moveLibraryFile':
      if (result.action === 'moveLibraryFile') await moved(ctx, job, result);
      return;
    case 'scanLibrary':
      if (result.action === 'scanLibrary') await scanRead(ctx, job.payload.scanRunId, result);
      return;
    case 'checkLibraryFiles':
      if (result.action === 'checkLibraryFiles') await checked(ctx, job.payload, result);
      return;
  }
}

/** The scan's read is done: the run counts what the worker found and moves on to matching, in the metadata pool. */
async function scanRead(ctx: MutationCtx, scanRunId: Id<'scanRuns'>, result: Extract<ResultOf<'maintenance'>, { action: 'scanLibrary' }>): Promise<void> {
  const run = await ctx.db.get(scanRunId);
  if (run?.state !== 'reading') return;
  await ctx.db.patch(scanRunId, { state: 'matching', counts: { ...run.counts, read: result.found, tracked: result.found - result.untracked } });
  await metadataPool.enqueueAction(ctx, internal.scan.match.run, { scanRunId });
  await enqueueFileCheck(ctx);
}

/** Dispatches a completed job's result to its class's handler; the job's event is sent after it. */
export async function applyResult(ctx: MutationCtx, job: Doc<'jobs'>, result: JobResult): Promise<void> {
  if (result.class === 'download.submit') await downloadSubmitted(ctx, job, result);
  else if (result.class === 'import') await imported(ctx, job, result);
  else if (result.class === 'prepare') await prepared(ctx, job, result);
  else if (result.class === 'publish') await published(ctx, job, result);
  else if (result.class === 'maintenance') await maintenance(ctx, job, result);
  else if (result.class === 'indexer') await indexerAnswered(ctx, job, result);
}

/**
 * An `indexer` job's answer is kept on the job for the relay, which
 * reads it and deletes the job. A search or RSS job answers `outcome`, a
 * test `test`; anything else is refused.
 */
async function indexerAnswered(ctx: MutationCtx, job: Doc<'jobs'>, result: ResultOf<'indexer'>): Promise<void> {
  const action = job.payload?.class === 'indexer' ? job.payload.action : undefined;
  const isTest = action === 'test' || action === 'testDraft';
  if (isTest ? !result.test : !result.outcome) throw workerError('invalidResult', { expected: `indexer/${action}` });
  await ctx.db.patch(job._id, isTest ? { indexerTest: result.test } : { indexerOutcome: result.outcome });
}

/** A job that ended without success: its entity fails or is cancelled (`queue.fail`). */
export async function applyEnd(
  ctx: MutationCtx,
  job: Doc<'jobs'>,
  outcome: 'failed' | 'cancelled',
  failureCode?: FailureCode,
  /** This failure's detail: `lastError` is patched onto the job only after `applyEnd`. */
  detail?: string,
): Promise<void> {
  const payload = job.payload;
  const event = { kind: outcome === 'failed' ? 'stageFailed' : 'cancelled', ...(failureCode ? { failureCode } : {}) } as const;
  if (payload?.class === 'import') {
    const importJob = await ctx.db.get(payload.importJobId);
    if (importJob?.state === 'pending')
      await transition(ctx, 'importJob', importJob._id, outcome, {
        ...event,
        message: outcome === 'failed' ? 'The import failed.' : 'The import was cancelled.',
      });
  } else if (payload?.class === 'prepare') {
    await prepareEnded(ctx, job, outcome, failureCode, detail);
  } else if (payload?.class === 'maintenance' && payload.action === 'scanLibrary') {
    const run = await ctx.db.get(payload.scanRunId);
    if (run?.state === 'reading') await ctx.db.patch(run._id, { state: outcome, finishedAt: Date.now() });
  } else if (payload?.class === 'maintenance' && payload.action === 'testUsenetServer') {
    // NZBGet unreachable on every attempt, say: the form shows the test failed.
    await recordProviderTest(ctx, job._id, 'failed');
  } else if (payload?.class === 'publish') {
    for (const publicationId of payload.publicationIds) {
      const publication = await ctx.db.get(publicationId);
      if (publication?.state === 'pending') await transition(ctx, 'publication', publicationId, 'failed', { ...event, message: 'Publishing failed.' });
    }
  }
}
