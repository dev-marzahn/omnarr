// The metadata enums, and the shapes the search reads from the metadata
// functions: `ResolveResult` from `resolveUnits` and `SearchKeys` from
// `searchKeys`.
import { zid } from 'convex-helpers/server/zod4';
import { z } from 'zod';

import { UnitRef } from './jobs.ts';
import { MappingSource, Ordering } from './library.ts';

/** `workMetadata.buildState`: `building` until the first write of Units succeeds. */
export const BuildState = z.enum(['building', 'ready', 'failed']);
export type BuildState = z.infer<typeof BuildState>;

/** How far a Work's TVDB and scene numbers are linked to its Units. */
export const MappingStatus = z.enum(['complete', 'partial', 'tmdbOnly']);
export type MappingStatus = z.infer<typeof MappingStatus>;

/** Where a `workAliases` row came from. */
export const AliasSource = z.enum(['tmdb', 'animeLists', 'xem', 'sceneMapping', 'manual']);
export type AliasSource = z.infer<typeof AliasSource>;

/** The community mapping sources, each with a `mappingSourceState` row; `sceneMapping` is Sonarr's scene-mapping list. */
export const MappingSourceName = z.enum(['animeLists', 'xem', 'sceneMapping']);
export type MappingSourceName = z.infer<typeof MappingSourceName>;

/** The outside sources whose health `metadataSettings.sourceHealth` tracks. */
export const MetadataSourceName = z.enum(['tmdb', 'xem', 'animeLists', 'sceneMapping']);
export type MetadataSourceName = z.infer<typeof MetadataSourceName>;

/** Why a numbering scheme is suggested: an Anime-Lists entry, TMDB's genre and origin, or neither. */
export const NumberingReason = z.enum(['animeLists', 'genreOrigin', 'none']);
export type NumberingReason = z.infer<typeof NumberingReason>;

/** How sure `resolveUnits` is that the release's numbers name these Units. */
export const Confidence = z.enum(['mapped', 'assumed', 'unverified']);
export type Confidence = z.infer<typeof Confidence>;

/**
 * The orderings `resolveUnits`' `orderings` argument can limit rules 3 and 4
 * to: TMDB's own numbers, `tvdb` and `scene` rows for
 * season and episode, `absolute` rows for absolute numbers.
 */
export const ResolveOrdering = z.enum(['tmdb', 'tvdb', 'scene', 'absolute']);
export type ResolveOrdering = z.infer<typeof ResolveOrdering>;

export const ResolveProblem = z.enum(['ambiguous', 'notFound', 'schemeMismatch']);
export type ResolveProblem = z.infer<typeof ResolveProblem>;

/**
 * `resolveUnits`' answer. `via` names the ordering the numbers were
 * read in: a `unitMappings` ordering, `tmdb` for TMDB's own numbers, or
 * `airDate`.
 */
export const ResolveResult = z.object({
  unitIds: z.array(zid('units')),
  via: z.object({ ordering: z.union([Ordering, z.enum(['tmdb', 'airDate'])]), source: MappingSource }),
  confidence: Confidence,
  problem: ResolveProblem.optional(),
  /** With `ambiguous`: the Units the disagreeing readings found, which the user may pick from. */
  possibleUnitIds: z.array(zid('units')).optional(),
});
export type ResolveResult = z.infer<typeof ResolveResult>;

/** What the indexer adapter builds its queries from: scene numbers where they exist, else TMDB's. */
export const SearchKeys = z.object({
  tmdbId: z.string(),
  tvdbId: z.string().optional(),
  imdbId: z.string().optional(),
  titles: z.array(z.string()),
  /**
   * The titles a title-only indexer is searched with, best first: the display
   * title, then XEM's and the scene-mapping list's names (the fansub naming),
   * Anime-Lists', the user's and TMDB's; one per compact form. A scene name
   * of another scene season is left out.
   */
  searchTitles: z.array(z.string()),
  units: z.array(UnitRef),
  /** The latest air date of the Units, when every one has an air date: how far back a search pages. */
  lastAirDateUtc: z.number().optional(),
});
export type SearchKeys = z.infer<typeof SearchKeys>;
