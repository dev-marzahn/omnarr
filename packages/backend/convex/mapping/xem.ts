// TheXEM client. Every request uses `origin=tvdb`. Responses are parsed
// with the schemas here; `result: failure` means "not in XEM", never an
// error.
import { v } from 'convex/values';
import { z } from 'zod';

import { internal } from '../_generated/api';
import { internalAction } from '../_generated/server';

const XemNumber = z.object({ season: z.number(), episode: z.number(), absolute: z.number().optional() });
export type XemNumber = z.infer<typeof XemNumber>;

/** One `/map/all` entry: the TVDB numbers, and the scene numbers with a second address when there is one. */
export type XemEntry = { tvdb: XemNumber; scene?: XemNumber; scene2?: XemNumber };

const MapAll = z.object({
  result: z.enum(['success', 'failure']),
  data: z.union([z.array(z.record(z.string(), XemNumber)), z.record(z.string(), z.never())]),
});

/** `/map/all?origin=tvdb`'s entries. A show XEM doesn't know, or an empty map, gives none. */
export function parseMapAll(json: unknown): XemEntry[] {
  const { result, data } = MapAll.parse(json);
  if (result === 'failure' || !Array.isArray(data)) return [];
  return data.flatMap((entry) => (entry.tvdb ? [{ tvdb: entry.tvdb, scene: entry.scene, scene2: entry.scene_2 }] : []));
}

/** `/map/names`: `{ <season or 'all'>: { <language>: names[] } }`; undocumented. */
const MapNames = z.object({
  result: z.enum(['success', 'failure']),
  data: z.union([z.record(z.string(), z.record(z.string(), z.array(z.string()))), z.array(z.never())]),
});

/** A name XEM lists for the show, with the scene season it lists the name under, if only one. */
export type XemName = { title: string; sceneSeason?: number };

/**
 * Every name XEM lists for the show, once each. A name listed under one
 * scene season only (a part's name, `… - Stone Ocean`) keeps that season;
 * one under `all` or several seasons has none.
 */
export function parseNames(json: unknown): XemName[] {
  const { result, data } = MapNames.parse(json);
  if (result === 'failure' || Array.isArray(data)) return [];
  const seasons = new Map<string, Set<string>>();
  for (const [season, byLanguage] of Object.entries(data))
    for (const title of Object.values(byLanguage).flat()) seasons.set(title, (seasons.get(title) ?? new Set()).add(season));
  return [...seasons].map(([title, keys]) => {
    const [only] = keys;
    const season = keys.size === 1 && /^\d+$/.test(only!) ? Number(only) : undefined;
    return season === undefined ? { title } : { title, sceneSeason: season };
  });
}

/** `/map/havemap?origin=tvdb`: the TVDB IDs XEM has a mapping for, as strings. */
const Havemap = z.object({ result: z.enum(['success', 'failure']), data: z.array(z.union([z.string(), z.number()])) });

export function parseHavemap(json: unknown): number[] {
  const { result, data } = Havemap.parse(json);
  if (result === 'failure') return [];
  return data.map(Number).filter(Number.isInteger);
}

export const XEM_URL = 'https://thexem.info';
const TIMEOUT_MS = 10_000;

/** GETs a XEM endpoint as JSON, with the 10 s timeout. Throws on a network error, a timeout or a non-2xx answer. */
async function getJson(path: string, query: Record<string, string>): Promise<unknown> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  try {
    const response = await fetch(`${XEM_URL}${path}?${new URLSearchParams(query)}`, { signal: controller.signal });
    if (!response.ok) throw new Error(`XEM ${path} answered ${response.status}.`);
    return await response.json();
  } catch (error) {
    throw error instanceof Error && error.message.startsWith('XEM ') ? error : new Error(`XEM ${path} could not be reached.`);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * One show's map and names. A failed map fails the fetch;
 * failed names leave `names` absent, and the Work keeps its XEM aliases.
 */
export async function fetchShow(tvdbId: number): Promise<{ entries: XemEntry[]; names?: XemName[] }> {
  const query = { id: String(tvdbId), origin: 'tvdb' };
  const entries = parseMapAll(await getJson('/map/all', query));
  try {
    return { entries, names: parseNames(await getJson('/map/names', query)) };
  } catch {
    return { entries };
  }
}

/**
 * The daily `havemap` fetch, a metadataPool job: stores XEM's TVDB ID
 * list, with its fetch time as the version, and syncs the Works whose TVDB
 * ID entered it. A failure counts toward XEM's health and fails the job.
 */
export const fetchHavemap = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    let xemTvdbIds: number[];
    try {
      xemTvdbIds = parseHavemap(await getJson('/map/havemap', { origin: 'tvdb' }));
    } catch (error) {
      await ctx.runMutation(internal.mapping.sources.recordSourceFailure, { source: 'xem' });
      throw error;
    }
    await ctx.runMutation(internal.mapping.sources.recordSourceFetch, { source: 'xem', version: new Date().toISOString(), xemTvdbIds });
    return null;
  },
});
