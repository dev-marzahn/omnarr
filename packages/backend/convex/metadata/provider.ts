// The MetadataProvider port, with the snapshot a sync
// writes from. v1's adapter is TMDB (tmdb.ts), run in Convex actions; a
// hosted proxy can be a second adapter. Mapping data comes from
// TheXEM and Anime-Lists, which are not providers (mapping/).
import { UnitKind, WorkKind } from '@omnarr/contracts';
import { ConvexError } from 'convex/values';
import { z } from 'zod';

import { tmdbProvider } from './tmdb';

/** One episode, special or movie. `tmdbId` is the TMDB episode ID; a movie's Unit has none (its ID is on the Work). */
export const UnitMetadata = z.object({
  kind: UnitKind,
  tmdbId: z.string().optional(),
  tmdbSeason: z.number().optional(),
  tmdbEpisode: z.number().optional(),
  title: z.string().optional(),
  airDateUtc: z.number().optional(),
  overview: z.string().optional(),
  stillPath: z.string().optional(),
  runtimeMin: z.number().optional(),
});
export type UnitMetadata = z.infer<typeof UnitMetadata>;

const TmdbNumber = z.object({ tmdbSeason: z.number(), tmdbEpisode: z.number() });

/** A series or movie as TMDB lists it now: what a sync writes. */
export const WorkMetadata = z.object({
  kind: WorkKind,
  tmdbId: z.string(),
  /** The display title, in `metadataSettings.language`. */
  title: z.string(),
  year: z.number().optional(),
  overview: z.string().optional(),
  posterPath: z.string().optional(),
  backdropPath: z.string().optional(),
  genreIds: z.array(z.number()),
  originCountry: z.array(z.string()),
  originalLanguage: z.string().optional(),
  tmdbStatus: z.string().optional(),
  tvdbId: z.number().optional(),
  imdbId: z.string().optional(),
  /** The English title, the original title and the alternative titles. */
  aliases: z.array(z.string()),
  /** TMDB's Absolute (type 2) episode groups: how many, and the episodes of the one fetched. */
  absoluteGroups: z.object({ count: z.number(), episodes: z.array(TmdbNumber).optional() }).optional(),
  /** A series' seasons with TMDB's name for each (`Steel Ball Run`, `Season 2`). */
  seasons: z.array(z.object({ season: z.number(), name: z.string().optional() })).optional(),
  /** In TMDB order; a movie has one Unit of kind `movie`. */
  units: z.array(UnitMetadata),
});
export type WorkMetadata = z.infer<typeof WorkMetadata>;

/** A search result as the provider gives it; the caller adds the numbering suggestion and `workId`. */
export type ProviderHit = { tmdbId: string; kind: WorkKind; title: string; year?: number; posterPath?: string; genreIds: number[]; originCountry: string[] };

/** What TMDB says of a token: only a `valid` one is ever stored. */
export type KeyCheck = 'valid' | 'rejected' | 'unreachable';

export interface MetadataProvider {
  /** Titles of one kind matching the query, best match first (add-title flow). */
  search(query: string, kind: WorkKind): Promise<ProviderHit[]>;
  /** A series or movie with its Units, or null when the provider doesn't know the ID. */
  lookupWork(tmdbId: string, kind: WorkKind): Promise<WorkMetadata | null>;
  /** Whether TMDB accepts a token, without using it for anything else. */
  checkKey(token: string): Promise<KeyCheck>;
  /** The series and movies TMDB links to a TVDB or IMDb ID (TMDB's `/find`, for the scan). */
  findByExternalId(provider: 'tvdb' | 'imdb', value: string): Promise<ProviderHit[]>;
}

/** `lookupWork` for a title the caller names: refuses an ID the provider doesn't know. */
export async function requireWork(provider: MetadataProvider, tmdbId: string, kind: WorkKind): Promise<WorkMetadata> {
  const work = await provider.lookupWork(tmdbId, kind);
  if (!work) throw new ConvexError({ code: 'notFound', message: `TMDB has no ${kind} with ID ${tmdbId}.` });
  return work;
}

/** The provider for a token and display language, from `keys.currentToken`. */
export function metadataProvider(token: string | undefined, language: string): MetadataProvider {
  return tmdbProvider({ baseUrl: process.env.TMDB_API_URL ?? 'https://api.themoviedb.org', token, language });
}
