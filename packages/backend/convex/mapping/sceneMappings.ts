// The daily fetch of Sonarr's scene mappings, a metadataPool job like
// Anime-Lists'. Each installation fetches the list itself, the endpoint
// Sonarr calls (SceneMappingProxy: `services.sonarr.tv/v1/scenemapping`);
// the project ships none of it.
import { v } from 'convex/values';

import { internal } from '../_generated/api';
import { internalAction } from '../_generated/server';
import { userAgent } from '../lib/userAgent';
import { sha256 } from './animeListsParse';
import { parseSceneMappings } from './sceneMappingsParse';

export const SCENE_MAPPINGS_URL = 'https://services.sonarr.tv/v1/scenemapping';
/** `SCENE_MAPPINGS_URL` in e2e points the fetch at the fake. */
const url = () => process.env.SCENE_MAPPINGS_URL || SCENE_MAPPINGS_URL;

/** The list is about 1.7 MB (2026-11-19), as large as Anime-Lists' file. */
const TIMEOUT_MS = 60_000;
/** A body over 16 MB is refused unread. */
const MAX_BYTES = 16 * 1024 * 1024;
const BATCH = 500;

/**
 * GETs the list. A body with the stored hash changes nothing. Otherwise the
 * names are written in batches of 500, names the list no longer has are
 * deleted, and the Works holding a changed name's TVDB ID sync. A failure,
 * or a list that is empty or not a list, counts toward the source's health
 * and fails the job; the stored names stay.
 */
export const fetchSceneMappings = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    const state = await ctx.runQuery(internal.mapping.sources.sourceState, { source: 'sceneMapping' });
    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      let body: string;
      try {
        const response = await fetch(url(), { headers: { 'User-Agent': userAgent(), Accept: 'application/json' }, signal: controller.signal });
        if (!response.ok) throw new Error(`Sonarr's scene mappings answered ${response.status}.`);
        if (Number(response.headers.get('content-length') ?? 0) > MAX_BYTES) throw new Error("Sonarr's scene mappings are too large.");
        body = await response.text();
        if (body.length > MAX_BYTES) throw new Error("Sonarr's scene mappings are too large.");
      } finally {
        clearTimeout(timer);
      }

      const version = await sha256(body);
      if (version === state.version) {
        await ctx.runMutation(internal.mapping.sources.recordSourceFetch, { source: 'sceneMapping' });
        return null;
      }
      const entries = parseSceneMappings(JSON.parse(body));
      const changed: number[] = [];
      for (let i = 0; i < entries.length; i += BATCH)
        changed.push(...(await ctx.runMutation(internal.mapping.sources.writeSceneMappings, { version, batch: entries.slice(i, i + BATCH) })));
      for (;;) {
        const page = await ctx.runMutation(internal.mapping.sources.deleteStaleSceneMappings, { version });
        changed.push(...page.tvdbIds);
        if (page.done) break;
      }
      await ctx.runMutation(internal.mapping.sources.recordSourceFetch, { source: 'sceneMapping', version, changedTvdbIds: changed });
      return null;
    } catch (error) {
      await ctx.runMutation(internal.mapping.sources.recordSourceFailure, { source: 'sceneMapping' });
      throw error;
    }
  },
});
