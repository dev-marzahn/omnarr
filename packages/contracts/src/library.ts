// Library identity types that cross a process boundary.
import { z } from 'zod';

/**
 * A numbering a mapping projects onto a Unit (`unitMappings.ordering`):
 * `scene`, `tvdb`, `absolute`, `anidb:<anidbId>` for one Anime-Lists entry,
 * or `episodeGroup:<id>` for a TMDB episode group.
 */
export const Ordering = z
  .string()
  .regex(/^(scene|tvdb|absolute|anidb:\d+|episodeGroup:[A-Za-z0-9]+)$/, 'scene, tvdb, absolute, anidb:<anidbId> or episodeGroup:<id>');
export type Ordering = z.infer<typeof Ordering>;

/** Whose ID an `externalIds` row holds. */
export const ExternalIdProvider = z.enum(['tmdb', 'tvdb', 'imdb', 'anidb']);
export type ExternalIdProvider = z.infer<typeof ExternalIdProvider>;

/** Where a `unitMappings` row came from. */
export const MappingSource = z.enum(['tmdb', 'tvdb', 'xem', 'animeLists', 'manual']);
export type MappingSource = z.infer<typeof MappingSource>;
