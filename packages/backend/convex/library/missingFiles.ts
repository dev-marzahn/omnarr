import {
  DEFAULT_LIMITS,
  FileCheckPageRequest,
  FileCheckPageResponse,
  FileCheckReportRequest,
  type LibraryRootState,
  MaintenanceResult,
  Ack,
} from '@omnarr/contracts';
import { zodToConvex } from 'convex-helpers/server/zod4';
import { z } from 'zod';

import type { Doc, Id } from '../_generated/dataModel';
import { internalMutation, type MutationCtx, type QueryCtx } from '../_generated/server';
import { enqueueJob, fenced } from '../jobs/queue';
import { recomputeUnits, unitSnapshot } from '../lib/derivedState';
import { appendEvent } from '../lib/events';
import { workerError, workerMutation } from '../lib/functions';
import { raiseIssue, resolveIssuesForUnit, resolveSystemIssue } from '../lib/issues';
import { limits } from '../lib/limits';
import { publishAt } from './naming';

type CheckPayload = Extract<Doc<'jobs'>['payload'] & {}, { action: 'checkLibraryFiles' }>;
type CheckResult = Extract<z.infer<typeof MaintenanceResult>, { action: 'checkLibraryFiles' }>;

const NOT_ENDED_STATUSES = ['queued', 'waiting', 'leased'] as const;

const theCharacterAfterSlash = '0';
const filesUnderRoot = (ctx: QueryCtx, root: string) =>
  ctx.db.query('files').withIndex('by_path', (q) => q.gte('path', `${root}/`).lt('path', `${root}${theCharacterAfterSlash}`));

async function leasedCheckPayload(ctx: MutationCtx, jobId: Id<'jobs'>, leaseEpoch: number): Promise<CheckPayload> {
  const job = await fenced(ctx, jobId, leaseEpoch);
  if (job.payload?.class !== 'maintenance' || job.payload.action !== 'checkLibraryFiles')
    throw workerError('invalidResult', { expected: 'maintenance/checkLibraryFiles' });
  return job.payload;
}

async function maintenanceJobsNotEnded(ctx: QueryCtx): Promise<Doc<'jobs'>[]> {
  const jobs: Doc<'jobs'>[] = [];
  for (const status of NOT_ENDED_STATUSES)
    jobs.push(
      ...(await ctx.db
        .query('jobs')
        .withIndex('by_status_class', (q) => q.eq('status', status).eq('class', 'maintenance'))
        .collect()),
    );
  return jobs;
}

export async function enqueueFileCheck(ctx: MutationCtx): Promise<Id<'jobs'> | null> {
  const aCheckIsRunning = (await maintenanceJobsNotEnded(ctx)).some(
    (job) => job.payload?.class === 'maintenance' && job.payload.action === 'checkLibraryFiles',
  );
  if (aCheckIsRunning) return null;
  const libraries = await ctx.db.query('libraries').collect();
  if (libraries.length === 0) return null;
  const aNewRunEachTime = `checkLibraryFiles:${crypto.randomUUID()}`;
  return await enqueueJob(ctx, {
    payload: { class: 'maintenance', action: 'checkLibraryFiles', roots: libraries.map((library) => ({ libraryId: library._id, path: library.rootPath })) },
    idempotencyKey: aNewRunEachTime,
  });
}

export const scheduledCheck = internalMutation({
  args: {},
  returns: zodToConvex(z.null()),
  handler: async (ctx) => {
    await enqueueFileCheck(ctx);
    return null;
  },
});

export const page = workerMutation({
  args: FileCheckPageRequest.shape,
  returns: FileCheckPageResponse,
  handler: async (ctx, { jobId, leaseEpoch, root, cursor }) => {
    const payload = await leasedCheckPayload(ctx, jobId, leaseEpoch);
    if (!payload.roots.some((known) => known.path === root)) throw workerError('invalidResult', { expected: 'a root of the job' });
    const result = await filesUnderRoot(ctx, root).paginate({ cursor, numItems: DEFAULT_LIMITS.fileCheckPageSize });
    return { files: result.page.map((file) => ({ fileId: file._id, path: file.path })), cursor: result.continueCursor, done: result.isDone };
  },
});

async function mayBeMovingNow(ctx: QueryCtx, file: Doc<'files'>, maintenance: Doc<'jobs'>[]): Promise<boolean> {
  for (const link of await ctx.db
    .query('fileUnits')
    .withIndex('by_file', (q) => q.eq('fileId', file._id))
    .collect())
    if ((await ctx.db.get(link.unitId))?.activeGrabId !== undefined) return true;
  const pendingRendition = await ctx.db
    .query('renditions')
    .withIndex('by_source_file', (q) => q.eq('sourceFileId', file._id))
    .filter((q) => q.eq(q.field('state'), 'pending'))
    .first();
  if (pendingRendition) return true;
  const versions = await ctx.db
    .query('fileVersions')
    .withIndex('by_file', (q) => q.eq('fileId', file._id))
    .collect();
  if (versions.some((version) => version.kind === 'staged')) return true;
  return maintenance.some(({ payload }) => {
    if (payload?.class !== 'maintenance') return false;
    if (payload.action === 'renameLibraryFile' || payload.action === 'moveLibraryFile') return payload.fileId === file._id;
    if (payload.action === 'deleteLibraryFiles') return payload.paths.includes(file.path);
    return false;
  });
}

async function unitsTheFileIsPrimaryOf(ctx: QueryCtx, fileId: Id<'files'>): Promise<Id<'units'>[]> {
  const versions = await ctx.db
    .query('fileVersions')
    .withIndex('by_file', (q) => q.eq('fileId', fileId))
    .collect();
  return [...new Set(versions.filter((version) => version.kind === 'primary').map((version) => version.unitId))];
}

const nameOf = (path: string) => path.slice(path.lastIndexOf('/') + 1);

async function stillPlays(ctx: QueryCtx, unitId: Id<'units'>): Promise<boolean> {
  const unit = await ctx.db.get(unitId);
  return unit !== null && (await unitSnapshot(ctx, unit, Date.now())).versions.some((version) => version.visible);
}

async function markMissingAndRaiseOnlyWhereNothingPlays(ctx: MutationCtx, file: Doc<'files'>, now: number): Promise<void> {
  await ctx.db.patch(file._id, { missingSince: now });
  const unitIds = await unitsTheFileIsPrimaryOf(ctx, file._id);
  const detail = `${nameOf(file.path)} is no longer on disk at ${file.path}. Search again for a new copy, or put the file back.`;
  for (const unitId of unitIds) {
    if (!(await stillPlays(ctx, unitId))) await raiseIssue(ctx, { code: 'fileMissing', unitId, detail });
    await appendEvent(ctx, {
      unitId,
      stage: 'system',
      kind: 'stageFailed',
      message: `${nameOf(file.path)} is missing from disk.`,
      data: { failureCode: 'fileMissing' },
    });
  }
  await recomputeUnits(ctx, unitIds);
}

async function demoteToUnpublishedAlternate(ctx: MutationCtx, unitId: Id<'units'>, fileId: Id<'files'>): Promise<void> {
  const versions = await ctx.db
    .query('fileVersions')
    .withIndex('by_file', (q) => q.eq('fileId', fileId))
    .collect();
  for (const version of versions) {
    if (version.unitId !== unitId || version.kind !== 'primary') continue;
    for (const publication of await ctx.db
      .query('publications')
      .withIndex('by_unit', (q) => q.eq('unitId', unitId))
      .filter((q) => q.eq(q.field('fileVersionId'), version._id))
      .collect())
      await ctx.db.delete(publication._id);
    await ctx.db.patch(version._id, { kind: 'alternate' });
  }
}

async function anotherPrimaryMissing(ctx: QueryCtx, unitId: Id<'units'>, fileId: Id<'files'>): Promise<boolean> {
  for (const version of await ctx.db
    .query('fileVersions')
    .withIndex('by_unit', (q) => q.eq('unitId', unitId))
    .collect()) {
    if (version.kind !== 'primary' || version.fileId === fileId) continue;
    if ((await ctx.db.get(version.fileId))?.missingSince !== undefined) return true;
  }
  return false;
}

async function markFoundAndPublishAgainOrKeepAsAlternate(ctx: MutationCtx, file: Doc<'files'>): Promise<void> {
  const unitIds = await unitsTheFileIsPrimaryOf(ctx, file._id);
  const playAnotherFileWhileThisOneIsStillMissing = new Set<Id<'units'>>();
  for (const unitId of unitIds) if (await stillPlays(ctx, unitId)) playAnotherFileWhileThisOneIsStillMissing.add(unitId);
  await ctx.db.patch(file._id, { missingSince: undefined, missingSeenAt: undefined });
  for (const unitId of unitIds) {
    if (playAnotherFileWhileThisOneIsStillMissing.has(unitId)) {
      await demoteToUnpublishedAlternate(ctx, unitId, file._id);
      await appendEvent(ctx, {
        unitId,
        stage: 'system',
        kind: 'stageFinished',
        message: `${nameOf(file.path)} is back on disk beside the newer file. It is kept as an alternate version and not published.`,
      });
      continue;
    }
    if (!(await anotherPrimaryMissing(ctx, unitId, file._id))) await resolveIssuesForUnit(ctx, unitId, ['fileMissing']);
    await appendEvent(ctx, { unitId, stage: 'system', kind: 'stageFinished', message: `${nameOf(file.path)} is back on disk.` });
  }
  await publishAt(ctx, file._id, file.path, { visible: true, failed: true }, 'Publishing the file again: it is back on disk.');
  await recomputeUnits(ctx, unitIds);
}

export const report = workerMutation({
  args: FileCheckReportRequest.shape,
  returns: Ack,
  handler: async (ctx, { jobId, leaseEpoch, verdicts }) => {
    await leasedCheckPayload(ctx, jobId, leaseEpoch);
    const now = Date.now();
    const maintenance = await maintenanceJobsNotEnded(ctx);
    for (const { fileId, path, verdict } of verdicts) {
      const file = await ctx.db.get(fileId);
      const movedSinceItsPage = !file || file.path !== path;
      if (movedSinceItsPage) continue;
      if (verdict === 'present') {
        if (file.missingSince !== undefined) await markFoundAndPublishAgainOrKeepAsAlternate(ctx, file);
        else if (file.missingSeenAt !== undefined) await ctx.db.patch(file._id, { missingSeenAt: undefined });
        continue;
      }
      if (file.missingSince !== undefined || (await mayBeMovingNow(ctx, file, maintenance))) continue;
      if (file.missingSeenAt === undefined) await ctx.db.patch(file._id, { missingSeenAt: now });
      else if (now - file.missingSeenAt >= limits().fileMissingConfirmMs) await markMissingAndRaiseOnlyWhereNothingPlays(ctx, file, now);
    }
    return null;
  },
});

const ROOT_PROBLEM: Record<Exclude<LibraryRootState, 'available'>, string> = {
  missing: 'is missing',
  empty: 'is empty',
  otherDevice: 'is on another filesystem than staging',
  unreadable: "can't be read, or a file in it didn't answer",
  mostMissing: 'has too many files missing at once',
};

const FOLDERS_NAMED_IN_ISSUE = 5;
const namedFolders = (folders: string[]): string =>
  folders.length <= FOLDERS_NAMED_IN_ISSUE
    ? folders.join(', ')
    : `${folders.slice(0, FOLDERS_NAMED_IN_ISSUE).join(', ')} and ${folders.length - FOLDERS_NAMED_IN_ISSUE} more`;

export async function checked(ctx: MutationCtx, payload: CheckPayload, result: CheckResult): Promise<void> {
  const problems: string[] = [];
  const gone: string[] = [];
  for (const { libraryId, state, checkedWhenMostMissing: seen, missingWhenMostMissing: missing, goneFolders } of result.roots) {
    if (state === 'available') {
      gone.push(...(goneFolders ?? []));
      continue;
    }
    const root = payload.roots.find((known) => known.libraryId === libraryId);
    const aNewInstallsEmptyRoot = !root || !(await filesUnderRoot(ctx, root.path).first());
    if (aNewInstallsEmptyRoot) continue;
    const library = await ctx.db.get(root.libraryId);
    const counts = state === 'mostMissing' && seen !== undefined && missing !== undefined ? ` (${missing} of ${seen})` : '';
    problems.push(`The ${library?.kind === 'series' ? 'Series' : 'Movies'} folder ${root.path} ${ROOT_PROBLEM[state]}${counts}.`);
  }
  if (problems.length === 0 && gone.length === 0) return await resolveSystemIssue(ctx, 'libraryUnavailable');
  const lines = [
    ...(problems.length ? [`${problems.join(' ')} Its files weren't checked and nothing was changed. Is the media share mounted?`] : []),
    ...(gone.length
      ? [
          `Every file under ${gone.length === 1 ? 'this folder' : 'these folders'} is gone: ${namedFolders(gone)}. ` +
            'They were not marked missing, since a share or mount that dropped looks the same. ' +
            'If the share is down, bring it back. If you removed them on purpose, delete the series or movie in omnarr. Either one clears this.',
        ]
      : []),
  ];
  await raiseIssue(ctx, { code: 'libraryUnavailable', detail: lines.join(' ') });
}

export async function resolveFileMissingOnceAFileOfItPlays(ctx: MutationCtx, unitId: Id<'units'>, visibleFileId: Id<'files'>): Promise<void> {
  if ((await ctx.db.get(visibleFileId))?.missingSince !== undefined) return;
  await resolveIssuesForUnit(ctx, unitId, ['fileMissing']);
}
