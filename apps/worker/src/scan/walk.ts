// The untracked-media scan's read step: walks each
// library root, sends the videos it finds to `scan.reportBatch` in batches,
// probes the ones no `files` row holds, and records them with
// `scan.recordProbes`. Paths go to the backend as the payload names them
// (under /data), whatever this worker's tree is mounted at.
import { lstat, readdir } from 'node:fs/promises';
import { join, normalize } from 'node:path';

import { DEFAULT_LIMITS, type Lease, type MaintenancePayload, type ProbeSummary, type ScanEntry, type ScanRecordProbesRequest } from '@omnarr/contracts';

import type { WorkerBackend } from '../convex.ts';
import { type DataLayout, toLocal } from '../fs/layout.ts';
import { inodeOf } from '../fs/space.ts';
import { isExtrasFolder, isFinishedVideo, isSample } from '../media/videoFiles.ts';
import { type JobContext, JobFailure } from '../runtime/lease.ts';

export type ScanDeps = {
  layout: DataLayout;
  /** ffprobe, summarised. */
  probe: (path: string, signal: AbortSignal) => Promise<ProbeSummary>;
  backend: Pick<WorkerBackend, 'scanReportBatch' | 'scanRecordProbes'>;
};

export type ScanLibraryPayload = Extract<MaintenancePayload, { action: 'scanLibrary' }>;

/** A found video: where the backend knows it, and where it is on this worker's tree. */
type Found = ScanEntry & { local: string };

const COUNT = new Intl.NumberFormat('en-US');

/** NAS housekeeping folders: Synology's thumbnails and recycle bin. */
const NAS_FOLDERS = new Set(['@eadir', '#recycle']);

/**
 * Whether the walk skips a folder: hidden (`.omnarr/` too), Jellyfin's
 * `<video>.trickplay/` and extras folders, a NAS folder, or a `Sample/`
 * folder. Only a folder named for samples is one: a Work folder such as
 * `The Sample (2020)` is read.
 */
const skippedFolder = (name: string): boolean => {
  const lower = name.toLowerCase();
  return name.startsWith('.') || lower.endsWith('.trickplay') || NAS_FOLDERS.has(lower) || isExtrasFolder(name) || lower === 'sample' || lower === 'samples';
};

/**
 * Whether the walk reports a file: a finished video that isn't hidden or a
 * sample. A name with "sample" in it is one only when its Work folder's
 * name hasn't the word too (`The Sample (2020).mkv` is the film).
 */
const reportedFile = (name: string, workFolder: string | undefined): boolean =>
  !name.startsWith('.') && isFinishedVideo(name) && !(isSample(name) && !(workFolder !== undefined && isSample(workFolder)));

/**
 * The videos under a folder, depth first in name order, outside the
 * `ignored` folders (their /data paths). `workFolder` is the first folder
 * under the root, undefined at the root itself. A missing folder (a root not
 * mounted, a folder removed meanwhile) holds none.
 */
async function* walk(path: string, local: string, ignored: ReadonlySet<string>, workFolder?: string): AsyncGenerator<Found> {
  const entries = await readdir(local, { withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  entries.sort((a, b) => a.name.localeCompare(b.name));
  for (const entry of entries) {
    const childPath = join(path, entry.name);
    const childLocal = join(local, entry.name);
    // A Dirent describes the link itself, never its target: a symlinked file or folder is
    // skipped, so the walk never leaves the root or loops.
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (!skippedFolder(entry.name) && !ignored.has(childPath)) yield* walk(childPath, childLocal, ignored, workFolder ?? entry.name);
    } else if (entry.isFile() && reportedFile(entry.name, workFolder)) {
      const info = await lstat(childLocal).catch((error: NodeJS.ErrnoException) => {
        if (error.code === 'ENOENT') return undefined; // removed meanwhile
        throw error;
      });
      if (info) yield { path: childPath, local: childLocal, sizeBytes: info.size, inode: inodeOf(info) };
    }
  }
}

/** Reads the payload's roots for its scan run, under the job's lease; returns the videos found, and how many no `files` row holds. */
export async function scanLibrary(job: Lease, payload: ScanLibraryPayload, deps: ScanDeps, ctx: JobContext): Promise<{ found: number; untracked: number }> {
  const lease = { jobId: job.jobId, leaseEpoch: job.leaseEpoch, scanRunId: payload.scanRunId };
  let found = 0;
  let untracked = 0;
  let handled = 0;
  let batch: Found[] = [];
  /** The scan page's "640 / 1,204": files handled (answered as tracked, or probed) over files found so far. The runtime throttles the writes. */
  const report = () => ctx.progress(handled / found, `${COUNT.format(handled)} / ${COUNT.format(found)} files`);
  /** The probe, or none for a file ffprobe can't read (matching marks it `unreadable`); any other failure fails the job. */
  const probeOrNone = (local: string) =>
    deps.probe(local, ctx.signal).catch((error: unknown) => {
      if (error instanceof JobFailure && error.code === 'fakeOrWrongContent' && !ctx.signal.aborted) return undefined;
      throw error;
    });
  const send = async () => {
    ctx.signal.throwIfAborted();
    const entry = ({ path, sizeBytes, inode }: Found): ScanEntry => ({ path, sizeBytes, inode });
    const answer = new Set(await deps.backend.scanReportBatch({ ...lease, entries: batch.map(entry) }));
    const fresh = batch.filter((video) => answer.has(video.path));
    handled += batch.length - fresh.length;
    batch = [];
    untracked += fresh.length;
    report();
    if (fresh.length === 0) return;
    const probes: ScanRecordProbesRequest['probes'] = Array.from({ length: fresh.length });
    let next = 0;
    const probeNext = async () => {
      while (next < fresh.length) {
        ctx.signal.throwIfAborted();
        const n = next++;
        const probe = await probeOrNone(fresh[n]!.local).catch((error: unknown) => {
          next = fresh.length; // the other probe loop stops too
          throw error;
        });
        probes[n] = { ...entry(fresh[n]!), ...(probe ? { probe } : {}) };
        handled++;
        report();
      }
    };
    await Promise.all(Array.from({ length: Math.min(DEFAULT_LIMITS.scanProbeConcurrency, fresh.length) }, probeNext));
    ctx.signal.throwIfAborted();
    await deps.backend.scanRecordProbes({ ...lease, probes });
  };
  const ignored = new Set(payload.ignores.map((folder) => normalize(folder).replace(/\/+$/, '')));
  for (const root of payload.roots) {
    for await (const video of walk(root.path, toLocal(deps.layout, root.path), ignored)) {
      ctx.signal.throwIfAborted();
      found++;
      batch.push(video);
      if (batch.length === DEFAULT_LIMITS.scanBatchSize) await send();
    }
  }
  if (batch.length > 0) await send();
  return { found, untracked };
}
