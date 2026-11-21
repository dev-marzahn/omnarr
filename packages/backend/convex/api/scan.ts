// The untracked-media scan's public functions: start and cancel a run, read
// its status and review groups, choose a folder's numbering, match it by
// hand, ignore it, import, and the repeat setting.
import {
  Ack,
  ScanFolderRequest,
  ScanGroup,
  ScanGroupsPage,
  ScanGroupsRequest,
  ScanIgnoreRequest,
  ScanImportRequest,
  ScanImportResponse,
  ScanMatchFolderRequest,
  ScanRunRequest,
  ScanSearchTitleRequest,
  ScanSearchTitleResponse,
  ScanSetNumberingRequest,
  ScanSettings,
  ScanStartRequest,
  ScanStartResponse,
  ScanStatus,
  ScanUpdateSettingsRequest,
} from '@omnarr/contracts';
import { ConvexError } from 'convex/values';

import { adminAction, adminMutation, adminQuery } from '../lib/functions';
import { importScan } from '../scan/importFolder';
import { matchByHand, recount, searchTitles, setNumberingFor } from '../scan/match';
import { folderItems, groupOf, groupsPage, statusOf } from '../scan/review';
import { cancelRun, folderPath, settingsOf, startRun } from '../scan/start';

export const status = adminQuery({ args: {}, returns: ScanStatus, handler: (ctx) => statusOf(ctx) });

export const start = adminMutation({
  args: ScanStartRequest.shape,
  returns: ScanStartResponse,
  handler: async (ctx, { trigger }) => ({ scanRunId: await startRun(ctx, trigger) }),
});

export const cancel = adminMutation({
  args: ScanRunRequest.shape,
  returns: Ack,
  handler: async (ctx, { scanRunId }) => {
    await cancelRun(ctx, scanRunId);
    return null;
  },
});

export const groups = adminQuery({
  args: ScanGroupsRequest.shape,
  returns: ScanGroupsPage,
  handler: (ctx, { scanRunId, tab, cursor }) => groupsPage(ctx, scanRunId, tab, cursor),
});

/** One folder with all its files; null when the run has none there. */
export const folder = adminQuery({
  args: ScanFolderRequest.shape,
  returns: ScanGroup.nullable(),
  handler: async (ctx, { scanRunId, libraryId, folder }) => {
    const library = await ctx.db.get(libraryId);
    const items = await folderItems(ctx, scanRunId, libraryId, folder);
    return library && items.length > 0 ? groupOf(library, folder, items) : null;
  },
});

export const setNumbering = adminMutation({
  args: ScanSetNumberingRequest.shape,
  returns: Ack,
  handler: async (ctx, request) => {
    await setNumberingFor(ctx, request);
    return null;
  },
});

export const matchFolder = adminMutation({
  args: ScanMatchFolderRequest.shape,
  returns: Ack,
  handler: async (ctx, request) => {
    await matchByHand(ctx, request);
    return null;
  },
});

/** Later scans skip the folder; the current run's items there become `ignored`. */
export const ignoreFolder = adminMutation({
  args: ScanIgnoreRequest.shape,
  returns: Ack,
  handler: async (ctx, { libraryId, folder, scanRunId }) => {
    if (!(await ctx.db.get(libraryId))) throw new ConvexError({ code: 'notFound', message: 'The library does not exist.' });
    const existing = await ctx.db
      .query('scanIgnores')
      .withIndex('by_library', (q) => q.eq('libraryId', libraryId).eq('folder', folder))
      .first();
    if (!existing) await ctx.db.insert('scanIgnores', { libraryId, folder });
    if (scanRunId) {
      for (const item of await folderItems(ctx, scanRunId, libraryId, folder))
        if (item.status !== 'imported') await ctx.db.patch(item._id, { status: 'ignored' });
      await recount(ctx, scanRunId);
    }
    return null;
  },
});

/** The next scan reads the folder again; the current run's ignored items there wait for that scan. */
export const unignoreFolder = adminMutation({
  args: ScanIgnoreRequest.shape,
  returns: Ack,
  handler: async (ctx, { libraryId, folder }) => {
    const rows = await ctx.db
      .query('scanIgnores')
      .withIndex('by_library', (q) => q.eq('libraryId', libraryId).eq('folder', folder))
      .collect();
    for (const row of rows) await ctx.db.delete(row._id);
    return null;
  },
});

/** The ignored folders, for the settings line under the tabs. */
export const ignored = adminQuery({
  args: {},
  returns: ScanIgnoreRequest.omit({ scanRunId: true }).extend({ path: ScanIgnoreRequest.shape.folder }).array(),
  handler: async (ctx) => {
    const out = [];
    for (const row of await ctx.db.query('scanIgnores').collect()) {
      const library = await ctx.db.get(row.libraryId);
      if (library) out.push({ libraryId: row.libraryId, folder: row.folder, path: folderPath(library.rootPath, row.folder) });
    }
    return out;
  },
});

export const settings = adminQuery({
  args: {},
  returns: ScanSettings,
  handler: async (ctx) => {
    const { schedule, lastRunAt } = await settingsOf(ctx);
    return { schedule, ...(lastRunAt === undefined ? {} : { lastRunAt }) };
  },
});

export const updateSettings = adminMutation({
  args: ScanUpdateSettingsRequest.shape,
  returns: Ack,
  handler: async (ctx, { schedule }) => {
    const row = await ctx.db.query('scanSettings').first();
    if (row) await ctx.db.patch(row._id, { schedule });
    else await ctx.db.insert('scanSettings', { schedule });
    return null;
  },
});

/** The match-by-hand title step: TMDB results of one kind, each with its Work when it's in the library. */
export const searchTitle = adminAction({
  args: ScanSearchTitleRequest.shape,
  returns: ScanSearchTitleResponse,
  handler: (ctx, { query, kind }) => searchTitles(ctx, query, kind),
});

/** The scan review's "Import": per folder, the Work (created from TMDB if new), then its files' rows and one publish job. */
const importFolders = adminAction({
  args: ScanImportRequest.shape,
  returns: ScanImportResponse,
  handler: (ctx, request) => importScan(ctx, request),
});
// `scan.import`: `import` is a reserved word, so it is exported under that name.
export { importFolders as import };
