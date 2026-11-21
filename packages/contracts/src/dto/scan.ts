// The untracked-media scan's DTOs: the
// latest run's status, its folders grouped for review, the review's
// requests, the import's options and the repeat setting.
import { zid } from 'convex-helpers/server/zod4';
import { z } from 'zod';

import { PreparationStep } from '../playback.ts';
import { LibraryKind, WorkKind } from './library.ts';

/** Who started a run. */
export const ScanTrigger = z.enum(['manual', 'periodic', 'firstRun']);
export type ScanTrigger = z.infer<typeof ScanTrigger>;

/** `scanRuns.state`: the worker reads, the backend matches, then the run waits for the review. */
export const ScanRunState = z.enum(['reading', 'matching', 'ready', 'failed', 'cancelled']);
export type ScanRunState = z.infer<typeof ScanRunState>;

/** `scanItems.status`. */
export const ScanItemStatus = z.enum(['matched', 'unmatched', 'ignored', 'conflict', 'imported']);
export type ScanItemStatus = z.infer<typeof ScanItemStatus>;

/** Why an item is unmatched: ffprobe couldn't read it, no Work for its folder, no numbers in its name, numbers no Unit has, or two numberings that disagree. */
export const UnmatchedReason = z.enum(['unreadable', 'noWork', 'noNumbers', 'unitNotFound', 'ambiguous']);
export type UnmatchedReason = z.infer<typeof UnmatchedReason>;

/** The numbering a folder's files were read in: the folder's "Numbering" select, or `manual` after "Match by hand". */
export const ScanOrdering = z.enum(['tmdb', 'tvdb', 'absolute', 'manual']);
export type ScanOrdering = z.infer<typeof ScanOrdering>;
/** The numberings the user can choose for a folder. */
export const ScanNumbering = ScanOrdering.exclude(['manual']);
export type ScanNumbering = z.infer<typeof ScanNumbering>;

/** A display label for the naming a folder follows ("Read as"). */
export const ReadAs = z.enum(['sonarr', 'radarr', 'jellyfin', 'unknown']);
export type ReadAs = z.infer<typeof ReadAs>;

/** The periodic scan: off by default. */
export const ScanSchedule = z.enum(['off', 'daily', 'weekly']);
export type ScanSchedule = z.infer<typeof ScanSchedule>;

export const ScanCounts = z.object({
  /** Videos the worker found under the roots. */
  read: z.number(),
  /** Of those, the ones a `files` row already holds (by path or inode). */
  tracked: z.number(),
  matched: z.number(),
  /** Unmatched and conflicting items. */
  unmatched: z.number(),
  ignored: z.number(),
  imported: z.number(),
});
export type ScanCounts = z.infer<typeof ScanCounts>;

/** What a file is in its Work: TMDB numbers and title, or "the movie". */
export const ScanUnitLabel = z.object({ season: z.number().optional(), episode: z.number().optional(), title: z.string().optional() });
export type ScanUnitLabel = z.infer<typeof ScanUnitLabel>;

/** The Work an item's folder matched, and how its file was read (`scanItems.match`). */
export const ScanMatch = z.object({
  /** The Work in the library; absent for a title the import will create. */
  workId: zid('works').optional(),
  tmdbId: z.string(),
  kind: WorkKind,
  title: z.string(),
  year: z.number().optional(),
  ordering: ScanOrdering,
  /** The Work's Units the file holds; empty for a title not in the library yet. */
  unitIds: z.array(zid('units')),
  /** The same Units as numbers and titles, for the review; a new title's come from TMDB's snapshot. */
  units: z.array(ScanUnitLabel),
  readAs: ReadAs,
  /** The Work's stored folder (`works.folder`), for a Work in the library that has one: a file outside it moves (`movesToLibraryNaming`). */
  workFolder: z.string().optional(),
});
export type ScanMatch = z.infer<typeof ScanMatch>;

/**
 * Whether the import moves a matched file to library naming: Jellyfin 12.4
 * reads a file's season and episode from its path, so a file whose naming
 * the scan didn't recognise, one matched by hand, and one read in absolute
 * numbering (which Jellyfin can't place in a season) would be filed under
 * the wrong episode or series. So does a file
 * in another folder than its Work's (`workFolder`, absent while the Work has
 * none and this folder will become it): one Work is one folder, so Jellyfin
 * never shows two series for it. Sonarr, Radarr and Jellyfin naming in the
 * Work's folder keep their path and name.
 */
export const movesToLibraryNaming = (match: Pick<ScanMatch, 'readAs' | 'ordering'>, folder: string, workFolder: string | undefined): boolean =>
  match.readAs === 'unknown' || match.ordering === 'manual' || match.ordering === 'absolute' || (workFolder !== undefined && workFolder !== folder);

/** A TMDB result offered in "Match by hand"'s title step. */
export const ScanSuggestion = z.object({ tmdbId: z.string(), kind: WorkKind, title: z.string(), year: z.number().optional(), workId: zid('works').optional() });
export type ScanSuggestion = z.infer<typeof ScanSuggestion>;

/** `scan.status`: the latest run, for the scan page, the header's count and first run. */
export const ScanStatus = z.object({
  run: z
    .object({
      scanRunId: zid('scanRuns'),
      trigger: ScanTrigger,
      state: ScanRunState,
      counts: ScanCounts,
      startedAt: z.number(),
      finishedAt: z.number().optional(),
      hasDecisions: z.boolean(),
      /** While reading: the worker's progress ("640 / 1,204"). */
      progress: z.object({ fraction: z.number(), detail: z.string().optional() }).optional(),
    })
    .nullable(),
  /** The header's "Scan untracked" count: matched and unmatched items of a `ready` run. */
  untracked: z.number(),
  schedule: ScanSchedule,
  lastRunAt: z.number().optional(),
});
export type ScanStatus = z.infer<typeof ScanStatus>;

/** One file of a folder. */
export const ScanItemRow = z.object({
  scanItemId: zid('scanItems'),
  path: z.string(),
  /** The path under the library root. */
  relPath: z.string(),
  sizeBytes: z.number(),
  status: ScanItemStatus,
  unmatchedReason: UnmatchedReason.optional(),
  /** What the file is in its Work, when matched. */
  units: z.array(ScanUnitLabel),
  /** The numbers its name gives, for "Absolute 13 → S02E01". */
  read: z.object({ season: z.number().optional(), episodes: z.array(z.number()), absolute: z.array(z.number()) }).optional(),
  fits: z.boolean().optional(),
  step: PreparationStep.optional(),
  /** Codecs and container from the probe, for "HEVC · E-AC-3 · MKV". */
  format: z.object({ video: z.string().optional(), audio: z.string().optional(), container: z.string() }).optional(),
});
export type ScanItemRow = z.infer<typeof ScanItemRow>;

/** A folder under a library root with its items, grouped for review. */
export const ScanGroup = z.object({
  libraryId: zid('libraries'),
  libraryKind: LibraryKind,
  /** The Work folder under the root; empty for loose files. */
  folder: z.string(),
  /** The Work its files matched, with whether it is in the library already. */
  match: ScanMatch.pick({ workId: true, tmdbId: true, kind: true, title: true, year: true, ordering: true, readAs: true, workFolder: true }).optional(),
  /** Why the folder as a whole is unmatched (`noWork`, `ambiguous`), when it is. */
  reason: UnmatchedReason.optional(),
  suggestions: z.array(ScanSuggestion),
  counts: z.object({
    files: z.number(),
    matched: z.number(),
    unmatched: z.number(),
    conflict: z.number(),
    ignored: z.number(),
    imported: z.number(),
    notFit: z.number(),
  }),
  /** The first files (all of them in `scan.folder`). */
  files: z.array(ScanItemRow),
});
export type ScanGroup = z.infer<typeof ScanGroup>;

/** Which folders a review tab lists: those with matched items, or with unmatched or conflicting ones. */
export const ScanTab = z.enum(['matched', 'unmatched']);
export type ScanTab = z.infer<typeof ScanTab>;

export const ScanGroupsRequest = z.object({ scanRunId: zid('scanRuns'), tab: ScanTab, cursor: z.string().nullable() });
export type ScanGroupsRequest = z.infer<typeof ScanGroupsRequest>;
export const ScanGroupsPage = z.object({ groups: z.array(ScanGroup), cursor: z.string().nullable() });
export type ScanGroupsPage = z.infer<typeof ScanGroupsPage>;

/** A folder of the run. */
export const ScanFolderRef = z.object({ libraryId: zid('libraries'), folder: z.string() });
export type ScanFolderRef = z.infer<typeof ScanFolderRef>;

export const ScanStartRequest = z.object({ trigger: ScanTrigger });
export const ScanStartResponse = z.object({ scanRunId: zid('scanRuns') });
export const ScanRunRequest = z.object({ scanRunId: zid('scanRuns') });
export const ScanFolderRequest = ScanRunRequest.extend(ScanFolderRef.shape);

/** `scan.setNumbering`: re-reads a folder in the chosen numbering. */
export const ScanSetNumberingRequest = ScanFolderRequest.extend({ ordering: ScanNumbering });

/**
 * `scan.matchFolder` ("Match by hand"): a title, then, optionally,
 * what each file is. Without `files` the folder is read again against the
 * title. With them, only the files assigned are matched; the rest stay
 * unmatched.
 */
export const ScanMatchFolderRequest = ScanFolderRequest.extend({
  title: z.object({ tmdbId: z.string(), kind: WorkKind, title: z.string(), year: z.number().optional() }),
  files: z
    .array(
      z.object({
        scanItemId: zid('scanItems'),
        /** "The movie", or a TMDB season and episode. */
        movie: z.boolean().optional(),
        season: z.number().int().min(0).optional(),
        episode: z.number().int().min(1).optional(),
      }),
    )
    .optional(),
});
export type ScanMatchFolderRequest = z.infer<typeof ScanMatchFolderRequest>;

export const ScanIgnoreRequest = ScanFolderRef.extend({ scanRunId: zid('scanRuns').optional() });

/** `scan.import`: the folders to import, the release profile for new series, and whether they're monitored. */
export const ScanImportOptions = z.object({
  folders: z.array(ScanFolderRef),
  releaseProfileId: zid('releaseProfiles'),
  /** "After import, series are": monitored, or tracked and not monitored (the default). */
  monitor: z.boolean(),
});
export type ScanImportOptions = z.infer<typeof ScanImportOptions>;
export const ScanImportRequest = ScanRunRequest.extend(ScanImportOptions.shape);
export const ScanImportResponse = z.object({ imported: z.number(), works: z.number(), failed: z.array(ScanFolderRef.extend({ message: z.string() })) });
export type ScanImportResponse = z.infer<typeof ScanImportResponse>;

export const ScanSearchTitleRequest = z.object({ query: z.string().min(1), kind: WorkKind });
export const ScanSearchTitleResponse = z.array(ScanSuggestion);

export const ScanSettings = z.object({ schedule: ScanSchedule, lastRunAt: z.number().optional() });
export type ScanSettings = z.infer<typeof ScanSettings>;
export const ScanUpdateSettingsRequest = z.object({ schedule: ScanSchedule });
