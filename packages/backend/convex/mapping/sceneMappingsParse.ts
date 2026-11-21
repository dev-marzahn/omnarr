// Parsing Sonarr's scene mappings (`GET services.sonarr.tv/v1/scenemapping`).
// The list is community data from
// outside, so every entry is checked on its own and a bad one is skipped.
// Only all-seasons names (`season: -1`) are kept: `season` is a TVDB season,
// which omnarr's `sceneSeason` (XEM's scene season) can't hold, and a
// `filterRegex` is an untrusted pattern that applies to some releases only.
import { z } from 'zod';

/** One stored mapping: a release name Sonarr's community lists for a TVDB series, in every season. */
export const SceneMappingEntry = z.object({ mappingId: z.string(), tvdbId: z.number(), title: z.string() });
export type SceneMappingEntry = z.infer<typeof SceneMappingEntry>;

/** Longer than any live title (105 characters on 2026-11-19), and short enough for an index key. */
export const MAX_TITLE = 200;
/** Live IDs are `s-` and 24 hex digits. */
const MAPPING_ID = /^[A-Za-z0-9_-]{1,64}$/;
/** C0 and C1 controls, and the Unicode format characters (bidi overrides, zero-width): never in a release name. */
const CONTROL = /[\p{Cc}\p{Cf}]/u;

const Raw = z.object({
  mappingId: z.string().regex(MAPPING_ID),
  tvdbId: z.number().int().positive(),
  title: z.string(),
  season: z.number().int().nullish(),
  sceneSeasonNumber: z.number().int().nullish(),
  filterRegex: z.string().nullish(),
});

/**
 * The list's all-seasons names, in list order. Throws on a body that is not
 * a list, or an empty list (Sonarr also keeps its copy then), so the fetch
 * fails and the stored copy stays.
 */
export function parseSceneMappings(json: unknown): SceneMappingEntry[] {
  const list = z.array(z.unknown()).min(1).parse(json);
  const entries: SceneMappingEntry[] = [];
  for (const item of list) {
    const raw = Raw.safeParse(item);
    if (!raw.success) continue;
    const { mappingId, tvdbId, season, sceneSeasonNumber, filterRegex } = raw.data;
    const title = raw.data.title.trim();
    if ((season ?? -1) !== -1 || (sceneSeasonNumber ?? -1) !== -1 || filterRegex?.trim()) continue;
    if (!title || title.length > MAX_TITLE || CONTROL.test(title)) continue;
    entries.push({ mappingId, tvdbId, title });
  }
  return entries;
}
