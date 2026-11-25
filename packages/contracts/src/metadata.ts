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
export const MappingSourceName = z.enum(['animeLists', 'xem', 'xemNames', 'sceneMapping']);
export type MappingSourceName = z.infer<typeof MappingSourceName>;

/** The outside sources whose health `metadataSettings.sourceHealth` tracks. */
export const MetadataSourceName = z.enum(['tmdb', 'xem', 'xemNames', 'animeLists', 'sceneMapping']);
export type MetadataSourceName = z.infer<typeof MetadataSourceName>;

export const ShownSourceName = z.enum(['tmdb', 'xem', 'animeLists', 'sceneMapping']);
export type ShownSourceName = z.infer<typeof ShownSourceName>;

export const JOBS_OF_SOURCE: Record<ShownSourceName, readonly [MetadataSourceName, ...MetadataSourceName[]]> = {
  tmdb: ['tmdb'],
  xem: ['xem', 'xemNames'],
  animeLists: ['animeLists'],
  sceneMapping: ['sceneMapping'],
};

export const SOURCE_LABEL: Record<ShownSourceName, string> = {
  tmdb: 'TMDB',
  xem: 'TheXEM',
  animeLists: 'Anime-Lists',
  sceneMapping: 'Sonarr scene mappings',
};

export const SourceHealth = z.object({ firstFailureAt: z.number().optional(), lastSuccessAt: z.number().optional() });
export type SourceHealth = z.infer<typeof SourceHealth>;

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

export const SeasonName = z.object({ season: z.number(), name: z.string(), normalized: z.string(), sceneSeason: z.number().optional() });
export type SeasonName = z.infer<typeof SeasonName>;

export const SeasonNameForMatch = SeasonName.omit({ name: true });
export type SeasonNameForMatch = z.infer<typeof SeasonNameForMatch>;

export const PartSeasonOrdering = z.enum(['scene', 'tmdb']);
export type PartSeasonOrdering = z.infer<typeof PartSeasonOrdering>;

export const PartSeason = z.object({ season: z.number(), ordering: PartSeasonOrdering });
export type PartSeason = z.infer<typeof PartSeason>;

export const AliasReading = z.object({
  anidbId: z.number().optional(),
  partSeason: PartSeason.optional(),
  releaseSeason: z.number().optional(),
  filter: z.string().optional(),
});
export type AliasReading = z.infer<typeof AliasReading>;

export const MatchedAlias = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('plain') }),
  z.object({ kind: z.literal('anidb'), anidbId: z.number() }),
  z.object({ kind: z.literal('namedSeason'), season: z.number() }),
  PartSeason.extend({ kind: z.literal('partSeason'), releaseSeason: z.number() }),
]);
export type MatchedAlias = z.infer<typeof MatchedAlias>;

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
