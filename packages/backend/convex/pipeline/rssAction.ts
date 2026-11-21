// The RSS fetch, in Convex's default runtime: up to 3
// pages within the RSS share, new items matched one page at a time, and one
// record mutation that picks for every matched Work.
import type { IndexerCall, IndexerItem, ParsedRelease } from '@omnarr/contracts';
import { parseRelease } from '@omnarr/parser';
import { matchUnits } from '@omnarr/scoring';
import { zid, zodToConvex, zodToConvexFields } from 'convex-helpers/server/zod4';
import { z } from 'zod';

import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { internalAction } from '../_generated/server';
import { builtCaps, createAdapter } from '../indexers/adapter';
import { pageSizeOf } from '../indexers/newznab';
import { atLimit, shareLeft } from '../indexers/rateLimit';
import { sendsRequest } from '../indexers/relay';
import { animeOnly } from '../indexers/requestPlan';
import { DAY } from '../indexers/usage';
import type { CandidateInsert } from './search';
import { candidateRow } from './searchAction';

const MAX_PAGES = 3;

/** `<publishedAt ms>:<guid>` of the newest item. */
const markOf = (item: IndexerItem) => `${item.publishedAt}:${item.guid}`;
const markTime = (mark: string) => Number(mark.slice(0, mark.indexOf(':')));

/** 2xxx is a movie, 5xxx a series; anything else is read as a series, and as a movie when that finds no numbers, pack or date. */
function parseByCategory(item: IndexerItem): ParsedRelease {
  if (item.categories.some((c) => c >= 2000 && c < 3000)) return parseRelease(item.title, 'movie');
  const series = parseRelease(item.title, 'series');
  if (item.categories.some((c) => (c >= 5000 && c < 6000) || c >= 100_000)) return series;
  return series.episodes.length > 0 || series.pack || series.airDate ? series : parseRelease(item.title, 'movie');
}

export const fetch = internalAction({
  args: zodToConvexFields({ indexerId: zid('indexers') }),
  returns: zodToConvex(z.null()),
  handler: async (ctx, { indexerId }) => {
    await ctx.runMutation(internal.indexers.store.markRssStarted, { indexerId, now: Date.now() });
    const indexer = await ctx.runQuery(internal.indexers.store.getForAction, { indexerId });
    if (!indexer) return null;
    const adapter = createAdapter(indexer, ctx);
    const calls = (call: IndexerCall) => ctx.runMutation(internal.indexers.store.recordCalls, { indexerId, calls: [call] });
    // Anime-only indexers have nothing for a series without anime numbering.
    const animeIndexer = animeOnly(indexer);

    // Caps older than 24 h are refreshed first; a site's caps are rebuilt, with no request.
    const built = builtCaps(indexer, Date.now());
    if (built && Date.now() - indexer.caps.fetchedAt > DAY) await ctx.runMutation(internal.indexers.store.saveCaps, { indexerId, caps: built });
    else if (Date.now() - indexer.caps.fetchedAt > DAY) {
      const started = Date.now();
      const caps = await adapter.caps();
      if (!caps.ok && caps.skipped) return null;
      await calls({ at: Date.now(), ok: caps.ok, latencyMs: Date.now() - started, kind: 'rss', ...(caps.ok ? {} : { failure: caps.failure }) });
      if (caps.ok) await ctx.runMutation(internal.indexers.store.saveCaps, { indexerId, caps: caps.value });
    }

    const mark = indexer.rssHighWaterMark;
    const limit = pageSizeOf(indexer.caps);
    let newest: string | undefined;
    const perWork = new Map<Id<'works'>, { unitIds: Set<Id<'units'>>; rows: CandidateInsert[] }>();
    let usage = indexer.usage;
    for (let page = 0; page < MAX_PAGES; page++) {
      // A page the adapter answers without a request is empty: the fetch ends with no call.
      if (!sendsRequest(indexer, page * limit)) break;
      if (shareLeft({ apiLimit: indexer.apiLimit, usage }, Date.now(), 'background') < 1) break;
      const started = Date.now();
      const response = await adapter.rss({ offset: page * limit });
      const latencyMs = Date.now() - started;
      // A refused pacing slot sent nothing: the fetch ends without a call; rssLastFetchAt is set, so the next interval retries.
      if (!response.ok && response.skipped) break;
      if (!response.ok) {
        await calls({ at: Date.now(), ok: false, latencyMs, kind: 'rss', failure: response.failure });
        break;
      }
      const items = response.value.items;
      const top = [...items].sort((a, b) => b.publishedAt - a.publishedAt)[0];
      if (page === 0 && top) newest = markOf(top);
      // The first fetch of a new indexer only sets the mark: its backlog isn't matched.
      const fresh = mark === undefined ? [] : items.filter((item) => item.publishedAt > markTime(mark));

      let matched = 0;
      if (fresh.length > 0) {
        const parsed = fresh.map(parseByCategory);
        const page = await ctx.runQuery(internal.pipeline.rss.matchPage, {
          items: fresh.map((item, i) => ({ item, parsed: parsed[i]! })),
        });
        const { works, preferredLanguage } = page;
        const skipsWork = (workId: Id<'works'>) => {
          const work = works.find((w) => w.work.id === workId)!.work;
          return animeIndexer && work.kind === 'series' && work.numberingScheme !== 'anime';
        };
        const matches = page.matches.filter((m) => !skipsWork(m.workId));
        matched = matches.length;
        for (const m of matches) {
          const work = works.find((w) => w.work.id === m.workId)!;
          const match = matchUnits(
            m.resolved as Parameters<typeof matchUnits>[0],
            { unitIds: m.unitIds as never, wantedUnitIds: m.unitIds as never },
            parsed[m.index]!,
          );
          const runtime = new Map(m.runtimes.map((r) => [r.unitId as string, r.runtimeMin]));
          const row = candidateRow(fresh[m.index]!, parsed[m.index]!, match, runtime, { ...work, preferredLanguage, currents: m.currents });
          const entry = perWork.get(m.workId) ?? { unitIds: new Set(), rows: [] };
          for (const unitId of m.unitIds) entry.unitIds.add(unitId);
          entry.rows.push(row);
          perWork.set(m.workId, entry);
        }
      }
      const recorded = await calls({
        at: Date.now(),
        ok: true,
        latencyMs,
        kind: 'rss',
        count: items.length,
        newItems: fresh.length,
        matched,
        ...(response.value.apiLimits ? { apiLimits: response.value.apiLimits } : {}),
      });
      if (recorded) usage = [{ hourStart: Date.now(), requests: recorded.total24h, errors: 0 }];
      // More pages only while the page was full and even its oldest item is new.
      const oldest = items.reduce((min, item) => Math.min(min, item.publishedAt), Infinity);
      // At the indexer's limit, this page counts but no further one is asked for.
      if (mark === undefined || atLimit(response.value.apiLimits) || items.length < limit || oldest <= markTime(mark)) break;
    }

    await ctx.runMutation(internal.pipeline.rss.record, {
      indexerId,
      ...(newest ? { highWaterMark: newest } : {}),
      perWork: [...perWork].map(([workId, { unitIds, rows }]) => ({ workId, unitIds: [...unitIds], rows })),
    });
    return null;
  },
});
