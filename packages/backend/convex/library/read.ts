// Builds the library DTOs (WorkSummary, UnitRow) from documents. Only the
// public functions in api/ call these; documents never leave this module.
import { seedingFraction, type SeedingProgress, type UnitDownload, UnitState, type UnitRow, type WorkSummary } from '@omnarr/contracts';

import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { jellyfinItemPath, jellyfinServerId } from '../jellyfin/links';
import { stillUrlOf } from '../metadata/images';

/** States in which a Unit has a playable file. */
const PLAYABLE: ReadonlySet<UnitState> = new Set(['preparing', 'ready', 'notInTargetFormat']);

/** Every open unit-scope Issue, by Unit, oldest first. Open Issues are few, so one index read serves a whole page. */
export async function openIssuesByUnit(ctx: QueryCtx): Promise<OpenIssues> {
  const open = await ctx.db
    .query('issues')
    .withIndex('by_state_scope', (q) => q.eq('state', 'open').eq('scope', 'unit'))
    .collect();
  const byUnit: OpenIssues = new Map();
  for (const issue of open) if (issue.unitId) byUnit.set(issue.unitId, [...(byUnit.get(issue.unitId) ?? []), issue]);
  return byUnit;
}

type OpenIssues = Map<Id<'units'>, Doc<'issues'>[]>;

/** A Work's Units, without those TMDB no longer lists unless they have a file version. */
export async function unitsOfWork(ctx: QueryCtx, workId: Id<'works'>): Promise<Doc<'units'>[]> {
  const units = await ctx.db
    .query('units')
    .withIndex('by_work', (q) => q.eq('workId', workId))
    .collect();
  const shown = await Promise.all(
    units.map(async (unit) => {
      const meta = await ctx.db
        .query('unitMetadata')
        .withIndex('by_unit', (q) => q.eq('unitId', unit._id))
        .unique();
      if (meta?.retiredAt === undefined) return true;
      return (
        (await ctx.db
          .query('fileVersions')
          .withIndex('by_unit', (q) => q.eq('unitId', unit._id))
          .first()) !== null
      );
    }),
  );
  return units.filter((_, i) => shown[i]);
}

export function summarize(work: Doc<'works'>, units: Doc<'units'>[], openIssues: OpenIssues): WorkSummary {
  const counts = new Map<UnitState, number>();
  for (const unit of units) counts.set(unit.derivedState, (counts.get(unit.derivedState) ?? 0) + 1);
  const monitored = units.filter((unit) => unit.monitored);
  return {
    workId: work._id,
    libraryId: work.libraryId,
    kind: work.kind,
    title: work.title,
    year: work.year,
    numberingScheme: work.numberingScheme,
    releaseProfileId: work.releaseProfileId,
    monitorNewUnits: work.monitorNewUnits,
    units: units.length,
    monitored: monitored.length,
    present: monitored.filter((unit) => PLAYABLE.has(unit.derivedState)).length,
    states: UnitState.options.filter((state) => counts.has(state)).map((state) => ({ state, count: counts.get(state)! })),
    openIssues: units.reduce((sum, unit) => sum + (openIssues.get(unit._id)?.length ?? 0), 0),
  };
}

/** `notInTargetCount` ("Prepare all (N)"): the Units' primary versions that don't fit, through `fileVersions.by_unit`. */
export async function notInTargetCountOf(ctx: QueryCtx, units: Doc<'units'>[]): Promise<number> {
  const counts = await Promise.all(
    units.map(async (unit) => {
      const versions = await ctx.db
        .query('fileVersions')
        .withIndex('by_unit', (q) => q.eq('unitId', unit._id))
        .collect();
      return versions.filter((version) => version.kind === 'primary' && !version.fits).length;
    }),
  );
  return counts.reduce((sum, n) => sum + n, 0);
}

/** A pending Rendition of one of the Unit's files, with its job's progress (the Unit row's Preparing state). */
async function preparationOf(ctx: QueryCtx, unitId: Id<'units'>): Promise<UnitRow['preparation']> {
  const links = await ctx.db
    .query('fileUnits')
    .withIndex('by_unit', (q) => q.eq('unitId', unitId))
    .collect();
  for (const { fileId } of links) {
    const rendition = await ctx.db
      .query('renditions')
      .withIndex('by_source_file', (q) => q.eq('sourceFileId', fileId))
      .filter((q) => q.eq(q.field('state'), 'pending'))
      .first();
    if (!rendition) continue;
    const progress = await ctx.db
      .query('jobProgress')
      .withIndex('by_job', (q) => q.eq('jobId', rendition.jobId))
      .first();
    return {
      renditionId: rendition._id,
      steps: rendition.steps.filter((step) => step !== 'none'),
      ...(progress ? { fraction: progress.fraction } : {}),
      ...(progress?.detail !== undefined ? { detail: progress.detail } : {}),
    };
  }
  return undefined;
}

const PROTOCOL = { nzbget: 'usenet', qbittorrent: 'torrent' } as const;

/**
 * A running Grab's Download for the read DTOs: its protocol,
 * stage, the client's fraction, bytes and speed. None once the Grab or its
 * Download has ended.
 */
export async function downloadOf(ctx: QueryCtx, grab: Doc<'grabs'> | null): Promise<UnitDownload | undefined> {
  if (!grab || grab.state === 'done' || grab.state === 'failed' || grab.state === 'cancelled') return undefined;
  const download = await ctx.db
    .query('downloads')
    .withIndex('by_grab', (q) => q.eq('grabId', grab._id))
    .filter((q) => q.eq(q.field('state'), 'active'))
    .first();
  if (!download) return undefined;
  const status = download.clientStatus;
  return {
    grabId: grab._id,
    protocol: PROTOCOL[download.clientKind],
    stage: download.clientStage,
    ...(status ? { fraction: Math.min(1, Math.max(0, status.progress)) } : {}),
    ...(status?.doneBytes !== undefined ? { doneBytes: status.doneBytes } : {}),
    ...(status?.totalBytes !== undefined ? { totalBytes: status.totalBytes } : {}),
    ...(status?.bytesPerSec !== undefined ? { bytesPerSec: status.bytesPerSec } : {}),
  };
}

/** A completed torrent still seeding: watched until its goal is met, so not once `seedingDoneAt` is set. */
export const isSeeding = (download: Doc<'downloads'>): boolean =>
  download.state === 'completed' && download.clientKind === 'qbittorrent' && download.seedingDoneAt === undefined;

/** Every torrent still seeding; bounded by disk, as `downloads.watched` reads them. */
export async function seedingDownloads(ctx: QueryCtx): Promise<Doc<'downloads'>[]> {
  return (
    await ctx.db
      .query('downloads')
      .withIndex('by_state', (q) => q.eq('state', 'completed'))
      .collect()
  ).filter(isSeeding);
}

/**
 * The torrents still seeding, by each Unit their Grab covers (a season pack
 * covers many), for `WorkSummary.seeding`. Bounded as `seedingDownloads` is.
 */
export async function seedingByUnit(ctx: QueryCtx): Promise<Map<Id<'units'>, Set<Id<'downloads'>>>> {
  const byUnit = new Map<Id<'units'>, Set<Id<'downloads'>>>();
  for (const download of await seedingDownloads(ctx)) {
    const links = await ctx.db
      .query('grabUnits')
      .withIndex('by_grab', (q) => q.eq('grabId', download.grabId))
      .collect();
    for (const { unitId } of links) byUnit.set(unitId, (byUnit.get(unitId) ?? new Set()).add(download._id));
  }
  return byUnit;
}

/** `WorkSummary.seeding`: the Units' seeding torrents, each once; undefined when none seeds. */
export function seedingCountOf(units: Doc<'units'>[], byUnit: Map<Id<'units'>, Set<Id<'downloads'>>>): WorkSummary['seeding'] {
  const downloads = new Set(units.flatMap((unit) => [...(byUnit.get(unit._id) ?? [])]));
  return downloads.size > 0 ? { count: downloads.size } : undefined;
}

/** A seeding torrent's progress for the read DTOs. */
export function seedingOf(download: Doc<'downloads'>): SeedingProgress {
  const status = download.clientStatus;
  const fraction = seedingFraction(download.seedGoal, status ?? {});
  return {
    ...(status?.ratio !== undefined ? { ratio: status.ratio } : {}),
    ...(status?.seedTimeMs !== undefined ? { seedTimeMs: status.seedTimeMs } : {}),
    ...(status?.uploadedBytes !== undefined ? { uploadedBytes: status.uploadedBytes } : {}),
    ...(download.seedGoal ? { goal: download.seedGoal } : {}),
    ...(fraction !== undefined ? { fraction } : {}),
  };
}

/**
 * `WorkSummary.activeDownloads`: the Downloads of the Units'
 * running Grabs, each once (a season pack covers many Units). The fraction is
 * weighted by size when every one reports it and the mean of the reported
 * ones otherwise; the speed is their sum.
 */
export async function activeDownloadsOf(ctx: QueryCtx, units: Doc<'units'>[]): Promise<WorkSummary['activeDownloads']> {
  const grabIds = [...new Set(units.flatMap((unit) => (unit.activeGrabId ? [unit.activeGrabId] : [])))];
  const downloads = (await Promise.all(grabIds.map(async (id) => downloadOf(ctx, await ctx.db.get(id))))).filter((d) => d !== undefined);
  if (downloads.length === 0) return undefined;
  const reported = downloads.filter((d) => d.fraction !== undefined);
  const sized = downloads.every((d) => d.totalBytes !== undefined && d.doneBytes !== undefined && d.totalBytes > 0);
  const total = downloads.reduce((sum, d) => sum + (d.totalBytes ?? 0), 0);
  const fraction = sized
    ? downloads.reduce((sum, d) => sum + (d.doneBytes ?? 0), 0) / total
    : reported.length > 0
      ? reported.reduce((sum, d) => sum + d.fraction!, 0) / reported.length
      : undefined;
  const speeds = downloads.filter((d) => d.bytesPerSec !== undefined);
  return {
    count: downloads.length,
    ...(fraction !== undefined ? { fraction } : {}),
    ...(speeds.length > 0 ? { bytesPerSec: speeds.reduce((sum, d) => sum + d.bytesPerSec!, 0) } : {}),
  };
}

/** An upgrade Grab's state, as its tag names it. */
const UPGRADING_STAGE = { submitting: 'grabbed', downloading: 'downloading', importing: 'importing', publishing: 'importing' } as const;

export async function unitRows(ctx: QueryCtx, units: Doc<'units'>[], openIssues: OpenIssues): Promise<UnitRow[]> {
  // A season-pack search or Grab covers many Units: read each once.
  const attempts = new Map<Id<'searchAttempts'>, Promise<Doc<'searchAttempts'> | null>>();
  const grabs = new Map<Id<'grabs'>, Promise<Doc<'grabs'> | null>>();
  const once = <T extends 'searchAttempts' | 'grabs'>(cache: Map<Id<T>, Promise<Doc<T> | null>>, id: Id<T>) => {
    if (!cache.has(id)) cache.set(id, ctx.db.get(id));
    return cache.get(id)!;
  };

  // A search's releases of unclear numbering, read once per search.
  const unclear = new Map<Id<'searchAttempts'>, Promise<Doc<'candidates'>[]>>();
  const unclearOf = (attemptId: Id<'searchAttempts'>) => {
    if (!unclear.has(attemptId))
      unclear.set(
        attemptId,
        ctx.db
          .query('candidates')
          .withIndex('by_attempt_outcome', (q) => q.eq('searchAttemptId', attemptId).eq('outcome', 'rejected'))
          .filter((q) => q.eq(q.field('matchProblem'), 'ambiguous'))
          .collect(),
      );
    return unclear.get(attemptId)!;
  };

  const sorted = [...units].sort((a, b) => (a.tmdbSeason ?? 0) - (b.tmdbSeason ?? 0) || (a.tmdbEpisode ?? 0) - (b.tmdbEpisode ?? 0));
  const serverId = await jellyfinServerId(ctx);
  return await Promise.all(
    sorted.map(async (unit): Promise<UnitRow> => {
      const attempt = unit.lastSearchAttemptId ? await once(attempts, unit.lastSearchAttemptId) : null;
      const grab = unit.activeGrabId ? await once(grabs, unit.activeGrabId) : null;
      // The tag links one Issue, the oldest; the Issues page lists them all.
      const issue = openIssues.get(unit._id)?.[0];
      const itemPath = await jellyfinItemPath(ctx, unit._id, serverId);
      const preparation = await preparationOf(ctx, unit._id);
      const download = await downloadOf(ctx, grab);
      const stillUrl = await stillUrlOf(ctx, unit._id);
      const unclearCount = attempt ? (await unclearOf(attempt._id)).filter((row) => row.possibleUnitIds?.includes(unit._id)).length : 0;
      return {
        ...(download ? { download } : {}),
        ...(grab?.kind === 'upgrade' && grab.state in UPGRADING_STAGE
          ? {
              upgrading: {
                grabId: grab._id,
                stage:
                  grab.state === 'downloading' && download?.stage === 'postProcessing'
                    ? 'repairUnpack'
                    : UPGRADING_STAGE[grab.state as keyof typeof UPGRADING_STAGE],
              },
            }
          : {}),
        ...(stillUrl ? { stillUrl } : {}),
        ...(itemPath ? { jellyfinItemPath: itemPath } : {}),
        ...(preparation ? { preparation } : {}),
        unitId: unit._id,
        kind: unit.kind,
        tmdbSeason: unit.tmdbSeason,
        tmdbEpisode: unit.tmdbEpisode,
        title: unit.title,
        airDateUtc: unit.airDateUtc,
        monitored: unit.monitored,
        state: unit.derivedState,
        lastSearch: attempt ? { at: attempt._creationTime, outcome: attempt.state, unclearCount } : undefined,
        openIssue: issue ? { issueId: issue._id, failureCode: issue.failureCode } : undefined,
        cancelRequested: grab?.cancelRequested ?? false,
      };
    }),
  );
}
