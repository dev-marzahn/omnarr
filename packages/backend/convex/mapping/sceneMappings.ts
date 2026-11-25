// The daily fetch of Sonarr's scene mappings, a metadataPool job like
// Anime-Lists'. Each installation fetches the list itself, the endpoint
// Sonarr calls (SceneMappingProxy: `services.sonarr.tv/v1/scenemapping`);
// the project ships none of it.
import { v } from 'convex/values';

import { internal } from '../_generated/api';
import { internalAction } from '../_generated/server';
import { fetchCappedText } from '../lib/fetchCappedText';
import { userAgent } from '../lib/userAgent';
import { storeList } from './listStore';
import { parseSceneMappings } from './sceneMappingsParse';

export const SCENE_MAPPINGS_URL = 'https://services.sonarr.tv/v1/scenemapping';
/** `SCENE_MAPPINGS_URL` in e2e points the fetch at the fake. */
const url = () => process.env.SCENE_MAPPINGS_URL || SCENE_MAPPINGS_URL;

const TIMEOUT_MS = 60_000;
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
      const body = await fetchCappedText(url(), {
        label: "Sonarr's scene mappings",
        timeoutMs: TIMEOUT_MS,
        headers: { 'User-Agent': userAgent(), Accept: 'application/json' },
      });
      await storeList(body, state.version, {
        parse: (text) => parseSceneMappings(JSON.parse(text)),
        batchSize: BATCH,
        writeBatch: (version, batch) => ctx.runMutation(internal.mapping.sources.writeSceneMappings, { version, batch }),
        deleteStalePage: (version) => ctx.runMutation(internal.mapping.sources.deleteStaleSceneMappings, { version }),
        recordFetch: (version) => ctx.runMutation(internal.mapping.sources.recordSourceFetch, { source: 'sceneMapping', version }),
        resync: (tvdbIds) => ctx.runMutation(internal.mapping.sources.resyncChangedWorks, { tvdbIds }),
      });
      return null;
    } catch (error) {
      await ctx.runMutation(internal.mapping.sources.recordSourceFailure, { source: 'sceneMapping' });
      throw error;
    }
  },
});
