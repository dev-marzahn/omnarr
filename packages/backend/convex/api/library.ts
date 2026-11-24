// The library's public functions: subscribe, the library list,
// the Work page, its "Prepare all" and `deleteWork`.
import {
  Ack,
  BlocklistList,
  DeleteWorkRequest,
  LibraryList,
  LibraryListRequest,
  PrepareAllResponse,
  SetMonitorNewRequest,
  SubscribeRequest,
  SubscribeResponse,
  UnblockRequest,
  WorkDetail,
  WorkDetailRequest,
  WorkFileRow,
} from '@omnarr/contracts';
import { qualityOf } from '@omnarr/scoring';
import { z } from 'zod';

import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import type { ActionCtx, QueryCtx } from '../_generated/server';
import { jellyfinServerId, jellyfinWorkPath } from '../jellyfin/links';
import { adminAction, adminMutation, adminQuery } from '../lib/functions';
import { start as startDelete } from '../library/deleteWork';
import {
  activeDownloadsOf,
  activePreparationsOf,
  notInTargetCountOf,
  openIssuesByUnit,
  seedingByUnit,
  seedingCountOf,
  seedingDownloads,
  seedingOf,
  summarize,
  unitRows,
  unitsOfWork,
} from '../library/read';
import { workImages } from '../metadata/images';
import { withProvider } from '../metadata/keys';
import { suggestNumbering } from '../metadata/numbering';
import { requireWork } from '../metadata/provider';
import { applySnapshot } from '../metadata/sync';
import { unblockEntry } from '../pipeline/blocklist';
import { prepareAllPage } from '../pipeline/preparation';
import { filesOf } from './units';

/**
 * Subscribes to a title: one TMDB lookup, then the Work row, then
 * its Units and mappings through `applySnapshot` with that same snapshot.
 * A title already in the library is returned as it is. If the first write
 * fails, the Work stays with `buildState = failed`, which the Work page
 * offers to retry. An action, because the metadata comes over HTTP.
 */
export const subscribe = adminAction({
  args: SubscribeRequest.shape,
  returns: SubscribeResponse,
  handler: (ctx, request) => subscribeWork(ctx, request),
});

/** `subscribe`'s body, which the scan import also calls for a new Work. */
export async function subscribeWork(
  ctx: ActionCtx,
  { tmdbId, kind, libraryId, releaseProfileId, seasons, numberingScheme, monitorNewUnits, folder }: SubscribeRequest,
): Promise<SubscribeResponse> {
  const work = await withProvider(ctx, (provider) => requireWork(provider, tmdbId, kind));
  const [inAnimeLists] = await ctx.runQuery(internal.metadata.write.animeListsMembership, { tmdbIds: kind === 'series' ? [tmdbId] : [] });
  const suggestion = suggestNumbering(work, inAnimeLists ?? false);
  const result = await ctx.runMutation(internal.library.works.insertWork, {
    libraryId,
    releaseProfileId,
    seasons,
    numberingScheme: numberingScheme ?? suggestion.scheme,
    monitorNewUnits,
    folder,
    work: { kind: work.kind, tmdbId: work.tmdbId, title: work.title, year: work.year },
  });
  if (!result.created) return result;
  try {
    await applySnapshot(ctx, result.workId, work);
  } catch (error) {
    console.error(`subscribe: the first write of Work ${result.workId} failed`, error);
    await ctx.runMutation(internal.metadata.write.failFirstWrite, { workId: result.workId });
  }
  return result;
}

async function extrasOf(ctx: QueryCtx, work: Doc<'works'>, units: Doc<'units'>[], page: 'list' | 'detail') {
  const active = await activeDownloadsOf(ctx, units);
  const preparing = await activePreparationsOf(ctx, units);
  const { meta, posterUrl, backdropUrl } = await workImages(ctx, work._id);
  return {
    ...(active ? { activeDownloads: active } : {}),
    ...(preparing ? { activePreparations: preparing } : {}),
    ...(posterUrl ? { posterUrl } : {}),
    ...(page === 'detail' && backdropUrl ? { backdropUrl } : {}),
    ...(page === 'detail' && meta?.overview ? { overview: meta.overview } : {}),
  };
}

export const list = adminQuery({
  args: LibraryListRequest.shape,
  returns: LibraryList,
  handler: async (ctx, { kind }) => {
    const library = (await ctx.db.query('libraries').collect()).find((row) => row.kind === kind);
    if (!library) return { works: [] };
    const works = await ctx.db
      .query('works')
      .withIndex('by_library', (q) => q.eq('libraryId', library._id))
      .collect();
    const openIssues = await openIssuesByUnit(ctx);
    const seeding = await seedingByUnit(ctx);
    const summaries = await Promise.all(
      works.map(async (work) => {
        const units = await unitsOfWork(ctx, work._id);
        const seedingCount = seedingCountOf(units, seeding);
        return {
          ...summarize(work, units, openIssues),
          ...(await extrasOf(ctx, work, units, 'list')),
          ...(seedingCount ? { seeding: seedingCount } : {}),
        };
      }),
    );
    return {
      library: { libraryId: library._id, kind: library.kind, name: library.name, defaultReleaseProfileId: library.defaultReleaseProfileId },
      works: summaries.sort((a, b) => a.title.localeCompare(b.title)),
    };
  },
});

/** The Work page; null once the Work is gone. */
export const detail = adminQuery({
  args: WorkDetailRequest.shape,
  returns: WorkDetail.nullable(),
  handler: async (ctx, { workId }) => {
    const work = await ctx.db.get(workId);
    if (!work) return null;
    const units = await unitsOfWork(ctx, workId);
    const openIssues = await openIssuesByUnit(ctx);
    const itemPath = await jellyfinWorkPath(ctx, workId, await jellyfinServerId(ctx));
    return {
      work: {
        ...summarize(work, units, openIssues),
        notInTargetCount: await notInTargetCountOf(ctx, units),
        ...(await extrasOf(ctx, work, units, 'detail')),
        ...(itemPath ? { jellyfinItemPath: itemPath } : {}),
      },
      units: await unitRows(ctx, units, openIssues),
    };
  },
});

/**
 * "Prepare all (N)": prepares every Unit of the Work whose primary
 * doesn't fit and has no pending Rendition, scanned files included, 100
 * Units per mutation. Returns how many it queued in this first page.
 */
export const prepareAll = adminMutation({
  args: WorkDetailRequest.shape,
  returns: PrepareAllResponse,
  handler: async (ctx, { workId }) => ({ queued: await prepareAllPage(ctx, workId, null) }),
});

/** The Work page's Blocklist tab: its entries newest first, with the episodes of the run that added each. */
export const blocklist = adminQuery({
  args: WorkDetailRequest.shape,
  returns: BlocklistList,
  handler: async (ctx, { workId }) => {
    const rows = await ctx.db
      .query('blocklist')
      .withIndex('by_work_key', (q) => q.eq('workId', workId))
      .collect();
    rows.sort((a, b) => b._creationTime - a._creationTime);
    return Promise.all(
      rows.map(async (row) => {
        const grabId = row.grabId;
        const covered = grabId
          ? await ctx.db
              .query('grabUnits')
              .withIndex('by_grab', (q) => q.eq('grabId', grabId))
              .collect()
          : [];
        const units = (await Promise.all(covered.map((link) => ctx.db.get(link.unitId)))).filter((unit) => unit !== null);
        return {
          entryId: row._id,
          title: row.title,
          reason: row.reason,
          ...(grabId ? { grabId } : {}),
          units: units.map((unit) => ({
            ...(unit.tmdbSeason !== undefined ? { tmdbSeason: unit.tmdbSeason } : {}),
            ...(unit.tmdbEpisode !== undefined ? { tmdbEpisode: unit.tmdbEpisode } : {}),
          })),
          addedAt: row._creationTime,
        };
      }),
    );
  },
});

/** The Work page's Files tab: the item page's Files rows of every Unit, in TMDB order, with the Unit, size and quality. */
export const files = adminQuery({
  args: WorkDetailRequest.shape,
  returns: z.array(WorkFileRow),
  handler: async (ctx, { workId }) => {
    const work = await ctx.db.get(workId);
    if (!work) return [];
    const units = (await unitsOfWork(ctx, workId)).sort((a, b) => (a.tmdbSeason ?? 0) - (b.tmdbSeason ?? 0) || (a.tmdbEpisode ?? 0) - (b.tmdbEpisode ?? 0));
    const rows: WorkFileRow[] = [];
    // The torrents still seeding, by the candidate their Grab picked, which a downloaded file keeps.
    const seedingByCandidate = new Map<string, Doc<'downloads'>>();
    for (const download of await seedingDownloads(ctx)) {
      const grab = await ctx.db.get(download.grabId);
      if (grab) seedingByCandidate.set(grab.candidateId, download);
    }
    for (const unit of units)
      for (const row of await filesOf(ctx, unit, work)) {
        const file = await ctx.db.get(row.fileId);
        const seeding = file?.candidateId ? seedingByCandidate.get(file.candidateId) : undefined;
        rows.push({
          ...row,
          unitId: unit._id,
          ...(unit.tmdbSeason !== undefined ? { tmdbSeason: unit.tmdbSeason } : {}),
          ...(unit.tmdbEpisode !== undefined ? { tmdbEpisode: unit.tmdbEpisode } : {}),
          sizeBytes: file?.sizeBytes ?? 0,
          ...(file?.release ? { quality: qualityOf(file.release).quality } : {}),
          ...(seeding ? { seeding: seedingOf(seeding) } : {}),
        });
      }
    return rows;
  },
});

/**
 * "Delete series…": stops the Work's runs, then deletes
 * its rows once they have ended. The files stay on disk unless `deleteFiles`.
 */
export const deleteWork = adminMutation({
  args: DeleteWorkRequest.shape,
  returns: Ack,
  handler: async (ctx, { workId, deleteFiles }) => {
    if (await ctx.db.get(workId)) await startDelete(ctx, workId, deleteFiles);
    return null;
  },
});

/** Edit monitoring's "monitor new episodes": whether Units TMDB adds later start monitored. */
export const setMonitorNew = adminMutation({
  args: SetMonitorNewRequest.shape,
  returns: Ack,
  handler: async (ctx, { workId, monitorNewUnits }) => {
    if (await ctx.db.get(workId)) await ctx.db.patch(workId, { monitorNewUnits });
    return null;
  },
});

/** "Unblock release": removes the entry only; nothing is grabbed. */
export const unblock = adminMutation({
  args: UnblockRequest.shape,
  returns: Ack,
  handler: async (ctx, { entryId }) => {
    await unblockEntry(ctx, entryId);
    return null;
  },
});
