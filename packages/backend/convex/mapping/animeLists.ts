// The daily Anime-Lists fetch, a metadataPool job. Each
// installation fetches the file itself; the project never republishes it
//.
import { v } from 'convex/values';

import { internal } from '../_generated/api';
import { internalAction } from '../_generated/server';
import { fetchCappedTextIfChanged } from '../lib/fetchCappedText';
import { parseAnimeList } from './animeListsParse';
import { storeList } from './listStore';

export const ANIME_LISTS_URL = 'https://raw.githubusercontent.com/Anime-Lists/anime-lists/master/anime-list.xml';

/** The file is about 1.7 MB, so it gets longer than an API call's 10 s. */
const TIMEOUT_MS = 60_000;
const BATCH = 500;

/**
 * A conditional GET of anime-list.xml. A 304, or a body with the stored
 * hash, changes nothing. Otherwise the entries are written in batches of
 * 500, entries the file no longer has are deleted, and the Works linked to
 * any changed entry sync. A failure counts toward the source's health and
 * fails the job, which the pool retries.
 */
export const fetchAnimeLists = internalAction({
  args: {},
  returns: v.null(),
  handler: async (ctx): Promise<null> => {
    const state = await ctx.runQuery(internal.mapping.sources.sourceState, { source: 'animeLists' });
    try {
      const fetched = await fetchCappedTextIfChanged(ANIME_LISTS_URL, state.etag, { label: 'Anime-Lists', timeoutMs: TIMEOUT_MS });
      if (fetched.notModified) {
        await ctx.runMutation(internal.mapping.sources.recordSourceFetch, { source: 'animeLists' });
        return null;
      }
      const { etag } = fetched;
      await storeList(fetched.body, state.version, {
        parse: parseAnimeList,
        batchSize: BATCH,
        writeBatch: (version, batch) => ctx.runMutation(internal.mapping.sources.writeAnimeListEntries, { version, batch }),
        deleteStalePage: (version) => ctx.runMutation(internal.mapping.sources.deleteStaleEntries, { version }),
        recordFetch: (version) => ctx.runMutation(internal.mapping.sources.recordSourceFetch, { source: 'animeLists', version, etag }),
        resync: (tmdbTvIds) => ctx.runMutation(internal.mapping.sources.resyncChangedWorks, { tmdbTvIds }),
      });
      return null;
    } catch (error) {
      await ctx.runMutation(internal.mapping.sources.recordSourceFailure, { source: 'animeLists' });
      throw error;
    }
  },
});
