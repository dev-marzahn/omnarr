import { isReadableReleaseFilter } from '@omnarr/scoring';
import { z } from 'zod';

import { sha256 } from '../lib/sha256';
import { releaseName } from './releaseName';

export const SceneMappingName = z.object({
  title: z.string(),
  tvdbSeason: z.number().optional(),
  releaseSeason: z.number().optional(),
  filter: z.string().optional(),
});
export type SceneMappingName = z.infer<typeof SceneMappingName>;

export const SceneMappingEntry = SceneMappingName.extend({ mappingId: z.string(), tvdbId: z.number(), contentHash: z.string() });
export type SceneMappingEntry = z.infer<typeof SceneMappingEntry>;

export const StoredSceneMapping = SceneMappingEntry.partial({ contentHash: true });

const MAPPING_ID = /^[A-Za-z0-9_-]{1,64}$/;

const EVERY_SEASON = -1;

const SeasonNumber = z
  .number()
  .int()
  .min(EVERY_SEASON)
  .nullish()
  .transform((season) => (season === EVERY_SEASON || season == null ? undefined : season));

const Raw = z.object({
  mappingId: z.string().regex(MAPPING_ID),
  tvdbId: z.number().int().positive(),
  title: z.string(),
  season: SeasonNumber,
  sceneSeasonNumber: SeasonNumber,
  filterRegex: z
    .string()
    .nullish()
    .transform((pattern) => pattern?.trim() || undefined),
  sceneOrigin: z.string().nullish(),
});
type Raw = z.infer<typeof Raw>;

const numbersInSceneOrder = (raw: Raw) => !raw.sceneOrigin || raw.sceneOrigin === 'scene';

type ParsedSceneMapping = Omit<SceneMappingEntry, 'contentHash'>;

function sceneMappingOf(item: unknown): ParsedSceneMapping | undefined {
  const raw = Raw.safeParse(item);
  if (!raw.success) return undefined;
  const { mappingId, tvdbId, season: tvdbSeason, sceneSeasonNumber: releaseSeason, filterRegex: filter } = raw.data;
  const title = releaseName(raw.data.title);
  const namesOneSeason = tvdbSeason !== undefined || releaseSeason !== undefined;
  if (!title || (filter !== undefined && !isReadableReleaseFilter(filter)) || (namesOneSeason && !numbersInSceneOrder(raw.data))) return undefined;
  return { mappingId, tvdbId, title, tvdbSeason, releaseSeason, filter };
}

export async function parseSceneMappings(json: unknown): Promise<SceneMappingEntry[]> {
  const entries = z
    .array(z.unknown())
    .min(1)
    .parse(json)
    .flatMap((item) => sceneMappingOf(item) ?? []);
  return Promise.all(entries.map(async (entry) => ({ ...entry, contentHash: await sha256(JSON.stringify(entry)) })));
}
