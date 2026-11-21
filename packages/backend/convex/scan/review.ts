// The scan's read model: the latest run's
// status, its folders grouped for the review tabs, one folder in full.
import type { ScanGroup, ScanItemRow, ScanStatus, ScanTab, UnmatchedReason } from '@omnarr/contracts';

import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { latestRun, librariesInOrder, settingsOf } from './start';

/** Files a group carries in a tab's list; `scan.folder` has all of them. */
export const GROUP_PREVIEW = 3;
/** Folders per page of a tab. */
const GROUPS_PER_PAGE = 50;

export async function statusOf(ctx: QueryCtx): Promise<ScanStatus> {
  const run = await latestRun(ctx);
  const settings = await settingsOf(ctx);
  let progress: { fraction: number; detail?: string } | undefined;
  if (run?.state === 'reading' && run.jobId) {
    const row = await ctx.db
      .query('jobProgress')
      .withIndex('by_job', (q) => q.eq('jobId', run.jobId!))
      .first();
    if (row) progress = { fraction: row.fraction, ...(row.detail === undefined ? {} : { detail: row.detail }) };
  }
  return {
    run: run
      ? {
          scanRunId: run._id,
          trigger: run.trigger,
          state: run.state,
          counts: run.counts,
          startedAt: run._creationTime,
          ...(run.finishedAt === undefined ? {} : { finishedAt: run.finishedAt }),
          hasDecisions: run.hasDecisions,
          ...(progress ? { progress } : {}),
        }
      : null,
    untracked: run?.state === 'ready' ? run.counts.matched + run.counts.unmatched : 0,
    schedule: settings.schedule,
    ...(settings.lastRunAt === undefined ? {} : { lastRunAt: settings.lastRunAt }),
  };
}

const ORDER: Record<Doc<'scanItems'>['status'], number> = { matched: 0, conflict: 1, unmatched: 2, ignored: 3, imported: 4 };

export function itemRow(item: Doc<'scanItems'>, root: string): ScanItemRow {
  const video = item.probe?.streams.find((stream) => stream.kind === 'video');
  const audio = item.probe?.streams.find((stream) => stream.kind === 'audio');
  const parsed = item.parsed;
  return {
    scanItemId: item._id,
    path: item.path,
    relPath: item.path.startsWith(`${root}/`) ? item.path.slice(root.length + 1) : item.path,
    sizeBytes: item.sizeBytes,
    status: item.status,
    ...(item.unmatchedReason ? { unmatchedReason: item.unmatchedReason } : {}),
    units: item.match?.units ?? [],
    ...(parsed
      ? {
          read: {
            ...(parsed.episodes[0]?.season === undefined ? {} : { season: parsed.episodes[0].season }),
            episodes: parsed.episodes.flatMap((e) => (e.episode === undefined ? [] : [e.episode])),
            absolute: parsed.episodes.flatMap((e) => (e.absolute === undefined ? [] : [e.absolute])),
          },
        }
      : {}),
    ...(item.fits === undefined ? {} : { fits: item.fits }),
    ...(item.step === undefined ? {} : { step: item.step }),
    ...(item.probe ? { format: { container: item.probe.container, ...(video ? { video: video.codec } : {}), ...(audio ? { audio: audio.codec } : {}) } } : {}),
  };
}

/** A folder's items as one group, with its first `preview` files (all when absent). */
export function groupOf(library: Doc<'libraries'>, folder: string, items: Doc<'scanItems'>[], preview?: number): ScanGroup {
  const sorted = [...items].sort((a, b) => ORDER[a.status] - ORDER[b.status] || a.path.localeCompare(b.path));
  const count = (status: Doc<'scanItems'>['status']) => items.filter((item) => item.status === status).length;
  const matched = items.find((item) => item.match);
  const folderReasons: UnmatchedReason[] = ['noWork', 'ambiguous'];
  const reason = items.every((item) => item.status === 'unmatched') ? folderReasons.find((r) => items.some((item) => item.unmatchedReason === r)) : undefined;
  return {
    libraryId: library._id,
    libraryKind: library.kind,
    folder,
    ...(matched?.match
      ? {
          match: {
            ...(matched.match.workId ? { workId: matched.match.workId } : {}),
            tmdbId: matched.match.tmdbId,
            kind: matched.match.kind,
            title: matched.match.title,
            ...(matched.match.year === undefined ? {} : { year: matched.match.year }),
            ordering: matched.match.ordering,
            readAs: matched.match.readAs,
            ...(matched.match.workFolder === undefined ? {} : { workFolder: matched.match.workFolder }),
          },
        }
      : {}),
    ...(reason ? { reason } : {}),
    suggestions: items.find((item) => item.suggestions?.length)?.suggestions ?? [],
    counts: {
      files: items.length,
      matched: count('matched'),
      unmatched: count('unmatched'),
      conflict: count('conflict'),
      ignored: count('ignored'),
      imported: count('imported'),
      notFit: items.filter((item) => item.status === 'matched' && item.fits === false).length,
    },
    files: (preview === undefined ? sorted : sorted.slice(0, preview)).map((item) => itemRow(item, library.rootPath)),
  };
}

export async function folderItems(ctx: QueryCtx, scanRunId: Id<'scanRuns'>, libraryId: Id<'libraries'>, folder: string): Promise<Doc<'scanItems'>[]> {
  return await ctx.db
    .query('scanItems')
    .withIndex('by_run_folder', (q) => q.eq('scanRunId', scanRunId).eq('libraryId', libraryId).eq('folder', folder))
    .collect();
}

/** The run's folders in order (library, then name), from `after` on: one index read per folder. */
export async function* foldersOf(
  ctx: QueryCtx,
  scanRunId: Id<'scanRuns'>,
  after: { libraryId: Id<'libraries'>; folder: string } | null,
): AsyncGenerator<{ library: Doc<'libraries'>; folder: string }> {
  const libraries = await librariesInOrder(ctx);
  let started = after === null;
  for (const library of libraries) {
    if (!started && library._id !== after!.libraryId) continue;
    let last: string | null = started ? null : after!.folder;
    started = true;
    for (;;) {
      const next = await ctx.db
        .query('scanItems')
        .withIndex('by_run_folder', (q) => {
          const prefix = q.eq('scanRunId', scanRunId).eq('libraryId', library._id);
          return last === null ? prefix : prefix.gt('folder', last);
        })
        .first();
      if (!next) break;
      last = next.folder;
      yield { library, folder: next.folder };
    }
  }
}

const cursorOf = (ref: { libraryId: Id<'libraries'>; folder: string }) => JSON.stringify([ref.libraryId, ref.folder]);
const parseCursor = (cursor: string | null) => {
  if (cursor === null) return null;
  const [libraryId, folder] = JSON.parse(cursor) as [Id<'libraries'>, string];
  return { libraryId, folder };
};

/** `scan.groups`: a tab's folders, a page at a time. "Matched" lists folders with matched files; "Unmatched" those with unmatched or conflicting ones. */
export async function groupsPage(ctx: QueryCtx, scanRunId: Id<'scanRuns'>, tab: ScanTab, cursor: string | null) {
  const groups: ScanGroup[] = [];
  let last: { libraryId: Id<'libraries'>; folder: string } | null = null;
  for await (const { library, folder } of foldersOf(ctx, scanRunId, parseCursor(cursor))) {
    if (groups.length === GROUPS_PER_PAGE) return { groups, cursor: cursorOf(last!) };
    last = { libraryId: library._id, folder };
    const items = await folderItems(ctx, scanRunId, library._id, folder);
    const listed =
      tab === 'matched' ? items.some((item) => item.status === 'matched') : items.some((item) => item.status === 'unmatched' || item.status === 'conflict');
    if (listed) groups.push(groupOf(library, folder, items, GROUP_PREVIEW));
  }
  return { groups, cursor: null };
}
