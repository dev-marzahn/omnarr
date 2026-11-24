// The item page's timeline: the Unit's events outside runs, its runs (one
// per Grab, keyed by the run ID the user copies) with their stages, and each
// run's decision records. Read from stored rows only, never by running the
// scorer again. No field holds a URL or a key: the schemas are strict.
import { zid } from 'convex-helpers/server/zod4';
import { z } from 'zod';

import { EventKind, EventStage } from '../events.ts';
import { BlocklistReason, FailureCode } from '../failures.ts';
import { DownloadProtocol, StoredIndexerSkip } from '../indexer.ts';
import { ClientStage, ClientStatus } from '../jobs.ts';
import { ResolveProblem } from '../metadata.ts';
import { Sidecar } from '../naming.ts';
import { PlanStep, PreparationStep } from '../playback.ts';
import { CandidateReason, LostOn, ParsedEpisode, ParsedRelease, QualityId, ReleasePack, ScoreBreakdown } from '../release.ts';
import { FileVersionKind, GrabKind, GrabState, SearchAttemptState, UnitState } from '../states.ts';
import { IssueRow } from './issues.ts';
import { SeedingProgress, UnitDownload, WorkKind } from './library.ts';
import { IndexerCallStatus } from './system.ts';

/** `interactive` is "Search and pick". */
export const SearchTriggerName = z.enum(['subscribe', 'rss', 'backfill', 'manual', 'nextBest', 'interactive', 'upgrade']);
export type SearchTriggerName = z.infer<typeof SearchTriggerName>;

/** One event: a state change, a client stage, a decision, a blocklisting. */
export const TimelineStage = z
  .object({
    stage: EventStage,
    kind: EventKind,
    message: z.string(),
    at: z.number(),
    from: z.string().optional(),
    to: z.string().optional(),
    failureCode: FailureCode.optional(),
    /** On a manual grab's pick step: the rejection the user grabbed it over. */
    confirmReason: CandidateReason.optional(),
  })
  .strict();
export type TimelineStage = z.infer<typeof TimelineStage>;

/** A Unit a candidate covers or could be, with its TMDB numbers for the label (`S03E02`). */
export const CandidateUnit = z.object({ unitId: zid('units'), tmdbSeason: z.number().optional(), tmdbEpisode: z.number().optional() }).strict();
export type CandidateUnit = z.infer<typeof CandidateUnit>;

/** A decision record (`candidates`). */
export const CandidateRow = z
  .object({
    candidateId: zid('candidates'),
    title: z.string(),
    /** "Removed" when the indexer was deleted since. */
    indexerName: z.string(),
    protocol: DownloadProtocol,
    sizeBytes: z.number(),
    publishedAt: z.number(),
    parsed: ParsedRelease,
    quality: QualityId,
    qualityAssumed: z.boolean(),
    baseScore: z.number(),
    score: z.number(),
    breakdown: ScoreBreakdown,
    preparationStep: PreparationStep,
    preparationAssumed: z.boolean(),
    outcome: z.enum(['pending', 'picked', 'rejected']),
    reason: CandidateReason.optional(),
    rank: z.number().optional(),
    lostOn: LostOn.optional(),
    matchDetail: z.string().optional(),
    torrent: z.object({ seeders: z.number().optional(), peers: z.number().optional() }).strict().optional(),
    /**
     * The release covers this Unit, or its unclear numbering may be this
     * Unit; false for a pack of other episodes or a release of another title
     * (the "All" view).
     */
    coversUnit: z.boolean(),
    /** Present once picked: `user` for a manual grab. */
    pickedBy: z.enum(['auto', 'user']).optional(),
    /** The release beats a playable Unit's current one. */
    isUpgrade: z.boolean().optional(),
    /** Why `resolveUnits` couldn't settle the numbers. */
    matchProblem: ResolveProblem.optional(),
    /** With `matchProblem: ambiguous`: the Units it could be ("Could be S03E02 or S04E02"). */
    possibleUnits: z.array(CandidateUnit).optional(),
    /** The Units a grab of this row covers, for the grab confirm's title: its own, or the search's for a wrong title or episode. */
    covers: z.array(CandidateUnit),
    /** A `blocklisted` row's entry: when and why. */
    blocklisted: z.object({ at: z.number(), reason: BlocklistReason }).strict().optional(),
  })
  .strict();
export type CandidateRow = z.infer<typeof CandidateRow>;

/**
 * How one indexer took part in a search, from `searchAttempts.indexerResults`.
 * `skipped` is the recorded skip (a legacy `category`
 * included), or `noRequest`: the indexer existed when the search ran, but the
 * request plan had no query for it, so the attempt has no row for it.
 */
export const TimelineSearchIndexer = z
  .object({
    indexerName: z.string(),
    status: IndexerCallStatus,
    count: z.number(),
    skipped: z.union([StoredIndexerSkip, z.literal('noRequest')]).optional(),
    failureCode: FailureCode.optional(),
  })
  .strict();
export type TimelineSearchIndexer = z.infer<typeof TimelineSearchIndexer>;

/** The search a run came from, with its decision records. */
export const TimelineSearch = z
  .object({
    searchAttemptId: zid('searchAttempts'),
    trigger: SearchTriggerName,
    state: SearchAttemptState,
    at: z.number(),
    /** An offered "Search and pick": its rows can be grabbed until then (1 h). */
    offeredUntil: z.number().optional(),
    candidates: z.array(CandidateRow),
    /** Every indexer's part in it, by name. */
    indexers: z.array(TimelineSearchIndexer),
  })
  .strict();
export type TimelineSearch = z.infer<typeof TimelineSearch>;

/** How long an offered attempt's rows can be grabbed. */
export const OFFER_TTL_MS = 3_600_000;

/** One Grab's run: the Grab ID is the run ID. */
export const TimelineRun = z
  .object({
    grabId: zid('grabs'),
    title: z.string(),
    state: GrabState,
    startedAt: z.number(),
    /** The UI shows "Cancelling…" until the run ends. */
    cancelRequested: z.boolean(),
    /** The run can't replay and waits for a fix. */
    paused: z.boolean(),
    /** `user` for a manual grab: "Picked by you". */
    pickedBy: z.enum(['auto', 'user']),
    /** `upgrade`: the timeline labels the run "Upgrade". */
    kind: GrabKind,
    failureCode: FailureCode.optional(),
    /** The Unit's outcome in this Grab. */
    outcome: z.enum(['pending', 'imported', 'skipped', 'failed']),
    stages: z.array(TimelineStage),
    /** The client's view, shown on demand: ParStatus, UnpackStatus, Health, or a tracker message and host. */
    download: z.object({ clientStage: ClientStage, clientStatus: ClientStatus.optional() }).strict().optional(),
    search: TimelineSearch,
  })
  .strict();
export type TimelineRun = z.infer<typeof TimelineRun>;

export const TimelineRequest = z.object({ unitId: zid('units') });

/** One of the Unit's file versions, for the item page's Files tab. */
export const FileRow = z
  .object({
    fileId: zid('files'),
    path: z.string(),
    origin: z.enum(['download', 'scan', 'prepared']),
    kind: FileVersionKind,
    fits: z.boolean(),
    /** The steps `compare` gives against the library's target; empty when it fits or has no probe. */
    steps: z.array(PlanStep),
    sidecars: z.array(Sidecar),
    missingSince: z.number().optional(),
  })
  .strict();
export type FileRow = z.infer<typeof FileRow>;

/** `library.files(workId)`: the Work page's Files tab, a FileRow per Unit's version with its Unit, size and the release's quality. */
export const WorkFileRow = FileRow.extend({
  unitId: zid('units'),
  tmdbSeason: z.number().optional(),
  tmdbEpisode: z.number().optional(),
  sizeBytes: z.number(),
  /** From the release the file came from; absent for a scanned file. */
  quality: QualityId.optional(),
  /** The file's Grab still seeds its torrent. */
  seeding: SeedingProgress.optional(),
});
export type WorkFileRow = z.infer<typeof WorkFileRow>;

/** `units.timeline(unitId)`: newest run first; null once the Unit is gone. */
export const Timeline = z
  .object({
    unitId: zid('units'),
    workId: zid('works'),
    workTitle: z.string(),
    /** For the breadcrumb and a movie's redirect to its Work page. */
    workKind: WorkKind,
    /** The running Grab's Download, for the progress card; absent when no Grab runs. */
    download: UnitDownload.optional(),
    preparation: z.object({ fraction: z.number().optional(), detail: z.string().optional() }).strict().optional(),
    /**
     * The newest run's torrent while it seeds to its goal, with its run's
     * release title for the seeding card.
     */
    seeding: SeedingProgress.extend({ releaseTitle: z.string().optional() }).strict().optional(),
    /** The Work's stored poster and the Unit's stored still, served by omnarr. */
    posterUrl: z.string().optional(),
    stillUrl: z.string().optional(),
    tmdbSeason: z.number().optional(),
    tmdbEpisode: z.number().optional(),
    title: z.string().optional(),
    state: UnitState,
    monitored: z.boolean(),
    /** Events outside runs: searches, monitoring, preparation. */
    events: z.array(TimelineStage),
    runs: z.array(TimelineRun),
    /** The last search when no run came from it: why nothing was grabbed. */
    lastSearch: TimelineSearch.optional(),
    /** "Open in Jellyfin": the item's path in jellyfin-web, without the origin. */
    jellyfinItemPath: z.string().optional(),
    /** The Unit's file versions: primary, staged, kept original. */
    files: z.array(FileRow),
    /** The Unit's open Issues, shown at the top of the Timeline tab with their fixes. */
    issues: z.array(IssueRow),
  })
  .strict();
export type Timeline = z.infer<typeof Timeline>;

/** `units.searchInteractive(unitIds)`: "Search and pick" for one Unit. */
export const SearchInteractiveRequest = z.object({ unitIds: z.array(zid('units')).length(1) });
export const SearchInteractiveResponse = z.object({ searchAttemptId: zid('searchAttempts') });

/** `units.grabCandidate(candidateId, { confirmReason? })`: the rejection the confirm showed, for a rejected row. */
export const GrabCandidateRequest = z.object({ candidateId: zid('candidates'), confirmReason: CandidateReason.optional() });

/**
 * The Grab, or why it was refused: the results are over an hour
 * old (`expired`, "Search again"), a covered Unit already has a running Grab
 * (`busy`, "Cancel grab"), or the row is a pack of unclear numbering, which
 * v1 can't import as a season (`packNeedsSeason`).
 */
export const GrabCandidateResponse = z.discriminatedUnion('outcome', [
  z.object({ outcome: z.literal('grabbed'), grabId: zid('grabs') }),
  z.object({ outcome: z.literal('expired') }),
  z.object({ outcome: z.literal('busy'), grabId: zid('grabs') }),
  z.object({ outcome: z.literal('packNeedsSeason') }),
]);
export type GrabCandidateResponse = z.infer<typeof GrabCandidateResponse>;

/**
 * A row of the episode's "Might be this episode" list: a release of its last
 * search rejected as a wrong title or episode whose name contains one of the
 * Work's aliases. Strict, with no URL or key: a candidate's download link can
 * carry the indexer's API key.
 */
export const MisreadRow = z
  .object({
    /** The search's row, for the Candidates tab's grab. */
    candidateId: zid('candidates'),
    title: z.string(),
    /** "Removed" when the indexer was deleted since. */
    indexerName: z.string(),
    protocol: DownloadProtocol,
    /** A torrent's seeders, when the indexer gave them. */
    seeders: z.number().optional(),
    /** What the parser read: the numbers, and a pack's seasons. */
    episodes: z.array(ParsedEpisode),
    pack: ReleasePack.optional(),
    airDate: z.string().optional(),
    /** `title`: no alias matched the name; `episode`: the name matched but the numbers named no Unit, or could be more than one. */
    matchDetail: z.enum(['title', 'episode']),
    /** Why `resolveUnits` couldn't settle the numbers, for `episode`. */
    matchProblem: ResolveProblem.optional(),
  })
  .strict();
export type MisreadRow = z.infer<typeof MisreadRow>;

/** At most this many rows. */
export const MISREAD_ROW_CAP = 20;

/** `units.mightBeThisEpisode(unitId)`: most seeders first, then newest; empty when the last search has a picked or acceptable release. */
export const MisreadList = z.array(MisreadRow);
