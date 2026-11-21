// The request plan: which requests a search group sends to
// one indexer, as a step function. The action calls `nextRequest`, sends the
// request, sets `titleMatched` from matchTitle and calls it again with the
// page, until the request is null. Pure.
import { protocolOf } from '@omnarr/contracts';
import type {
  ApiLimit,
  NumberingScheme,
  DownloadProtocol,
  IndexerCaps,
  IndexerCategories,
  IndexerIds,
  IndexerKind,
  IndexerRequest,
  IndexerSkip,
  IndexerUsageHour,
  SearchGroupKind,
  SearchKeys,
  SearchMode,
} from '@omnarr/contracts';

import type { Id } from '../_generated/dataModel';
import { type Origin, shareLeft } from './rateLimit';

/** A group spends at most this many requests per indexer, pages and fallbacks included. */
export const BUDGET = 4;

/**
 * Deeper paging: past BUDGET, a series group keeps
 * paging while the last page was full and its oldest result is still newer
 * than the group's last air date plus DEEP_PAGING_MARGIN_MS, up to
 * DEEP_PAGING_CAP requests. The action checks the indexer's share before
 * every request, so the share still stops it.
 */
export const DEEP_PAGING_CAP = 10;
export const DEEP_PAGING_MARGIN_MS = 30 * 86_400_000;

export type PlanGroup = { kind: SearchGroupKind; unitIds: Id<'units'>[]; airDateUtc?: number; year?: number };

type Step = Omit<IndexerRequest, 'limit' | 'offset'>;

/** A title-only indexer is searched with at most this many of SearchKeys' `searchTitles`. */
export const TITLE_CAP = 3;

export type PlanState = {
  group: PlanGroup;
  /**
   * The first requests, then the fallbacks; each runs only while no title
   * matched. A `title` step, one per search title on a title-only indexer,
   * runs while no page had an accepted release, matched titles or not.
   */
  steps: { phase: 'first' | 'title' | 'fallback'; request: Step }[];
  limit: number;
  spent: number;
  current: { step: number; offset: number };
  titleMatched: boolean;
  /** A page had an accepted release: no further step runs. The action sets it, as it sets `titleMatched`. */
  accepted: boolean;
  truncated: boolean;
  /** Paging past BUDGET goes on while the oldest result is newer than this: the last air date plus the margin. Unset: no deeper paging. */
  deepUntil?: number;
  /** The oldest `publishedAt` of every page so far. */
  oldestSeen?: number;
};

const ID_ORDER = ['tvdbid', 'tmdbid', 'imdbid'] as const;

/** The IDs a request in this mode carries. IMDb without its `tt` prefix. */
function idsFor(mode: IndexerCaps['searchModes'][number] | undefined, keys: SearchKeys): IndexerIds {
  if (!mode) return {};
  const values: IndexerIds = { tvdbid: keys.tvdbId, tmdbid: keys.tmdbId, imdbid: keys.imdbId?.replace(/^tt/i, '') };
  const supported = ID_ORDER.filter((id) => mode.supportedParams.includes(id) && values[id] !== undefined);
  // Defaults: only the first supported ID. Explicit params: every listed ID at once (IDs combine with OR).
  const chosen = mode.defaulted ? supported.slice(0, 1) : supported;
  return Object.fromEntries(chosen.map((id) => [id, values[id]!]));
}

const pad = (n: number) => String(n).padStart(2, '0');

function dateOf(ms: number): string {
  const d = new Date(ms);
  return `${d.getUTCFullYear()}.${pad(d.getUTCMonth() + 1)}.${pad(d.getUTCDate())}`;
}

/** 5070 and its children; the series categories when the indexer lists no anime category. */
function animeCategories(caps: IndexerCaps, series: number[]): number[] {
  const anime = caps.categories.filter((c) => c.id === 5070 || c.parentId === 5070).map((c) => c.id);
  return anime.length > 0 ? anime : series;
}

const distinct = (titles: string[]) => {
  const seen = new Set<string>();
  return titles.filter((title) => {
    const key = title.toLowerCase();
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
};

/** The request steps for one group on one indexer. A first request with no ID is left out. */
function stepsFor(group: PlanGroup, indexer: { caps: IndexerCaps; categories: IndexerCategories }, keys: SearchKeys): PlanState['steps'] {
  const modes = new Map<SearchMode, IndexerCaps['searchModes'][number]>(indexer.caps.searchModes.map((m) => [m.mode, m]));
  const usable = (mode: SearchMode) => (modes.get(mode)?.available ? modes.get(mode) : undefined);
  const tv = usable('tv-search');
  const tvSeason = tv && tv.supportedParams.includes('season') ? tv : undefined;
  const series = indexer.categories.series;
  const title = keys.titles[0];
  const unit = keys.units[0];
  const steps: PlanState['steps'] = [];
  const first = (request: Step) => steps.push({ phase: 'first', request });
  const fallback = (request: Step) => steps.push({ phase: 'fallback', request });
  const withIds = (request: Step, ids: IndexerIds) => (Object.keys(ids).length > 0 ? { ...request, ids } : undefined);

  if (group.kind === 'movie') {
    const movie = usable('movie-search');
    const byId = movie && withIds({ fn: 'movie', categories: indexer.categories.movies }, idsFor(movie, keys));
    if (byId) first(byId);
    if (title) fallback({ fn: 'search', q: group.year === undefined ? title : `${title} ${group.year}`, categories: indexer.categories.movies });
    return steps;
  }
  if (!unit) return steps;
  const season = String(unit.season);
  const ep = String(unit.episode);
  // An anime query's number. Without an absolute number, the in-season episode: fansub groups number per season ("S2 - 04").
  const number = pad(unit.absolute ?? unit.episode);

  // A title-only indexer (only `q`, as Nyaa): one request per search title, so the
  // fansub groups' romaji is searched too.
  if (!tv) {
    const anime = () => animeCategories(indexer.caps, series);
    const each = (query: (name: string) => string, categories: number[]) => {
      for (const name of keys.searchTitles.slice(0, TITLE_CAP)) steps.push({ phase: 'title', request: { fn: 'search', q: query(name), categories } });
    };
    switch (group.kind) {
      case 'episode':
        each((name) => `${name} S${pad(unit.season)}E${pad(unit.episode)}`, series);
        if (title && group.airDateUtc !== undefined) fallback({ fn: 'search', q: `${title} ${dateOf(group.airDateUtc)}`, categories: series });
        return steps;
      case 'season':
        each((name) => `${name} S${pad(unit.season)}`, series);
        return steps;
      case 'animeEpisode':
        each((name) => `${name} ${number}`, anime());
        return steps;
      case 'animeSeason':
        each((name) => name, anime());
        return steps;
    }
  }

  switch (group.kind) {
    case 'episode': {
      const byId = tvSeason && withIds({ fn: 'tvsearch', season, ep, categories: series }, idsFor(tvSeason, keys));
      if (byId) first(byId);
      if (title) {
        if (tvSeason) fallback({ fn: 'tvsearch', q: title, season, ep, categories: series });
        else fallback({ fn: 'search', q: `${title} S${pad(unit.season)}E${pad(unit.episode)}`, categories: series });
        if (group.airDateUtc !== undefined) fallback({ fn: 'search', q: `${title} ${dateOf(group.airDateUtc)}`, categories: series });
      }
      return steps;
    }
    case 'season': {
      const byId = tvSeason && withIds({ fn: 'tvsearch', season, categories: series }, idsFor(tvSeason, keys));
      if (byId) first(byId);
      if (title)
        fallback(
          tvSeason ? { fn: 'tvsearch', q: title, season, categories: series } : { fn: 'search', q: `${title} S${pad(unit.season)}`, categories: series },
        );
      return steps;
    }
    case 'animeEpisode': {
      const anime = animeCategories(indexer.caps, series);
      const titled = distinct(keys.titles)
        .slice(0, 3)
        .map((name): Step => ({ fn: 'search', q: `${name} ${number}`, categories: anime }));
      const byId = tvSeason && withIds({ fn: 'tvsearch', season, ep, categories: series }, idsFor(tvSeason, keys));
      if (unit.absolute !== undefined) {
        titled.forEach(first);
        if (byId) fallback(byId);
      } else {
        // An in-season query also finds other seasons' episode, whose titles match and end the
        // plan: the ID request, which names the season, goes first.
        if (byId) first(byId);
        titled.forEach(fallback);
      }
      return steps;
    }
    case 'animeSeason': {
      const byId = tvSeason && withIds({ fn: 'tvsearch', season, categories: series }, idsFor(tvSeason, keys));
      if (byId) first(byId);
      if (title) fallback({ fn: 'search', q: title, categories: animeCategories(indexer.caps, series) });
      return steps;
    }
  }
}

export function initialState(group: PlanGroup, indexer: { caps: IndexerCaps; categories: IndexerCategories }, keys: SearchKeys): PlanState {
  const limit = indexer.caps.pageLimit.max ?? indexer.caps.pageLimit.default ?? 100;
  const deep = group.kind !== 'movie' && keys.lastAirDateUtc !== undefined;
  return {
    group,
    steps: stepsFor(group, indexer, keys),
    limit,
    spent: 0,
    current: { step: 0, offset: 0 },
    titleMatched: false,
    accepted: false,
    truncated: false,
    ...(deep ? { deepUntil: keys.lastAirDateUtc! + DEEP_PAGING_MARGIN_MS } : {}),
  };
}

/** Whether the group's first request covers its season: false when the indexer's tv-search can't search by season. */
export function supportsSeason(caps: IndexerCaps): boolean {
  const tv = caps.searchModes.find((m) => m.mode === 'tv-search');
  return tv !== undefined && tv.available && tv.supportedParams.includes('season');
}

export type PlanStep = { request: IndexerRequest | null; state: PlanState };

/**
 * The next request after `lastPage`, or `request: null` when the plan is
 * done. A request pages on while the last page was full and budget is left,
 * or, past the budget, while deeper paging allows it; a full last page that
 * ends the paging marks the plan `truncated`.
 */
export function nextRequest(previous: PlanState, lastPage?: { items: readonly { publishedAt: number }[] }): PlanStep {
  const oldest = Math.min(previous.oldestSeen ?? Infinity, ...(lastPage?.items.map((item) => item.publishedAt) ?? []));
  const state = oldest === Infinity ? previous : { ...previous, oldestSeen: oldest };
  const send = (step: number, offset: number): PlanStep => {
    const next = { ...state, spent: state.spent + 1, current: { step, offset } };
    return { request: { ...state.steps[step]!.request, limit: state.limit, offset }, state: next };
  };
  const done = (truncated = false): PlanStep => ({ request: null, state: { ...state, truncated: state.truncated || truncated } });

  if (!lastPage) return state.steps.length > 0 ? send(0, 0) : done();
  const full = lastPage.items.length > 0 && lastPage.items.length >= state.limit;
  const deeper = state.deepUntil !== undefined && state.spent < DEEP_PAGING_CAP && oldest > state.deepUntil;
  if (full) return state.spent < BUDGET || deeper ? send(state.current.step, state.current.offset + state.limit) : done(true);
  if (state.accepted) return done();
  const following = state.current.step + 1;
  if (following >= state.steps.length || state.spent >= BUDGET) return done();
  if (state.titleMatched && state.steps[following]!.phase !== 'title') return done();
  return send(following, 0);
}

/** The indexer fields a skip reads. `caps.categories` tells which ids are children of 5070. */
export type SkipIndexer = {
  enabled: boolean;
  kind: IndexerKind;
  categories: IndexerCategories;
  caps?: Pick<IndexerCaps, 'categories'>;
  rateLimitedUntil?: number;
  apiLimit?: ApiLimit;
  usage: readonly IndexerUsageHour[];
};

/** Series categories that are all anime: 5070 or its children. RSS applies it per matched Work. */
export function animeOnly(indexer: Pick<SkipIndexer, 'categories' | 'caps'>): boolean {
  const series = indexer.categories.series;
  const child = (id: number) => indexer.caps?.categories.some((c) => c.id === id && c.parentId === 5070) ?? false;
  return series.length > 0 && series.every((id) => id === 5070 || child(id));
}

/** Why an indexer sits out this search, if it does. */
export function skipReason(
  indexer: SkipIndexer,
  ctx: { now: number; origin: Origin; protocols: readonly DownloadProtocol[]; workKind: 'series' | 'movie'; numberingScheme?: NumberingScheme },
): IndexerSkip | undefined {
  if (!indexer.enabled) return 'disabled';
  if (indexer.rateLimitedUntil !== undefined && indexer.rateLimitedUntil > ctx.now) return 'rateLimited';
  if (shareLeft(indexer, ctx.now, ctx.origin) < 1) return 'share';
  if (!ctx.protocols.includes(protocolOf(indexer.kind))) return 'protocol';
  if (indexer.categories[ctx.workKind === 'series' ? 'series' : 'movies'].length === 0) return 'noCategories';
  // An anime-only indexer has nothing for a series without anime numbering; movies have no anime flag (Risks).
  if (ctx.workKind === 'series' && ctx.numberingScheme !== 'anime' && animeOnly(indexer)) return 'animeOnly';
  return undefined;
}
