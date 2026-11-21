// A worker that does what the real one would, through the worker functions
// only: submits, reports downloads, imports and publishes, so the
// pipeline tests drive a Grab's run end to end in convex-test. Its import
// asks `imports.resolveFiles` which Units each file holds and assigns them
// as the real import does, then names each file with `libraryFileName`.
import {
  compare,
  libraryFileName,
  seasonFolderFor,
  type ClientStatus,
  type ClientStatusReport,
  type DownloadReport,
  type FailureData,
  type ImportPayload,
  type JobClass,
  type JobResult,
  type LeasedJob,
  type ProbeSummary,
  type ResolvedFile,
} from '@omnarr/contracts';

import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import { capabilities, skipDefinitionSync, storageSpace, worker, type Backend } from './setup';

const stream = { default: false, forced: false, hearingImpaired: false } as const;
const video1080p = {
  ...stream,
  index: 0,
  kind: 'video',
  codec: 'h264',
  profile: 'High',
  default: true,
  width: 1920,
  height: 1080,
  bitDepth: 8,
  pixFmt: 'yuv420p',
  interlaced: false,
  frameRate: 23.976,
  colorPrimaries: 'bt709',
  colorTransfer: 'bt709',
  colorSpace: 'bt709',
  hdr: 'sdr',
} as const;

/**
 * The standard WEB-DL: Matroska, H.264 8-bit 1080p, E-AC-3 5.1 in English,
 * SubRip in English and German. Against the default target it needs the
 * `audio`, `subtitle` and `remux` steps, but no video transcode.
 */
export const WEB_DL_PROBE: ProbeSummary = {
  container: 'matroska',
  durationMs: 2_640_000,
  bitRateKbps: 6_500,
  streams: [
    video1080p,
    {
      ...stream,
      index: 1,
      kind: 'audio',
      codec: 'eac3',
      language: 'en',
      default: true,
      channels: 6,
      channelLayout: '5.1(side)',
      sampleRate: 48_000,
      bitRateKbps: 640,
    },
    { ...stream, index: 2, kind: 'subtitle', codec: 'subrip', language: 'en', format: 'text' },
    { ...stream, index: 3, kind: 'subtitle', codec: 'subrip', language: 'de', format: 'text' },
  ],
};

/** A file the default target plays as it is: MP4, H.264 8-bit 1080p, AAC 2.0, no subtitle streams. */
export const FITTING_PROBE: ProbeSummary = {
  container: 'mp4',
  durationMs: 2_640_000,
  bitRateKbps: 5_200,
  streams: [
    video1080p,
    {
      ...stream,
      index: 1,
      kind: 'audio',
      codec: 'aac',
      profile: 'LC',
      language: 'en',
      default: true,
      channels: 2,
      channelLayout: 'stereo',
      sampleRate: 48_000,
      bitRateKbps: 192,
    },
  ],
};

const status = (stage: string, progress: number): ClientStatus => ({ stage, progress, raw: { Status: stage } });

const pad = (n: number | undefined) => String(n ?? 0).padStart(2, '0');

/** What a download of the import's expected Units holds by default: one release-named video per Unit (a movie: one). */
export function releaseFiles(payload: ImportPayload): { relPath: string; sizeBytes: number }[] {
  const { naming, expectedUnits } = payload;
  const title = naming.title.replace(/ /g, '.');
  if (naming.kind === 'movie') return [{ relPath: `${title}.${naming.year ?? ''}.1080p.WEB-DL.DDP5.1.H.264-GRP.mkv`, sizeBytes: 4_000_000_000 }];
  return expectedUnits.map((unit) => ({
    relPath: `${title}.S${pad(unit.season)}E${pad(unit.episode)}.1080p.WEB-DL.DDP5.1.H.264-GRP.mkv`,
    sizeBytes: 1_500_000_000,
  }));
}

export type ImportOptions = {
  /** The download's videos, relative to `contentPath`; by default `releaseFiles(payload)`. */
  files?: (payload: ImportPayload) => { relPath: string; sizeBytes: number }[];
  /** What ffprobe finds in each file; by default the standard WEB-DL. */
  probe?: ProbeSummary;
};

/**
 * The import's assignment, as the worker applies it: a file takes the expected Units it
 * holds, a file of only other Units is skipped, and one unresolved video goes
 * to one Unit left without a file. A movie takes its largest video. An
 * expected Unit still without a file is the import's `importMismatch`.
 */
function assign(payload: ImportPayload, files: { relPath: string; sizeBytes: number }[], resolved: ResolvedFile[]) {
  const expected = new Set(payload.expectedUnits.map((unit) => unit.unitId));
  // A manual grab of unclear numbering: its one video is the chosen Units, several are a mismatch.
  if (payload.importAs) {
    const chosen = payload.expectedUnits.filter((unit) => payload.importAs!.includes(unit.unitId)).map((unit) => unit.unitId);
    return files.length === 1 ? { taken: [{ ...files[0]!, unitIds: chosen }], missing: [] } : { taken: [], missing: chosen };
  }
  if (payload.naming.kind === 'movie') {
    const largest = [...files].sort((a, b) => b.sizeBytes - a.sizeBytes)[0];
    return { taken: largest ? [{ ...largest, unitIds: payload.expectedUnits.map((unit) => unit.unitId) }] : [], missing: largest ? [] : [...expected] };
  }
  const taken: { relPath: string; sizeBytes: number; unitIds: Id<'units'>[] }[] = [];
  for (const [i, file] of files.entries()) {
    const unitIds = resolved[i]!.unitIds.filter((unitId) => expected.has(unitId));
    if (unitIds.length > 0) taken.push({ ...file, unitIds });
  }
  const covered = new Set(taken.flatMap((file) => file.unitIds));
  // An optional Unit (a pack's other episode) the download lacks is no mismatch, as in the worker's `assign`.
  const required = payload.expectedUnits.filter((unit) => !unit.optional).map((unit) => unit.unitId);
  let missing = required.filter((unitId) => !covered.has(unitId));
  const unresolved = files.filter((_, i) => resolved[i]!.unitIds.length === 0);
  if (missing.length === 1 && unresolved.length === 1) {
    taken.push({ ...unresolved[0]!, unitIds: missing });
    missing = [];
  }
  return { taken, missing };
}

export type FakeWorker = Awaited<ReturnType<typeof fakeWorker>>;

export async function fakeWorker(t: Backend, workerId = 'w1') {
  await skipDefinitionSync(t);
  const response = await t.mutation(api.jobs.worker.connect, { ...worker, workerId, capabilities });
  if (!response.accepted) throw new Error('not accepted');
  const sessionId = response.sessionId;

  const claim = (cls: JobClass, max = 10): Promise<LeasedJob[]> => t.mutation(api.jobs.queue.claim, { ...worker, sessionId, class: cls, max });
  /** Completes a leased job with this result, as the worker's `job.complete` does. */
  const complete = (job: LeasedJob, result: JobResult) =>
    t.mutation(api.jobs.queue.complete, { ...worker, jobId: job.jobId, leaseEpoch: job.leaseEpoch, result });
  const fail = (
    job: LeasedJob,
    failureCode: Parameters<typeof t.mutation<typeof api.jobs.queue.fail>>[1]['failureCode'],
    detail = 'Failed.',
    data?: FailureData,
  ) => t.mutation(api.jobs.queue.fail, { ...worker, jobId: job.jobId, leaseEpoch: job.leaseEpoch, failureCode, detail, ...(data ? { data } : {}) });
  const report = (reports: DownloadReport) => t.mutation(api.jobs.downloads.report, { ...worker, sessionId, reports });
  /** `imports.resolveFiles` for a leased import. */
  const resolveFiles = (job: LeasedJob, files: { relPath: string; sizeBytes: number }[]) =>
    t.query(api.jobs.imports.resolveFiles, { ...worker, jobId: job.jobId, leaseEpoch: job.leaseEpoch, files });

  /** Runs one leased import as the worker does: resolve, assign, place under the Work folder, complete (or fail `importMismatch`). */
  async function runImport(job: LeasedJob, options: ImportOptions = {}): Promise<void> {
    if (job.payload.class !== 'import') throw new Error(`not an import: ${job.payload.class}`);
    const payload = job.payload;
    const files = (options.files ?? releaseFiles)(payload);
    const probe = options.probe ?? WEB_DL_PROBE;
    // Movies skip the resolve step.
    const resolved = payload.naming.kind === 'movie' || payload.importAs ? [] : await resolveFiles(job, files);
    const { taken, missing } = assign(payload, files, resolved);
    if (missing.length > 0) {
      await fail(job, 'importMismatch', `Expected ${missing.length} more Unit(s); found ${files.map((file) => file.relPath).join(', ')}.`);
      return;
    }
    const units = new Map(payload.expectedUnits.map((unit) => [unit.unitId, unit]));
    await complete(job, {
      class: 'import',
      files: taken.map((file, i) => {
        const named = file.unitIds.map((unitId) => units.get(unitId)!);
        const ext = `.${file.relPath.split('.').at(-1)!}`;
        const name = libraryFileName({ naming: payload.naming, units: named, probe, ext });
        const folder = payload.naming.kind === 'movie' ? payload.workFolderPath : `${payload.workFolderPath}/${seasonFolderFor([], named[0]!.season ?? 0)}`;
        // An upgrade file that doesn't fit waits under staging/held/.
        const held = payload.holdUnlessFits && !compare(probe, payload.holdUnlessFits).fits;
        return {
          path: held ? `/data/staging/held/${job.jobId}/${i + 1}${ext}` : `${folder}/${name}`,
          sizeBytes: file.sizeBytes,
          inode: `1:${job.jobId}:${i + 1}`,
          probe,
          unitIds: file.unitIds,
        };
      }),
    });
  }

  return {
    sessionId,
    claim,
    complete,
    fail,
    report,
    resolveFiles,
    runImport,
    /** The reconciler's config read. */
    desiredClients: () => t.query(api.jobs.clients.desired, { ...worker, sessionId }),
    /** The reconciler's client status, sent on change. */
    reportClients: (reports: ClientStatusReport[]) => t.mutation(api.jobs.clients.report, { ...worker, sessionId, reports }),
    heartbeat: () => t.mutation(api.jobs.worker.heartbeat, { ...worker, sessionId, storage: storageSpace() }),
    /** Claims every queued `download.submit` and completes it: the client accepted the release. */
    async submitAll(): Promise<LeasedJob[]> {
      const jobs = await claim('download.submit');
      for (const job of jobs) await complete(job, { class: 'download.submit', clientRef: `nzb-${job.jobId}` });
      return jobs;
    },
    /** The reconciler saw the download move to a new stage in its client. */
    stage: (downloadId: Id<'downloads'>, clientStage: 'queued' | 'downloading' | 'postProcessing') =>
      report([{ downloadId, clientStage, clientStatus: status(clientStage, 0.5) }]),
    /** The reconciler saw the download finish. */
    completed: (downloadId: Id<'downloads'>, contentPath = `/data/downloads/usenet/series/${downloadId}`) =>
      report([{ downloadId, outcome: 'completed', contentPath, clientStatus: status('SUCCESS/ALL', 1) }]),
    /** The reconciler saw a torrent finish and start seeding, with qBittorrent's private flag. */
    torrentCompleted: (downloadId: Id<'downloads'>, options: { private: boolean }) =>
      report([
        {
          downloadId,
          outcome: 'completed',
          contentPath: `/data/downloads/torrents/platform-series/${downloadId}`,
          private: options.private,
          clientStatus: status('stalledUP', 1),
        },
      ]),
    /** The Downloads the reconciler compares with its clients. */
    watched: () => t.query(api.jobs.downloads.watched, { ...worker, sessionId }),
    /** qBittorrent stopped the torrent at its goal. */
    seedingDone: (downloadId: Id<'downloads'>, seed: { ratio: number; seedTimeMs: number }) =>
      report([{ downloadId, outcome: 'seedingDone', seedRatio: seed.ratio, seedTimeMs: seed.seedTimeMs, clientStatus: status('stoppedUP', 1) }]),
    /** A seeding torrent's ratio, seed time and uploaded bytes, as the pass reports them without an outcome (seeding progress). */
    seeding: (downloadId: Id<'downloads'>, seed: { ratio: number; seedTimeMs: number; uploadedBytes: number }) =>
      report([{ downloadId, clientStatus: { ...status('stalledUP', 1), ...seed } }]),
    /** A seeding torrent's files are gone, or it left the client. */
    seedingLost: (downloadId: Id<'downloads'>) => report([{ downloadId, outcome: 'seedingLost', clientStatus: status('missingFiles', 1) }]),
    /** The reconciler saw the download fail, with the code failures.ts maps its status to, if it maps one. */
    failed: (downloadId: Id<'downloads'>, failureCode?: DownloadReport[number]['failureCode'], clientStage = 'FAILURE/HEALTH') =>
      report([{ downloadId, outcome: 'failed', ...(failureCode ? { failureCode } : {}), clientStatus: status(clientStage, 0.6) }]),
    /** The reconciler saw the item deleted in the client. */
    removed: (downloadId: Id<'downloads'>) => report([{ downloadId, outcome: 'removed', clientStatus: status('DELETED/MANUAL', 0.6) }]),
    /** Claims every queued import and runs it: by default one release-named WEB-DL per expected Unit (the standard WEB-DL's probe). */
    async importAll(options: ImportOptions = {}): Promise<LeasedJob[]> {
      const jobs = await claim('import');
      for (const job of jobs) await runImport(job, options);
      return jobs;
    },
    /** Claims every queued publish and completes it: Jellyfin sees every file. */
    async publishAll(): Promise<LeasedJob[]> {
      const jobs = await claim('publish');
      for (const job of jobs) {
        if (job.payload.class !== 'publish') continue;
        const targetItemRefs = Object.fromEntries(job.payload.publicationIds.map((id) => [id, `jf-${id}`]));
        await complete(job, { class: 'publish', targetItemRefs });
      }
      return jobs;
    },
  };
}
