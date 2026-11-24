// Job classes, payloads and results, keyed on `class`. Each
// payload carries its class, so the payload alone says which handler runs it.
import { zid } from 'convex-helpers/server/zod4';
import { z } from 'zod';

import { LibraryKind } from './dto/library.ts';
import { FailureCode } from './failures.ts';
import { IndexerFailure, IndexerPage, IndexerRequest, IndexerTestResult } from './indexer.ts';
import { JellyfinLibraryItem, JellyfinLocale, SetupMode, SetupStepState } from './jellyfin.ts';
import { ClientKind } from './kinds.ts';
import { NamedUnit, NamingContext, Sidecar } from './naming.ts';
import { PlanStep, ProbeSummary, TargetFormat } from './playback.ts';
import { LanguageCode } from './release.ts';
import { SeedGoal } from './seedGoal.ts';
import { SiteSettings } from './sites.ts';

export { ClientKind, JOB_CLASSES, JobClass } from './kinds.ts';

/** A Unit a Grab expects to find in its download. */
export const UnitRef = z.object({
  unitId: zid('units'),
  season: z.number(),
  episode: z.number(),
  absolute: z.number().optional(),
});
export type UnitRef = z.infer<typeof UnitRef>;

/**
 * A Unit an import expects: a UnitRef whose numbers a movie doesn't have, with its title for the file name.
 * `optional`: one of the release's other Units (`alsoContainsUnitIds`), linked if the download holds it and never a mismatch if not.
 */
export const ExpectedUnit = UnitRef.partial({ season: true, episode: true }).extend({ title: z.string().optional(), optional: z.boolean().optional() });
export type ExpectedUnit = z.infer<typeof ExpectedUnit>;

/** Why a Rendition was started; its priority group comes from `DEFAULT_LIMITS.prepareGroups`. */
export const RenditionReason = z.enum(['import', 'manual', 'retry', 'profileEdit', 'bulk']);
export type RenditionReason = z.infer<typeof RenditionReason>;

export const DownloadSource = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('nzbUrl'), url: z.string() }),
  z.object({ kind: z.literal('magnet'), uri: z.string() }),
  z.object({ kind: z.literal('torrentUrl'), url: z.string() }),
  // A definition indexer's link, which the worker's engine resolves to a .torrent or a magnet.
  z.object({ kind: z.literal('siteUrl'), url: z.string(), indexerId: zid('indexers') }),
]);
export type DownloadSource = z.infer<typeof DownloadSource>;

export const clientKindOf = (source: DownloadSource): ClientKind => (source.kind === 'nzbUrl' ? 'nzbget' : 'qbittorrent');

export const DownloadSubmitPayload = z.object({
  class: z.literal('download.submit'),
  grabId: zid('grabs'),
  downloadId: zid('downloads'),
  source: DownloadSource,
  correlationTag: z.string(),
  category: z.enum(['platform-series', 'platform-movies']),
  /** The release's size from the indexer, for the free-space check before submitting (`diskFull`). */
  sizeBytes: z.number().optional(),
  /** The release's title, which names the item in the client. Absent on jobs queued before it was added. */
  releaseTitle: z.string().optional(),
  /** The candidate's indexer, or `Removed` once it was deleted: a failed fetch's detail names it, never its URL. */
  indexerName: z.string(),
  /** A torrent's goal (`seedGoalFor`), which qBittorrent enforces through per-torrent limits. */
  seedGoal: SeedGoal.optional(),
});
export type DownloadSubmitPayload = z.infer<typeof DownloadSubmitPayload>;

export const ImportPayload = z.object({
  class: z.literal('import'),
  grabId: zid('grabs'),
  importJobId: zid('importJobs'),
  /** Always a folder holding only this Download's files. */
  contentPath: z.string(),
  /** The absolute path of `works.folder`. */
  workFolderPath: z.string(),
  expectedUnits: z.array(ExpectedUnit),
  naming: NamingContext,
  /**
   * A manual grab of a release whose numbers didn't decide it:
   * after the sample and extras rules, its one video is imported as these
   * Units without resolving its name; several videos are `importMismatch`.
   */
  importAs: z.array(zid('units')).optional(),
  /**
   * An upgrade Grab's import: the library's target. A file that doesn't fit
   * it is held under `staging/held/<jobId>/` instead of being placed beside
   * the primary.
   */
  holdUnlessFits: TargetFormat.optional(),
});
export type ImportPayload = z.infer<typeof ImportPayload>;

export const PreparePayload = z.object({
  class: z.literal('prepare'),
  renditionId: zid('renditions'),
  sourceFileId: zid('files'),
  sourcePath: z.string(),
  /** `dev:ino` of the source when the job was enqueued: a file at `sourcePath` with another inode is the job's own output. */
  sourceInode: z.string(),
  targetProfileId: zid('playbackProfiles'),
  target: TargetFormat,
  /** The profile's "Keep the original". */
  disposition: z.enum(['replace', 'keep']),
  /** A file with `keepsName` keeps its base name with the new extension. */
  naming: z.union([NamingContext, z.object({ keepBaseName: z.string() })]),
  /** The Units the source holds, in part order, for `libraryFileName`, which names the output. */
  units: z.array(NamedUnit),
  /** The source's library folder, and its `originals/` twin. */
  outputFolder: z.string(),
  originalsFolder: z.string(),
  /**
   * With a kept original as the source: the Unit's current primary in the
   * library, which the swap removes with its sidecars (restoring a kept
   * original that fits, and re-preparing from one).
   */
  replacesPath: z.string().optional(),
});
export type PreparePayload = z.infer<typeof PreparePayload>;

/** What a finished `prepare` job recorded on disk; `noChange` when the source already fit. */
export const PrepareResult = z.discriminatedUnion('noChange', [
  z.object({
    class: z.literal('prepare'),
    noChange: z.literal(false),
    outputPath: z.string(),
    sizeBytes: z.number(),
    inode: z.string(),
    probe: ProbeSummary,
    /** `libx264`, `libx265`, `libsvtav1` or `copy` (a seam for v2). */
    encoder: z.string(),
    steps: z.array(PlanStep),
    sidecars: z.array(Sidecar),
    /** Image tracks dropped without a text twin, for the Rendition's timeline entry. */
    droppedTracks: z.array(z.object({ language: z.union([LanguageCode, z.literal('und')]).optional(), forced: z.boolean() })),
    /** The source's library path is gone (`replace`, or `keep` after its move). */
    sourceRemoved: z.boolean(),
    /** With `keep`: where the source now is, under `originals/`. */
    originalPath: z.string().optional(),
    originalSidecars: z.array(Sidecar).optional(),
    /** A kept original that fits its target was moved back into the library: the output is the original itself. */
    restored: z.literal(true).optional(),
  }),
  z.object({ class: z.literal('prepare'), noChange: z.literal(true) }),
]);
export type PrepareResult = z.infer<typeof PrepareResult>;

export const PublishPayload = z.object({
  class: z.literal('publish'),
  publicationIds: z.array(zid('publications')),
  /** The Work's folder under its library root, as in `ImportPayload`. */
  workFolderPath: z.string(),
  /** The file each Publication makes visible, so the worker can look up the target's item for it. */
  items: z.array(z.object({ publicationId: zid('publications'), path: z.string() })),
  /** The library the Work is in; the adapter finds the target's library item by `libraryId`. */
  library: z.object({ libraryId: zid('libraries'), root: z.string(), kind: LibraryKind }),
});
export type PublishPayload = z.infer<typeof PublishPayload>;

export const LibraryRootState = z.enum(['available', 'missing', 'empty', 'otherDevice', 'unreadable', 'mostMissing']);
export type LibraryRootState = z.infer<typeof LibraryRootState>;

export const MaintenancePayload = z.discriminatedUnion('action', [
  z.object({
    class: z.literal('maintenance'),
    action: z.literal('removeDownload'),
    // Absent for an orphan client item, which has no `downloads` row (the `removeClientItem` fix).
    downloadId: zid('downloads').optional(),
    clientKind: ClientKind,
    clientRef: z.string().optional(),
    releaseTitle: z.string().optional(),
    deleteData: z.boolean(),
    /** A Usenet download's folder, which the worker deletes with the item; accepted only under downloads/usenet/. */
    contentPath: z.string().optional(),
    /** The Grab whose tag a shared torrent loses; the torrent goes only when no other Grab's tag is left. */
    correlationTag: z.string().optional(),
  }),
  // Holds the provider's password until the job ends, like pushJellyfinPassword. Never log it.
  z.object({
    class: z.literal('maintenance'),
    action: z.literal('testUsenetServer'),
    host: z.string(),
    port: z.number().int(),
    ssl: z.boolean(),
    username: z.string(),
    password: z.string(),
  }),
  z.object({ class: z.literal('maintenance'), action: z.literal('cleanStaging'), paths: z.array(z.string()) }),
  // A deleted Work's library files, when the user ticks "Also delete files".
  // `libraryId` and `folders` are what PlaybackTarget.forget drops afterwards.
  // The worker then removes the folders the deletion emptied, up to the layout roots.
  z.object({
    class: z.literal('maintenance'),
    action: z.literal('deleteLibraryFiles'),
    paths: z.array(z.string()),
    libraryId: zid('libraries'),
    folders: z.array(z.string()),
    /** A deleted Work's folder under originals/, removed with all it holds; absent from a backend that predates it. */
    originalsFolder: z.string().optional(),
  }),
  z.object({ class: z.literal('maintenance'), action: z.literal('buildSupportBundle') }),
  // The definitions sync: the package from OMNARR_DEFINITIONS_URL and the user's /definitions files.
  z.object({ class: z.literal('maintenance'), action: z.literal('syncDefinitions') }),
  // A primary file's new name after its episode title changed: sidecars first, then the file, in one folder.
  z.object({
    class: z.literal('maintenance'),
    action: z.literal('renameLibraryFile'),
    fileId: zid('files'),
    from: z.string(),
    to: z.string(),
    sidecars: z.array(z.object({ from: z.string(), to: z.string() })),
  }),
  // A scanned file Jellyfin would misread, moved into its Work folder under the name the import gives.
  z.object({
    class: z.literal('maintenance'),
    action: z.literal('moveLibraryFile'),
    fileId: zid('files'),
    from: z.string(),
    /** `dev:ino` of the file: a re-run whose `from` is gone finds the file at its new name by it. */
    inode: z.string(),
    /** The absolute path of `works.folder`, as in `ImportPayload`. */
    workFolderPath: z.string(),
    naming: NamingContext,
    /** The Units the file holds, in part order. */
    units: z.array(NamedUnit),
    probe: ProbeSummary,
  }),
  // The untracked-media scan's read: walk the roots, skipping the ignored folders (absolute paths).
  z.object({
    class: z.literal('maintenance'),
    action: z.literal('scanLibrary'),
    scanRunId: zid('scanRuns'),
    roots: z.array(z.object({ libraryId: zid('libraries'), path: z.string() })),
    ignores: z.array(z.string()),
  }),
  z.object({
    class: z.literal('maintenance'),
    action: z.literal('checkLibraryFiles'),
    roots: z.array(z.object({ libraryId: zid('libraries'), path: z.string() })),
  }),
  // Holds a plaintext password until the job ends. Never log it.
  z.object({ class: z.literal('maintenance'), action: z.literal('pushJellyfinPassword'), username: z.string(), newPassword: z.string() }),
  // Jellyfin's first-run setup or a re-run. Holds the admin's plaintext password until the job ends. Never log it.
  z.object({
    class: z.literal('maintenance'),
    action: z.literal('setupJellyfin'),
    mode: SetupMode,
    admin: z.object({ username: z.string(), password: z.string() }),
    locale: JellyfinLocale,
    libraries: z.array(z.object({ libraryId: zid('libraries'), name: z.string(), kind: LibraryKind, rootPath: z.string() })),
    /** Jellyfin's remote access setting; its default (true) for now. */
    remoteAccess: z.boolean(),
    /** Libraries without metadata or image fetchers: tests only. */
    offline: z.literal(true).optional(),
  }),
]);
export type MaintenancePayload = z.infer<typeof MaintenancePayload>;
export type MaintenanceAction = MaintenancePayload['action'];

/**
 * One request of a definition indexer, relayed to the worker's
 * engine. No secret: the worker reads the site's settings through `sites.config`.
 * `z.lazy` because indexer.ts imports this module through dto/system.ts.
 */
export const IndexerJobPayload = z.discriminatedUnion('action', [
  z.object({ class: z.literal('indexer'), action: z.literal('search'), indexerId: zid('indexers'), request: z.lazy(() => IndexerRequest) }).strict(),
  z.object({ class: z.literal('indexer'), action: z.literal('rss'), indexerId: zid('indexers') }).strict(),
  z.object({ class: z.literal('indexer'), action: z.literal('test'), indexerId: zid('indexers') }).strict(),
  // "Test connection" before the indexer is saved: the form's values, held until the job ends like testUsenetServer's password. Never log them.
  z
    .object({
      class: z.literal('indexer'),
      action: z.literal('testDraft'),
      draft: z.object({ definitionId: z.string(), baseUrl: z.string(), settings: z.lazy(() => SiteSettings) }).strict(),
    })
    .strict(),
]);
export type IndexerJobPayload = z.infer<typeof IndexerJobPayload>;

/** IndexerResult<IndexerPage> as a value: the page, the failure, or the paced skip. */
export const IndexerPageResult = z.union([
  z.object({ ok: z.literal(true), value: z.lazy(() => IndexerPage) }).strict(),
  z.object({ ok: z.literal(false), failure: z.lazy(() => IndexerFailure) }).strict(),
  z.object({ ok: z.literal(false), skipped: z.literal('paced') }).strict(),
]);

export const JobPayload = z.discriminatedUnion('class', [
  DownloadSubmitPayload,
  ImportPayload,
  PreparePayload,
  PublishPayload,
  MaintenancePayload,
  IndexerJobPayload,
]);
export type JobPayload = z.infer<typeof JobPayload>;

export const ImportedFile = z.object({
  path: z.string(),
  sizeBytes: z.number(),
  inode: z.string(),
  probe: ProbeSummary,
  unitIds: z.array(zid('units')),
});

export const MaintenanceResult = z.discriminatedUnion('action', [
  z.object({ class: z.literal('maintenance'), action: z.literal('removeDownload'), removed: z.boolean() }),
  z.object({ class: z.literal('maintenance'), action: z.literal('cleanStaging'), removedPaths: z.array(z.string()) }),
  z.object({ class: z.literal('maintenance'), action: z.literal('deleteLibraryFiles'), removedPaths: z.array(z.string()) }),
  z.object({ class: z.literal('maintenance'), action: z.literal('testUsenetServer'), outcome: z.enum(['ok', 'authRejected', 'failed']) }),
  z.object({ class: z.literal('maintenance'), action: z.literal('buildSupportBundle'), storageId: zid('_storage') }),
  z.object({ class: z.literal('maintenance'), action: z.literal('renameLibraryFile'), path: z.string() }),
  // `sidecars`: the subtitle files beside the moved file afterwards; absent from a worker that predates them.
  z.object({ class: z.literal('maintenance'), action: z.literal('moveLibraryFile'), path: z.string(), sidecars: z.array(Sidecar).optional() }),
  // Videos found under the roots, and how many of them no `files` row holds.
  z.object({ class: z.literal('maintenance'), action: z.literal('scanLibrary'), found: z.number(), untracked: z.number() }),
  z.object({
    class: z.literal('maintenance'),
    action: z.literal('checkLibraryFiles'),
    checked: z.number(),
    missing: z.number(),
    roots: z.array(
      z.object({
        libraryId: zid('libraries'),
        state: LibraryRootState,
        checkedWhenMostMissing: z.number().optional(),
        missingWhenMostMissing: z.number().optional(),
        goneFolders: z.array(z.string()).optional(),
      }),
    ),
  }),
  // The sync's counts; `definitions.finishSync` already wrote the status.
  z.object({
    class: z.literal('maintenance'),
    action: z.literal('syncDefinitions'),
    ok: z.boolean(),
    supported: z.number(),
    unsupported: z.number(),
    pending: z.number(),
  }),
  z.object({ class: z.literal('maintenance'), action: z.literal('pushJellyfinPassword'), pushed: z.boolean() }),
  z.object({
    class: z.literal('maintenance'),
    action: z.literal('setupJellyfin'),
    serverId: z.string(),
    version: z.string(),
    adminUserId: z.string(),
    /** Only when the run made a new key. */
    apiKey: z.string().optional(),
    libraries: z.array(JellyfinLibraryItem),
    steps: z.array(SetupStepState),
  }),
]);

/**
 * What the playback target made of a published file, which
 * `results.published` compares with the Unit: an episode with the season and
 * episode it read, a movie, or something else.
 */
export const TargetReading = z.object({
  kind: z.enum(['episode', 'movie', 'other']),
  season: z.number().optional(),
  episode: z.number().optional(),
  /** A multi-episode file's last episode. */
  episodeEnd: z.number().optional(),
  /** An episode filed under the series of another folder than the Work's. */
  otherSeries: z.literal(true).optional(),
});
export type TargetReading = z.infer<typeof TargetReading>;

export const JobResult = z.discriminatedUnion('class', [
  z.object({ class: z.literal('download.submit'), clientRef: z.string() }),
  z.object({ class: z.literal('import'), files: z.array(ImportedFile) }),
  PrepareResult,
  z.object({
    class: z.literal('publish'),
    targetItemRefs: z.record(zid('publications'), z.string()),
    /** Absent from a worker that predates the check: the files are taken as read right. */
    readings: z.record(zid('publications'), TargetReading).optional(),
    /** Each file's series item, or the movie's own item: the Work's "Open in Jellyfin". Absent from an older worker. */
    seriesItemRefs: z.record(zid('publications'), z.string()).optional(),
  }),
  MaintenanceResult,
  // A search or RSS answer is `outcome`; a connection test's is `test`.
  z.object({ class: z.literal('indexer'), outcome: IndexerPageResult.optional(), test: z.lazy(() => IndexerTestResult).optional() }).strict(),
]);
export type JobResult = z.infer<typeof JobResult>;

/** Where an active download is in its client; `postProcessing` is repair and unpack (`downloads.clientStage`). */
export const ClientStage = z.enum(['queued', 'downloading', 'postProcessing']);
export type ClientStage = z.infer<typeof ClientStage>;

/** The client's view of a download: tracker message and host only, never a URL. */
export const ClientStatus = z.object({
  stage: z.string(),
  progress: z.number(),
  /**
   * The bytes downloaded and the release's size, and the rate.
   * qBittorrent reports all three; NZBGet's rate is the worker's, from the
   * change in `doneBytes` since its previous poll.
   */
  doneBytes: z.number().optional(),
  totalBytes: z.number().optional(),
  bytesPerSec: z.number().optional(),
  /**
   * A completed torrent's share ratio, seed time and uploaded bytes while it
   * seeds, from the reconciler's pass.
   */
  ratio: z.number().optional(),
  seedTimeMs: z.number().optional(),
  uploadedBytes: z.number().optional(),
  message: z.string().optional(),
  raw: z.record(z.string(), z.union([z.string(), z.number()])),
});
export type ClientStatus = z.infer<typeof ClientStatus>;

/** The value a job's event carries to the run that awaits it. */
export const JobEventValue = z.object({
  outcome: z.enum(['done', 'failed', 'cancelled']),
  jobId: zid('jobs'),
  failureCode: FailureCode.optional(),
});
export type JobEventValue = z.infer<typeof JobEventValue>;

/** What a pipeline run returns: how it ended and at which stage. */
export const PipelineRunResult = z.object({
  outcome: z.enum(['done', 'failed', 'cancelled']),
  stage: z.enum(['download', 'import', 'publish', 'finish']),
  failureCode: FailureCode.optional(),
  jobId: zid('jobs').optional(),
});
export type PipelineRunResult = z.infer<typeof PipelineRunResult>;

export const jobEventName = (jobId: string): `job:${string}` => `job:${jobId}`;
export const downloadEventName = (downloadId: string): `download:${string}` => `download:${downloadId}`;
