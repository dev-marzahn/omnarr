// The library data model's tables and their indexes. A CamelCase type is a
// schema from @omnarr/contracts, converted here with zodToConvex; inline
// literal unions are written once, here.
import { vWorkflowId } from '@dev-marzahn/convex-workflow-migrations';
import {
  AliasSource,
  ApiLimit,
  BlocklistReason,
  BuildState,
  CandidateReason,
  CandidateTorrent,
  Capabilities,
  FirstRunStep,
  ItemLeftInClient,
  ResolveProblem,
  IndexerCaps,
  IndexerSite,
  DefinitionMeta,
  DefinitionSource,
  DefinitionSupport,
  DefinitionSyncStatus,
  PendingUpdate,
  IndexerPageResult,
  IndexerTestResult,
  IndexerCategories,
  IndexerKind,
  StoredIndexerSkip,
  IndexerUsageHour,
  LostOn,
  QualityId,
  RateLimitReason,
  ReleaseProfile,
  SearchGroupKind,
  ClientKind,
  ClientRuntimeStatus,
  ClientStage,
  ProviderTest,
  SeedGoal,
  UsenetServers,
  VpnSettings,
  ClientStatus,
  DeviceId,
  DownloadState,
  FileVersionKind,
  StoredPlayMethod,
  RenditionReason,
  Sidecar,
  TargetFormat,
  TranscodeReason,
  EventData,
  EventKind,
  EventStage,
  ExternalIdProvider,
  FailureClass,
  FailureCode,
  FixAction,
  GrabKind,
  GrabState,
  ImportJobState,
  IndexerCallStatus,
  IndexerHealth,
  JellyfinLibraryItem,
  JellyfinLocale,
  JellyfinState,
  JobClass,
  JobPayload,
  SetupStepState,
  LibraryKind,
  MappingSource,
  MappingSourceName,
  MappingStatus,
  NumberingReason,
  NumberingScheme,
  Ordering,
  ParsedEpisode,
  ParsedRelease,
  PreparationStep,
  ProbeSummary,
  PublicationState,
  RenditionState,
  ScoreBreakdown,
  SearchAttemptState,
  UnitKind,
  ExpectedUnit,
  UnitState,
  WorkKind,
} from '@omnarr/contracts';
import { ScanCounts, ScanItemStatus, ScanMatch, ScanRunState, ScanSchedule, ScanSuggestion, ScanTrigger, UnmatchedReason } from '@omnarr/contracts';
import { zodToConvex, zodToConvexFields } from 'convex-helpers/server/zod4';
import { defineSchema, defineTable } from 'convex/server';
import { v } from 'convex/values';

import { AnimeListEntry } from './mapping/animeListsParse';
import { SceneMappingEntry } from './mapping/sceneMappingsParse';

const protocol = v.union(v.literal('usenet'), v.literal('torrent'));

/** One source's health: written only when a value changes. */
const sourceHealth = v.object({ firstFailureAt: v.optional(v.number()), lastSuccessAt: v.optional(v.number()) });

export default defineSchema({
  // Library and identity

  libraries: defineTable({
    kind: zodToConvex(LibraryKind),
    name: v.string(),
    rootPath: v.string(),
    playbackProfileId: v.id('playbackProfiles'),
    defaultReleaseProfileId: v.id('releaseProfiles'),
  }),

  works: defineTable({
    libraryId: v.id('libraries'),
    kind: zodToConvex(WorkKind),
    title: v.string(),
    year: v.optional(v.number()),
    numberingScheme: zodToConvex(NumberingScheme),
    releaseProfileId: v.id('releaseProfiles'),
    monitorNewUnits: v.boolean(),
    metadataUpdatedAt: v.optional(v.number()),
    // The Work's folder under its library root: set once, at the first import or by the scan, never recomputed.
    folder: v.optional(v.string()),
    // Jellyfin's item for the series, or the movie: "Open in Jellyfin" on the Work page. Written by each publish.
    jellyfinItemRef: v.optional(v.string()),
  })
    .index('by_library', ['libraryId'])
    .index('by_release_profile', ['releaseProfileId']),

  // Exactly one of workId and unitId is set.
  externalIds: defineTable({
    workId: v.optional(v.id('works')),
    unitId: v.optional(v.id('units')),
    provider: zodToConvex(ExternalIdProvider),
    value: v.string(),
  })
    .index('by_provider_value', ['provider', 'value'])
    .index('by_work', ['workId'])
    .index('by_unit', ['unitId']),

  units: defineTable({
    workId: v.id('works'),
    kind: zodToConvex(UnitKind),
    tmdbSeason: v.optional(v.number()),
    tmdbEpisode: v.optional(v.number()),
    title: v.optional(v.string()),
    airDateUtc: v.optional(v.number()),
    monitored: v.boolean(),
    derivedState: zodToConvex(UnitState),
    activeGrabId: v.optional(v.id('grabs')),
    lastSearchAttemptId: v.optional(v.id('searchAttempts')),
    // Set by search.start on every Unit it searches.
    lastSearchAt: v.optional(v.number()),
  })
    .index('by_work', ['workId'])
    .index('by_last_search', ['lastSearchAt'])
    .index('by_work_tmdb', ['workId', 'tmdbSeason', 'tmdbEpisode'])
    .index('by_work_air_date', ['workId', 'airDateUtc']),

  unitMappings: defineTable({
    unitId: v.id('units'),
    workId: v.id('works'),
    ordering: zodToConvex(Ordering),
    season: v.optional(v.number()),
    episode: v.optional(v.number()),
    absolute: v.optional(v.number()),
    source: zodToConvex(MappingSource),
    sourceVersion: v.optional(v.string()),
    // The sync that wrote the row; absent on manual rows.
    projectionVersion: v.optional(v.number()),
  })
    .index('by_ordering', ['workId', 'ordering', 'season', 'episode'])
    .index('by_absolute', ['workId', 'absolute'])
    .index('by_unit', ['unitId']),

  files: defineTable({
    path: v.string(),
    sizeBytes: v.number(),
    inode: v.string(),
    probe: v.optional(zodToConvex(ProbeSummary)),
    origin: v.union(v.literal('download'), v.literal('scan'), v.literal('prepared')),
    role: v.union(v.literal('source'), v.literal('rendition')),
    // The release a downloaded file came from, copied from its candidate at import.
    release: v.optional(zodToConvex(ParsedRelease)),
    candidateId: v.optional(v.id('candidates')),
    // Sidecar subtitles beside the file.
    sidecars: v.optional(v.array(zodToConvex(Sidecar))),
    // A scanned file, or a prepared copy of one: never renamed.
    keepsName: v.optional(v.boolean()),
    missingSeenAt: v.optional(v.number()),
    missingSince: v.optional(v.number()),
  })
    .index('by_path', ['path'])
    .index('by_inode', ['inode']),

  fileUnits: defineTable({
    fileId: v.id('files'),
    unitId: v.id('units'),
    part: v.optional(v.number()),
  })
    .index('by_unit', ['unitId'])
    .index('by_file', ['fileId']),

  fileVersions: defineTable({
    unitId: v.id('units'),
    fileId: v.id('files'),
    kind: zodToConvex(FileVersionKind),
    playbackProfileId: v.id('playbackProfiles'),
    fits: v.boolean(),
  })
    .index('by_unit', ['unitId'])
    .index('by_profile', ['playbackProfileId'])
    .index('by_file', ['fileId']),

  // Pipeline

  searchAttempts: defineTable({
    unitIds: v.array(v.id('units')),
    // `interactive`: "Search and pick", offered to the user instead of picked.
    trigger: v.union(
      v.literal('subscribe'),
      v.literal('rss'),
      v.literal('backfill'),
      v.literal('manual'),
      v.literal('nextBest'),
      v.literal('interactive'),
      v.literal('upgrade'),
    ),
    state: zodToConvex(SearchAttemptState),
    // The search group: its Work, kind and the Units of it that were wanted when it started.
    workId: v.id('works'),
    groupKind: zodToConvex(SearchGroupKind),
    wantedUnitIds: v.array(v.id('units')),
    indexerResults: v.array(
      v.object({
        indexerId: v.id('indexers'),
        status: zodToConvex(IndexerCallStatus),
        count: v.number(),
        failureCode: v.optional(zodToConvex(FailureCode)),
        pages: v.number(),
        truncated: v.optional(v.boolean()),
        skipped: v.optional(zodToConvex(StoredIndexerSkip)),
      }),
    ),
  }).index('by_state', ['state']),

  candidates: defineTable({
    searchAttemptId: v.id('searchAttempts'),
    indexerId: v.id('indexers'),
    guid: v.string(),
    title: v.string(),
    // Internal only: can carry an API key or passkey.
    downloadUrl: v.string(),
    sizeBytes: v.number(),
    protocol,
    publishedAt: v.number(),
    parsed: zodToConvex(ParsedRelease),
    // The covered Units, and the pack's other Units.
    unitIds: v.array(v.id('units')),
    alsoContainsUnitIds: v.array(v.id('units')),
    quality: zodToConvex(QualityId),
    qualityRank: v.number(),
    qualityAssumed: v.boolean(),
    baseScore: v.number(),
    score: v.number(),
    scoreBreakdown: zodToConvex(ScoreBreakdown),
    preparationStep: zodToConvex(PreparationStep),
    preparationAssumed: v.boolean(),
    outcome: v.union(v.literal('picked'), v.literal('rejected'), v.literal('pending')),
    reason: v.optional(zodToConvex(CandidateReason)),
    rank: v.optional(v.number()),
    lostOn: v.optional(zodToConvex(LostOn)),
    matchDetail: v.optional(v.string()),
    // Why numbering couldn't settle the numbers, and for `ambiguous` the Units the readings found.
    matchProblem: v.optional(zodToConvex(ResolveProblem)),
    possibleUnitIds: v.optional(v.array(v.id('units'))),
    // `magnetUrl` is internal only, like `downloadUrl`.
    torrent: v.optional(zodToConvex(CandidateTorrent)),
    // Who picked it: absent for the automatic pick, `user` for a manual grab.
    pickedBy: v.optional(v.literal('user')),
    // It beats the current release of every playable Unit it covers.
    isUpgrade: v.optional(v.boolean()),
    expiresAt: v.optional(v.number()),
  })
    .index('by_attempt', ['searchAttemptId'])
    .index('by_attempt_outcome', ['searchAttemptId', 'outcome'])
    // "Might be this episode" reads only an attempt's wrong-title-or-episode rows.
    .index('by_attempt_reason', ['searchAttemptId', 'reason'])
    .index('by_expires_at', ['expiresAt']),

  grabs: defineTable({
    candidateId: v.id('candidates'),
    protocol,
    // Patched in the mutation that inserts the Grab, once the run has started.
    workflowId: v.optional(vWorkflowId),
    state: zodToConvex(GrabState),
    // `upgrade` when its Units already had a playable primary. Absent on Grabs older than 0004_grab_kind, which backfills `initial`.
    kind: v.optional(zodToConvex(GrabKind)),
    cancelRequested: v.boolean(),
    // Set by cancelGrab(grabId, { blocklist: true }); onRunComplete then blocklists with reason `manual`.
    cancelBlocklist: v.optional(v.boolean()),
    // Set by onRunPaused, cleared by supervision when the pause ends. A paused run doesn't count as "running".
    pausedAt: v.optional(v.number()),
    // How often onRunComplete restarted a failed run from its failed step; capped by DEFAULT_LIMITS.runRestarts.
    runRestarts: v.optional(v.number()),
    // Why a failed run failed: the next-best search raises it when nothing is left, and the timeline shows it.
    failureCode: v.optional(zodToConvex(FailureCode)),
    // A manual grab of a release whose numbers didn't decide it: its one video is imported as these Units.
    importAs: v.optional(v.array(v.id('units'))),
  })
    .index('by_workflow', ['workflowId'])
    .index('by_state', ['state'])
    .index('by_paused', ['pausedAt']),

  grabUnits: defineTable({
    grabId: v.id('grabs'),
    unitId: v.id('units'),
    outcome: v.union(v.literal('pending'), v.literal('imported'), v.literal('skipped'), v.literal('failed')),
  })
    .index('by_unit', ['unitId'])
    .index('by_grab', ['grabId']),

  downloads: defineTable({
    grabId: v.id('grabs'),
    // Patched in the mutation that inserts the Download, once the job is enqueued.
    jobId: v.optional(v.id('jobs')),
    clientKind: zodToConvex(ClientKind),
    clientRef: v.optional(v.string()),
    correlationTag: v.string(),
    state: zodToConvex(DownloadState),
    clientStage: zodToConvex(ClientStage),
    clientStatus: v.optional(zodToConvex(ClientStatus)),
    // Where the finished content is, from the report that completed it; the import job's payload reads it.
    contentPath: v.optional(v.string()),
    // Torrents: the goal qBittorrent enforces, the tracker's private flag from the completing report, and when the goal was met.
    seedGoal: v.optional(zodToConvex(SeedGoal)),
    private: v.optional(v.boolean()),
    seedingDoneAt: v.optional(v.number()),
  })
    .index('by_grab', ['grabId'])
    .index('by_correlation_tag', ['correlationTag'])
    // The reconciler's active Downloads (jobs/downloads.ts).
    .index('by_state', ['state']),

  importJobs: defineTable({
    grabId: v.id('grabs'),
    jobId: v.id('jobs'),
    state: zodToConvex(ImportJobState),
    stagingPath: v.string(),
    mismatch: v.optional(v.object({ expected: v.array(zodToConvex(ExpectedUnit)), found: v.array(zodToConvex(ParsedEpisode)) })),
  }).index('by_grab', ['grabId']),

  renditions: defineTable({
    sourceFileId: v.id('files'),
    jobId: v.id('jobs'),
    playbackProfileId: v.id('playbackProfiles'),
    steps: v.array(zodToConvex(PreparationStep)),
    reason: zodToConvex(RenditionReason),
    state: zodToConvex(RenditionState),
    outputFileId: v.optional(v.id('files')),
    encoder: v.optional(v.string()),
  })
    .index('by_source_file', ['sourceFileId'])
    .index('by_state', ['state']),

  publications: defineTable({
    unitId: v.id('units'),
    fileVersionId: v.id('fileVersions'),
    /** The latest `publish` job; set once it is enqueued, since its payload needs this row's ID. */
    jobId: v.optional(v.id('jobs')),
    /** 0 at insert, +1 on every `visible → pending` reset; part of the job's idempotency key. */
    generation: v.number(),
    target: v.literal('jellyfin'),
    state: zodToConvex(PublicationState),
    targetItemRef: v.optional(v.string()),
  })
    .index('by_unit', ['unitId'])
    .index('by_target_item_ref', ['targetItemRef']),

  blocklist: defineTable({
    workId: v.id('works'),
    releaseKey: v.string(),
    normalizedTitle: v.optional(v.string()),
    title: v.string(),
    reason: zodToConvex(BlocklistReason),
    grabId: v.optional(v.id('grabs')),
    // The release's protocol, written on every new entry since Settings › Blocklist was added to show it; older rows have none, and Settings › Blocklist shows none for them.
    protocol: v.optional(protocol),
  })
    .index('by_work_key', ['workId', 'releaseKey'])
    .index('by_work_title', ['workId', 'normalizedTitle']),

  // Worker and observability

  jobs: defineTable({
    class: zodToConvex(JobClass),
    // Internal only. Cleared on terminal completion or terminal failure.
    payload: v.optional(zodToConvex(JobPayload)),
    status: v.union(v.literal('queued'), v.literal('waiting'), v.literal('leased'), v.literal('done'), v.literal('failed'), v.literal('cancelled')),
    attempt: v.number(),
    maxAttempts: v.number(),
    availableAt: v.optional(v.number()),
    leaseOwner: v.optional(v.string()),
    leaseEpoch: v.number(),
    leaseExpiresAt: v.optional(v.number()),
    idempotencyKey: v.string(),
    grabId: v.optional(v.id('grabs')),
    renditionId: v.optional(v.id('renditions')),
    workflowId: v.optional(vWorkflowId),
    failureCode: v.optional(zodToConvex(FailureCode)),
    lastError: v.optional(v.string()),
    artifactStorageId: v.optional(v.id('_storage')),
    protocolVersion: v.number(),
    cancelRequested: v.boolean(),
    // Claim order within a class, lowest first; absent reads as 0 (set on prepare jobs only).
    priority: v.optional(v.number()),
    // An `indexer` job's answer, which the relay reads; no other class writes it.
    indexerOutcome: v.optional(zodToConvex(IndexerPageResult)),
    indexerTest: v.optional(zodToConvex(IndexerTestResult)),
  })
    .index('by_status_class', ['status', 'class'])
    .index('by_status_class_priority', ['status', 'class', 'priority'])
    .index('by_lease_expiry', ['status', 'leaseExpiresAt'])
    .index('by_lease_owner', ['leaseOwner', 'status'])
    .index('by_idempotency_key', ['idempotencyKey'])
    // ttl.artifacts clears the job of each artifact it deletes.
    .index('by_artifact', ['artifactStorageId']),

  jobProgress: defineTable({
    jobId: v.id('jobs'),
    fraction: v.number(),
    detail: v.optional(v.string()),
    updatedAt: v.number(),
  }).index('by_job', ['jobId']),

  workerSessions: defineTable({
    workerId: v.string(),
    protocolVersion: v.number(),
    // Omitted on a rejected session: another release's shape isn't parsed.
    capabilities: v.optional(zodToConvex(Capabilities)),
    connectedAt: v.number(),
    lastSeenAt: v.number(),
    accepted: v.boolean(),
    rejectReason: v.optional(v.literal('protocolMismatch')),
  })
    .index('by_worker', ['workerId'])
    .index('by_last_seen', ['lastSeenAt']),

  events: defineTable({
    unitId: v.optional(v.id('units')),
    grabId: v.optional(v.id('grabs')),
    stage: zodToConvex(EventStage),
    kind: zodToConvex(EventKind),
    message: v.string(),
    data: v.optional(zodToConvex(EventData)),
    at: v.number(),
  })
    .index('by_unit_at', ['unitId', 'at'])
    .index('by_grab_at', ['grabId', 'at']),

  issues: defineTable({
    scope: v.union(v.literal('unit'), v.literal('system')),
    unitId: v.optional(v.id('units')),
    grabId: v.optional(v.id('grabs')),
    jobId: v.optional(v.id('jobs')),
    failureCode: zodToConvex(FailureCode),
    class: zodToConvex(FailureClass),
    state: v.union(v.literal('open'), v.literal('resolved'), v.literal('dismissed')),
    fixActions: v.array(zodToConvex(FixAction)),
    detail: v.optional(v.string()),
    resolvedAt: v.optional(v.number()),
    // `orphanClientItem`: the client items it names, which `removeClientItem` removes.
    orphanItems: v.optional(v.array(zodToConvex(ItemLeftInClient))),
    // `orphanAfterDelete`: the deleted Works' rows that never ended, which `removeOrphans` deletes.
    orphanRows: v.optional(v.object({ jobIds: v.array(v.id('jobs')), grabIds: v.array(v.id('grabs')) })),
  })
    .index('by_state_scope', ['state', 'scope'])
    .index('by_unit', ['unitId']),

  // Configuration.

  indexers: defineTable({
    name: v.string(),
    kind: zodToConvex(IndexerKind),
    apiUrl: v.string(),
    // Internal only: never in a DTO, a log or an error.
    apiKey: v.string(),
    enabled: v.boolean(),
    priority: v.number(),
    categories: zodToConvex(IndexerCategories),
    caps: zodToConvex(IndexerCaps),
    rssIntervalMinutes: v.number(),
    rssLastFetchAt: v.optional(v.number()),
    apiLimit: v.optional(zodToConvex(ApiLimit)),
    usage: v.array(zodToConvex(IndexerUsageHour)),
    consecutiveRateLimits: v.number(),
    rateLimitReason: v.optional(zodToConvex(RateLimitReason)),
    rssHighWaterMark: v.optional(v.string()),
    rateLimitedUntil: v.optional(v.number()),
    health: zodToConvex(IndexerHealth),
    // `definition` indexers only. Text and password settings are internal, like `apiKey`.
    site: v.optional(zodToConvex(IndexerSite)),
  }).index('by_enabled', ['enabled']),
  // The whole site-definition catalogue, written by the worker's sync. The file's text is in `siteDefinitionFiles`, so the
  // picker's list doesn't read ~1.2 MB of YAML. `yaml` is only on rows from before migration 0005, which moves it.
  siteDefinitions: defineTable({
    definitionId: v.string(),
    source: zodToConvex(DefinitionSource),
    sha256: v.string(),
    yaml: v.optional(v.string()),
    meta: v.optional(zodToConvex(DefinitionMeta)),
    support: zodToConvex(DefinitionSupport),
    supported: v.boolean(),
    pendingUpdate: v.optional(zodToConvex(PendingUpdate)),
    removedUpstream: v.optional(v.boolean()),
    syncedAt: v.number(),
  })
    .index('by_definition_id', ['definitionId'])
    .index('by_support', ['supported']),
  // A definition's file as fetched, one row per `siteDefinitions` row, read only by the worker's `sites.config`. It is never bundled.
  siteDefinitionFiles: defineTable({
    definitionId: v.string(),
    yaml: v.string(),
  }).index('by_definition_id', ['definitionId']),
  // The last site-definition sync, one row.
  definitionSync: defineTable(zodToConvex(DefinitionSyncStatus).fields),
  // A site indexer's next free request slot, outside `indexers` so its frequent writes don't wake the indexer subscriptions.
  // A row holds `indexerId`, or `site` for a site not yet saved (its pre-save test); `createSite` moves the `site` row onto the new indexer.
  indexerPacing: defineTable({
    indexerId: v.optional(v.id('indexers')),
    site: v.optional(v.literal('nyaa')),
    nextAt: v.number(),
  })
    .index('by_indexer', ['indexerId'])
    .index('by_site', ['site']),
  // One row per client kind. `usenetServers[].password` is internal: never in a DTO, a log or an error.
  downloadClients: defineTable({
    kind: zodToConvex(ClientKind),
    enabled: v.boolean(),
    configVersion: v.number(),
    appliedConfigVersion: v.optional(v.number()),
    appliedAt: v.optional(v.number()),
    applyFailure: v.optional(zodToConvex(FailureCode)),
    clientVersion: v.optional(v.string()),
    usenetServers: v.optional(zodToConvex(UsenetServers)),
    providerTestCount: v.optional(v.number()),
    providerTest: v.optional(zodToConvex(ProviderTest)),
    // qBittorrent only: the user's default goal; a changed goal applies to new torrents only.
    seedGoal: v.optional(zodToConvex(SeedGoal)),
    // qBittorrent only: the VPN choice; absent is "No VPN". Its config, key and credentials are internal.
    vpn: v.optional(zodToConvex(VpnSettings)),
    status: v.optional(zodToConvex(ClientRuntimeStatus)),
  }).index('by_kind', ['kind']),
  releaseProfiles: defineTable(zodToConvexFields(ReleaseProfile.shape)).index('by_shipped_key', ['shippedKey']),
  // One row per library. Optional until v1; the contract's parser fills the defaults.
  playbackProfiles: defineTable({
    name: v.string(),
    devices: v.optional(v.array(zodToConvex(DeviceId))),
    // Absent means `devices`.
    mode: v.optional(v.union(v.literal('devices'), v.literal('custom'))),
    // Absent only on rows the reference seed hasn't filled.
    target: v.optional(zodToConvex(TargetFormat)),
    // null: no cap; absent: the derived cap.
    maxHeightOverride: v.optional(v.union(v.number(), v.null())),
    deviceTableVersion: v.optional(v.number()),
    keepOriginal: v.optional(v.boolean()),
  }),

  // Metadata. Every table keys on the library's IDs.

  // One row, created by metadata.tick on its first run.
  metadataSettings: defineTable({
    // Internal only: never in a DTO.
    userApiToken: v.optional(v.string()),
    userTokenCheckedAt: v.optional(v.number()),
    language: v.string(),
    // `sceneMapping` is optional: rows written before the source have none.
    sourceHealth: v.object({ tmdb: sourceHealth, xem: sourceHealth, animeLists: sourceHealth, sceneMapping: v.optional(sourceHealth) }),
  }),

  workMetadata: defineTable({
    workId: v.id('works'),
    overview: v.optional(v.string()),
    posterPath: v.optional(v.string()),
    backdropPath: v.optional(v.string()),
    genreIds: v.optional(v.array(v.number())),
    originCountry: v.optional(v.array(v.string())),
    originalLanguage: v.optional(v.string()),
    tmdbStatus: v.optional(v.string()),
    buildState: zodToConvex(BuildState),
    // The seasons ticked at subscribe, kept until the first write succeeds, so a retry monitors them.
    initialSeasons: v.optional(v.array(v.number())),
    numberingSuggestion: v.optional(v.object({ scheme: zodToConvex(NumberingScheme), reason: zodToConvex(NumberingReason) })),
    mappingStatus: v.optional(zodToConvex(MappingStatus)),
    mappingNotes: v.array(v.string()),
    /** The series' named TMDB seasons, each with its one scene season: `<alias> <season name>` reads that scene season. */
    seasonNames: v.optional(v.array(v.object({ season: v.number(), name: v.string(), normalized: v.string(), sceneSeason: v.number() }))),
    projectionVersion: v.number(),
    nextSyncAt: v.number(),
    syncWorkId: v.optional(v.string()),
    tmdbMissingSince: v.optional(v.number()),
  })
    .index('by_work', ['workId'])
    .index('by_next_sync', ['nextSyncAt']),

  // TMDB images fetched once and served from Convex file storage, so the browser never talks to TMDB.
  images: defineTable({
    workId: v.id('works'),
    /** TMDB's path, as `workMetadata.posterPath` and the others hold it. */
    path: v.string(),
    /** TMDB's width: w342 posters, w780 backdrops, w300 stills. */
    size: v.string(),
    storageId: v.id('_storage'),
    fetchedAt: v.number(),
  })
    .index('by_path_size', ['path', 'size'])
    .index('by_work', ['workId'])
    // The artifact TTL keeps the files images hold (jobs/artifacts.ts).
    .index('by_storage', ['storageId']),

  unitMetadata: defineTable({
    unitId: v.id('units'),
    workId: v.id('works'),
    overview: v.optional(v.string()),
    stillPath: v.optional(v.string()),
    runtimeMin: v.optional(v.number()),
    retiredAt: v.optional(v.number()),
  })
    .index('by_unit', ['unitId'])
    .index('by_work', ['workId']),

  workAliases: defineTable({
    workId: v.id('works'),
    title: v.string(),
    normalized: v.string(),
    /** `normalized` without spaces (`compactTitle`), so a hyphen on either side still matches (migration 0001). */
    compact: v.string(),
    source: zodToConvex(AliasSource),
    anidbId: v.optional(v.number()),
    /** The scene season XEM lists the name under (a part's name); an absolute number after it is read in that season. */
    sceneSeason: v.optional(v.number()),
  })
    .index('by_work', ['workId'])
    .index('by_normalized', ['normalized'])
    .index('by_compact', ['compact']),

  // One row per source, created by metadata.tick on its first run.
  mappingSourceState: defineTable({
    source: zodToConvex(MappingSourceName),
    version: v.optional(v.string()),
    etag: v.optional(v.string()),
    lastAttemptAt: v.optional(v.number()),
    xemTvdbIds: v.optional(v.array(v.number())),
  }).index('by_source', ['source']),

  animeListEntries: defineTable({
    ...zodToConvexFields(AnimeListEntry.shape),
    seenVersion: v.string(),
  })
    .index('by_anidb', ['anidbId'])
    .index('by_tmdb_tv', ['tmdbTvId'])
    .index('by_seen_version', ['seenVersion']),

  // Sonarr's scene-mapping list, its all-seasons names only.
  sceneMappings: defineTable({
    ...zodToConvexFields(SceneMappingEntry.shape),
    seenVersion: v.string(),
  })
    .index('by_mapping', ['mappingId'])
    .index('by_tvdb', ['tvdbId'])
    .index('by_seen_version', ['seenVersion']),

  // Jellyfin: one row, inserted by `jellyfin.setup.startSetup`.
  jellyfinServer: defineTable({
    state: zodToConvex(JellyfinState),
    /** In checklist order; written from the setup job's result or its terminal failure. */
    steps: v.array(zodToConvex(SetupStepState)),
    locale: zodToConvex(JellyfinLocale),
    serverId: v.optional(v.string()),
    version: v.optional(v.string()),
    adminUserId: v.optional(v.string()),
    /** Never in a DTO; only `jellyfin.setup.connection` returns it. */
    apiKey: v.optional(v.string()),
    libraries: v.array(zodToConvex(JellyfinLibraryItem)),
    /** The platform admin's user ID, the owner of plays. */
    ownerUserId: v.string(),
    lastSetupAt: v.optional(v.number()),
  }),

  // One row per play the session poller saw; kept 90 days.
  playbackReports: defineTable({
    owner: v.string(),
    deviceId: v.string(),
    deviceName: v.string(),
    client: v.string(),
    itemRef: v.string(),
    unitId: v.optional(v.id('units')),
    method: zodToConvex(StoredPlayMethod),
    reasons: v.array(zodToConvex(TranscodeReason)),
    rawReasons: v.array(v.string()),
    open: v.boolean(),
    startedAt: v.number(),
    endedAt: v.optional(v.number()),
  })
    .index('by_open', ['open', 'deviceId', 'itemRef'])
    .index('by_unit_started', ['unitId', 'startedAt'])
    .index('by_started', ['startedAt']),

  // The untracked-media scan. Only the latest run's items are kept.
  scanRuns: defineTable({
    trigger: zodToConvex(ScanTrigger),
    state: zodToConvex(ScanRunState),
    jobId: v.optional(v.id('jobs')),
    counts: zodToConvex(ScanCounts),
    // Set by setNumbering and matchFolder: the periodic scan never replaces a review in progress.
    hasDecisions: v.boolean(),
    finishedAt: v.optional(v.number()),
  }),

  scanItems: defineTable({
    scanRunId: v.id('scanRuns'),
    libraryId: v.id('libraries'),
    path: v.string(),
    // The Work folder under the root; empty for a loose file.
    folder: v.string(),
    sizeBytes: v.number(),
    inode: v.string(),
    probe: v.optional(zodToConvex(ProbeSummary)),
    parsed: v.optional(zodToConvex(ParsedRelease)),
    status: zodToConvex(ScanItemStatus),
    unmatchedReason: v.optional(zodToConvex(UnmatchedReason)),
    match: v.optional(zodToConvex(ScanMatch)),
    suggestions: v.optional(v.array(zodToConvex(ScanSuggestion))),
    fits: v.optional(v.boolean()),
    step: v.optional(zodToConvex(PreparationStep)),
  })
    .index('by_run_status', ['scanRunId', 'status'])
    .index('by_run_folder', ['scanRunId', 'libraryId', 'folder'])
    .index('by_run_path', ['scanRunId', 'path']),

  scanIgnores: defineTable({ libraryId: v.id('libraries'), folder: v.string() }).index('by_library', ['libraryId', 'folder']),

  // One row.
  scanSettings: defineTable({ schedule: zodToConvex(ScanSchedule), lastRunAt: v.optional(v.number()) }),

  // Future tables

  watchState: defineTable({
    owner: v.string(),
    unitId: v.id('units'),
    positionMs: v.number(),
    playedAt: v.optional(v.number()),
    source: v.union(v.literal('jellyfin'), v.literal('platform')),
  }),

  referenceSeeds: defineTable({
    name: v.string(),
  }).index('by_name', ['name']),

  // One row, inserted by `ensureSettingsRow`.
  settings: defineTable({
    firstRun: v.object({ step: zodToConvex(FirstRunStep), completedAt: v.optional(v.number()) }),
    /** Set when the admin is created; its presence means "an admin exists". */
    adminUserId: v.optional(v.string()),
    setupPasswordFailures: v.optional(v.object({ count: v.number(), lockedUntil: v.optional(v.number()) })),
    /** The daily update check's last result, and its last failure. */
    updateCheck: v.optional(
      v.object({
        latestVersion: v.optional(v.string()),
        releaseUrl: v.optional(v.string()),
        checkedAt: v.optional(v.number()),
        failedAt: v.optional(v.number()),
      }),
    ),
  }),
});
