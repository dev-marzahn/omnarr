// Metadata DTOs: adding a title (`metadata.search` and `metadata.preview`),
// the metadata settings and a Work's numbering.
import { zid } from 'convex-helpers/server/zod4';
import { z } from 'zod';

import { MappingSource, Ordering } from '../library.ts';
import { AliasSource, BuildState, MappingStatus, MetadataSourceName, NumberingReason } from '../metadata.ts';
import { NumberingScheme, WorkKind } from './library.ts';

export const MetadataSearchRequest = z.object({
  query: z.string().trim().min(1),
  /** Both kinds when absent. */
  kind: WorkKind.optional(),
});

/** A title the provider found. `workId` is set when it's already in the library. */
export const MetadataHit = z.object({
  tmdbId: z.string(),
  kind: WorkKind,
  title: z.string(),
  year: z.number().optional(),
  /** What subscribing would preselect. */
  numberingScheme: NumberingScheme,
  /** Why: "From Anime-Lists", TMDB's genre and origin, or neither. */
  numberingReason: NumberingReason,
  workId: zid('works').optional(),
  /** The w92 poster the search action fetched, as a data URI; not stored, and the browser never asks TMDB. */
  posterDataUri: z.string().optional(),
});
export type MetadataHit = z.infer<typeof MetadataHit>;

export const MetadataSearchResult = z.array(MetadataHit);
export type MetadataSearchResult = z.infer<typeof MetadataSearchResult>;

export const WorkPreviewRequest = z.object({ tmdbId: z.string(), kind: WorkKind });

/** A TMDB season before subscribing: how many episodes it has and how many aired. 0 is specials. */
export const SeasonPreview = z.object({
  season: z.number(),
  episodes: z.number(),
  aired: z.number(),
  nextAirDateUtc: z.number().optional(),
});
export type SeasonPreview = z.infer<typeof SeasonPreview>;

/** The subscribe panel's view of a title. A movie has no seasons. */
export const WorkPreview = MetadataHit.extend({ seasons: z.array(SeasonPreview) });
export type WorkPreview = z.infer<typeof WorkPreview>;

// Metadata settings. The user's token is never in a DTO.

/** The metadata settings page: which token is in use, the language, and each source's health. */
export const MetadataSettingsRow = z.object({
  tokenSource: z.enum(['user', 'deployment']),
  userTokenCheckedAt: z.number().optional(),
  language: z.string(),
  sources: z.array(
    z.object({ name: MetadataSourceName, version: z.string().optional(), lastSuccessAt: z.number().optional(), firstFailureAt: z.number().optional() }),
  ),
});
export type MetadataSettingsRow = z.infer<typeof MetadataSettingsRow>;

/** TMDB's API Read Access Token, to test and, when valid, store. */
export const KeyTestRequest = z.object({ token: z.string().trim().min(1) });
export const KeyTestResult = z.object({ outcome: z.enum(['valid', 'rejected', 'unreachable']) });
export type KeyTestResult = z.infer<typeof KeyTestResult>;

// A Work's numbering (the Work page's numbering panel).

export const WorkAliasRow = z.object({ aliasId: zid('workAliases'), title: z.string(), source: AliasSource, anidbId: z.number().optional() });
export type WorkAliasRow = z.infer<typeof WorkAliasRow>;

/** The Work page's metadata: display data, the first write's state, the numbering suggestion, mapping status and aliases. */
export const WorkMetadataRow = z.object({
  workId: zid('works'),
  overview: z.string().optional(),
  posterPath: z.string().optional(),
  backdropPath: z.string().optional(),
  genreIds: z.array(z.number()),
  originCountry: z.array(z.string()),
  originalLanguage: z.string().optional(),
  tmdbStatus: z.string().optional(),
  buildState: BuildState,
  numberingSuggestion: z.object({ scheme: NumberingScheme, reason: NumberingReason }).optional(),
  mappingStatus: MappingStatus.optional(),
  mappingNotes: z.array(z.string()),
  aliases: z.array(WorkAliasRow),
  /** TMDB no longer lists the title; its Units and files stay. */
  tmdbMissing: z.boolean(),
  /** A sync is enqueued or running. */
  syncing: z.boolean(),
});
export type WorkMetadataRow = z.infer<typeof WorkMetadataRow>;

export const WorkRequest = z.object({ workId: zid('works') });
export const UnitRequest = z.object({ unitId: zid('units') });

/** One of a Unit's numbers in another ordering, with where it came from. */
export const UnitMappingRow = z.object({
  mappingId: zid('unitMappings'),
  ordering: Ordering,
  season: z.number().optional(),
  episode: z.number().optional(),
  absolute: z.number().optional(),
  source: MappingSource,
  sourceVersion: z.string().optional(),
});
export type UnitMappingRow = z.infer<typeof UnitMappingRow>;

export const SetNumberingSchemeRequest = z.object({ workId: zid('works'), scheme: NumberingScheme });
export const AddAliasRequest = z.object({ workId: zid('works'), title: z.string().trim().min(1) });
export const RemoveAliasRequest = z.object({ aliasId: zid('workAliases') });

/** A manual mapping names a season and episode, an absolute number, or both. */
export const SetManualMappingRequest = z
  .object({
    unitId: zid('units'),
    ordering: Ordering,
    season: z.number().int().min(0).optional(),
    episode: z.number().int().min(1).optional(),
    absolute: z.number().int().min(1).optional(),
  })
  .refine((m) => (m.season === undefined) === (m.episode === undefined), 'season and episode go together')
  .refine((m) => m.episode !== undefined || m.absolute !== undefined, 'a season and episode, or an absolute number');
export const RemoveManualMappingRequest = z.object({ mappingId: zid('unitMappings') });
