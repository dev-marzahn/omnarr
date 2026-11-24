// Deleting a Work. `start` stops what
// runs for it: its Units are unmonitored, so no new search or RSS grab
// starts, its active Grabs are cancelled, and its pending preparations too.
// `purge` waits until none of that is left, then deletes the Work's rows in
// pages, its blocklist and metadata rows included, and its stored images through
// `images.remove`. A torrent still seeding keeps its Grab and Download rows
// until the Download is removed, which tolerates the missing Work.
// With `deleteFiles`, the library files go first, by a `deleteLibraryFiles`
// job that has Jellyfin forget the Work folder; it also removes the
// Work's kept originals (its folder's originals/ twin) and the
// folders the deletion emptied.
//
// No row is left behind: every search attempt a Unit's events name
// goes, not only its last one, and the jobs and workflow records of what is
// deleted go with it. Each page stops once it has read and written
// `PAGE_BUDGET` documents, and reads each event once, so a Work with years
// of searches never passes Convex's read or write limits.
// A job still queued or running then (the purge's own `deleteLibraryFiles`
// included), and a seeding torrent's kept Grab, are handed to `sweep`, which
// deletes each once it has ended, the Grab once its Download is removed.
// A torrent still seeding isn't stuck, so its time doesn't count. What is
// still there `orphanSweepMaxMs` later is raised as one `orphanAfterDelete`
// Issue, whose `removeOrphans` deletes the jobs and asks the client again
// for a torrent it still has (`removeOrphans` below).
import { DEFAULT_LIMITS } from '@omnarr/contracts';
import { v } from 'convex/values';

import { internal } from '../_generated/api';
import type { Doc, Id, TableNames } from '../_generated/dataModel';
import { internalMutation, type MutationCtx } from '../_generated/server';
import { enqueueJob } from '../jobs/queue';
import { raiseIssue, type OrphanRows } from '../lib/issues';
import { cancelGrab } from '../pipeline/grabs';
import { cancelForUnit, originalsTwin } from '../pipeline/preparation';
import { deleteEndedJob, deleteJobRow, ended, jobsByKey } from '../pipeline/retention';
import { workflow } from '../pipeline/workflow';
import { workFolderPathOf } from './naming';
import { isSeeding } from './read';

/**
 * Documents a purge page reads plus writes before it hands on to the next
 * page: a deleted row counts as one read and one write, a lookup as one
 * read. Convex allows 16 000 writes and fewer reads than that in no
 * transaction, so 4 000 together stays well inside both. One step may go
 * past the budget by what it does at once (a page of 500 events, a search
 * attempt's candidates), which the margin absorbs.
 */
export const PAGE_BUDGET = 4000;
/** The budget a page starts with; a test lowers it so a few hundred rows span pages. */
export const purgeBudget = { rows: PAGE_BUDGET };
/** How long `purge` waits before it looks again for a run, search or preparation of the Work. */
export const PURGE_RETRY_MS = 30_000;

/** What a page couldn't delete yet: `sweep` deletes it once it has ended. */
type Leftovers = { jobIds: Set<Id<'jobs'>>; grabIds: Set<Id<'grabs'>> };
const noLeftovers = (): Leftovers => ({ jobIds: new Set(), grabIds: new Set() });

/** The rows a page may still delete; a step charges what it deleted. */
type Budget = { readonly spent: boolean; charge: (rows: number) => void };
function newBudget(rows: number): Budget {
  let left = rows;
  return {
    get spent() {
      return left <= 0;
    },
    charge: (deleted) => {
      left -= deleted;
    },
  };
}

/** `library.deleteWork`: stops the Work's runs and schedules the purge. */
export async function start(ctx: MutationCtx, workId: Id<'works'>, deleteFiles: boolean): Promise<void> {
  const units = await unitsOf(ctx, workId);
  for (const unit of units) if (unit.monitored) await ctx.db.patch(unit._id, { monitored: false });
  for (const grabId of new Set(units.map((unit) => unit.activeGrabId).filter((id) => id !== undefined))) await cancelGrab(ctx, grabId);
  for (const unit of units) await cancelForUnit(ctx, unit._id);
  await ctx.scheduler.runAfter(0, internal.library.deleteWork.purge, { workId, deleteFiles, started: false });
}

const unitsOf = (ctx: MutationCtx, workId: Id<'works'>) =>
  ctx.db
    .query('units')
    .withIndex('by_work', (q) => q.eq('workId', workId))
    .collect();

const fileIdsOf = async (ctx: MutationCtx, unitId: Id<'units'>) =>
  (
    await ctx.db
      .query('fileUnits')
      .withIndex('by_unit', (q) => q.eq('unitId', unitId))
      .collect()
  ).map((link) => link.fileId);

/** A Grab, search or preparation of the Work that hasn't ended yet. */
async function busy(ctx: MutationCtx, units: Doc<'units'>[]): Promise<boolean> {
  for (const unit of units) {
    if (unit.activeGrabId) return true;
    const attempt = unit.lastSearchAttemptId && (await ctx.db.get(unit.lastSearchAttemptId));
    if (attempt && attempt.state === 'running') return true;
    for (const fileId of await fileIdsOf(ctx, unit._id)) {
      const pending = await ctx.db
        .query('renditions')
        .withIndex('by_source_file', (q) => q.eq('sourceFileId', fileId))
        .filter((q) => q.eq(q.field('state'), 'pending'))
        .first();
      if (pending) return true;
    }
  }
  return false;
}

/** Every library file of the Work and its sidecars. */
async function libraryPaths(ctx: MutationCtx, units: Doc<'units'>[]): Promise<string[]> {
  const paths: string[] = [];
  const seen = new Set<Id<'files'>>();
  for (const unit of units)
    for (const fileId of await fileIdsOf(ctx, unit._id)) {
      if (seen.has(fileId)) continue;
      seen.add(fileId);
      const file = await ctx.db.get(fileId);
      if (file) paths.push(file.path, ...(file.sidecars ?? []).map((sidecar) => sidecar.path));
    }
  return paths;
}

export const purge = internalMutation({
  args: { workId: v.id('works'), deleteFiles: v.boolean(), started: v.boolean() },
  returns: v.null(),
  handler: async (ctx, { workId, deleteFiles, started }) => {
    await purgePage(ctx, workId, started, deleteFiles);
    return null;
  },
});

/** One page of the purge: the body of `purge`, apart so a test can count its reads. */
export async function purgePage(ctx: MutationCtx, workId: Id<'works'>, started: boolean, deleteFiles = false): Promise<null> {
  const work = await ctx.db.get(workId);
  if (!work) return null;
  if (!started) {
    const units = await unitsOf(ctx, workId);
    // Never delete rows under a running Grab: look again once it has ended.
    if (await busy(ctx, units)) {
      await ctx.scheduler.runAfter(PURGE_RETRY_MS, internal.library.deleteWork.purge, { workId, deleteFiles, started: false });
      return null;
    }
    if (deleteFiles) {
      const library = (await ctx.db.get(work.libraryId))!;
      const folder = await workFolderPathOf(ctx, library, work);
      const jobId = await enqueueJob(ctx, {
        payload: {
          class: 'maintenance',
          action: 'deleteLibraryFiles',
          paths: await libraryPaths(ctx, units),
          libraryId: library._id,
          folders: [folder],
          originalsFolder: originalsTwin(library, folder),
        },
        idempotencyKey: `deleteLibraryFiles:work:${workId}`,
      });
      // The worker still has to run it: it is the sweep's from now on.
      await scheduleSweep(ctx, { jobIds: new Set([jobId]), grabIds: new Set() }, Date.now());
    }
  }

  const left = noLeftovers();
  const budget = newBudget(purgeBudget.rows);
  for (;;) {
    const unit = await ctx.db
      .query('units')
      .withIndex('by_work', (q) => q.eq('workId', workId))
      .first();
    if (!unit) break;
    // A Unit that didn't fit in the budget keeps its row, so the next page picks it up where this one stopped.
    if (!(await deleteUnit(ctx, unit, left, budget))) break;
    if (budget.spent) break;
  }
  await scheduleSweep(ctx, left, Date.now());
  if (budget.spent) {
    await ctx.scheduler.runAfter(0, internal.library.deleteWork.purge, { workId, deleteFiles, started: true });
    return null;
  }
  await deleteWorkRows(ctx, workId);
  return null;
}

/** Hands rows to the sweep: `since` is their own clock, `deletedAt` the delete's, which a seeding torrent's limit counts from. */
async function scheduleSweep(ctx: MutationCtx, left: Leftovers, since: number, deletedAt = since): Promise<void> {
  if (left.jobIds.size === 0 && left.grabIds.size === 0) return;
  await ctx.scheduler.runAfter(DEFAULT_LIMITS.orphanSweepRetryMs, internal.library.deleteWork.sweep, {
    jobIds: [...left.jobIds],
    grabIds: [...left.grabIds],
    since,
    deletedAt,
  });
}

/**
 * The seeding torrent's Download: `completed`, still watched, and nobody has
 * asked the client to remove it yet. That is the normal life of a seeding
 * torrent, which can last 14 days or more. Once `seedingEnded` asks
 * for its removal, or it was never watched, it is no longer seeding here.
 */
async function seedingDownloadOf(ctx: MutationCtx, grabId: Id<'grabs'>): Promise<Doc<'downloads'> | null> {
  const downloads = await ctx.db
    .query('downloads')
    .withIndex('by_grab', (q) => q.eq('grabId', grabId))
    .collect();
  for (const download of downloads) {
    if (!isSeeding(download)) continue;
    if ((await jobsByKey(ctx, `removeDownload:${download._id}`)).length === 0) return download;
  }
  return null;
}

/**
 * How long a torrent may seed after its Work was deleted before it counts
 * as stuck: its goal's seed time plus `orphanSweepMaxMs`, or
 * `orphanSeedingMaxMs` when its goal has no time. This limit never restarts,
 * so a client that never answers is caught too.
 */
const seedingLimitMs = (download: Doc<'downloads'>) =>
  download.seedGoal?.seedTimeMs !== undefined ? download.seedGoal.seedTimeMs + DEFAULT_LIMITS.orphanSweepMaxMs : DEFAULT_LIMITS.orphanSeedingMaxMs;

/**
 * What a deleted Work's purge left: jobs that hadn't ended (a run's clean-up
 * still queued, the purge's `deleteLibraryFiles`, a publish of a prepared
 * file) and the Grabs of torrents still seeding. Each goes once it has
 * ended, a Grab once its Download is `removed`; the rest is looked at again
 * hourly.
 *
 * Two clocks. `since` starts when the rows were handed over (again after
 * `removeOrphans`): jobs and Grabs that stopped seeding are stuck once it
 * passes `orphanSweepMaxMs`, for example a removal the client refused
 * (`seedingEnded` asks only once) or a worker that never came back.
 * `deletedAt` starts at the delete and never restarts: a torrent still
 * seeding isn't stuck until it passes `seedingLimitMs`, which also catches a
 * client that was uninstalled or never answers, so its row never changes.
 * What is stuck is raised as one `orphanAfterDelete` Issue, and the sweep
 * stops for it.
 */
export const sweep = internalMutation({
  args: { jobIds: v.array(v.id('jobs')), grabIds: v.array(v.id('grabs')), since: v.number(), deletedAt: v.optional(v.number()) },
  returns: v.null(),
  handler: async (ctx, { jobIds, grabIds, since, deletedAt = since }) => {
    const now = Date.now();
    const left = noLeftovers();
    // The sweep deletes few rows, so its budget is only for deleteGrab's signature.
    const budget = newBudget(Number.POSITIVE_INFINITY);
    for (const jobId of jobIds) await deleteJob(ctx, left, jobId);
    for (const grabId of grabIds) await deleteGrab(ctx, grabId, left, budget);

    const stuck: OrphanRows = { jobIds: [], grabIds: [] };
    const waiting = noLeftovers();
    const pastSince = now - since >= DEFAULT_LIMITS.orphanSweepMaxMs;
    for (const jobId of left.jobIds) {
      if (pastSince) stuck.jobIds.push(jobId);
      else waiting.jobIds.add(jobId);
    }
    for (const grabId of left.grabIds) {
      const seeding = await seedingDownloadOf(ctx, grabId);
      const isStuck = seeding ? now - deletedAt >= seedingLimitMs(seeding) : pastSince;
      if (isStuck) stuck.grabIds.push(grabId);
      else waiting.grabIds.add(grabId);
    }
    await scheduleSweep(ctx, waiting, since, deletedAt);
    if (stuck.jobIds.length > 0 || stuck.grabIds.length > 0) await raiseOrphans(ctx, stuck);
    return null;
  },
});

async function raiseOrphans(ctx: MutationCtx, rows: OrphanRows): Promise<void> {
  const parts = [];
  if (rows.jobIds.length > 0) parts.push(`${rows.jobIds.length} job${rows.jobIds.length === 1 ? '' : 's'} that never ended`);
  if (rows.grabIds.length > 0) parts.push(`${rows.grabIds.length} torrent run${rows.grabIds.length === 1 ? '' : 's'} whose torrent was never removed`);
  await raiseIssue(ctx, {
    code: 'orphanAfterDelete',
    detail: `A deleted series or movie left ${parts.join(' and ')}.`,
    orphanRows: rows,
  });
}

/**
 * `removeOrphans`: the jobs an `orphanAfterDelete` Issue names go,
 * ended or not. A queued job is never claimed then; a leased one's result
 * is refused as a stale lease, since its row is gone.
 *
 * A kept Grab's rows never go while the client may still have its torrent:
 * that would leave the torrent unwatched, to come back as `orphanClientItem`
 * with its data on disk. Instead the client is asked again to remove it (a
 * fresh `removeDownload`, with its data once the goal was met or its Grab
 * is done), and the
 * sweep, with a new clock, deletes the rows once the Download is `removed`.
 * Only a Grab with no Download left in a client goes at once.
 */
export async function removeOrphans(ctx: MutationCtx, rows: OrphanRows): Promise<void> {
  for (const jobId of rows.jobIds) {
    const job = await ctx.db.get(jobId);
    if (job) await deleteJobRow(ctx, job);
  }
  const again = noLeftovers();
  for (const grabId of rows.grabIds) {
    const inClient = (
      await ctx.db
        .query('downloads')
        .withIndex('by_grab', (q) => q.eq('grabId', grabId))
        .collect()
    ).filter((download) => download.state !== 'removed' && download.clientRef !== undefined);
    if (inClient.length === 0) {
      await deleteGrab(ctx, grabId, noLeftovers(), newBudget(Number.POSITIVE_INFINITY), { force: true });
      continue;
    }
    for (const download of inClient) await askRemovalAgain(ctx, download);
    again.grabIds.add(grabId);
  }
  await scheduleSweep(ctx, again, Date.now());
}

/** A new `removeDownload` for the Download, under its usual key: the ended one it replaces goes first. */
async function askRemovalAgain(ctx: MutationCtx, download: Doc<'downloads'>): Promise<void> {
  const idempotencyKey = `removeDownload:${download._id}`;
  const asked = await jobsByKey(ctx, idempotencyKey);
  // One still queued or running is the client being asked already.
  if (asked.some((job) => !ended(job))) return;
  for (const job of asked) await deleteJobRow(ctx, job);
  // As `seedingEnded` decides: the data goes once the goal was met or the Grab is done, never while it is the only copy.
  const grab = await ctx.db.get(download.grabId);
  await enqueueJob(ctx, {
    payload: {
      class: 'maintenance',
      action: 'removeDownload',
      downloadId: download._id,
      clientKind: download.clientKind,
      clientRef: download.clientRef!,
      deleteData: download.seedingDoneAt !== undefined || grab?.state === 'done',
      ...(download.correlationTag ? { correlationTag: download.correlationTag } : {}),
    },
    idempotencyKey,
    grabId: download.grabId,
  });
}

/** Each row read and deleted: one read and one write. */
async function deleteAll<T extends TableNames>(ctx: MutationCtx, rows: { _id: Id<T> }[], budget?: Budget): Promise<void> {
  for (const row of rows) await ctx.db.delete(row._id);
  budget?.charge(2 * rows.length);
}

/** An ended job goes with its progress; one still queued or running is left to `sweep`, so its effect still happens. */
async function deleteJob(ctx: MutationCtx, left: Leftovers, jobId: Id<'jobs'> | undefined, budget?: Budget): Promise<void> {
  const job = jobId ? await ctx.db.get(jobId) : null;
  budget?.charge(1);
  if (!job) return;
  if (await deleteEndedJob(ctx, job)) budget?.charge(1);
  else left.jobIds.add(job._id);
}

async function deleteJobsByKey(ctx: MutationCtx, left: Leftovers, idempotencyKey: string, budget: Budget): Promise<void> {
  for (const job of await jobsByKey(ctx, idempotencyKey)) await deleteJob(ctx, left, job._id, budget);
}

/**
 * The Unit's events, oldest first, a page at a time: each goes with the
 * search attempt it names (every search appends a `searchAttempt` event for
 * each of its Units), so every event is read once, whatever page it falls
 * in, and an attempt is looked up once per event that names it.
 */
async function deleteEventsAndAttempts(ctx: MutationCtx, unitId: Id<'units'>, budget: Budget): Promise<boolean> {
  for (;;) {
    if (budget.spent) return false;
    const page = await ctx.db
      .query('events')
      .withIndex('by_unit_at', (q) => q.eq('unitId', unitId))
      .take(PAGE_OF_ROWS);
    budget.charge(page.length);
    for (const event of page) {
      // Checked per event: one attempt can carry hundreds of candidates. The rest of the page is read again next time.
      if (budget.spent) return false;
      const attemptId = event.data?.entity === 'searchAttempt' && event.data.entityId ? ctx.db.normalizeId('searchAttempts', event.data.entityId) : null;
      if (attemptId) await deleteAttempt(ctx, attemptId, budget);
      await ctx.db.delete(event._id);
      budget.charge(1);
    }
    if (page.length < PAGE_OF_ROWS) return true;
  }
}

/**
 * Deletes the Unit and what is its own, in steps whose order makes it
 * resumable: its events with the search attempts they name, then its Grabs,
 * files and the rows by Unit, its play reports, and the Unit itself once all
 * of that is gone. Every read and write is charged to the budget. Returns
 * whether the Unit is gone; when the budget runs out first, the next page
 * carries on from the step it reached.
 */
async function deleteUnit(ctx: MutationCtx, unit: Doc<'units'>, left: Leftovers, budget: Budget): Promise<boolean> {
  const unitId = unit._id;
  if (unit.lastSearchAttemptId) await deleteAttempt(ctx, unit.lastSearchAttemptId, budget);
  if (!(await deleteEventsAndAttempts(ctx, unitId, budget))) return false;

  const grabLinks = await ctx.db
    .query('grabUnits')
    .withIndex('by_unit', (q) => q.eq('unitId', unitId))
    .collect();
  budget.charge(grabLinks.length);
  for (const link of grabLinks) {
    if (budget.spent) return false;
    await deleteGrab(ctx, link.grabId, left, budget);
  }

  const fileIds = await fileIdsOf(ctx, unitId);
  budget.charge(fileIds.length);
  for (const fileId of fileIds) {
    if (budget.spent) return false;
    await deleteFileLink(ctx, fileId, unitId, left, budget);
  }
  if (budget.spent) return false;
  const byUnit = <T extends 'fileVersions' | 'publications' | 'issues' | 'unitMetadata' | 'unitMappings' | 'externalIds'>(table: T) =>
    ctx.db
      .query(table as 'fileVersions')
      .withIndex('by_unit', (q) => q.eq('unitId', unitId))
      .collect();
  // A publish job, the run's or a prepared file's, is found through its Publications: read once, deleted after their jobs.
  const publications = (await byUnit('publications')) as unknown as Doc<'publications'>[];
  for (const publication of publications) await deleteJob(ctx, left, publication.jobId, budget);
  await deleteAll(ctx, publications, budget);
  for (const table of ['fileVersions', 'issues', 'unitMetadata', 'unitMappings', 'externalIds'] as const) await deleteAll(ctx, await byUnit(table), budget);

  // Play reports grow without bound too: in pages. Events written since the first step (none should be) go with them.
  if (!(await deleteEventsAndAttempts(ctx, unitId, budget))) return false;
  for (;;) {
    if (budget.spent) return false;
    const page = await ctx.db
      .query('playbackReports')
      .withIndex('by_unit_started', (q) => q.eq('unitId', unitId))
      .take(PAGE_OF_ROWS);
    await deleteAll(ctx, page, budget);
    if (page.length < PAGE_OF_ROWS) break;
  }
  await ctx.db.delete(unitId);
  budget.charge(1);
  return true;
}

/** Rows read and deleted at a time from a table that only grows. */
const PAGE_OF_ROWS = 500;

/** A file goes with its last Unit, with the Renditions made from it and their prepare jobs. */
async function deleteFileLink(ctx: MutationCtx, fileId: Id<'files'>, unitId: Id<'units'>, left: Leftovers, budget: Budget): Promise<void> {
  const links = await ctx.db
    .query('fileUnits')
    .withIndex('by_file', (q) => q.eq('fileId', fileId))
    .collect();
  const own = links.filter((link) => link.unitId === unitId);
  // The other Units' links are read but stay.
  budget.charge(links.length - own.length);
  await deleteAll(ctx, own, budget);
  if (links.length > own.length) return;
  const renditions = await ctx.db
    .query('renditions')
    .withIndex('by_source_file', (q) => q.eq('sourceFileId', fileId))
    .collect();
  for (const rendition of renditions) await deleteJob(ctx, left, rendition.jobId, budget);
  await deleteAll(ctx, renditions, budget);
  budget.charge(1);
  if (await ctx.db.get(fileId)) {
    await ctx.db.delete(fileId);
    budget.charge(1);
  }
}

/** The attempt with its candidates; one already gone (another Unit's group, or a Grab's) is skipped, its lookup still charged. */
async function deleteAttempt(ctx: MutationCtx, attemptId: Id<'searchAttempts'>, budget: Budget): Promise<void> {
  budget.charge(1);
  if (!(await ctx.db.get(attemptId))) return;
  await deleteAll(
    ctx,
    await ctx.db
      .query('candidates')
      .withIndex('by_attempt', (q) => q.eq('searchAttemptId', attemptId))
      .collect(),
    budget,
  );
  await ctx.db.delete(attemptId);
  budget.charge(1);
}

/**
 * A Grab with its Downloads, import, events, jobs and workflow records, and
 * the search it came from. A seeding torrent's Grab and Download stay until
 * the Download is `removed`, and `sweep` deletes them then; `force`
 * (`removeOrphans`) deletes them anyway, with jobs that never ended.
 */
async function deleteGrab(ctx: MutationCtx, grabId: Id<'grabs'>, left: Leftovers, budget: Budget, options: { force?: boolean } = {}): Promise<void> {
  const grab = await ctx.db.get(grabId);
  budget.charge(1);
  await deleteAll(
    ctx,
    await ctx.db
      .query('grabUnits')
      .withIndex('by_grab', (q) => q.eq('grabId', grabId))
      .collect(),
    budget,
  );
  if (!grab) return;
  const candidate = await ctx.db.get(grab.candidateId);
  budget.charge(1);
  if (candidate) await deleteAttempt(ctx, candidate.searchAttemptId, budget);
  const downloads = await ctx.db
    .query('downloads')
    .withIndex('by_grab', (q) => q.eq('grabId', grabId))
    .collect();
  if (!options.force && downloads.some((download) => download.clientKind === 'qbittorrent' && download.state === 'completed')) {
    // Read, and kept for the sweep.
    budget.charge(downloads.length);
    left.grabIds.add(grabId);
    return;
  }
  for (const download of downloads) {
    await deleteJob(ctx, left, download.jobId, budget);
    await deleteJobsByKey(ctx, left, `removeDownload:${download._id}`, budget);
  }
  await deleteAll(ctx, downloads, budget);
  const imports = await ctx.db
    .query('importJobs')
    .withIndex('by_grab', (q) => q.eq('grabId', grabId))
    .collect();
  for (const row of imports) await deleteJob(ctx, left, row.jobId, budget);
  await deleteAll(ctx, imports, budget);
  for (const key of [`${grabId}:download.submit`, `${grabId}:import`, `cleanStaging:${grabId}`]) await deleteJobsByKey(ctx, left, key, budget);
  if (options.force) await removeOrphans(ctx, { jobIds: [...left.jobIds], grabIds: [] });
  // The run has ended (purge waits for it), so its records can go; retention may have taken them already.
  if (grab.workflowId) await workflow.cleanup(ctx, grab.workflowId);
  for (;;) {
    const page = await ctx.db
      .query('events')
      .withIndex('by_grab_at', (q) => q.eq('grabId', grabId))
      .take(PAGE_OF_ROWS);
    await deleteAll(ctx, page, budget);
    if (page.length < PAGE_OF_ROWS) break;
  }
  await ctx.db.delete(grabId);
  budget.charge(1);
}

/** The Work's own rows, last: its blocklist, its metadata rows, its images (through `images.remove`) and the Work. */
async function deleteWorkRows(ctx: MutationCtx, workId: Id<'works'>): Promise<void> {
  const byWork = <T extends 'workMetadata' | 'workAliases' | 'externalIds' | 'unitMetadata' | 'images'>(table: T) =>
    ctx.db
      .query(table as 'workMetadata')
      .withIndex('by_work', (q) => q.eq('workId', workId))
      .collect();
  await deleteAll(
    ctx,
    await ctx.db
      .query('blocklist')
      .withIndex('by_work_key', (q) => q.eq('workId', workId))
      .collect(),
  );
  for (const table of ['workMetadata', 'workAliases', 'externalIds', 'unitMetadata'] as const) await deleteAll(ctx, await byWork(table));
  await deleteAll(
    ctx,
    await ctx.db
      .query('unitMappings')
      .withIndex('by_ordering', (q) => q.eq('workId', workId))
      .collect(),
  );
  const images = (await byWork('images')) as unknown as Doc<'images'>[];
  if (images.length > 0) await ctx.runMutation(internal.metadata.images.remove, { imageIds: images.map((image) => image._id) });
  await ctx.db.delete(workId);
}
