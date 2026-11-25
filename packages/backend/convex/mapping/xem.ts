import { v } from 'convex/values';
import { z } from 'zod';

import { internal } from '../_generated/api';
import { internalAction } from '../_generated/server';
import { fetchCappedText } from '../lib/fetchCappedText';
import { resyncInBatches, storeList } from './listStore';
import { parseAllNames } from './xemNamesParse';

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

/** `/map/havemap?origin=tvdb`: the TVDB IDs XEM has a mapping for, as strings. */
const Havemap = z.object({ result: z.enum(['success', 'failure']), data: z.array(z.union([z.string(), z.number()])) });

export function parseHavemap(json: unknown): number[] {
  const { result, data } = Havemap.parse(json);
  if (result === 'failure') return [];
  return data.map(Number).filter(Number.isInteger);
}

export const XEM_URL = 'https://thexem.info';
const SHOW_TIMEOUT_MS = 10_000;
const ALL_NAMES_TIMEOUT_MS = 60_000;
const SHOWS_PER_WRITE = 200;

const getBody = (path: string, query: Record<string, string>, timeoutMs: number): Promise<string> =>
  fetchCappedText(`${XEM_URL}${path}?${new URLSearchParams(query)}`, { label: `XEM ${path}`, timeoutMs });

const getJson = async (path: string, query: Record<string, string>): Promise<unknown> => JSON.parse(await getBody(path, query, SHOW_TIMEOUT_MS));

export async function fetchShow(tvdbId: number): Promise<XemEntry[]> {
  return parseMapAll(await getJson('/map/all', { id: String(tvdbId), origin: 'tvdb' }));
}

export const fetchHavemap = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    const state = await ctx.runQuery(internal.mapping.sources.sourceState, { source: 'xem' });
    let xemTvdbIds: number[];
    try {
      xemTvdbIds = parseHavemap(await getJson('/map/havemap', { origin: 'tvdb' }));
    } catch (error) {
      await ctx.runMutation(internal.mapping.sources.recordSourceFailure, { source: 'xem' });
      throw error;
    }
    await ctx.runMutation(internal.mapping.sources.recordSourceFetch, { source: 'xem', version: new Date().toISOString(), xemTvdbIds });
    const known = new Set(state.xemTvdbIds ?? []);
    await resyncInBatches(
      xemTvdbIds.filter((tvdbId) => !known.has(tvdbId)),
      (tvdbIds) => ctx.runMutation(internal.mapping.sources.resyncChangedWorks, { tvdbIds }),
    );
    return null;
  },
});

export const fetchXemNames = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    const state = await ctx.runQuery(internal.mapping.sources.sourceState, { source: 'xemNames' });
    try {
      const body = await getBody('/map/allNames', { origin: 'tvdb', seasonNumbers: '1' }, ALL_NAMES_TIMEOUT_MS);
      await storeList(body, state.version, {
        parse: (text) => parseAllNames(JSON.parse(text)),
        batchSize: SHOWS_PER_WRITE,
        writeBatch: (version, batch) => ctx.runMutation(internal.mapping.sources.writeXemNames, { version, batch }),
        deleteStalePage: (version) => ctx.runMutation(internal.mapping.sources.deleteStaleXemNames, { version }),
        recordFetch: (version) => ctx.runMutation(internal.mapping.sources.recordSourceFetch, { source: 'xemNames', version }),
        resync: (tvdbIds) => ctx.runMutation(internal.mapping.sources.resyncChangedWorks, { tvdbIds }),
      });
    } catch (error) {
      await ctx.runMutation(internal.mapping.sources.recordSourceFailure, { source: 'xemNames' });
      throw error;
    }
    return null;
  },
});
