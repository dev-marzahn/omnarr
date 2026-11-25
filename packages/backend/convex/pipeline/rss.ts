// RSS: the dispatch cron, the per-page Work lookup
// and the record mutation, which creates one `rss` SearchAttempt per matched
// Work and picks in the same mutation.
import { IndexerItem, type MatchedAlias, ParsedRelease, protocolOf, ReleaseProfileContent, ResolveResult, TargetFormat } from '@omnarr/contracts';
import { normalizeTitle, titleSides } from '@omnarr/parser';
import { filterWorks, matchTitle, splitSeasonMark, type WorkForMatch } from '@omnarr/scoring';
import { zid, zodToConvex, zodToConvexFields } from 'convex-helpers/server/zod4';
import { z } from 'zod';

import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { internalMutation, internalQuery, type QueryCtx } from '../_generated/server';
import { dueIndexers } from '../indexers/store';
import { recomputeUnits } from '../lib/derivedState';
import { appendEvent } from '../lib/events';
import { findWorkByTmdbId } from '../library/works';
import { findWorksByTitle, resolveUnits } from '../metadata/resolve';
import { workMetadataOf } from '../metadata/write';
import { targetOf } from '../playback/target';
import { keysForWork } from './blocklist';
import { pickInMutation } from './pick';
import {
  CandidateInsert,
  disabledProtocols,
  insertCandidates,
  isWanted,
  preferredLanguageOf,
  profileContent,
  unitsBeingSearchedToPick,
  WorkForSearch,
  workForSearch,
} from './search';
import { CurrentRelease, currentsFor, isUpgradeable } from './upgrades';

/**
 * The cron (every 5 minutes): one fetch per indexer that is due
 * (`store.dueForRss`), except those of a protocol whose client is off, so RSS
 * starts no Grab for it.
 */
export const dispatch = internalMutation({
  args: {},
  returns: zodToConvex(z.null()),
  handler: async (ctx) => {
    const disabled = await disabledProtocols(ctx);
    for (const indexerId of await dueIndexers(ctx, Date.now())) {
      const indexer = (await ctx.db.get(indexerId))!;
      if (disabled.includes(protocolOf(indexer.kind))) continue;
      await ctx.scheduler.runAfter(0, internal.pipeline.rssAction.fetch, { indexerId });
    }
    return null;
  },
});

/** What evaluating a matched Work's items needs: the evaluation inputs search.context would return. */
export const RssWork = z.object({
  work: WorkForSearch,
  profile: ReleaseProfileContent,
  blocklistKeys: z.object({ releaseKeys: z.array(z.string()), normalizedTitles: z.array(z.string()) }),
  originalLanguage: z.string().optional(),
  /** The Work's library target, as search.context gives it. */
  target: TargetFormat,
});

export const RssMatch = z.object({
  /** The item's position in the page. */
  index: z.number(),
  workId: zid('works'),
  /** The monitored, wanted Units the release covers. */
  unitIds: z.array(zid('units')),
  resolved: ResolveResult,
  runtimes: z.array(z.object({ unitId: zid('units'), runtimeMin: z.number().optional() })),
  /** The upgradeable Units' current releases. */
  currents: z.array(CurrentRelease),
});

const asMatchWork = (work: z.infer<typeof WorkForSearch>) => work as unknown as WorkForMatch;

/** The Works an item's IDs name: TMDB through the kind-checked lookup, TVDB and IMDb (with `tt`) through externalIds. */
async function worksByIds(ctx: QueryCtx, item: IndexerItem, kind: 'series' | 'movie'): Promise<Id<'works'>[]> {
  const found: Id<'works'>[] = [];
  if (item.ids.tmdbid) {
    const workId = await findWorkByTmdbId(ctx, item.ids.tmdbid, kind);
    if (workId) found.push(workId);
  }
  const lookups: ['tvdb' | 'imdb', string | undefined][] = [
    ['tvdb', item.ids.tvdbid],
    ['imdb', item.ids.imdbid === undefined ? undefined : `tt${item.ids.imdbid}`],
  ];
  for (const [provider, value] of lookups) {
    if (value === undefined) continue;
    const rows = await ctx.db
      .query('externalIds')
      .withIndex('by_provider_value', (q) => q.eq('provider', provider).eq('value', value))
      .collect();
    for (const row of rows) if (row.workId) found.push(row.workId);
  }
  return found;
}

/**
 * One RSS page: each item's Works by title and IDs, matchTitle and
 * the several-Works rule, resolveUnits with the matched alias, and the
 * monitored, wanted Units it covers. Items that cover none are dropped.
 */
export const matchPage = internalQuery({
  args: zodToConvexFields({ items: z.array(z.object({ item: IndexerItem, parsed: ParsedRelease })) }),
  returns: zodToConvex(z.object({ matches: z.array(RssMatch), works: z.array(RssWork), preferredLanguage: z.string() })),
  handler: async (ctx, { items }) => {
    const now = Date.now();
    const views = new Map<Id<'works'>, { doc: Doc<'works'>; view: z.infer<typeof WorkForSearch> }>();
    const view = async (workId: Id<'works'>) => {
      if (!views.has(workId)) {
        const doc = await ctx.db.get(workId);
        if (doc) views.set(workId, { doc, view: await workForSearch(ctx, doc) });
      }
      return views.get(workId);
    };

    // The library's named seasons, read once per page when a title finds no Work by its aliases.
    let named: { workId: Id<'works'>; normalized: string }[] | undefined;
    const bySeasonName = async (normalized: string) => {
      named ??= (await ctx.db.query('workMetadata').collect()).flatMap((m) =>
        (m.seasonNames ?? []).map((s) => ({ workId: m.workId, normalized: s.normalized })),
      );
      return named.filter((s) => normalized.endsWith(` ${s.normalized}`) || normalized.startsWith(`${s.normalized} `)).map((s) => s.workId);
    };

    const byName = async (normalized: string) => {
      // A title that finds no Work may be one with a season mark (`Ember Rite S2`): the name before it is looked up.
      let byTitle = (await findWorksByTitle(ctx, normalized, 'releaseTitle')).map((m) => m.workId);
      const marked = byTitle.length === 0 ? splitSeasonMark(normalized) : undefined;
      if (marked) byTitle = (await findWorksByTitle(ctx, marked.base, 'releaseTitle')).map((m) => m.workId);
      // Or one with a season's name (`JoJo's Bizarre Adventure Steel Ball Run`): matchTitle decides whether the rest is the Work's alias.
      return byTitle.length > 0 ? byTitle : await bySeasonName(normalized);
    };

    const matches: z.infer<typeof RssMatch>[] = [];
    for (const [index, { item, parsed }] of items.entries()) {
      let byTitle = await byName(parsed.normalizedTitle);
      // A dual title (`中文名 / English Title`) that finds none: each side is looked up.
      if (byTitle.length === 0) for (const side of titleSides(parsed.title)) byTitle = [...byTitle, ...(await byName(normalizeTitle(side)))];
      const ids = [...new Set([...byTitle, ...(await worksByIds(ctx, item, parsed.episodes.length > 0 || parsed.pack ? 'series' : 'movie'))])];
      const candidates: { work: z.infer<typeof WorkForSearch>; doc: Doc<'works'>; alias: MatchedAlias }[] = [];
      for (const workId of ids) {
        const entry = await view(workId);
        if (!entry) continue;
        const title = matchTitle(parsed, item, asMatchWork(entry.view));
        if (title.ok) candidates.push({ work: entry.view, doc: entry.doc, alias: title.alias });
      }
      const kept = filterWorks(
        candidates.map((c) => asMatchWork(c.work)),
        item,
        parsed,
      );
      if (kept.length !== 1) continue;
      const chosen = candidates.find((c) => asMatchWork(c.work) === kept[0])!;
      const resolved = await resolveUnits(ctx, chosen.doc._id, parsed.episodes, parsed.airDate, chosen.alias);
      if (resolved.problem) continue;
      // RSS matches upgradeable Units like wanted ones.
      const profile = await ctx.db.get(chosen.doc.releaseProfileId);
      const wanted: Id<'units'>[] = [];
      for (const unitId of resolved.unitIds) {
        const unit = await ctx.db.get(unitId);
        if (unit && (isWanted(unit, now) || (profile && (await isUpgradeable(ctx, unit, profile, now))))) wanted.push(unitId);
      }
      if (wanted.length === 0) continue;
      const runtimes = [];
      for (const unitId of resolved.unitIds) {
        const meta = await ctx.db
          .query('unitMetadata')
          .withIndex('by_unit', (q) => q.eq('unitId', unitId))
          .unique();
        runtimes.push(meta?.runtimeMin === undefined ? { unitId } : { unitId, runtimeMin: meta.runtimeMin });
      }
      matches.push({ index, workId: chosen.doc._id, unitIds: wanted, resolved, runtimes, currents: await currentsFor(ctx, wanted) });
    }

    const works: z.infer<typeof RssWork>[] = [];
    for (const workId of new Set(matches.map((m) => m.workId))) {
      const { doc, view: work } = views.get(workId)!;
      const profile = (await ctx.db.get(doc.releaseProfileId))!;
      const metadata = await workMetadataOf(ctx, workId);
      works.push({
        work,
        profile: profileContent(profile),
        blocklistKeys: await keysForWork(ctx, workId),
        ...(metadata?.originalLanguage ? { originalLanguage: metadata.originalLanguage } : {}),
        target: await targetOf(ctx, doc.libraryId),
      });
    }
    return { matches, works, preferredLanguage: await preferredLanguageOf(ctx) };
  },
});

/**
 * Records a fetch: the new high-water mark and, per matched
 * Work, an `rss` SearchAttempt whose Units are the union of its matched
 * items' Units, its candidates, and the pick, all in one mutation.
 */
export const record = internalMutation({
  args: zodToConvexFields({
    indexerId: zid('indexers'),
    highWaterMark: z.string().optional(),
    perWork: z.array(z.object({ workId: zid('works'), unitIds: z.array(zid('units')), rows: z.array(CandidateInsert) })),
  }),
  returns: zodToConvex(z.array(zid('searchAttempts'))),
  handler: async (ctx, { indexerId, highWaterMark, perWork }) => {
    const indexer = await ctx.db.get(indexerId);
    if (indexer && highWaterMark !== undefined) await ctx.db.patch(indexerId, { rssHighWaterMark: highWaterMark });
    const attempts: Id<'searchAttempts'>[] = [];
    for (const { workId, unitIds, rows } of perWork) {
      const work = await ctx.db.get(workId);
      if (!work || rows.length === 0) continue;
      const searching = await unitsBeingSearchedToPick(ctx, workId);
      const attemptId = await ctx.db.insert('searchAttempts', {
        unitIds,
        wantedUnitIds: unitIds,
        workId,
        groupKind: work.kind === 'movie' ? 'movie' : work.numberingScheme === 'anime' ? 'animeEpisode' : 'episode',
        trigger: 'rss',
        state: 'running',
        indexerResults: [{ indexerId, status: 'ok', count: rows.length, pages: 1 }],
      });
      for (const unitId of unitIds) {
        if (!searching.has(unitId)) await ctx.db.patch(unitId, { lastSearchAttemptId: attemptId });
        await appendEvent(ctx, {
          unitId,
          stage: 'search',
          kind: 'stageStarted',
          message: 'Found on RSS.',
          data: { entity: 'searchAttempt', entityId: attemptId, to: 'running' },
        });
      }
      await insertCandidates(ctx, attemptId, indexerId, rows);
      await pickInMutation(ctx, attemptId);
      await recomputeUnits(ctx, unitIds);
      attempts.push(attemptId);
    }
    return attempts;
  },
});
