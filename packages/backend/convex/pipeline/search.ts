// Searching: search.start splits the Units
// into groups and starts one SearchAttempt per group; the search action reads
// its context, records candidates one page per mutation, and finishAttempt
// picks.
import {
  CandidateReason,
  CandidateTorrent,
  DownloadProtocol,
  FailureCode,
  IndexerCall,
  IndexerCallStatus,
  IndexerCaps,
  IndexerCategories,
  IndexerKind,
  IndexerSkip,
  NumberingScheme,
  IndexerUsageHour,
  ApiLimit,
  ParsedEpisode,
  ParsedRelease,
  QualityId,
  ReleaseProfileContent,
  ResolveProblem,
  ResolveResult,
  ScoreBreakdown,
  SearchGroupKind,
  SearchKeys,
  TargetFormat,
} from '@omnarr/contracts';
import { zid, zodToConvex, zodToConvexFields } from 'convex-helpers/server/zod4';
import { z } from 'zod';

import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from '../_generated/server';
import { recordCallsIn } from '../indexers/store';
import { recomputeUnits } from '../lib/derivedState';
import { appendEvent } from '../lib/events';
import { CONVEX_ACTION_LIMIT_MS } from '../lib/limits';
import { transition } from '../lib/stateMachine';
import { resolveUnits, searchKeys } from '../metadata/resolve';
import { workMetadataOf } from '../metadata/write';
import { targetOf } from '../playback/target';
import { keysForWork } from './blocklist';
import { groupUnits, type GroupUnit, type SearchGroup } from './groups';
import { pickInMutation } from './pick';
import { CurrentRelease, currentsFor, playablePrimary } from './upgrades';

/** `interactive`: "Search and pick", whose results are offered instead of picked. `upgrade`: a search for Units that play. */
export const SearchTrigger = z.enum(['subscribe', 'rss', 'backfill', 'manual', 'nextBest', 'interactive', 'upgrade']);
export type SearchTrigger = z.infer<typeof SearchTrigger>;

/** Work the user starts uses the 95 % share; background work the 80 % share. */
export const originOf = (trigger: SearchTrigger) => (trigger === 'subscribe' || trigger === 'manual' || trigger === 'interactive' ? 'user' : 'background');

/** A Unit a search may grab for: monitored, aired, nothing playable and no active Grab. */
export function isWanted(unit: Doc<'units'>, now: number): boolean {
  return (
    unit.monitored &&
    unit.airDateUtc !== undefined &&
    unit.airDateUtc <= now &&
    unit.activeGrabId === undefined &&
    unit.derivedState !== 'ready' &&
    unit.derivedState !== 'notInTargetFormat'
  );
}

/** An upgrade search's Units: monitored, playable, no active Grab. Whether each is upgradeable the evaluation decides. */
async function playableUnitIds(ctx: QueryCtx, units: Doc<'units'>[]): Promise<Set<Id<'units'>>> {
  const playable = new Set<Id<'units'>>();
  for (const unit of units) if (unit.monitored && unit.activeGrabId === undefined && (await playablePrimary(ctx, unit._id))) playable.add(unit._id);
  return playable;
}

const onlyOffers = (trigger: SearchTrigger) => trigger === 'interactive';

export async function unitsBeingSearchedToPick(ctx: QueryCtx, workId: Id<'works'>): Promise<Set<Id<'units'>>> {
  const running = await ctx.db
    .query('searchAttempts')
    .withIndex('by_state_work', (q) => q.eq('state', 'running').eq('workId', workId))
    .collect();
  return new Set(running.filter((attempt) => !onlyOffers(attempt.trigger)).flatMap((attempt) => attempt.unitIds));
}

type SearchPlan = { groups: SearchGroup[]; alreadySearching: Id<'units'>[] };
export type StartedSearch = { attemptIds: Id<'searchAttempts'>[]; alreadySearching: Id<'units'>[] };

export async function planSearch(
  ctx: QueryCtx,
  work: Doc<'works'>,
  units: Doc<'units'>[],
  trigger: SearchTrigger,
  options: { perUnit?: boolean; now: number },
): Promise<SearchPlan> {
  if (onlyOffers(trigger)) return { groups: units.map((unit) => episodeGroup(work, unit._id)), alreadySearching: [] };
  const all = await ctx.db
    .query('units')
    .withIndex('by_work', (q) => q.eq('workId', work._id))
    .collect();
  const searching = await unitsBeingSearchedToPick(ctx, work._id);
  const playable = trigger === 'upgrade' ? await playableUnitIds(ctx, all) : undefined;
  const eligible = (unit: Doc<'units'>) => !searching.has(unit._id) && (playable ? playable.has(unit._id) : isWanted(unit, options.now));
  const asGroupUnit = (unit: Doc<'units'>): GroupUnit => ({
    _id: unit._id,
    tmdbSeason: unit.tmdbSeason,
    tmdbEpisode: unit.tmdbEpisode,
    wanted: eligible(unit),
  });
  const groups = options.perUnit
    ? units.filter(eligible).map((unit) => episodeGroup(work, unit._id))
    : groupUnits(units.map(asGroupUnit), { kind: work.kind, numberingScheme: work.numberingScheme, units: all.map(asGroupUnit) });
  return { groups, alreadySearching: units.filter((unit) => searching.has(unit._id)).map((unit) => unit._id) };
}

const episodeGroup = (work: Doc<'works'>, unitId: Id<'units'>): SearchGroup => ({
  kind: work.numberingScheme === 'anime' ? 'animeEpisode' : 'episode',
  unitIds: [unitId],
});

/**
 * Groups the Units (per Work), inserts one `running` SearchAttempt per group,
 * stamps `lastSearchAt` and `lastSearchAttemptId` on its Units and schedules
 * the search action. `perUnit` forces one group per Unit (follow-ups).
 * An interactive search is one group per Unit too, wanted or not: the user
 * asked for it, and the grab decides whether it can run.
 */
export async function startSearch(
  ctx: MutationCtx,
  unitIds: Id<'units'>[],
  trigger: SearchTrigger,
  options: { perUnit?: boolean } = {},
): Promise<StartedSearch> {
  const now = Date.now();
  const byWork = new Map<Id<'works'>, Doc<'units'>[]>();
  for (const unitId of new Set(unitIds)) {
    const unit = await ctx.db.get(unitId);
    if (unit) byWork.set(unit.workId, [...(byWork.get(unit.workId) ?? []), unit]);
  }

  const started: StartedSearch = { attemptIds: [], alreadySearching: [] };
  for (const [workId, units] of byWork) {
    const work = await ctx.db.get(workId);
    if (!work) continue;
    const { groups, alreadySearching } = await planSearch(ctx, work, units, trigger, { ...options, now });
    started.alreadySearching.push(...alreadySearching);

    for (const group of groups) {
      const attemptId = await ctx.db.insert('searchAttempts', {
        unitIds: group.unitIds,
        wantedUnitIds: group.unitIds,
        workId,
        groupKind: work.kind === 'movie' ? 'movie' : group.kind,
        trigger,
        state: 'running',
        indexerResults: [],
      });
      for (const unitId of group.unitIds) {
        await ctx.db.patch(unitId, { lastSearchAt: now, lastSearchAttemptId: attemptId });
        await appendEvent(ctx, {
          unitId,
          stage: 'search',
          kind: 'stageStarted',
          message: `Searching (${trigger}).`,
          data: { entity: 'searchAttempt', entityId: attemptId, to: 'running' },
        });
      }
      await recomputeUnits(ctx, group.unitIds);
      const searchRunId = await ctx.scheduler.runAfter(0, internal.pipeline.searchAction.runSearch, { attemptId });
      await ctx.db.patch(attemptId, { searchRunId });
      started.attemptIds.push(attemptId);
    }
  }
  return started;
}

const LOST_RUN_MARGIN_MS = 10 * 60_000;
const longerThanAnyRun = (since: number, now: number) => now - since > CONVEX_ACTION_LIMIT_MS + LOST_RUN_MARGIN_MS;

const preUpdateSearchLost = (attempt: Doc<'searchAttempts'>, now: number) => longerThanAnyRun(attempt._creationTime, now);

async function searchStopped(ctx: QueryCtx, attempt: Doc<'searchAttempts'>, now: number): Promise<boolean> {
  if (attempt.searchRunId === undefined) return preUpdateSearchLost(attempt, now);
  const run = await ctx.db.system.get(attempt.searchRunId);
  if (run === null) return true;
  switch (run.state.kind) {
    case 'pending':
      return false;
    case 'inProgress':
      if (attempt.answerBy === undefined) return longerThanAnyRun(run.scheduledTime, now);
      return now > attempt.answerBy + LOST_RUN_MARGIN_MS;
    default:
      return true;
  }
}

export const endStoppedSearches = internalMutation({
  args: {},
  returns: zodToConvex(z.null()),
  handler: async (ctx) => {
    const now = Date.now();
    const running = await ctx.db
      .query('searchAttempts')
      .withIndex('by_state_work', (q) => q.eq('state', 'running'))
      .collect();
    for (const attempt of running)
      if (await searchStopped(ctx, attempt, now))
        await transition(ctx, 'searchAttempt', attempt._id, 'failed', { kind: 'stageFailed', message: 'The search stopped before it finished.' });
    return null;
  },
});

export const start = internalMutation({
  args: zodToConvexFields({ unitIds: z.array(zid('units')), trigger: SearchTrigger }),
  returns: zodToConvex(z.array(zid('searchAttempts'))),
  handler: async (ctx, { unitIds, trigger }) => (await startSearch(ctx, unitIds, trigger)).attemptIds,
});

/**
 * A fresh search after a bad release: `onRunComplete`
 * schedules it. "None left" is a pick that finds nothing acceptable
 * that isn't blocklisted. Background work, so it stays within the 80 % share.
 */
export const nextBest = internalMutation({
  args: zodToConvexFields({ unitIds: z.array(zid('units')) }),
  returns: zodToConvex(z.array(zid('searchAttempts'))),
  handler: async (ctx, { unitIds }) => (await startSearch(ctx, unitIds, 'nextBest')).attemptIds,
});

/** An indexer as a search sees it: everything but its key. */
export const IndexerForSearch = z.object({
  id: zid('indexers'),
  name: z.string(),
  kind: IndexerKind,
  enabled: z.boolean(),
  priority: z.number(),
  categories: IndexerCategories,
  caps: IndexerCaps,
  usage: z.array(IndexerUsageHour),
  apiLimit: ApiLimit.optional(),
  rateLimitedUntil: z.number().optional(),
});
export type IndexerForSearch = z.infer<typeof IndexerForSearch>;

/** The Work as matching sees it: aliases without an AniDB link first. */
export const WorkForSearch = z.object({
  id: zid('works'),
  kind: z.enum(['series', 'movie']),
  /** For the anime-only skip. */
  numberingScheme: NumberingScheme,
  year: z.number().optional(),
  aliases: z.array(z.object({ aliasId: zid('workAliases'), normalized: z.string(), anidbId: z.number().optional(), sceneSeason: z.number().optional() })),
  /** The named TMDB seasons with their scene seasons, for `<alias> <season name>`. */
  seasonNames: z.array(z.object({ normalized: z.string(), sceneSeason: z.number() })),
  ids: z.object({ tmdb: z.string(), tvdb: z.string().optional(), imdb: z.string().optional() }),
});

/** Everything a search reads before its first request. */
export const SearchContext = z.object({
  work: WorkForSearch,
  group: z.object({
    kind: SearchGroupKind,
    unitIds: z.array(zid('units')),
    wantedUnitIds: z.array(zid('units')),
    airDateUtc: z.number().optional(),
    year: z.number().optional(),
  }),
  origin: z.enum(['user', 'background']),
  keys: SearchKeys,
  profile: ReleaseProfileContent,
  blocklistKeys: z.object({ releaseKeys: z.array(z.string()), normalizedTitles: z.array(z.string()) }),
  preferredLanguage: z.string(),
  originalLanguage: z.string().optional(),
  /** The Work's library target, which ranking predicts preparation against. */
  target: TargetFormat,
  indexers: z.array(IndexerForSearch),
  /** The protocols whose client row exists with `enabled = false`: skipped like one the profile excludes. */
  disabledProtocols: z.array(DownloadProtocol),
  /** The current releases of the group's playable Units: a candidate covering one must be an upgrade. */
  currents: z.array(CurrentRelease),
});
export type SearchContext = z.infer<typeof SearchContext>;

const PROTOCOL_OF_CLIENT = { nzbget: 'usenet', qbittorrent: 'torrent' } as const;

/** A protocol is disabled only when its client row exists with `enabled = false`; a missing row disables nothing. */
export async function disabledProtocols(ctx: QueryCtx): Promise<DownloadProtocol[]> {
  const rows = await ctx.db.query('downloadClients').collect();
  return rows.filter((row) => !row.enabled).map((row) => PROTOCOL_OF_CLIENT[row.kind]);
}

/** The Work's matching view, shared by search and RSS. */
export async function workForSearch(ctx: QueryCtx, work: Doc<'works'>): Promise<z.infer<typeof WorkForSearch>> {
  const aliases = await ctx.db
    .query('workAliases')
    .withIndex('by_work', (q) => q.eq('workId', work._id))
    .collect();
  const ids = await ctx.db
    .query('externalIds')
    .withIndex('by_work', (q) => q.eq('workId', work._id))
    .collect();
  const id = (provider: 'tmdb' | 'tvdb' | 'imdb') => ids.find((row) => row.provider === provider)?.value;
  const linked = (a: Doc<'workAliases'>) => (a.anidbId === undefined ? 0 : 1);
  const metadata = await workMetadataOf(ctx, work._id);
  return {
    id: work._id,
    kind: work.kind,
    numberingScheme: work.numberingScheme,
    ...(work.year === undefined ? {} : { year: work.year }),
    aliases: aliases
      .sort((a, b) => linked(a) - linked(b))
      .map((a) => ({
        aliasId: a._id,
        normalized: a.normalized,
        ...(a.anidbId === undefined ? {} : { anidbId: a.anidbId }),
        ...(a.sceneSeason === undefined ? {} : { sceneSeason: a.sceneSeason }),
      })),
    seasonNames: (metadata?.seasonNames ?? []).map(({ normalized, sceneSeason }) => ({ normalized, sceneSeason })),
    ids: { tmdb: id('tmdb') ?? '', ...(id('tvdb') ? { tvdb: id('tvdb') } : {}), ...(id('imdb') ? { imdb: id('imdb') } : {}) },
  };
}

/** The language subtag of `metadataSettings.language` (`de-DE` → `de`), `en` until the first-run setup writes it. */
export async function preferredLanguageOf(ctx: QueryCtx): Promise<string> {
  const settings = await ctx.db.query('metadataSettings').first();
  return (settings?.language ?? 'en-US').split('-')[0]!.toLowerCase();
}

export async function indexersForSearch(ctx: QueryCtx): Promise<IndexerForSearch[]> {
  const rows = await ctx.db.query('indexers').collect();
  return rows.map((row) => ({
    id: row._id,
    name: row.name,
    kind: row.kind,
    enabled: row.enabled,
    priority: row.priority,
    categories: row.categories,
    caps: row.caps,
    usage: row.usage,
    ...(row.apiLimit ? { apiLimit: row.apiLimit } : {}),
    ...(row.rateLimitedUntil === undefined ? {} : { rateLimitedUntil: row.rateLimitedUntil }),
  }));
}

/** The release profile's editable content: what `evaluate` reads. */
export const profileContent = (profile: Doc<'releaseProfiles'>): ReleaseProfileContent => {
  const { _id, _creationTime, shippedKey: _k, shippedVersion: _v, pendingShippedVersion: _p, editedByUser: _e, ...content } = profile;
  return content;
};

export const recordAnswerBy = internalMutation({
  args: zodToConvexFields({ attemptId: zid('searchAttempts'), answerBy: z.number() }),
  returns: zodToConvex(z.null()),
  handler: async (ctx, { attemptId, answerBy }) => {
    const attempt = await ctx.db.get(attemptId);
    if (attempt?.state === 'running') await ctx.db.patch(attemptId, { answerBy });
    return null;
  },
});

/** The search's one context read; null once the attempt or its Work is gone. */
export const context = internalQuery({
  args: zodToConvexFields({ attemptId: zid('searchAttempts') }),
  returns: zodToConvex(SearchContext.nullable()),
  handler: async (ctx, { attemptId }): Promise<SearchContext | null> => {
    const attempt = await ctx.db.get(attemptId);
    const work = attempt && (await ctx.db.get(attempt.workId));
    const profile = work && (await ctx.db.get(work.releaseProfileId));
    if (!attempt || !work || !profile || attempt.state !== 'running') return null;
    const first = attempt.unitIds.length === 1 ? await ctx.db.get(attempt.unitIds[0]!) : null;
    const metadata = await workMetadataOf(ctx, work._id);
    return {
      work: await workForSearch(ctx, work),
      group: {
        kind: attempt.groupKind,
        unitIds: attempt.unitIds,
        wantedUnitIds: attempt.wantedUnitIds,
        ...(first?.airDateUtc === undefined ? {} : { airDateUtc: first.airDateUtc }),
        ...(work.year === undefined ? {} : { year: work.year }),
      },
      origin: originOf(attempt.trigger),
      keys: await searchKeys(ctx, work._id, attempt.unitIds),
      profile: profileContent(profile),
      blocklistKeys: await keysForWork(ctx, work._id),
      preferredLanguage: await preferredLanguageOf(ctx),
      ...(metadata?.originalLanguage ? { originalLanguage: metadata.originalLanguage } : {}),
      target: await targetOf(ctx, work.libraryId),
      indexers: await indexersForSearch(ctx),
      disabledProtocols: await disabledProtocols(ctx),
      currents: await currentsFor(ctx, attempt.unitIds),
    };
  },
});

export const ResolveItem = z.object({
  episodes: z.array(ParsedEpisode),
  airDate: z.string().optional(),
  anidbId: z.number().optional(),
  season: z.number().optional(),
  sceneSeason: z.number().optional(),
});

/**
 * resolveUnits for each title-matched item of a page, with the
 * runtime of every resolved Unit for the size check (absent when unknown).
 */
export const resolvePage = internalQuery({
  args: zodToConvexFields({ workId: zid('works'), items: z.array(ResolveItem) }),
  returns: zodToConvex(z.object({ results: z.array(ResolveResult), runtimes: z.array(z.object({ unitId: zid('units'), runtimeMin: z.number().optional() })) })),
  handler: async (ctx, { workId, items }) => {
    const results = [];
    for (const item of items)
      results.push(await resolveUnits(ctx, workId, item.episodes, item.airDate, { anidbId: item.anidbId, season: item.season, sceneSeason: item.sceneSeason }));
    const runtimes = [];
    for (const unitId of new Set(results.flatMap((result) => result.unitIds))) {
      const meta = await ctx.db
        .query('unitMetadata')
        .withIndex('by_unit', (q) => q.eq('unitId', unitId))
        .unique();
      runtimes.push(meta?.runtimeMin === undefined ? { unitId } : { unitId, runtimeMin: meta.runtimeMin });
    }
    return { results, runtimes };
  },
});

/** One evaluated result, as the action hands it over (the stored row without its attempt, indexer and outcome). */
export const CandidateInsert = z.object({
  guid: z.string(),
  title: z.string(),
  downloadUrl: z.string(),
  sizeBytes: z.number(),
  protocol: DownloadProtocol,
  publishedAt: z.number(),
  parsed: ParsedRelease,
  unitIds: z.array(zid('units')),
  alsoContainsUnitIds: z.array(zid('units')),
  quality: QualityId,
  qualityRank: z.number(),
  qualityAssumed: z.boolean(),
  baseScore: z.number(),
  score: z.number(),
  scoreBreakdown: ScoreBreakdown,
  preparationStep: z.enum(['none', 'remux', 'audio', 'subtitle', 'video']),
  preparationAssumed: z.boolean(),
  accepted: z.boolean(),
  reason: CandidateReason.optional(),
  matchDetail: z.string().optional(),
  /** A wrong episode's numbering problem, and for `ambiguous` the Units it could be. */
  matchProblem: ResolveProblem.optional(),
  possibleUnitIds: z.array(zid('units')).optional(),
  torrent: CandidateTorrent.optional(),
  isUpgrade: z.boolean().optional(),
});
export type CandidateInsert = z.infer<typeof CandidateInsert>;

export const PageResult = z.object({
  pages: z.number(),
  count: z.number(),
  status: IndexerCallStatus,
  truncated: z.boolean().optional(),
  skipped: IndexerSkip.optional(),
  failureCode: FailureCode.optional(),
});
export type PageResult = z.infer<typeof PageResult>;

/** Candidates are kept 30 days unless a Grab holds them. */
const CANDIDATE_TTL_MS = 30 * 86_400_000;

/** Inserts one indexer page's rows (pending or rejected), with their expiry. */
export async function insertCandidates(ctx: MutationCtx, attemptId: Id<'searchAttempts'>, indexerId: Id<'indexers'>, rows: CandidateInsert[]): Promise<void> {
  const expiresAt = Date.now() + CANDIDATE_TTL_MS;
  for (const { accepted, ...row } of rows) {
    await ctx.db.insert('candidates', { ...row, searchAttemptId: attemptId, indexerId, outcome: accepted ? 'pending' : 'rejected', expiresAt });
  }
}

/**
 * One results page: its candidates, the indexer's entry in
 * `indexerResults` (count and pages added up), and the page's calls in the
 * indexer's usage and health. Returns the 24-hour total for the share check.
 */
export const recordCandidatesPage = internalMutation({
  args: zodToConvexFields({
    attemptId: zid('searchAttempts'),
    indexerId: zid('indexers'),
    rows: z.array(CandidateInsert),
    calls: z.array(IndexerCall),
    result: PageResult,
  }),
  returns: zodToConvex(z.object({ total24h: z.number() })),
  handler: async (ctx, { attemptId, indexerId, rows, calls, result }) => {
    const recorded = await recordCallsIn(ctx, indexerId, calls);
    const attempt = await ctx.db.get(attemptId);
    if (!attempt || attempt.state !== 'running') return { total24h: recorded?.total24h ?? 0 };
    await insertCandidates(ctx, attemptId, indexerId, rows);
    const previous = attempt.indexerResults.find((entry) => entry.indexerId === indexerId);
    const entry = {
      indexerId,
      status: result.skipped ? ('error' as const) : result.status,
      count: (previous?.count ?? 0) + result.count,
      pages: (previous?.pages ?? 0) + result.pages,
      ...((result.truncated ?? previous?.truncated) ? { truncated: true } : {}),
      ...(result.skipped ? { skipped: result.skipped } : {}),
      ...(result.failureCode && !result.skipped ? { failureCode: result.failureCode } : {}),
    };
    const indexerResults = previous
      ? attempt.indexerResults.map((existing) => (existing.indexerId === indexerId ? entry : existing))
      : [...attempt.indexerResults, entry];
    await ctx.db.patch(attemptId, { indexerResults });
    return { total24h: recorded?.total24h ?? 0 };
  },
});

/**
 * After every indexer finished: an attempt in which every indexer was skipped
 * or failed ends `failed` (`recordSearchFailed`); otherwise the pick runs.
 */
export const finishAttempt = internalMutation({
  args: zodToConvexFields({ attemptId: zid('searchAttempts') }),
  returns: zodToConvex(z.null()),
  handler: async (ctx, { attemptId }) => {
    const attempt = await ctx.db.get(attemptId);
    if (attempt?.state !== 'running') return null;
    const served = attempt.indexerResults.some((result) => result.status === 'ok' && result.skipped === undefined);
    if (!served) {
      await transition(ctx, 'searchAttempt', attemptId, 'failed', { kind: 'stageFailed', message: 'No indexer could be searched.' });
      return null;
    }
    await pickInMutation(ctx, attemptId);
    return null;
  },
});
