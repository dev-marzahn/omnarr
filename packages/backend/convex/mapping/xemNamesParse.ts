import { z } from 'zod';

import { releaseName } from './releaseName';

export const XemName = z.object({ title: z.string(), sceneSeason: z.number().int().optional() });
export type XemName = z.infer<typeof XemName>;

export const XemShowNames = z.object({ tvdbId: z.number().int(), names: z.array(XemName) });
export type XemShowNames = z.infer<typeof XemShowNames>;

const ALL_SEASONS = -1;
export const MAX_NAMES_PER_SHOW = 100;

const TVDB_ID = /^\d+$/;
const SCENE_SEASON = /^-?\d+$/;

const AllNames = z.object({ result: z.literal('success'), data: z.record(z.string(), z.unknown()) });
const NameEntries = z.array(z.unknown());
const NameEntry = z.record(z.string(), z.unknown());

function sceneSeasonOf(value: unknown): number | undefined {
  const text = typeof value === 'number' ? String(value) : value;
  if (typeof text !== 'string' || !SCENE_SEASON.test(text)) return undefined;
  const season = Number(text);
  return season >= ALL_SEASONS ? season : undefined;
}

function namesOfShow(entries: unknown[]): XemName[] {
  const seasonsByTitle = new Map<string, Set<number>>();
  for (const entry of entries) {
    const parsed = NameEntry.safeParse(entry);
    if (!parsed.success) continue;
    for (const [raw, value] of Object.entries(parsed.data)) {
      const title = releaseName(raw);
      const season = sceneSeasonOf(value);
      if (title === undefined || season === undefined) continue;
      const seasons = seasonsByTitle.get(title);
      if (seasons) seasons.add(season);
      else if (seasonsByTitle.size < MAX_NAMES_PER_SHOW) seasonsByTitle.set(title, new Set([season]));
    }
  }
  const names: XemName[] = [...seasonsByTitle].map(([title, seasons]) => {
    const [only] = seasons;
    return seasons.size === 1 && only !== ALL_SEASONS ? { title, sceneSeason: only } : { title };
  });
  return names.sort(partNamesFirst);
}

const partNamesFirst = (a: XemName, b: XemName) => (a.sceneSeason ?? Number.MAX_SAFE_INTEGER) - (b.sceneSeason ?? Number.MAX_SAFE_INTEGER);

export function parseAllNames(json: unknown): XemShowNames[] {
  const { data } = AllNames.parse(json);
  const shows = Object.entries(data).flatMap(([id, value]) => {
    const entries = NameEntries.safeParse(value);
    if (!TVDB_ID.test(id) || !entries.success) return [];
    const tvdbId = Number(id);
    const names = namesOfShow(entries.data);
    return tvdbId > 0 && names.length > 0 ? [{ tvdbId, names }] : [];
  });
  if (shows.length === 0) throw new Error('XEM listed no names.');
  return shows;
}
