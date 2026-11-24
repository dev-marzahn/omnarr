// `prepare`: turns a library file into one that
// fits its library's target. A re-claimed job first looks for its own earlier
// work; then the source is probed and compared, staging's free space checked,
// the text subtitles extracted, the main ffmpeg run made and its output
// checked, and the result swapped into the library: for `keep` the source and
// its sidecars move to originals/ first. A kept original that already fits
// is restored instead: it moves back into the library under its own name.
// With a kept original as the source, the swap also removes the
// Unit's earlier primary (`replacesPath`). Everything is written under
// `staging/<jobId>`, which is removed in every case. A failure uploads the
// job's `ffmpeg.log` and fails with its storage ID.
import { copyFile, mkdir, readdir, readFile, rename, rm, stat, unlink } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

import {
  compare,
  type Comparison,
  DEFAULT_LIMITS,
  type JobResult,
  LanguageCode,
  libraryFileName,
  PreparePayload,
  type PrepareResult,
  type ProbeSummary,
  type Sidecar,
  sidecarName,
  type TargetFormat,
} from '@omnarr/contracts';
import type { GenericId } from 'convex/values';

import type { WorkerBackend } from '../convex.ts';
import { errorFailureCode } from '../failures.ts';
import { areaOf, type DataLayout, stagingPath, toLocal } from '../fs/layout.ts';
import { freeBytesAt, inodeOf } from '../fs/space.ts';
import { mainArgs, outputContainer, videoEncoder } from '../media/ffmpegArgs.ts';
import { checkOutput, type RunOptions } from '../media/prepare.ts';
import { extractSubtitles } from '../media/subtitles.ts';
import { type JobHandler, JobFailure } from '../runtime/lease.ts';

export type PrepareDeps = {
  layout: DataLayout;
  /** ffprobe, summarised. */
  probe: (path: string, signal: AbortSignal) => Promise<ProbeSummary>;
  /** The main ffmpeg run: `runChild` (media/prepare.ts). */
  run: (options: RunOptions) => Promise<void>;
  backend: Pick<WorkerBackend, 'artifactUploadUrl'>;
  /** The POST of `ffmpeg.log` to the upload URL; the global `fetch` by default. */
  fetch?: typeof fetch;
  /** Free bytes where a path is (`statfs`); injected by tests. */
  freeBytes?: (path: string) => Promise<number>;
  /** The rename that restores a kept original (and its sidecars) from originals/; injected by tests to fail with `EXDEV`. */
  rename?: (from: string, to: string) => Promise<void>;
};

type Payload = PreparePayload;
type Prepared = Extract<PrepareResult, { noChange: false }>;

const MIB = 1024 * 1024;
const SIDECAR = /\.(srt|ass)$/i;

const CODECS: Readonly<Record<string, string>> = {
  h264: 'H.264',
  hevc: 'HEVC',
  av1: 'AV1',
  vp9: 'VP9',
  mpeg2video: 'MPEG-2',
  vc1: 'VC-1',
  mpeg4: 'MPEG-4',
  aac: 'AAC',
  ac3: 'AC-3',
  eac3: 'E-AC-3',
  dts: 'DTS',
  truehd: 'TrueHD',
  flac: 'FLAC',
  opus: 'Opus',
  mp3: 'MP3',
  mp2: 'MP2',
};
const CONTAINERS: Readonly<Record<string, string>> = { matroska: 'Matroska', mkv: 'Matroska', mp4: 'MP4', webm: 'WebM', mpegts: 'MPEG-TS', avi: 'AVI' };
const label = (table: Readonly<Record<string, string>>, name: string | undefined) => (name ? (table[name] ?? name.toUpperCase()) : '?');

export const PREPARE_STEP = {
  checkingSource: 'Checking the file',
  subtitles: 'Subtitle extraction',
  checkingOutput: 'Checking the new file',
  moving: 'Moving into the library',
} as const;

export function mainRunDetail(plan: Comparison): string {
  const transcoded = (kind: 'video' | 'audio') => plan.streams.find((stream) => stream.kind === kind && stream.action === 'transcode');
  const [step] = plan.steps;
  if (step === 'video') {
    const row = transcoded('video');
    return `Video conversion ${label(CODECS, row?.from)} → ${label(CODECS, row?.to)}`;
  }
  if (step === 'audio') {
    const row = transcoded('audio');
    return `Audio conversion ${label(CODECS, row?.from)} → ${label(CODECS, row?.to)}`;
  }
  if (step === 'subtitle') return PREPARE_STEP.subtitles;
  return `Remux ${label(CONTAINERS, plan.container.from)} → ${label(CONTAINERS, plan.container.to)}`;
}

/** The text sidecars beside a video (`<base>[.<lang>][.sdh][.forced][.<n>].srt|ass`), with the flags their names carry. */
async function sidecarsOf(video: string): Promise<Sidecar[]> {
  const folder = dirname(video);
  const base = basename(video, extname(video));
  const names = (await readdir(folder).catch(() => [])).filter((name) => name.startsWith(`${base}.`) && SIDECAR.test(name)).sort();
  return names.map((name) => {
    const tokens = name.slice(base.length + 1).split('.');
    const format = tokens.pop()!.toLowerCase() as Sidecar['format'];
    const language = LanguageCode.safeParse(tokens[0]);
    return {
      path: join(folder, name),
      ...(language.success && language.data !== 'multi' ? { language: language.data } : {}),
      forced: tokens.includes('forced'),
      sdh: tokens.includes('sdh'),
      format,
    };
  });
}

/** The output's size estimate: the source's size; with a video step `videoSizeRatio` × it, or the bit-rate cap × the duration, whichever is smaller; + 1 MiB per subtitle track. */
function estimate(sourceBytes: number, probe: ProbeSummary, plan: Comparison, target: TargetFormat): number {
  let bytes = sourceBytes;
  if (plan.steps.includes('video')) {
    bytes = DEFAULT_LIMITS.videoSizeRatio * sourceBytes;
    const cap = target.video.maxBitrateKbps;
    if (cap !== null && probe.durationMs !== undefined) bytes = Math.min(bytes, ((cap * 1000) / 8) * (probe.durationMs / 1000));
  }
  const subtitles = plan.streams.filter((stream) => stream.kind === 'subtitle' && (stream.action === 'extract' || stream.action === 'burnIn')).length;
  return Math.ceil(bytes + subtitles * MIB);
}

const exists = (path: string) => stat(path).catch(() => undefined);

export function prepareHandler(deps: PrepareDeps): JobHandler {
  const upload = async (job: { jobId: GenericId<'jobs'>; leaseEpoch: number }, logPath: string): Promise<GenericId<'_storage'> | undefined> => {
    const body = await readFile(logPath).catch(() => undefined);
    if (!body?.length) return undefined;
    try {
      const { uploadUrl } = await deps.backend.artifactUploadUrl({ jobId: job.jobId, leaseEpoch: job.leaseEpoch });
      const response = await (deps.fetch ?? fetch)(uploadUrl, { method: 'POST', headers: { 'Content-Type': 'text/plain; charset=utf-8' }, body });
      if (!response.ok) return undefined;
      return ((await response.json()) as { storageId?: GenericId<'_storage'> }).storageId;
    } catch {
      // The failure itself matters more than its log.
      return undefined;
    }
  };

  const prepare = handle(deps, upload);
  // A held upgrade file's folder goes once the swap moved or removed the file; a failed job leaves it to the backend.
  return async (job, context): Promise<JobResult> => {
    const result = await prepare(job, context);
    const source = toLocal(deps.layout, PreparePayload.parse(job.payload).sourcePath);
    const folder = dirname(source);
    if (dirname(folder) === deps.layout.held && !(await exists(source))) await rm(folder, { recursive: true, force: true });
    return result;
  };
}

function handle(
  deps: PrepareDeps,
  upload: (job: { jobId: GenericId<'jobs'>; leaseEpoch: number }, logPath: string) => Promise<GenericId<'_storage'> | undefined>,
): JobHandler {
  return async (job, { signal, progress }): Promise<JobResult> => {
    const payload: Payload = PreparePayload.parse(job.payload);
    const { layout } = deps;
    const { target } = payload;
    const sourcePath = toLocal(layout, payload.sourcePath);
    const outputFolder = toLocal(layout, payload.outputFolder);
    const originalsFolder = toLocal(layout, payload.originalsFolder);
    const kept = join(originalsFolder, basename(sourcePath));
    const keep = payload.disposition === 'keep';
    /** The source is a kept original (a later profile edit, "Prepare now" or "Prepare all"): one that fits is restored. */
    const fromOriginal = areaOf(layout, sourcePath) === 'originals';
    /** The Unit's earlier primary, which a kept original's output replaces. */
    const replaces = payload.replacesPath === undefined ? undefined : toLocal(layout, payload.replacesPath);
    const staging = stagingPath(layout, job.jobId);
    const logPath = join(staging, 'ffmpeg.log');
    const { naming } = payload;
    const nameFor = (probe: ProbeSummary, ext: string) =>
      'keepBaseName' in naming ? `${naming.keepBaseName}${ext}` : libraryFileName({ naming, units: payload.units, probe, ext });
    const fits = (probe: ProbeSummary) => compare(probe, target).fits;
    const probeOrNone = (path: string) => deps.probe(path, signal).catch((error: unknown) => (signal.aborted ? Promise.reject(error) : undefined));

    /** The source's sidecars go with it: to originals/ for `keep`. */
    const moveToOriginals = async (source: string) => {
      await mkdir(originalsFolder, { recursive: true });
      for (const sidecar of await sidecarsOf(source)) await rename(sidecar.path, join(originalsFolder, basename(sidecar.path)));
      await rename(source, kept);
    };
    /** Whether a file's sidecars are the output's too: beside it, under the same base name. */
    const besideOutput = (path: string, outputPath: string) =>
      dirname(path) === dirname(outputPath) && basename(path, extname(path)) === basename(outputPath, extname(outputPath));
    /**
     * `replace`, and the earlier primary a kept original's output replaces:
     * the path goes, with sidecars that aren't the output's. A seeding
     * torrent keeps its own link.
     */
    const removeSource = async (source: string, outputPath: string) => {
      if (!besideOutput(source, outputPath)) for (const sidecar of await sidecarsOf(source)) await unlink(sidecar.path).catch(() => {});
      if (source !== outputPath) await unlink(source).catch(() => {});
    };
    /** A move out of originals/: a rename, or on another filesystem a copy to `<to>.partial`, renamed into place, then the original deleted. */
    const move = async (from: string, to: string) => {
      try {
        await (deps.rename ?? rename)(from, to);
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
        const partial = `${to}.partial`;
        await copyFile(from, partial);
        await rename(partial, to);
        await unlink(from);
      }
    };
    /** The result for a restored original at `outputPath`, with the earlier primary gone. */
    const restoredAt = async (outputPath: string, probe: ProbeSummary): Promise<Prepared> => {
      if (replaces) await removeSource(replaces, outputPath);
      const info = await stat(outputPath);
      return {
        class: 'prepare',
        noChange: false,
        restored: true,
        outputPath,
        sizeBytes: info.size,
        inode: inodeOf(info),
        probe,
        encoder: 'copy',
        steps: [],
        sidecars: await sidecarsOf(outputPath),
        droppedTracks: [],
        sourceRemoved: true,
      };
    };
    /**
     * A kept original that fits goes back into the library under its own
     * name, with its sidecars renamed onto the new base. An earlier
     * primary's sidecars under that same base are overwritten where the
     * names meet and otherwise stay, so a re-run after a crash never deletes
     * a sidecar this restore already moved in.
     */
    const restore = async (original: string, probe: ProbeSummary): Promise<Prepared> => {
      progress(0, PREPARE_STEP.moving);
      const ext = extname(original);
      const outputPath = join(outputFolder, nameFor(probe, ext));
      const base = basename(outputPath, ext);
      await mkdir(outputFolder, { recursive: true });
      const taken = new Set<string>();
      for (const sidecar of await sidecarsOf(original)) await move(sidecar.path, join(outputFolder, sidecarName(base, sidecar, taken)));
      await move(original, outputPath);
      return await restoredAt(outputPath, probe);
    };

    /** A full result for an output found in place, with what is left of the swap finished. */
    const resumed = async (outputPath: string, outputProbe: ProbeSummary, leftover: string | undefined): Promise<Prepared> => {
      progress(0, PREPARE_STEP.moving);
      const plan = leftover
        ? compare(await deps.probe(leftover, signal), target)
        : (await exists(kept))
          ? compare(await deps.probe(kept, signal), target)
          : undefined;
      if (leftover && keep) await moveToOriginals(leftover);
      else if (leftover) await removeSource(leftover, outputPath);
      if (replaces) await removeSource(replaces, outputPath);
      const info = await stat(outputPath);
      const original = keep && (await exists(kept)) ? kept : undefined;
      return {
        class: 'prepare',
        noChange: false,
        outputPath,
        sizeBytes: info.size,
        inode: inodeOf(info),
        probe: outputProbe,
        // Without a source left to compare, the plan is unknown.
        encoder: plan ? videoEncoder(plan, target) : 'unknown',
        steps: plan?.steps ?? [],
        sidecars: await sidecarsOf(outputPath),
        droppedTracks: [],
        sourceRemoved: true,
        ...(original ? { originalPath: original, originalSidecars: await sidecarsOf(original) } : {}),
      };
    };

    /**
     * The planned output in `outputFolder`: a video whose name is the one
     * `libraryFileName` (or `keepBaseName`) gives for its own probe, that
     * fits and isn't the source. Only names with the planned name's leading
     * part are probed. A kept original's restore keeps its inode, so for a
     * source under originals/ the source's inode is the restored output; the
     * earlier primary being replaced never is the output.
     */
    const findOutput = async (): Promise<{ path: string; probe: ProbeSummary; restored: boolean } | undefined> => {
      const lead = nameFor({ container: 'other', streams: [] }, '').split('[')[0]!;
      const names = (await readdir(outputFolder).catch(() => [])).filter((name) => /\.(mp4|m4v|mkv)$/.test(name) && name.startsWith(lead)).sort();
      for (const name of names) {
        const path = join(outputFolder, name);
        const info = await exists(path);
        if (!info?.isFile()) continue;
        const restored = fromOriginal && inodeOf(info) === payload.sourceInode;
        if (inodeOf(info) === payload.sourceInode && !restored) continue;
        if (path === replaces && !restored) continue;
        const probe = await probeOrNone(path);
        if (probe && name === nameFor(probe, extname(name)) && fits(probe)) return { path, probe, restored };
      }
      return undefined;
    };

    try {
      progress(0, PREPARE_STEP.checkingSource);
      const atSource = await exists(sourcePath);
      const isSource = atSource !== undefined && inodeOf(atSource) === payload.sourceInode;
      // A kept original still under originals/ that fits is restored, before any resume rule: a restore cut short runs again.
      let originalProbe: ProbeSummary | undefined;
      if (fromOriginal && isSource) {
        originalProbe = await deps.probe(sourcePath, signal);
        if (fits(originalProbe)) return await restore(sourcePath, originalProbe);
      }
      if (atSource && !isSource && !fromOriginal) {
        const probe = await probeOrNone(sourcePath);
        if (probe && fits(probe)) return await resumed(sourcePath, probe, undefined);
      }
      const found = await findOutput();
      if (found?.restored) return await restoredAt(found.path, found.probe);
      if (found) return await resumed(found.path, found.probe, isSource ? sourcePath : undefined);

      const source = keep && (await exists(kept)) ? kept : atSource ? sourcePath : undefined;
      if (!source) throw new JobFailure('pipelineError', `Source file missing: ${basename(sourcePath)}.`);

      const sourceProbe = source === sourcePath && originalProbe ? originalProbe : await deps.probe(source, signal);
      const plan = compare(sourceProbe, target);
      if (plan.fits) return { class: 'prepare', noChange: true };
      if (plan.streams.some((stream) => stream.reason === 'dvNoFallback'))
        throw new JobFailure('transcodeFailed', "Dolby Vision without an HDR10 base layer can't be converted on CPU.");

      const needed = estimate((await stat(source)).size, sourceProbe, plan, target) + DEFAULT_LIMITS.freeSpaceMarginBytes;
      const free = await (deps.freeBytes ?? freeBytesAt)(layout.staging);
      if (free < needed) throw new JobFailure('diskFull', `Preparation needs ${needed} bytes in staging/ (with the margin); ${free} bytes free.`);
      await mkdir(staging, { recursive: true });

      const subtitles = await extractSubtitles({
        source,
        comparison: plan,
        sourceProbe,
        outDir: join(staging, 'subs'),
        logPath,
        signal,
        onProgress: (fraction) => progress(fraction, PREPARE_STEP.subtitles),
      });

      const ext = `.${outputContainer(plan, target)}`;
      const out = join(staging, `out${ext}`);
      const detail = mainRunDetail(plan);
      progress(0, detail);
      await deps.run({
        command: 'ffmpeg',
        args: mainArgs(source, plan, target, { output: out, sourceProbe, ...(subtitles.burn ? { burn: subtitles.burn } : {}) }),
        signal,
        logPath,
        nice: true,
        ...(sourceProbe.durationMs === undefined ? {} : { durationMs: sourceProbe.durationMs }),
        onProgress: (fraction) => progress(fraction, detail),
      });

      progress(0, PREPARE_STEP.checkingOutput);
      const outputProbe = await deps.probe(out, signal);
      checkOutput(sourceProbe, outputProbe, target, plan);

      progress(0, PREPARE_STEP.moving);
      const outputPath = join(outputFolder, nameFor(outputProbe, ext));
      const base = basename(outputPath, ext);
      if (keep && source !== kept) await moveToOriginals(source);
      await mkdir(outputFolder, { recursive: true });
      // A source with the same base name keeps its sidecars beside the new file; new tracks are numbered after them.
      const sameBase = !keep && besideOutput(source, outputPath);
      const existing = sameBase ? await sidecarsOf(source) : [];
      // An earlier primary under the same base loses its sidecars to the new ones (a re-run makes them again).
      if (replaces && besideOutput(replaces, outputPath)) for (const old of await sidecarsOf(replaces)) await unlink(old.path).catch(() => {});
      const taken = new Set(existing.map((sidecar) => basename(sidecar.path)));
      const sidecars: Sidecar[] = [...existing];
      for (const sidecar of subtitles.sidecars) {
        const path = join(outputFolder, sidecarName(base, sidecar, taken));
        await rename(sidecar.path, path);
        sidecars.push({ ...sidecar, path });
      }
      await rename(out, outputPath);
      if (!keep) await removeSource(source, outputPath);
      if (replaces) await removeSource(replaces, outputPath);

      const info = await stat(outputPath);
      return {
        class: 'prepare',
        noChange: false,
        outputPath,
        sizeBytes: info.size,
        inode: inodeOf(info),
        probe: outputProbe,
        encoder: videoEncoder(plan, target),
        steps: plan.steps,
        sidecars: sidecars.sort((a, b) => a.path.localeCompare(b.path)),
        droppedTracks: subtitles.dropped,
        sourceRemoved: true,
        ...(keep ? { originalPath: kept, originalSidecars: await sidecarsOf(kept) } : {}),
      };
    } catch (error) {
      if (signal.aborted) throw error;
      const failure =
        error instanceof JobFailure
          ? error
          : errorFailureCode(error) === 'diskFull'
            ? new JobFailure('diskFull', 'The disk ran out of space during preparation.', undefined, { cause: error })
            : undefined;
      if (failure) {
        const storageId = await upload(job, logPath);
        if (storageId) failure.artifactStorageId = storageId;
      }
      throw failure ?? error;
    } finally {
      await rm(staging, { recursive: true, force: true });
    }
  };
}
