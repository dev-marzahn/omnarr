// The run's step mutations: each worker step enqueues a job
// the run then awaits; `finish` closes the run's books.
import { folderTitle, seedGoalFor, workFolderName, type DownloadSource, type ExpectedUnit, type IndexerKind, type NamingContext } from '@omnarr/contracts';
import { v } from 'convex/values';

import type { Doc, Id } from '../_generated/dataModel';
import { internalMutation, type MutationCtx, type QueryCtx } from '../_generated/server';
import { clientRow, userSeedGoal } from '../downloadClients/store';
import { cancelJob, enqueueJob, enqueueWith } from '../jobs/queue';
import { appendEvent } from '../lib/events';
import { resolveIssuesForUnit } from '../lib/issues';
import { transition } from '../lib/stateMachine';
import { targetOf } from '../playback/target';
import { removeDownloads } from './cleanup';
import { decide } from './preparation';

/** Usenet goes to NZBGet, torrents to qBittorrent. */
const CLIENT = { usenet: 'nzbget', torrent: 'qbittorrent' } as const;

/**
 * What the worker fetches: the NZB; for a torrent its
 * `.torrent` file when the candidate's own link is http(s), else its magnet.
 * A definition indexer's http(s) link goes back to its engine as `siteUrl`,
 * which runs the definition's download block.
 */
export function downloadSourceOf(
  protocol: 'usenet' | 'torrent',
  candidate: { downloadUrl: string; indexerId: Id<'indexers'>; torrent?: { magnetUrl?: string } },
  indexerKind: IndexerKind | undefined,
): DownloadSource {
  const url = candidate.downloadUrl;
  if (protocol === 'usenet') return { kind: 'nzbUrl', url };
  if (/^https?:/i.test(url)) return indexerKind === 'definition' ? { kind: 'siteUrl', url, indexerId: candidate.indexerId } : { kind: 'torrentUrl', url };
  return { kind: 'magnet', uri: candidate.torrent?.magnetUrl ?? url };
}

type RunContext = { grab: Doc<'grabs'>; candidate: Doc<'candidates'>; work: Doc<'works'>; library: Doc<'libraries'> };

async function runContext(ctx: MutationCtx, grabId: Id<'grabs'>): Promise<RunContext> {
  const grab = (await ctx.db.get(grabId))!;
  const candidate = (await ctx.db.get(grab.candidateId))!;
  const attempt = (await ctx.db.get(candidate.searchAttemptId))!;
  const work = (await ctx.db.get(attempt.workId))!;
  const library = (await ctx.db.get(work.libraryId))!;
  return { grab, candidate, work, library };
}

/** The Work's TMDB ID, from its `externalIds` row. */
async function tmdbIdOf(ctx: QueryCtx, workId: Id<'works'>): Promise<number> {
  const row = await ctx.db
    .query('externalIds')
    .withIndex('by_work', (q) => q.eq('workId', workId))
    .filter((q) => q.eq(q.field('provider'), 'tmdb'))
    .first();
  return Number(row?.value);
}

/** The absolute path of the Work's stored folder; set by `startImport` before any job names it. */
export const workFolder = (library: Doc<'libraries'>, work: Doc<'works'>): string => `${library.rootPath}/${work.folder}`;

/**
 * The Work's folder, chosen once: the stored one, else
 * `{Title} ({Year}) [tmdbid-{tmdbId}]` from the Work's current title, stored
 * so that a later TMDB title change never moves the Work in Jellyfin.
 */
async function ensureWorkFolder(ctx: MutationCtx, work: Doc<'works'>, tmdbId: number): Promise<Doc<'works'>> {
  if (work.folder !== undefined) return work;
  const folder = workFolderName({ kind: work.kind, title: work.title, ...(work.year !== undefined ? { year: work.year } : {}), tmdbId });
  await ctx.db.patch(work._id, { folder });
  return { ...work, folder };
}

/**
 * Inserts the Download (`active`, `queued`), enqueues `download.submit` with
 * the idempotency key `${grabId}:download.submit`, and patches the job onto
 * the Download, in one mutation.
 */
export const submitDownload = internalMutation({
  args: { grabId: v.id('grabs') },
  returns: v.object({ jobId: v.id('jobs'), downloadId: v.id('downloads') }),
  handler: async (ctx, { grabId }) => {
    const { grab, candidate, work } = await runContext(ctx, grabId);
    // A torrent's goal never stops it below a minimum its tracker reports.
    const seedGoal = grab.protocol === 'torrent' ? seedGoalFor(userSeedGoal(await clientRow(ctx, 'qbittorrent')), candidate.torrent) : undefined;
    const downloadId = await ctx.db.insert('downloads', {
      grabId,
      clientKind: CLIENT[grab.protocol],
      correlationTag: grabId,
      state: 'active',
      clientStage: 'queued',
      ...(seedGoal ? { seedGoal } : {}),
    });
    const jobId = await enqueueJob(ctx, {
      payload: {
        class: 'download.submit',
        grabId,
        downloadId,
        source: downloadSourceOf(grab.protocol, candidate, (await ctx.db.get(candidate.indexerId))?.kind),
        correlationTag: grabId,
        category: work.kind === 'series' ? 'platform-series' : 'platform-movies',
        sizeBytes: candidate.sizeBytes,
        releaseTitle: candidate.title,
        // A failed fetch names the indexer, never its URL; as units.timeline does for a deleted one.
        indexerName: (await ctx.db.get(candidate.indexerId))?.name ?? 'Removed',
        ...(seedGoal ? { seedGoal } : {}),
      },
      idempotencyKey: `${grabId}:download.submit`,
      grabId,
      ...(grab.workflowId ? { workflowId: grab.workflowId } : {}),
    });
    await ctx.db.patch(downloadId, { jobId });
    await appendEvent(ctx, { grabId, stage: 'download', kind: 'stageStarted', message: 'Sending the release to the download client.', data: { jobId } });
    if (grab.cancelRequested) await cancelJob(ctx, jobId);
    return { jobId, downloadId };
  },
});

/**
 * Enqueues the import of the finished download, with the ImportJob it serves
 * (`pending`, staging under `staging/<jobId>`). The Units it expects are the
 * Grab's monitored ones; a Unit unmonitored since the pick is skipped,
 * unless it is one of the release's `alsoContainsUnitIds`, which are `optional`.
 * The payload names the Work's folder, set here on its first import, and
 * what the worker names the files with.
 */
export const startImport = internalMutation({
  args: { grabId: v.id('grabs') },
  returns: v.object({ jobId: v.id('jobs') }),
  handler: async (ctx, { grabId }) => {
    const context = await runContext(ctx, grabId);
    const { grab, candidate, library } = context;
    const tmdbId = await tmdbIdOf(ctx, context.work._id);
    const work = await ensureWorkFolder(ctx, context.work, tmdbId);
    const folder = folderTitle(work.folder!);
    const naming: NamingContext = {
      kind: work.kind,
      title: folder.title,
      ...(folder.year !== undefined ? { year: folder.year } : {}),
      tmdbId,
      anime: work.numberingScheme === 'anime',
      release: { ...candidate.parsed, quality: candidate.quality },
    };
    const download = (await ctx.db
      .query('downloads')
      .withIndex('by_grab', (q) => q.eq('grabId', grabId))
      .filter((q) => q.eq(q.field('state'), 'completed'))
      .first())!;
    const rows = await ctx.db
      .query('grabUnits')
      .withIndex('by_grab', (q) => q.eq('grabId', grabId))
      .collect();
    const expectedUnits: ExpectedUnit[] = [];
    for (const row of rows) {
      const unit = await ctx.db.get(row.unitId);
      // A pack's other Unit is expected whatever its monitoring: the file holds it either way.
      const also = candidate.alsoContainsUnitIds.includes(row.unitId);
      if (!unit || (!unit.monitored && !also)) continue;
      const absolute = await ctx.db
        .query('unitMappings')
        .withIndex('by_unit', (q) => q.eq('unitId', unit._id))
        .filter((q) => q.eq(q.field('ordering'), 'absolute'))
        .first();
      expectedUnits.push({
        unitId: unit._id,
        ...(unit.tmdbSeason !== undefined ? { season: unit.tmdbSeason } : {}),
        ...(unit.tmdbEpisode !== undefined ? { episode: unit.tmdbEpisode } : {}),
        ...(work.numberingScheme === 'anime' && absolute?.absolute !== undefined ? { absolute: absolute.absolute } : {}),
        ...(unit.title !== undefined ? { title: unit.title } : {}),
        ...(also ? { optional: true } : {}),
      });
    }
    const { jobId } = await enqueueWith(
      ctx,
      { class: 'import', idempotencyKey: `${grabId}:import`, grabId, ...(grab.workflowId ? { workflowId: grab.workflowId } : {}) },
      async (jobId) => {
        const importJobId = await ctx.db.insert('importJobs', { grabId, jobId, state: 'pending', stagingPath: `/data/staging/${jobId}` });
        return {
          class: 'import',
          grabId,
          importJobId,
          contentPath: download.contentPath ?? '',
          workFolderPath: workFolder(library, work),
          expectedUnits,
          naming,
          // A manual grab of unclear numbering imports as the Unit the user chose.
          ...(grab.importAs ? { importAs: grab.importAs } : {}),
          // An upgrade file that needs preparation waits in staging/held/, never beside the primary.
          ...(grab.kind === 'upgrade' ? { holdUnlessFits: await targetOf(ctx, library._id) } : {}),
        };
      },
    );
    // A cancel that came between two steps ends the run at this job.
    if (grab.cancelRequested) await cancelJob(ctx, jobId);
    return { jobId };
  },
});

/**
 * A `publish` job's idempotency key: `${publicationId}:publish:${generation}`
 * of the lowest Publication ID in string order. Undefined for no Publications.
 */
export function publishKey(publications: { _id: Id<'publications'>; generation: number }[]): string | undefined {
  const [lowest] = [...publications].sort((a, b) => (a._id < b._id ? -1 : a._id > b._id ? 1 : 0));
  return lowest && `${lowest._id}:publish:${lowest.generation}`;
}

/** A run's publish jobs: keyed by their Publications, so they are found through the Grab's Units' Publications. */
export async function runPublishJobs(ctx: QueryCtx, grabId: Id<'grabs'>): Promise<Doc<'jobs'>[]> {
  const found = new Map<Id<'jobs'>, Doc<'jobs'>>();
  const rows = await ctx.db
    .query('grabUnits')
    .withIndex('by_grab', (q) => q.eq('grabId', grabId))
    .collect();
  for (const { unitId } of rows)
    for (const publication of await ctx.db
      .query('publications')
      .withIndex('by_unit', (q) => q.eq('unitId', unitId))
      .collect()) {
      const job = publication.jobId && !found.has(publication.jobId) ? await ctx.db.get(publication.jobId) : null;
      if (job?.grabId === grabId) found.set(job._id, job);
    }
  return [...found.values()];
}

/** Enqueues the publish of the Grab's new primary versions, with a Publication (`pending`) per Unit. */
export const startPublish = internalMutation({
  args: { grabId: v.id('grabs') },
  returns: v.object({ jobId: v.id('jobs') }),
  handler: async (ctx, { grabId }) => {
    const { grab, work, library } = await runContext(ctx, grabId);
    const versions: { unitId: Id<'units'>; fileVersionId: Id<'fileVersions'>; path: string }[] = [];
    const rows = await ctx.db
      .query('grabUnits')
      .withIndex('by_grab', (q) => q.eq('grabId', grabId))
      .collect();
    for (const row of rows) {
      if (row.outcome !== 'imported') continue;
      const unitVersions = await ctx.db
        .query('fileVersions')
        .withIndex('by_unit', (q) => q.eq('unitId', row.unitId))
        .collect();
      for (const version of unitVersions) {
        const file = await ctx.db.get(version.fileId);
        // An upgrade's fitting file is `staged` until Jellyfin sees it; a held one waits for its preparation.
        const publishable = version.kind === 'primary' || (version.kind === 'staged' && version.fits);
        if (publishable && file?.candidateId === grab.candidateId) versions.push({ unitId: row.unitId, fileVersionId: version._id, path: file.path });
      }
    }
    // The Publications come first: the job's payload and key name them.
    const items = [];
    for (const version of versions) {
      const publicationId = await ctx.db.insert('publications', {
        unitId: version.unitId,
        fileVersionId: version.fileVersionId,
        generation: 0,
        target: 'jellyfin',
        state: 'pending',
      });
      items.push({ publicationId, path: version.path });
    }
    const publicationIds = items.map((item) => item.publicationId);
    const jobId = await enqueueJob(ctx, {
      payload: {
        class: 'publish',
        publicationIds,
        workFolderPath: workFolder(library, work),
        items,
        library: { libraryId: library._id, root: library.rootPath, kind: library.kind },
      },
      idempotencyKey: publishKey(publicationIds.map((id) => ({ _id: id, generation: 0 }))) ?? `${grabId}:publish`,
      grabId,
      ...(grab.workflowId ? { workflowId: grab.workflowId } : {}),
    });
    for (const publicationId of publicationIds) await ctx.db.patch(publicationId, { jobId });
    if (grab.cancelRequested) await cancelJob(ctx, jobId);
    return { jobId };
  },
});

/**
 * The run's last step: the Grab is `done`, its Units are free, the
 * Issues its success settles are resolved, and preparation is decided for
 * each new file. `grabUnits` outcomes were written at import.
 */
export const finish = internalMutation({
  args: { grabId: v.id('grabs') },
  returns: v.null(),
  handler: async (ctx, { grabId }) => {
    const grab = (await ctx.db.get(grabId))!;
    const rows = await ctx.db
      .query('grabUnits')
      .withIndex('by_grab', (q) => q.eq('grabId', grabId))
      .collect();
    for (const row of rows) {
      const unit = await ctx.db.get(row.unitId);
      if (unit?.activeGrabId === grabId) await ctx.db.patch(row.unitId, { activeGrabId: undefined });
      // Transient, bad-release, pipelineError and unknownClientFailure Issues.
      await resolveIssuesForUnit(
        ctx,
        row.unitId,
        (issue) =>
          issue.class === 'transient' || issue.class === 'badRelease' || issue.failureCode === 'pipelineError' || issue.failureCode === 'unknownClientFailure',
      );
    }
    if (grab.state === 'publishing') await transition(ctx, 'grab', grabId, 'done', { kind: 'stageFinished', message: 'Done.' });
    const files = new Set<Id<'files'>>();
    for (const row of rows) {
      if (row.outcome !== 'imported') continue;
      for (const link of await ctx.db
        .query('fileUnits')
        .withIndex('by_unit', (q) => q.eq('unitId', row.unitId))
        .collect()) {
        const file = await ctx.db.get(link.fileId);
        if (file?.candidateId === grab.candidateId) files.add(file._id);
      }
    }
    for (const fileId of files) await decide(ctx, fileId);
    // The import hard-linked the files into the library, so the download can go.
    // A torrent stays watched until its seeding goal removes it; Usenet has nothing to seed.
    if (grab.protocol === 'usenet') await removeDownloads(ctx, grabId);
    return null;
  },
});
