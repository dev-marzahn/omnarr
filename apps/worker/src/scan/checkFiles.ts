import { lstat, readdir, stat } from 'node:fs/promises';
import { dirname } from 'node:path';

import { DEFAULT_LIMITS, type FileCheckReportRequest, type Lease, type LibraryRootState, type MaintenancePayload } from '@omnarr/contracts';

import type { WorkerBackend } from '../convex.ts';
import { type DataLayout, toLocal } from '../fs/layout.ts';
import type { JobContext } from '../runtime/lease.ts';

type PendingStatsByRoot = Map<string, Promise<unknown>>;

export type CheckFilesDeps = {
  layout: DataLayout;
  backend: Pick<WorkerBackend, 'fileCheckPage' | 'fileCheckReport'>;
  lstat?: (path: string) => Promise<unknown>;
  statTimeoutMs?: number;
  pendingStats?: PendingStatsByRoot;
};

export type CheckFilesPayload = Extract<MaintenancePayload, { action: 'checkLibraryFiles' }>;

type Verdict = FileCheckReportRequest['verdicts'][number];
type RootResult = {
  libraryId: CheckFilesPayload['roots'][number]['libraryId'];
  state: LibraryRootState;
  checkedWhenMostMissing?: number;
  missingWhenMostMissing?: number;
  goneFolders?: string[];
};

const errorCode = (error: unknown): string | undefined => (error as NodeJS.ErrnoException | undefined)?.code;
const isGoneError = (error: unknown): boolean => errorCode(error) === 'ENOENT' || errorCode(error) === 'ENOTDIR';

const HUNG = Symbol('hung');
type OnHung = (stillRunning: Promise<unknown>) => void;

async function resultOrHungAfter<T>(promise: Promise<T>, ms: number, onHung?: OnHung): Promise<T | typeof HUNG> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<typeof HUNG>((resolve) => {
    timer = setTimeout(() => resolve(HUNG), ms);
  });
  try {
    const result = await Promise.race([promise, timeout]);
    if (result === HUNG) onHung?.(promise);
    return result;
  } finally {
    clearTimeout(timer);
  }
}

export async function rootState(
  local: string,
  staging: string,
  timeoutMs: number = DEFAULT_LIMITS.fileStatTimeoutMs,
  onHung?: OnHung,
): Promise<LibraryRootState> {
  const presentNonEmptyFolderOnStagingDevice = async (): Promise<LibraryRootState> => {
    const info = await stat(local);
    if (!info.isDirectory()) return 'missing';
    if ((await readdir(local)).length === 0) return 'empty';
    const stagingDevice = await stat(staging).then(
      (staged) => staged.dev,
      () => undefined,
    );
    if (stagingDevice !== undefined && stagingDevice !== info.dev) return 'otherDevice';
    return 'available';
  };
  try {
    const state = await resultOrHungAfter(presentNonEmptyFolderOnStagingDevice(), timeoutMs, onHung);
    return state === HUNG ? 'unreadable' : state;
  } catch (error) {
    return isGoneError(error) ? 'missing' : 'unreadable';
  }
}

async function verdictOrNothingOrHung(
  local: string,
  look: (path: string) => Promise<unknown>,
  timeoutMs: number,
  onHung: OnHung,
): Promise<Verdict['verdict'] | undefined | typeof HUNG> {
  try {
    return (await resultOrHungAfter(look(local), timeoutMs, onHung)) === HUNG ? HUNG : 'present';
  } catch (error) {
    return isGoneError(error) ? 'missing' : undefined;
  }
}

function foldersBetweenRootAndFile(root: string, path: string): string[] {
  const folders: string[] = [];
  for (let folder = dirname(path); folder.startsWith(`${root}/`); folder = dirname(folder)) folders.push(folder);
  return folders;
}

export type MassMiss = { rootMostlyGone: boolean; goneFolders: string[] };

export const isUnder = (folders: readonly string[], path: string): boolean => folders.some((folder) => path.startsWith(`${folder}/`));

function topmostWhollyGoneFolders(root: string, verdicts: readonly Verdict[], min: number): string[] {
  const byFolder = new Map<string, { all: number; missing: number }>();
  for (const { path, verdict } of verdicts)
    for (const name of foldersBetweenRootAndFile(root, path)) {
      const folder = byFolder.get(name) ?? { all: 0, missing: 0 };
      folder.all++;
      if (verdict === 'missing') folder.missing++;
      byFolder.set(name, folder);
    }
  const gone = [...byFolder].filter(([, folder]) => folder.all >= min && folder.missing === folder.all).map(([name]) => name);
  return gone.filter((name) => !isUnder(gone, name)).sort();
}

export function massMisses(root: string, verdicts: readonly Verdict[], min: number = DEFAULT_LIMITS.fileMassMissingMin): MassMiss {
  const goneFolders = topmostWhollyGoneFolders(root, verdicts, min);
  const outsideGoneFolders = verdicts.filter((verdict) => !isUnder(goneFolders, verdict.path));
  const missedOutside = outsideGoneFolders.filter((verdict) => verdict.verdict === 'missing').length;
  return { rootMostlyGone: missedOutside >= min && missedOutside * 2 > outsideGoneFolders.length, goneFolders };
}

const statsStillHangingByRoot: PendingStatsByRoot = new Map();

function holdUntilSettled(root: string, hangingStat: Promise<unknown>, pending: PendingStatsByRoot): void {
  const settled = hangingStat.then(
    () => {},
    () => {},
  );
  pending.set(root, settled);
  void settled.then(() => {
    if (pending.get(root) === settled) pending.delete(root);
  });
}

export async function checkLibraryFiles(
  job: Lease,
  payload: CheckFilesPayload,
  deps: CheckFilesDeps,
  ctx: Pick<JobContext, 'signal'>,
): Promise<{ checked: number; missing: number; roots: RootResult[] }> {
  const lease = { jobId: job.jobId, leaseEpoch: job.leaseEpoch };
  const look = deps.lstat ?? lstat;
  const timeoutMs = deps.statTimeoutMs ?? DEFAULT_LIMITS.fileStatTimeoutMs;
  const pending = deps.pendingStats ?? statsStillHangingByRoot;
  let checked = 0;
  let missing = 0;
  const roots: RootResult[] = [];
  for (const root of payload.roots) {
    ctx.signal.throwIfAborted();
    const anEarlierStatStillHangs = pending.has(root.path);
    if (anEarlierStatStillHangs) {
      roots.push({ libraryId: root.libraryId, state: 'unreadable' });
      continue;
    }
    const onHung = (stillRunning: Promise<unknown>) => holdUntilSettled(root.path, stillRunning, pending);
    const state = await rootState(toLocal(deps.layout, root.path), deps.layout.staging, timeoutMs, onHung);
    if (state !== 'available') {
      roots.push({ libraryId: root.libraryId, state });
      continue;
    }
    const wholeRootVerdicts: Verdict[] = [];
    let hung = false;
    let cursor: string | null = null;
    pages: for (;;) {
      ctx.signal.throwIfAborted();
      const page = await deps.backend.fileCheckPage({ ...lease, root: root.path, cursor });
      for (const file of page.files) {
        const verdict = await verdictOrNothingOrHung(toLocal(deps.layout, file.path), look, timeoutMs, onHung);
        if (verdict === HUNG) {
          hung = true;
          break pages;
        }
        if (verdict) wholeRootVerdicts.push({ ...file, verdict });
      }
      if (page.done) break;
      cursor = page.cursor;
    }
    const missed = wholeRootVerdicts.filter((verdict) => verdict.verdict === 'missing').length;
    const mass = hung ? undefined : massMisses(root.path, wholeRootVerdicts);
    const rootResult: RootResult = !mass
      ? { libraryId: root.libraryId, state: 'unreadable' }
      : mass.rootMostlyGone
        ? { libraryId: root.libraryId, state: 'mostMissing', checkedWhenMostMissing: wholeRootVerdicts.length, missingWhenMostMissing: missed }
        : { libraryId: root.libraryId, state: 'available', ...(mass.goneFolders.length ? { goneFolders: mass.goneFolders } : {}) };
    roots.push(rootResult);
    const missesHeldBackUnder = rootResult.state === 'available' ? mass!.goneFolders : [root.path];
    const reported = wholeRootVerdicts.filter((verdict) => verdict.verdict === 'present' || !isUnder(missesHeldBackUnder, verdict.path));
    checked += reported.length;
    missing += reported.filter((verdict) => verdict.verdict === 'missing').length;
    for (let at = 0; at < reported.length; at += DEFAULT_LIMITS.fileCheckPageSize) {
      ctx.signal.throwIfAborted();
      await deps.backend.fileCheckReport({ ...lease, verdicts: reported.slice(at, at + DEFAULT_LIMITS.fileCheckPageSize) });
    }
  }
  return { checked, missing, roots };
}
