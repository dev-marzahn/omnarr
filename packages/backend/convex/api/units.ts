// Per-Unit public functions, with preparation on the item page.
import {
  Ack,
  CancelGrabRequest,
  CancelGrabResponse,
  type CandidateRow,
  type CandidateUnit,
  compare,
  type FileRow,
  GrabCandidateRequest,
  GrabCandidateResponse,
  type IssueRow,
  MisreadList,
  OFFER_TTL_MS,
  SearchInteractiveRequest,
  SearchInteractiveResponse,
  PlayRow,
  PrepareAllResponse,
  PreparationPlan,
  SearchNowRequest,
  SearchNowResponse,
  SetMonitoredRequest,
  SetMonitoredResponse,
  Timeline,
  TimelineRequest,
  type TimelineRun,
  type TimelineSearch,
  type TimelineSearchIndexer,
  type TimelineStage,
} from '@omnarr/contracts';
import { z } from 'zod';

import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { issueRow } from '../issues/rows';
import { jellyfinItemPath, jellyfinServerId } from '../jellyfin/links';
import { recomputeUnits } from '../lib/derivedState';
import { adminMutation, adminQuery } from '../lib/functions';
import { mightBeThisEpisode as mightBe } from '../library/misread';
import { fileNameOf } from '../library/naming';
import { downloadOf, isSeeding, preparationOf, seedingOf } from '../library/read';
import { stillUrlOf, workImages } from '../metadata/images';
import { blocklistEntryFor } from '../pipeline/blocklist';
import { cancelGrab as cancel } from '../pipeline/grabs';
import { coveredBy, grabCandidate as grab, searchInteractive as startInteractive } from '../pipeline/manualGrab';
import { cancelForUnit, sourceForUnit, start } from '../pipeline/preparation';
import { startSearch } from '../pipeline/search';
import { playablePrimary } from '../pipeline/upgrades';
import { targetOf } from '../playback/target';

/**
 * Monitors or unmonitors Units, by ID or as one season of a Work. A Grab
 * whose every Unit is now unmonitored is cancelled; one that still
 * covers a monitored Unit runs on and skips the others at import.
 */
export const setMonitored = adminMutation({
  args: SetMonitoredRequest.shape,
  returns: SetMonitoredResponse,
  handler: async (ctx, { target, monitored }) => {
    let units: Doc<'units'>[];
    if (target.kind === 'units') {
      units = (await Promise.all(target.unitIds.map((unitId) => ctx.db.get(unitId)))).filter((unit) => unit !== null);
    } else {
      units = await ctx.db
        .query('units')
        .withIndex('by_work_tmdb', (q) => q.eq('workId', target.workId).eq('tmdbSeason', target.season))
        .collect();
    }

    const changed = units.filter((unit) => unit.monitored !== monitored);
    for (const unit of changed) await ctx.db.patch(unit._id, { monitored });
    await recomputeUnits(
      ctx,
      changed.map((unit) => unit._id),
    );
    if (!monitored) {
      const grabIds = new Set(changed.map((unit) => unit.activeGrabId).filter((grabId) => grabId !== undefined));
      for (const grabId of grabIds) if (await everyUnitUnmonitored(ctx, grabId)) await cancel(ctx, grabId);
    }
    // A newly monitored season gets its episode stills.
    if (monitored)
      for (const workId of new Set(changed.map((unit) => unit.workId))) await ctx.scheduler.runAfter(0, internal.metadata.images.fetchForWork, { workId });
    // Monitoring aired Units again is searched by the backfill cron.
    return { changed: changed.length };
  },
});

async function everyUnitUnmonitored(ctx: Parameters<typeof cancel>[0], grabId: Id<'grabs'>): Promise<boolean> {
  const rows = await ctx.db
    .query('grabUnits')
    .withIndex('by_grab', (q) => q.eq('grabId', grabId))
    .collect();
  for (const row of rows) if ((await ctx.db.get(row.unitId))?.monitored) return false;
  return true;
}

/** "Cancel grab", with the confirm dialog's "Also blocklist this release". */
export const cancelGrab = adminMutation({
  args: CancelGrabRequest.shape,
  returns: CancelGrabResponse,
  handler: async (ctx, { grabId, blocklist }) => ({ cancelRequested: await cancel(ctx, grabId, { blocklist }) }),
});

const stageOf = (event: Doc<'events'>): TimelineStage => ({
  stage: event.stage,
  kind: event.kind,
  message: event.message,
  at: event.at,
  ...(event.data?.from ? { from: event.data.from } : {}),
  ...(event.data?.to ? { to: event.data.to } : {}),
  ...(event.data?.failureCode ? { failureCode: event.data.failureCode } : {}),
  ...(event.data?.confirmReason ? { confirmReason: event.data.confirmReason } : {}),
});

/** A Unit with its TMDB numbers, for a candidate's labels. */
async function candidateUnit(ctx: QueryCtx, unitId: Id<'units'>): Promise<CandidateUnit> {
  const unit = await ctx.db.get(unitId);
  return {
    unitId,
    ...(unit?.tmdbSeason !== undefined ? { tmdbSeason: unit.tmdbSeason } : {}),
    ...(unit?.tmdbEpisode !== undefined ? { tmdbEpisode: unit.tmdbEpisode } : {}),
  };
}

/**
 * Each indexer's part in an attempt, by name (test-install backlog): its
 * `indexerResults` row, or `noRequest` for an indexer that existed when a
 * finished search ran but has no row: the request plan had no query for it.
 * RSS reads one indexer only, and a running search has rows still to come.
 */
async function searchIndexersOf(ctx: QueryCtx, attempt: Doc<'searchAttempts'>): Promise<TimelineSearchIndexer[]> {
  const indexers = await ctx.db.query('indexers').collect();
  const nameOf = (id: Id<'indexers'>) => indexers.find((row) => row._id === id)?.name ?? 'Removed';
  const recorded: TimelineSearchIndexer[] = attempt.indexerResults.map((result) => ({
    indexerName: nameOf(result.indexerId),
    status: result.status,
    count: result.count,
    ...(result.skipped ? { skipped: result.skipped } : {}),
    ...(result.failureCode ? { failureCode: result.failureCode } : {}),
  }));
  const finished = attempt.state !== 'running' && attempt.trigger !== 'rss';
  const unplanned: TimelineSearchIndexer[] = finished
    ? indexers
        .filter((row) => row._creationTime < attempt._creationTime && !attempt.indexerResults.some((result) => result.indexerId === row._id))
        .map((row) => ({ indexerName: row.name, status: 'ok', count: 0, skipped: 'noRequest' }))
    : [];
  return [...recorded, ...unplanned].sort((a, b) => a.indexerName.localeCompare(b.indexerName));
}

/** An attempt with its decision records, as stored: nothing is scored again. */
async function searchOf(ctx: QueryCtx, attempt: Doc<'searchAttempts'>, unitId: Id<'units'>): Promise<TimelineSearch> {
  const rows = await ctx.db
    .query('candidates')
    .withIndex('by_attempt', (q) => q.eq('searchAttemptId', attempt._id))
    .collect();
  const indexerNames = new Map<Id<'indexers'>, string>();
  for (const indexerId of new Set(rows.map((row) => row.indexerId))) indexerNames.set(indexerId, (await ctx.db.get(indexerId))?.name ?? 'Removed');
  const units = new Map<Id<'units'>, CandidateUnit>();
  for (const id of new Set([...attempt.unitIds, ...rows.flatMap((row) => [...row.unitIds, ...(row.possibleUnitIds ?? [])])]))
    units.set(id, await candidateUnit(ctx, id));
  const blocklisted = new Map<Id<'candidates'>, Doc<'blocklist'>>();
  for (const row of rows) {
    const entry = row.reason === 'blocklisted' ? await blocklistEntryFor(ctx, row._id) : null;
    if (entry) blocklisted.set(row._id, entry);
  }
  const candidates: CandidateRow[] = rows.map((row) => ({
    candidateId: row._id,
    title: row.title,
    indexerName: indexerNames.get(row.indexerId)!,
    protocol: row.protocol,
    sizeBytes: row.sizeBytes,
    publishedAt: row.publishedAt,
    parsed: row.parsed,
    quality: row.quality,
    qualityAssumed: row.qualityAssumed,
    baseScore: row.baseScore,
    score: row.score,
    breakdown: row.scoreBreakdown,
    preparationStep: row.preparationStep,
    preparationAssumed: row.preparationAssumed,
    outcome: row.outcome,
    ...(row.reason ? { reason: row.reason } : {}),
    ...(row.rank !== undefined ? { rank: row.rank } : {}),
    ...(row.lostOn ? { lostOn: row.lostOn } : {}),
    ...(row.matchDetail ? { matchDetail: row.matchDetail } : {}),
    ...(row.torrent ? { torrent: { seeders: row.torrent.seeders, peers: row.torrent.peers } } : {}),
    // A release of unclear numbering that may be this Unit is listed under "This episode".
    coversUnit: row.unitIds.includes(unitId) || (row.matchProblem === 'ambiguous' && (row.possibleUnitIds ?? []).includes(unitId)),
    ...(row.outcome === 'picked' ? { pickedBy: row.pickedBy ?? 'auto' } : {}),
    ...(row.isUpgrade ? { isUpgrade: true } : {}),
    ...(row.matchProblem ? { matchProblem: row.matchProblem } : {}),
    ...(row.possibleUnitIds?.length ? { possibleUnits: row.possibleUnitIds.map((id) => units.get(id)!) } : {}),
    covers: coveredBy(row, attempt).map((id) => units.get(id)!),
    ...(blocklisted.has(row._id) ? { blocklisted: { at: blocklisted.get(row._id)!._creationTime, reason: blocklisted.get(row._id)!.reason } } : {}),
  }));
  candidates.sort((a, b) => (a.rank ?? Infinity) - (b.rank ?? Infinity));
  return {
    searchAttemptId: attempt._id,
    trigger: attempt.trigger,
    state: attempt.state,
    at: attempt._creationTime,
    ...(attempt.state === 'offered' ? { offeredUntil: attempt._creationTime + OFFER_TTL_MS } : {}),
    candidates,
    indexers: await searchIndexersOf(ctx, attempt),
  };
}

/** Primary first, then a staged output, then a kept original. */
const KIND_ORDER: Record<Doc<'fileVersions'>['kind'], number> = { primary: 0, staged: 1, original: 2, alternate: 3 };

/** The Files section: the Unit's file versions, each with the steps `compare` gives against the library's target. */
export async function filesOf(ctx: QueryCtx, unit: Doc<'units'>, work: Doc<'works'>): Promise<FileRow[]> {
  const target = await targetOf(ctx, work.libraryId);
  const versions = await ctx.db
    .query('fileVersions')
    .withIndex('by_unit', (q) => q.eq('unitId', unit._id))
    .collect();
  versions.sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind]);
  const rows: FileRow[] = [];
  for (const version of versions) {
    const file = await ctx.db.get(version.fileId);
    if (!file) continue;
    rows.push({
      fileId: file._id,
      path: file.path,
      origin: file.origin,
      kind: version.kind,
      fits: version.fits,
      steps: file.probe ? compare(file.probe, target).steps : [],
      sidecars: file.sidecars ?? [],
    });
  }
  return rows;
}

/**
 * The item page: the Unit's own events, plus each Grab's run
 * events through `grabUnits`, grouped by run, with the decision records of
 * the search each run came from.
 */
export const timeline = adminQuery({
  args: TimelineRequest.shape,
  returns: Timeline.nullable(),
  handler: async (ctx, { unitId }) => {
    const unit = await ctx.db.get(unitId);
    // `deleteWork` removes the Units before the Work, and keeps a seeding torrent's Grab.
    const work = unit && (await ctx.db.get(unit.workId));
    if (!unit || !work) return null;
    const events = await ctx.db
      .query('events')
      .withIndex('by_unit_at', (q) => q.eq('unitId', unitId))
      .collect();
    const links = await ctx.db
      .query('grabUnits')
      .withIndex('by_unit', (q) => q.eq('unitId', unitId))
      .order('desc')
      .collect();
    const runs: TimelineRun[] = [];
    // The newest run's torrent still seeding, with its release title.
    let seeding: { download: Doc<'downloads'>; releaseTitle: string } | undefined;
    const runAttempts = new Set<Id<'searchAttempts'>>();
    for (const link of links) {
      const grab = (await ctx.db.get(link.grabId))!;
      const candidate = (await ctx.db.get(grab.candidateId))!;
      const attempt = (await ctx.db.get(candidate.searchAttemptId))!;
      runAttempts.add(attempt._id);
      const stages = await ctx.db
        .query('events')
        .withIndex('by_grab_at', (q) => q.eq('grabId', grab._id))
        .collect();
      const download = await ctx.db
        .query('downloads')
        .withIndex('by_grab', (q) => q.eq('grabId', grab._id))
        .first();
      if (!seeding && download && isSeeding(download)) seeding = { download, releaseTitle: candidate.title };
      runs.push({
        grabId: grab._id,
        title: candidate.title,
        state: grab.state,
        startedAt: grab._creationTime,
        cancelRequested: grab.cancelRequested,
        paused: grab.pausedAt !== undefined,
        pickedBy: candidate.pickedBy ?? 'auto',
        kind: grab.kind ?? 'initial',
        ...(grab.failureCode ? { failureCode: grab.failureCode } : {}),
        outcome: link.outcome,
        stages: stages.map(stageOf),
        ...(download ? { download: { clientStage: download.clientStage, ...(download.clientStatus ? { clientStatus: download.clientStatus } : {}) } } : {}),
        search: await searchOf(ctx, attempt, unitId),
      });
    }
    const last = unit.lastSearchAttemptId && !runAttempts.has(unit.lastSearchAttemptId) ? await ctx.db.get(unit.lastSearchAttemptId) : null;
    const itemPath = await jellyfinItemPath(ctx, unitId, await jellyfinServerId(ctx));
    const active = await downloadOf(ctx, unit.activeGrabId ? await ctx.db.get(unit.activeGrabId) : null);
    const preparation = await preparationOf(ctx, unitId);
    const { posterUrl } = await workImages(ctx, work._id);
    const stillUrl = await stillUrlOf(ctx, unitId);
    return {
      workKind: work.kind,
      ...(posterUrl ? { posterUrl } : {}),
      ...(stillUrl ? { stillUrl } : {}),
      ...(active ? { download: active } : {}),
      ...(preparation
        ? {
            preparation: {
              ...(preparation.fraction === undefined ? {} : { fraction: preparation.fraction }),
              ...(preparation.detail === undefined ? {} : { detail: preparation.detail }),
            },
          }
        : {}),
      ...(seeding ? { seeding: { ...seedingOf(seeding.download), releaseTitle: seeding.releaseTitle } } : {}),
      files: await filesOf(ctx, unit, work),
      ...(itemPath ? { jellyfinItemPath: itemPath } : {}),
      unitId,
      workId: work._id,
      workTitle: work.title,
      ...(unit.tmdbSeason !== undefined ? { tmdbSeason: unit.tmdbSeason } : {}),
      ...(unit.tmdbEpisode !== undefined ? { tmdbEpisode: unit.tmdbEpisode } : {}),
      ...(unit.title ? { title: unit.title } : {}),
      state: unit.derivedState,
      monitored: unit.monitored,
      events: events.map(stageOf),
      runs,
      ...(last ? { lastSearch: await searchOf(ctx, last, unitId) } : {}),
      issues: await unitIssues(ctx, unitId),
    };
  },
});

/** The Unit's open Issues, newest first, for the alert at the top of its Timeline tab. */
async function unitIssues(ctx: QueryCtx, unitId: Id<'units'>): Promise<IssueRow[]> {
  const open = await ctx.db
    .query('issues')
    .withIndex('by_unit', (q) => q.eq('unitId', unitId))
    .order('desc')
    .filter((q) => q.eq(q.field('state'), 'open'))
    .collect();
  return Promise.all(open.map((issue) => issueRow(ctx, issue)));
}

/** "Search and pick": a user search of one Unit whose results are offered on its Candidates tab for an hour. */
export const searchInteractive = adminMutation({
  args: SearchInteractiveRequest.shape,
  returns: SearchInteractiveResponse,
  handler: async (ctx, { unitIds }) => ({ searchAttemptId: await startInteractive(ctx, unitIds[0]!) }),
});

/** Grabs a row of an offered "Search and pick", rejected ones too. */
export const grabCandidate = adminMutation({
  args: GrabCandidateRequest.shape,
  returns: GrabCandidateResponse,
  handler: (ctx, { candidateId, confirmReason }) => grab(ctx, candidateId, confirmReason),
});

/** The Candidates tab's "Might be this episode": misread releases of the Unit's last search. */
export const mightBeThisEpisode = adminQuery({
  args: TimelineRequest.shape,
  returns: MisreadList,
  handler: (ctx, { unitId }) => mightBe(ctx, unitId),
});

/** The Unit's primary file, if it has one. */
async function primaryOf(ctx: QueryCtx, unitId: Id<'units'>): Promise<Doc<'files'> | null> {
  const primary = await ctx.db
    .query('fileVersions')
    .withIndex('by_unit', (q) => q.eq('unitId', unitId))
    .filter((q) => q.eq(q.field('kind'), 'primary'))
    .first();
  return primary ? await ctx.db.get(primary.fileId) : null;
}

/** The preparation plan: the primary's comparison with its library's target; null without a probed primary. */
export const preparationPlan = adminQuery({
  args: TimelineRequest.shape,
  returns: PreparationPlan.nullable(),
  handler: async (ctx, { unitId }) => {
    const unit = await ctx.db.get(unitId);
    const work = unit && (await ctx.db.get(unit.workId));
    const file = unit && (await primaryOf(ctx, unitId));
    if (!work || !file?.probe) return null;
    const links = await ctx.db
      .query('fileUnits')
      .withIndex('by_unit', (q) => q.eq('unitId', unitId))
      .collect();
    let queued = false;
    for (const { fileId } of links)
      queued ||=
        (await ctx.db
          .query('renditions')
          .withIndex('by_source_file', (q) => q.eq('sourceFileId', fileId))
          .filter((q) => q.eq(q.field('state'), 'pending'))
          .first()) !== null;
    return { fileName: fileNameOf(file.path), origin: file.origin, comparison: compare(file.probe, await targetOf(ctx, work.libraryId)), queued };
  },
});

/**
 * "Prepare now": prepares the Unit's source (its kept
 * original, else its primary) in group 0, scanned files included. With an
 * open `transcodeFailed` Issue the Rendition is a `retry`, else `manual`; both
 * are group 0. A pending Rendition is replaced, so a queued profile-edit job
 * moves up to group 0. Returns 0 when the file already fits.
 */
export const prepareNow = adminMutation({
  args: TimelineRequest.shape,
  returns: PrepareAllResponse,
  handler: async (ctx, { unitId }) => {
    // Only for a primary that doesn't fit: a fitting kept original is restored by a profile edit, never here.
    const primary = (
      await ctx.db
        .query('fileVersions')
        .withIndex('by_unit', (q) => q.eq('unitId', unitId))
        .collect()
    ).find((version) => version.kind === 'primary');
    if (!primary || primary.fits) return { queued: 0 };
    const sourceId = await sourceForUnit(ctx, unitId);
    if (!sourceId) return { queued: 0 };
    const failed = await ctx.db
      .query('issues')
      .withIndex('by_unit', (q) => q.eq('unitId', unitId))
      .filter((q) => q.and(q.eq(q.field('state'), 'open'), q.eq(q.field('failureCode'), 'transcodeFailed')))
      .first();
    return { queued: (await start(ctx, sourceId, failed ? 'retry' : 'manual')) ? 1 : 0 };
  },
});

/** "Cancel preparation": the Unit's pending Renditions, through the job cancel. */
export const cancelPreparation = adminMutation({
  args: TimelineRequest.shape,
  returns: Ack,
  handler: async (ctx, { unitId }) => {
    await cancelForUnit(ctx, unitId);
    return null;
  },
});

/** "Search now" on Wanted rows and the item page: a manual search of the wanted Units among them. */
export const searchNow = adminMutation({
  args: SearchNowRequest.shape,
  returns: SearchNowResponse,
  // A Unit that already plays gets an upgrade search; the others a manual one.
  handler: async (ctx, { unitIds }) => {
    const playable: Id<'units'>[] = [];
    const other: Id<'units'>[] = [];
    for (const unitId of unitIds) ((await playablePrimary(ctx, unitId)) ? playable : other).push(unitId);
    const attempts = [...(await startSearch(ctx, other, 'manual')), ...(await startSearch(ctx, playable, 'upgrade'))];
    return { attempts: attempts.length };
  },
});

/** The item page's "Plays": the Unit's last 10 plays, newest first. */
export const plays = adminQuery({
  args: TimelineRequest.shape,
  returns: z.array(PlayRow),
  handler: async (ctx, { unitId }) => {
    const rows = await ctx.db
      .query('playbackReports')
      .withIndex('by_unit_started', (q) => q.eq('unitId', unitId))
      .order('desc')
      .take(10);
    return rows.map((row) => ({
      deviceName: row.deviceName,
      client: row.client,
      method: row.method,
      reasons: row.reasons,
      startedAt: row.startedAt,
      ...(row.endedAt !== undefined ? { endedAt: row.endedAt } : {}),
    }));
  },
});
