// The daily Anime-Lists fetch, a metadataPool job. Each
// installation fetches the file itself; the project never republishes it
//.
import { v } from 'convex/values';

import { internal } from '../_generated/api';
import { internalAction } from '../_generated/server';
import { parseAnimeList, sha256 } from './animeListsParse';

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
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
      let body: string | null;
      let etag: string | undefined;
      try {
        const response = await fetch(ANIME_LISTS_URL, { headers: state.etag ? { 'if-none-match': state.etag } : {}, signal: controller.signal });
        if (response.status !== 304 && !response.ok) throw new Error(`Anime-Lists answered ${response.status}.`);
        body = response.status === 304 ? null : await response.text();
        etag = response.headers.get('etag') ?? undefined;
      } finally {
        clearTimeout(timer);
      }

      const version = body === null ? undefined : await sha256(body);
      if (body === null || version === state.version) {
        await ctx.runMutation(internal.mapping.sources.recordSourceFetch, { source: 'animeLists', etag });
        return null;
      }
      const entries = await parseAnimeList(body);
      const changed: number[] = [];
      for (let i = 0; i < entries.length; i += BATCH)
        changed.push(...(await ctx.runMutation(internal.mapping.sources.writeAnimeListEntries, { version: version!, batch: entries.slice(i, i + BATCH) })));
      for (;;) {
        const page = await ctx.runMutation(internal.mapping.sources.deleteStaleEntries, { version: version! });
        changed.push(...page.tmdbTvIds);
        if (page.done) break;
      }
      await ctx.runMutation(internal.mapping.sources.recordSourceFetch, { source: 'animeLists', version, etag, changedTmdbTvIds: changed });
      return null;
    } catch (error) {
      await ctx.runMutation(internal.mapping.sources.recordSourceFailure, { source: 'animeLists' });
      throw error;
    }
  },
});
