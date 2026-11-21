// Library DTOs: what the library pages read and what subscribing
// takes. Added with their first consumer, `api/library` and `api/units`.
import { zid } from 'convex-helpers/server/zod4';
import { z } from 'zod';

import { BlocklistReason, FailureCode } from '../failures.ts';
import { PlanStep } from '../playback.ts';
import { SeedGoal } from '../seedGoal.ts';
import { SearchAttemptState, UnitState } from '../states.ts';

export const LibraryKind = z.enum(['series', 'movies']);
export type LibraryKind = z.infer<typeof LibraryKind>;

export const WorkKind = z.enum(['series', 'movie']);
export type WorkKind = z.infer<typeof WorkKind>;

/** The library a Work of each kind belongs in: anime is a series. */
export const LIBRARY_OF: Record<WorkKind, LibraryKind> = { series: 'series', movie: 'movies' };
/** The kind of Work a library holds. */
export const WORK_KIND_OF: Record<LibraryKind, WorkKind> = { series: 'series', movies: 'movie' };

export const UnitKind = z.enum(['episode', 'movie', 'special']);
export type UnitKind = z.infer<typeof UnitKind>;

export const NumberingScheme = z.enum(['standard', 'anime']);
export type NumberingScheme = z.infer<typeof NumberingScheme>;

/** How many of a Work's Units show one state. */
export const StateCount = z.object({ state: UnitState, count: z.number() });
export type StateCount = z.infer<typeof StateCount>;

/**
 * A running Grab's Download: its protocol, client
 * stage, fraction done, bytes and speed. `fraction` is absent before the
 * client's first report; the bytes and speed when the client gives none.
 * The UI computes the time left as (totalBytes − doneBytes) / bytesPerSec.
 */
export const UnitDownload = z.object({
  grabId: zid('grabs'),
  // DownloadProtocol and ClientStage, spelled out: jobs.ts imports this module, and indexer.ts reaches jobs.ts.
  protocol: z.enum(['usenet', 'torrent']),
  stage: z.enum(['queued', 'downloading', 'postProcessing']),
  fraction: z.number().optional(),
  doneBytes: z.number().optional(),
  totalBytes: z.number().optional(),
  bytesPerSec: z.number().optional(),
});
export type UnitDownload = z.infer<typeof UnitDownload>;

/**
 * A completed torrent that is still seeding: the ratio, seed time and
 * uploaded bytes the reconciler last reported (absent before its first
 * report), the goal it seeds to, and `fraction`, how far it is towards
 * whichever goal is closer.
 */
export const SeedingProgress = z
  .object({
    ratio: z.number().optional(),
    seedTimeMs: z.number().optional(),
    uploadedBytes: z.number().optional(),
    goal: SeedGoal.optional(),
    fraction: z.number().optional(),
  })
  .strict();
export type SeedingProgress = z.infer<typeof SeedingProgress>;

/** A row of the library list: a Work with its Units' states rolled up. */
export const WorkSummary = z.object({
  workId: zid('works'),
  libraryId: zid('libraries'),
  kind: WorkKind,
  title: z.string(),
  year: z.number().optional(),
  numberingScheme: NumberingScheme,
  releaseProfileId: zid('releaseProfiles'),
  monitorNewUnits: z.boolean(),
  /** Every Unit, monitored or not. */
  units: z.number(),
  monitored: z.number(),
  /** Monitored Units with a playable file, read from their derived state. */
  present: z.number(),
  /** Counts per derived state, in UnitState's order, without the states no Unit shows. */
  states: z.array(StateCount),
  /** Open unit-scope Issues of the Work's Units, counting each Issue. A playable Unit can have one too. */
  openIssues: z.number(),
  /** On `library.detail` only: primary versions that don't fit, for "Prepare all (N)". */
  notInTargetCount: z.number().optional(),
  /**
   * The Work's running Downloads: how many, their fraction
   * (weighted by size when every one reports it, the mean otherwise) and
   * their summed speed. Absent when none runs.
   */
  activeDownloads: z.object({ count: z.number(), fraction: z.number().optional(), bytesPerSec: z.number().optional() }).optional(),
  /**
   * On `library.list` only: the Work's torrents still seeding to their goals,
   * each once. Absent when none seeds.
   */
  seeding: z.object({ count: z.number() }).optional(),
  /** The stored poster's URL, served by omnarr; absent until it is fetched. */
  posterUrl: z.string().optional(),
  /** On `library.detail` only: the stored backdrop's URL, and TMDB's overview for the hero. */
  backdropUrl: z.string().optional(),
  overview: z.string().optional(),
  /** On `library.detail` only: the series' or movie's path in jellyfin-web, without the origin. Absent until a publish records it. */
  jellyfinItemPath: z.string().optional(),
});
export type WorkSummary = z.infer<typeof WorkSummary>;

/** One episode or movie on the Work page. */
export const UnitRow = z.object({
  unitId: zid('units'),
  kind: UnitKind,
  tmdbSeason: z.number().optional(),
  tmdbEpisode: z.number().optional(),
  title: z.string().optional(),
  airDateUtc: z.number().optional(),
  monitored: z.boolean(),
  state: UnitState,
  /** When the last search started and how it ended (no acceptable release isn't a failure). */
  /**
   * `unclearCount`: the search's releases of unclear numbering that may be
   * this Unit; with any, the Work row's action is "Search and pick".
   */
  lastSearch: z.object({ at: z.number(), outcome: SearchAttemptState, unclearCount: z.number() }).optional(),
  /** The next scheduled search. */
  nextSearchAt: z.number().optional(),
  /** Shown as a tag beside the state, not as a state. */
  openIssue: z.object({ issueId: zid('issues'), failureCode: FailureCode }).optional(),
  /** The active Grab is being cancelled: the UI shows "Cancelling…" until its run ends. */
  cancelRequested: z.boolean(),
  /** "Open in Jellyfin": the item's path in jellyfin-web, without the origin. */
  jellyfinItemPath: z.string().optional(),
  /** A pending Rendition of the Unit's file: its steps and the job's progress, for the Unit's Preparing row. */
  preparation: z
    .object({ renditionId: zid('renditions'), steps: z.array(PlanStep), fraction: z.number().optional(), detail: z.string().optional() })
    .optional(),
  /** An upgrade Grab runs for the Unit, which keeps its state: shown as an "Upgrading" tag. */
  upgrading: z.object({ grabId: zid('grabs'), stage: z.enum(['grabbed', 'downloading', 'repairUnpack', 'importing']) }).optional(),
  /** The running Grab's Download; absent when no Grab runs. */
  download: UnitDownload.optional(),
  /** The stored still's URL: stills are fetched only for seasons with a monitored or present Unit. */
  stillUrl: z.string().optional(),
});
export type UnitRow = z.infer<typeof UnitRow>;

/** `library.prepareAll(workId)`: how many prepare jobs it queued, in its first page. */
export const PrepareAllResponse = z.object({ queued: z.number() });

/** A library as its list page names it. */
export const LibraryRef = z.object({
  libraryId: zid('libraries'),
  kind: LibraryKind,
  name: z.string(),
  defaultReleaseProfileId: zid('releaseProfiles'),
});
export type LibraryRef = z.infer<typeof LibraryRef>;

export const LibraryListRequest = z.object({ kind: LibraryKind });

/** `library.list`: the library, absent until first run creates it, and its Works. */
export const LibraryList = z.object({ library: LibraryRef.optional(), works: z.array(WorkSummary) });
export type LibraryList = z.infer<typeof LibraryList>;

export const WorkDetailRequest = z.object({ workId: zid('works') });

/** `library.detail`: the Work page, with every Unit in TMDB order. */
export const WorkDetail = z.object({ work: WorkSummary, units: z.array(UnitRow) });
export type WorkDetail = z.infer<typeof WorkDetail>;

/** `library.subscribe`. */
export const SubscribeRequest = z.object({
  tmdbId: z.string(),
  kind: WorkKind,
  libraryId: zid('libraries'),
  releaseProfileId: zid('releaseProfiles'),
  /** The TMDB seasons to monitor. Specials (season 0) always start unmonitored. Ignored for a movie. */
  seasons: z.array(z.number().int().min(1)),
  /** Overrides the scheme the metadata provider preselects. */
  numberingScheme: NumberingScheme.optional(),
  /** Whether episodes TMDB adds later start monitored; on when left out. Ignored for a movie. */
  monitorNewUnits: z.boolean().optional(),
  /**
   * The Work's folder under its library root, for a Work the scan found in an
   * existing folder. Such a Work starts with no
   * Unit monitored, a movie too, and no search; the scan import monitors it.
   */
  folder: z.string().min(1).optional(),
});
export type SubscribeRequest = z.infer<typeof SubscribeRequest>;

/** `units.setMonitored(unitIds | seasonNumber, monitored)`; a season is one Work's TMDB season, 0 for specials. */
export const SetMonitoredRequest = z.object({
  target: z.discriminatedUnion('kind', [
    z.object({ kind: z.literal('units'), unitIds: z.array(zid('units')) }),
    z.object({ kind: z.literal('season'), workId: zid('works'), season: z.number().int().min(0) }),
  ]),
  monitored: z.boolean(),
});
export type SetMonitoredRequest = z.infer<typeof SetMonitoredRequest>;

/** How many Units had their flag changed. */
export const SetMonitoredResponse = z.object({ changed: z.number() });
export type SetMonitoredResponse = z.infer<typeof SetMonitoredResponse>;

/** `units.cancelGrab(grabId, { blocklist? })`. */
export const CancelGrabRequest = z.object({ grabId: zid('grabs'), blocklist: z.boolean().optional() });
export type CancelGrabRequest = z.infer<typeof CancelGrabRequest>;

/** False when the run had already finished, so there was nothing to cancel. */
export const CancelGrabResponse = z.object({ cancelRequested: z.boolean() });
export type CancelGrabResponse = z.infer<typeof CancelGrabResponse>;

/** `units.searchNow(unitIds)`: an ordinary control, not a fix action. */
export const SearchNowRequest = z.object({ unitIds: z.array(zid('units')).min(1) });
export type SearchNowRequest = z.infer<typeof SearchNowRequest>;

/** How many SearchAttempts started: one per search group of the wanted Units among them. */
export const SearchNowResponse = z.object({ attempts: z.number() });
export type SearchNowResponse = z.infer<typeof SearchNowResponse>;

/** A row of the Work page's Blocklist tab: the release, why, the run that added it and that run's episodes. */
export const BlocklistEntry = z.object({
  entryId: zid('blocklist'),
  title: z.string(),
  reason: BlocklistReason,
  /** The run that added it; absent for an entry no run added. */
  grabId: zid('grabs').optional(),
  units: z.array(z.object({ tmdbSeason: z.number().optional(), tmdbEpisode: z.number().optional() })),
  addedAt: z.number(),
});
export type BlocklistEntry = z.infer<typeof BlocklistEntry>;

/** `library.blocklist(workId)`: the Work's entries, newest first. */
export const BlocklistList = z.array(BlocklistEntry);

/** `library.unblock(entryId)`: "Unblock release", which grabs nothing. */
export const UnblockRequest = z.object({ entryId: zid('blocklist') });

/** `library.setMonitorNew(workId, monitorNewUnits)`: Edit monitoring's "monitor new episodes", as subscribe sets it. */
export const SetMonitorNewRequest = z.object({ workId: zid('works'), monitorNewUnits: z.boolean() });

/** `library.deleteWork(workId, { deleteFiles })`: files stay on disk unless `deleteFiles`. */
export const DeleteWorkRequest = z.object({ workId: zid('works'), deleteFiles: z.boolean() });

/** The subscribed Work. `created` is false when the title was already in the library. */
export const SubscribeResponse = z.object({ workId: zid('works'), created: z.boolean() });
export type SubscribeResponse = z.infer<typeof SubscribeResponse>;
