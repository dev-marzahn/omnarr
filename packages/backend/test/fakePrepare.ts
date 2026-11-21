// The preparation tests' scaffolding: probes of typical source files, a
// library file seeded as an import or the scan leaves it, and a
// worker that claims, completes and fails `prepare` jobs through the worker
// functions only, as the real one would.
import {
  type FailureCode,
  type LeasedJob,
  libraryFileName,
  type PreparePayload,
  type PrepareResult,
  type ProbeSummary,
  type ProbeStream,
  type Sidecar,
} from '@omnarr/contracts';
import { parseRelease } from '@omnarr/parser';

import { api } from '../convex/_generated/api';
import type { Doc, Id } from '../convex/_generated/dataModel';
import { capabilities, skipDefinitionSync, storageSpace, worker, type Backend, type Libraries } from './setup';

const base = { default: false, forced: false, hearingImpaired: false } as const;
const video = (codec: string, extra: Partial<Extract<ProbeStream, { kind: 'video' }>> = {}): ProbeStream => ({
  ...base,
  default: true,
  index: 0,
  kind: 'video',
  codec,
  width: 1920,
  height: 1080,
  bitDepth: 8,
  pixFmt: 'yuv420p',
  interlaced: false,
  hdr: 'sdr',
  ...extra,
});
const audio = (index: number, codec: string, channels: number): ProbeStream => ({
  ...base,
  default: true,
  index,
  kind: 'audio',
  codec,
  channels,
  language: 'en',
});
const subtitle = (index: number, codec: string, extra: Partial<ProbeStream> = {}): ProbeStream =>
  ({ ...base, index, kind: 'subtitle', codec, format: codec === 'hdmv_pgs_subtitle' ? 'image' : 'text', language: 'en', ...extra }) as ProbeStream;

/** The standard WEB-DL: H.264 8-bit, E-AC-3 5.1, SubRip in English and German, Matroska. Needs audio, subtitle and remux. */
export const WEBDL_PROBE: ProbeSummary = {
  container: 'matroska',
  durationMs: 1_440_000,
  streams: [video('h264'), audio(1, 'eac3', 6), subtitle(2, 'subrip'), subtitle(3, 'subrip', { language: 'de' })],
};

/** What preparing that WEB-DL to the default target gives: H.264 and AAC 2.0 in MP4. Fits. */
export const PREPARED_PROBE: ProbeSummary = { container: 'mp4', durationMs: 1_440_000, streams: [video('h264'), audio(1, 'aac', 2)] };

/** Fits the default target but for its container: a remux. */
export const MKV_PROBE: ProbeSummary = { container: 'matroska', durationMs: 1_440_000, streams: [video('h264'), audio(1, 'aac', 2)] };

/** HEVC 10-bit, which needs a video transcode. */
export const HEVC_PROBE: ProbeSummary = {
  container: 'mp4',
  durationMs: 1_440_000,
  streams: [video('hevc', { bitDepth: 10, pixFmt: 'yuv420p10le' }), audio(1, 'aac', 2)],
};

/** A Bluray encode: H.264, DTS 5.1, English PGS full and forced, Matroska. */
export const BLURAY_PROBE: ProbeSummary = {
  container: 'matroska',
  durationMs: 6_000_000,
  streams: [video('h264'), audio(1, 'dts', 6), subtitle(2, 'hdmv_pgs_subtitle'), subtitle(3, 'hdmv_pgs_subtitle', { forced: true })],
};

export const SHOW_FOLDER = 'Show (2019) [tmdbid-123]';
export const SERIES_ROOT = '/data/library/series';
export const SEASON_1 = `${SERIES_ROOT}/${SHOW_FOLDER}/Season 01`;
/** The WEB-DL as the import named it. */
export const WEBDL_PATH = `${SEASON_1}/Show (2019) - S01E02 - Pilot [AMZN][WEBDL-1080p][EAC3 5.1][h264]-GRP.mkv`;
export const WEBDL_RELEASE = 'Show.S01E02.1080p.AMZN.WEB-DL.DDP5.1.H.264-GRP';

/** A series Work with its stored folder and TMDB ID, as the first import leaves it. */
export function seedShow(t: Backend, libraries: Libraries, extra: Partial<Doc<'works'>> = {}): Promise<Id<'works'>> {
  return t.run(async (ctx) => {
    const workId = await ctx.db.insert('works', {
      libraryId: libraries.series,
      kind: 'series',
      title: 'Show',
      year: 2019,
      numberingScheme: 'standard',
      releaseProfileId: libraries.releaseProfileId,
      monitorNewUnits: true,
      folder: SHOW_FOLDER,
      ...extra,
    });
    await ctx.db.insert('externalIds', { workId, provider: 'tmdb', value: '123' });
    return workId;
  });
}

export function seedUnit(t: Backend, workId: Id<'works'>, episode: number, title?: string, season = 1): Promise<Id<'units'>> {
  return t.run((ctx) =>
    ctx.db.insert('units', {
      workId,
      kind: 'episode',
      tmdbSeason: season,
      tmdbEpisode: episode,
      ...(title === undefined ? {} : { title }),
      airDateUtc: Date.UTC(2019, 0, episode),
      monitored: true,
      derivedState: 'wanted',
    }),
  );
}

export type SeedFile = {
  unitIds: Id<'units'>[];
  path?: string;
  probe?: ProbeSummary;
  origin?: Doc<'files'>['origin'];
  role?: Doc<'files'>['role'];
  keepsName?: boolean;
  /** The release title the file came from; none for a scanned file. */
  release?: string | null;
  kind?: Doc<'fileVersions'>['kind'];
  fits?: boolean;
  /** A `visible` Publication per version (a published primary); off for originals. */
  published?: boolean;
  sidecars?: Sidecar[];
  inode?: string;
};

/** A library file with its links, a version per Unit on its library's profile and, by default, a visible Publication. */
export function seedFile(t: Backend, file: SeedFile): Promise<{ fileId: Id<'files'>; versionIds: Id<'fileVersions'>[] }> {
  return t.run(async (ctx) => {
    const unit = (await ctx.db.get(file.unitIds[0]!))!;
    const work = (await ctx.db.get(unit.workId))!;
    const library = (await ctx.db.get(work.libraryId))!;
    const release = file.release === undefined ? WEBDL_RELEASE : file.release;
    const fileId = await ctx.db.insert('files', {
      path: file.path ?? WEBDL_PATH,
      sizeBytes: 1_500_000_000,
      inode: file.inode ?? '2049:100',
      probe: file.probe ?? WEBDL_PROBE,
      origin: file.origin ?? 'download',
      role: file.role ?? 'source',
      ...(release === null ? {} : { release: parseRelease(release, work.kind) }),
      ...(file.keepsName ? { keepsName: true } : {}),
      ...(file.sidecars ? { sidecars: file.sidecars } : {}),
    });
    const versionIds: Id<'fileVersions'>[] = [];
    for (const [part, unitId] of file.unitIds.entries()) {
      await ctx.db.insert('fileUnits', { fileId, unitId, ...(file.unitIds.length > 1 ? { part: part + 1 } : {}) });
      const fileVersionId = await ctx.db.insert('fileVersions', {
        unitId,
        fileId,
        kind: file.kind ?? 'primary',
        playbackProfileId: library.playbackProfileId,
        fits: file.fits ?? false,
      });
      versionIds.push(fileVersionId);
      if (file.published ?? (file.kind ?? 'primary') === 'primary')
        await ctx.db.insert('publications', { unitId, fileVersionId, generation: 0, target: 'jellyfin', state: 'visible', targetItemRef: `jf-${unitId}` });
    }
    return { fileId, versionIds };
  });
}

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1).replace(/\.[^.]+$/, '');

/**
 * What the worker's prepare job returns for a payload: the
 * output named by `libraryFileName` (or the kept base name), its SubRip
 * sidecars, and, with `keep`, the source under `originalsFolder`.
 */
export function preparedResult(
  payload: PreparePayload,
  extra: Partial<Extract<PrepareResult, { noChange: false }>> & { sidecarLanguages?: ('en' | 'de')[] } = {},
): PrepareResult {
  const { sidecarLanguages = ['en', 'de'], ...rest } = extra;
  const probe = rest.probe ?? PREPARED_PROBE;
  const name =
    'keepBaseName' in payload.naming
      ? `${payload.naming.keepBaseName}.mp4`
      : libraryFileName({ naming: payload.naming, units: payload.units, probe, ext: '.mp4' });
  const outputPath = `${payload.outputFolder}/${name}`;
  const sidecars: Sidecar[] = sidecarLanguages.map((language) => ({
    path: `${payload.outputFolder}/${baseName(name)}.${language}.srt`,
    language,
    forced: false,
    sdh: false,
    format: 'srt',
  }));
  const keep = payload.disposition === 'keep';
  return {
    class: 'prepare',
    noChange: false,
    outputPath,
    sizeBytes: 900_000_000,
    inode: '2049:900',
    probe,
    encoder: 'copy',
    steps: ['audio', 'subtitle', 'remux'],
    sidecars,
    droppedTracks: [],
    sourceRemoved: true,
    ...(keep ? { originalPath: `${payload.originalsFolder}/${payload.sourcePath.slice(payload.sourcePath.lastIndexOf('/') + 1)}`, originalSidecars: [] } : {}),
    ...rest,
  };
}

export type PrepareWorker = Awaited<ReturnType<typeof prepareWorker>>;

/** A connected worker for `prepare` jobs. */
export async function prepareWorker(t: Backend, workerId = 'prepare-worker') {
  await skipDefinitionSync(t);
  const response = await t.mutation(api.jobs.worker.connect, { ...worker, workerId, capabilities });
  if (!response.accepted) throw new Error('not accepted');
  const sessionId = response.sessionId;
  const claim = (max = 1): Promise<LeasedJob[]> => t.mutation(api.jobs.queue.claim, { ...worker, sessionId, class: 'prepare', max });
  const payloadOf = (job: LeasedJob): PreparePayload => {
    if (job.payload.class !== 'prepare') throw new Error(`not a prepare job: ${job.payload.class}`);
    return job.payload;
  };
  return {
    sessionId,
    claim,
    payloadOf,
    complete: (job: LeasedJob, result: PrepareResult) =>
      t.mutation(api.jobs.queue.complete, { ...worker, jobId: job.jobId, leaseEpoch: job.leaseEpoch, result }),
    fail: (job: LeasedJob, failureCode: FailureCode | 'cancelled', detail: string, artifactStorageId?: Id<'_storage'>) =>
      t.mutation(api.jobs.queue.fail, {
        ...worker,
        jobId: job.jobId,
        leaseEpoch: job.leaseEpoch,
        failureCode,
        detail,
        ...(artifactStorageId ? { artifactStorageId } : {}),
      }),
    heartbeat: () => t.mutation(api.jobs.worker.heartbeat, { ...worker, sessionId, storage: storageSpace() }),
    /** Claims every queued publish and completes it: Jellyfin sees every file. */
    async publishAll(): Promise<void> {
      const jobs = await t.mutation(api.jobs.queue.claim, { ...worker, sessionId, class: 'publish', max: 10 });
      for (const job of jobs) {
        if (job.payload.class !== 'publish') continue;
        const targetItemRefs = Object.fromEntries(job.payload.publicationIds.map((id) => [id, `jf-${id}`]));
        await t.mutation(api.jobs.queue.complete, { ...worker, jobId: job.jobId, leaseEpoch: job.leaseEpoch, result: { class: 'publish', targetItemRefs } });
      }
    },
    /** Claims the next prepare job and completes it as the real worker would. */
    async prepareNext(extra: Parameters<typeof preparedResult>[1] = {}): Promise<{ job: LeasedJob; payload: PreparePayload; result: PrepareResult }> {
      const [job] = await claim(1);
      if (!job) throw new Error('no prepare job queued');
      const payload = payloadOf(job);
      const result = preparedResult(payload, extra);
      await t.mutation(api.jobs.queue.complete, { ...worker, jobId: job.jobId, leaseEpoch: job.leaseEpoch, result });
      return { job, payload, result };
    },
  };
}
