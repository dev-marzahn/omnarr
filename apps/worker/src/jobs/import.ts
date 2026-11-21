// `import`: the download's videos go into
// the library through `staging/<jobId>`, under the names `libraryFileName`
// gives them. RAR sets are extracted into staging first. The backend says
// which Units each file holds (`imports.resolveFiles`, the numbering search
// used), and the assignment rules pick one file per expected Unit. A file is
// hard-linked, never moved, so the download stays whole for seeding and a
// re-run finds its earlier work; nothing is ever written under downloads/
//. `staging/<jobId>` is removed in every case.
import { copyFile, link as fsLink, mkdir, readdir, rename, rm, stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join, relative, sep } from 'node:path';

import {
  compare,
  DEFAULT_LIMITS,
  type ExpectedUnit,
  ImportPayload,
  type JobResult,
  type NamedUnit,
  type ProbeSummary,
  type ResolvedFile,
} from '@omnarr/contracts';

import type { WorkerBackend } from '../convex.ts';
import { errorFailureCode } from '../failures.ts';
import { type DataLayout, stagingPath, toLocal } from '../fs/layout.ts';
import { libraryTarget, placeAt } from '../fs/place.ts';
import { freeBytesAt, inodeOf } from '../fs/space.ts';
import { extractSet, findRarSets, listSet } from '../media/archives.ts';
import { isExtrasFolder, isFinishedVideo, isSample } from '../media/videoFiles.ts';
import { type JobHandler, JobFailure } from '../runtime/lease.ts';

export type ImportDeps = {
  layout: DataLayout;
  /** ffprobe, summarised. */
  probe: (path: string, signal: AbortSignal) => Promise<ProbeSummary>;
  backend: Pick<WorkerBackend, 'resolveFiles'>;
  /** Free bytes where a path is (`statfs`); injected by tests. */
  freeBytes?: (path: string) => Promise<number>;
  /** `fs.link`; injected by tests to stand in for another filesystem (EXDEV). */
  link?: (existingPath: string, newPath: string) => Promise<void>;
};

type Video = {
  /** Where it is now: under the download, or extracted under staging. */
  path: string;
  /** What `resolveFiles` gets: its path under the download (an extracted file under its set's folder). */
  relPath: string;
  sizeBytes: number;
  /** Extracted into staging already: a copy, never a link of the seeding file. */
  extracted: boolean;
};

/** Whether a path under the download is one the listing skips: a sample, or inside an extras folder. */
const skipped = (relPath: string): boolean => {
  const parts = relPath.split(sep);
  return parts.some(isSample) || parts.slice(0, -1).some(isExtrasFolder);
};

/** The videos under `dir`, without samples and extras, sorted by `relPath`: the path under `dir`, after `prefix` when one is given. */
async function listVideos(dir: string, prefix = '', extracted = false): Promise<Video[]> {
  const found: Video[] = [];
  const entries = await readdir(dir, { recursive: true, withFileTypes: true }).catch((error: NodeJS.ErrnoException) => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    const path = join(entry.parentPath, entry.name);
    const own = relative(dir, path);
    if (!isFinishedVideo(entry.name) || skipped(own)) continue;
    found.push({ path, relPath: prefix ? join(prefix, own) : own, sizeBytes: (await stat(path)).size, extracted });
  }
  return found.sort((a, b) => a.relPath.localeCompare(b.relPath));
}

/**
 * With no video outside archives, each RAR set is listed, the unpacked
 * total checked against staging's free space, and every set extracted into
 * `extract/<n>/`. An encrypted set is `passwordProtected`.
 */
async function extractArchives(content: string, extractDir: string, deps: ImportDeps, signal: AbortSignal): Promise<Video[]> {
  const sets = (await findRarSets(content)).filter((set) => !skipped(relative(content, set)));
  if (sets.length === 0) return [];
  const listings = [];
  for (const set of sets) {
    const listing = await listSet(set, signal);
    if (listing.encrypted) throw new JobFailure('passwordProtected', `The archive ${basename(set)} needs a password.`);
    listings.push(listing);
  }
  const needed = listings.reduce((sum, listing) => sum + listing.unpackedBytes, 0);
  await requireSpace(deps, needed, 'Extracting the archives');
  const videos: Video[] = [];
  for (const [n, set] of sets.entries()) {
    const out = join(extractDir, String(n + 1));
    await extractSet(set, out, signal);
    const folder = relative(content, dirname(set));
    videos.push(...(await listVideos(out, folder, true)));
  }
  return videos;
}

/** staging free bytes ≥ what a copy or extraction writes + the margin, or `diskFull`. */
async function requireSpace(deps: ImportDeps, bytes: number, what: string): Promise<void> {
  const free = await (deps.freeBytes ?? freeBytesAt)(deps.layout.staging);
  const needed = bytes + DEFAULT_LIMITS.freeSpaceMarginBytes;
  if (free < needed) throw new JobFailure('diskFull', `${what} needs ${needed} bytes in staging/ (with the margin); ${free} bytes free.`);
}

const pad = (n: number) => String(n).padStart(2, '0');
const unitLabel = (unit: ExpectedUnit) =>
  unit.season !== undefined && unit.episode !== undefined
    ? `S${pad(unit.season)}E${pad(unit.episode)}`
    : unit.absolute !== undefined
      ? `absolute ${unit.absolute}`
      : 'the movie';

/**
 * Which video holds each expected Unit.
 *
 * - A file takes the expected Units among its own; Units outside the Grab are
 *   not linked (the worker only knows the expected Unit IDs, so "outside the
 *   expected set" and "in alsoContainsUnitIds" read the same here).
 * - Two files for one Unit: the higher revision (version, then REAL, as
 *   `resolveFiles` reads them from the name), then the larger.
 * - An `optional` Unit (one of the release's `alsoContainsUnitIds` the Grab
 *   covers) is linked if a file holds it, and dropped if none does.
 * - Exactly one required Unit without a file and exactly one video that
 *   resolved to nothing: that video holds it.
 * - A required Unit still missing: `importMismatch`.
 */
function assign(videos: Video[], resolved: Map<string, ResolvedFile>, expected: ExpectedUnit[]): Map<Video, ExpectedUnit[]> {
  const rank = (video: Video): [number, number, number] => {
    const revision = resolved.get(video.relPath)?.revision ?? { version: 1, real: 0 };
    return [revision.version, revision.real, video.sizeBytes];
  };
  const better = (a: Video, b: Video): boolean => {
    const [x, y] = [rank(a), rank(b)];
    const i = x.findIndex((value, n) => value !== y[n]);
    return i >= 0 && x[i]! > y[i]!;
  };
  const winner = new Map<string, Video>();
  for (const video of videos) {
    for (const unitId of (resolved.get(video.relPath)?.unitIds ?? []) as string[]) {
      if (!expected.some((unit) => unit.unitId === unitId)) continue;
      const current = winner.get(unitId);
      if (!current || better(video, current)) winner.set(unitId, video);
    }
  }
  // An optional Unit (a pack's other episode) the download lacks is dropped; only the required ones can be missing.
  const required = expected.filter((unit) => !unit.optional);
  const missing = required.filter((unit) => !winner.has(unit.unitId));
  const unresolved = videos.filter((video) => (resolved.get(video.relPath)?.unitIds ?? []).length === 0);
  if (missing.length === 1 && unresolved.length === 1) winner.set(missing[0]!.unitId, unresolved[0]!);

  const still = required.filter((unit) => !winner.has(unit.unitId));
  if (still.length > 0) {
    const found = videos.map((video) => basename(video.relPath)).join(', ');
    const detail = `No file for ${still.map(unitLabel).join(', ')} in the download (expected ${expected.map(unitLabel).join(', ')}); found: ${found}.`;
    throw new JobFailure('importMismatch', detail.length > 1000 ? `${detail.slice(0, 999)}…` : detail);
  }
  // In the expected Units' order.
  const byVideo = new Map<Video, ExpectedUnit[]>();
  for (const unit of expected) {
    const video = winner.get(unit.unitId);
    if (!video) continue;
    byVideo.set(video, [...(byVideo.get(video) ?? []), unit]);
  }
  return byVideo;
}

const namedUnit = ({ season, episode, absolute, title }: ExpectedUnit): NamedUnit => ({
  ...(season === undefined ? {} : { season }),
  ...(episode === undefined ? {} : { episode }),
  ...(absolute === undefined ? {} : { absolute }),
  ...(title === undefined ? {} : { title }),
});

export function importHandler(deps: ImportDeps): JobHandler {
  const link = deps.link ?? fsLink;

  /** Puts the video in staging: extracted already, else hard-linked, else (another filesystem) copied. Returns whether it is a copy. */
  const stage = async (video: Video, staged: string): Promise<boolean> => {
    if (video.extracted) return true;
    await unlink(staged).catch(() => {});
    try {
      await link(video.path, staged);
      return false;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== 'EXDEV' && code !== 'EPERM') throw error;
      await requireSpace(deps, video.sizeBytes, 'Copying the file from another filesystem');
      await copyFile(video.path, staged);
      return true;
    }
  };

  return async (job, { signal }): Promise<JobResult> => {
    const payload = ImportPayload.parse(job.payload);
    const { layout } = deps;
    const content = toLocal(layout, payload.contentPath);
    const workFolder = toLocal(layout, payload.workFolderPath);
    const staging = stagingPath(layout, job.jobId);
    const movie = payload.naming.kind === 'movie';
    try {
      let videos = await listVideos(content);
      if (videos.length === 0) videos = await extractArchives(content, join(staging, 'extract'), deps, signal);
      if (videos.length === 0) throw new JobFailure('noMediaFile', 'The download holds no video file.');

      let assigned: Map<Video, ExpectedUnit[]>;
      if (payload.importAs) {
        // A manual grab of unclear numbering: after the sample and extras rules, its one video is the Unit the user chose.
        if (videos.length > 1) throw new JobFailure('importMismatch', "This release has several episodes; omnarr can't tell which one you wanted.");
        const chosen = new Set<string>(payload.importAs);
        assigned = new Map([[videos[0]!, payload.expectedUnits.filter((unit) => chosen.has(unit.unitId))]]);
      } else if (movie) {
        const largest = videos.reduce((a, b) => (b.sizeBytes > a.sizeBytes ? b : a));
        assigned = new Map([[largest, payload.expectedUnits]]);
      } else {
        const answer = await deps.backend.resolveFiles({
          jobId: job.jobId,
          leaseEpoch: job.leaseEpoch,
          files: videos.map(({ relPath, sizeBytes }) => ({ relPath, sizeBytes })),
        });
        assigned = assign(videos, new Map(answer.map((file) => [file.relPath, file])), payload.expectedUnits);
      }

      await mkdir(staging, { recursive: true });
      const files = [];
      let n = 0;
      for (const [video, units] of assigned) {
        n++;
        const ext = extname(video.path).toLowerCase();
        const staged = video.extracted ? video.path : join(staging, `${n}${ext}`);
        const copy = await stage(video, staged);
        const probe = await deps.probe(staged, signal);
        // An upgrade file that needs preparation waits in staging/held/<jobId>/ for its prepare job.
        if (payload.holdUnlessFits && !compare(probe, payload.holdUnlessFits).fits) {
          const held = join(deps.layout.held, job.jobId, basename(staged));
          await mkdir(dirname(held), { recursive: true });
          await rename(staged, held);
          const info = await stat(held);
          files.push({ path: held, sizeBytes: info.size, inode: inodeOf(info), probe, unitIds: units.map((unit) => unit.unitId) });
          continue;
        }
        const target = await libraryTarget(workFolder, payload.naming, units.map(namedUnit), probe, ext);
        await mkdir(dirname(target), { recursive: true });
        const path = await placeAt(staged, target, copy);
        const info = await stat(path);
        files.push({ path, sizeBytes: info.size, inode: inodeOf(info), probe, unitIds: units.map((unit) => unit.unitId) });
      }
      return { class: 'import', files };
    } catch (error) {
      if (error instanceof JobFailure || signal.aborted) throw error;
      if (errorFailureCode(error) === 'diskFull') throw new JobFailure('diskFull', 'The disk ran out of space during the import.', undefined, { cause: error });
      throw error;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  };
}
