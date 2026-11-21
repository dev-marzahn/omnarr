// The request plan, driven with scripted pages: every kind of first request,
// the ID rule, paging, the fallback trigger, the budget and the skips.
import type { IndexerCaps, IndexerRequest, SearchKeys } from '@omnarr/contracts';
import { describe, expect, test } from 'vite-plus/test';

import type { Id } from '../convex/_generated/dataModel';
import { initialState, nextRequest, type PlanGroup, type PlanState, skipReason } from '../convex/indexers/requestPlan';

const unit = 'u1' as Id<'units'>;

const caps = (
  overrides: {
    tv?: Partial<IndexerCaps['searchModes'][number]>;
    movie?: Partial<IndexerCaps['searchModes'][number]>;
    pageLimit?: IndexerCaps['pageLimit'];
  } = {},
): IndexerCaps => ({
  searchModes: [
    { mode: 'search', available: true, supportedParams: ['q'] },
    { mode: 'tv-search', available: true, supportedParams: ['q', 'tvdbid', 'imdbid', 'season', 'ep'], ...overrides.tv },
    { mode: 'movie-search', available: true, supportedParams: ['q', 'imdbid', 'tmdbid'], ...overrides.movie },
  ],
  pageLimit: overrides.pageLimit ?? { max: 2 },
  categories: [
    { id: 5000, name: 'TV' },
    { id: 5070, name: 'Anime', parentId: 5000 },
    { id: 100070, name: 'Anime HEVC', parentId: 5070 },
  ],
  fetchedAt: 0,
});

const keys: SearchKeys = {
  tmdbId: '900001',
  tvdbId: '7700001',
  imdbId: 'tt9900001',
  titles: ['Harbour Lights', 'Harbor Lights', 'Les Lumières du Port', 'Hafenlichter'],
  // searchKeys ranks them by source, scene names first: another order than `titles`.
  searchTitles: ['Harbour Lights', 'Hafenlichter', 'Harbor Lights', 'Les Lumières du Port'],
  units: [{ unitId: unit, season: 2, episode: 3, absolute: 9 }],
};

const indexer = (c = caps()) => ({ caps: c, categories: { series: [5000], movies: [2000] } });

const group = (kind: PlanGroup['kind'], extra: Partial<PlanGroup> = {}): PlanGroup => ({ kind, unitIds: [unit], ...extra });

/**
 * Runs the plan to the end, as the search action does. `pages(request)` says
 * how many items each page has; `matches(request)` whether any item's title
 * matched the Work; `accepts(request)` whether one was accepted. Returns the
 * requests sent and the final state.
 */
function drive(
  state: PlanState,
  pages: (r: IndexerRequest) => number,
  matches: (r: IndexerRequest) => boolean = () => false,
  accepts: (r: IndexerRequest) => boolean = () => false,
) {
  const sent: IndexerRequest[] = [];
  let step = nextRequest(state);
  while (step.request) {
    const request = step.request;
    sent.push(request);
    const items = pages(request);
    step = nextRequest(
      {
        ...step.state,
        titleMatched: step.state.titleMatched || (items > 0 && matches(request)),
        accepted: step.state.accepted || (items > 0 && accepts(request)),
      },
      { items: Array.from({ length: items }, () => ({ publishedAt: 0 })) },
    );
  }
  return { sent, state: step.state };
}

const run = (...args: Parameters<typeof drive>) => drive(...args).sent;

const strip = (r: IndexerRequest) => {
  const { categories: _c, limit: _l, offset: _o, ...rest } = r;
  return rest;
};

describe('first requests', () => {
  test('episode: t=tvsearch with every listed ID, season and ep from the scene numbers', () => {
    const [first] = run(
      initialState(group('episode'), indexer(), keys),
      () => 0,
      () => true,
    );
    expect(first).toEqual({ fn: 'tvsearch', ids: { tvdbid: '7700001', imdbid: '9900001' }, season: '2', ep: '3', categories: [5000], limit: 2, offset: 0 });
  });

  test('season: as episode, season only', () => {
    const [first] = run(
      initialState(group('season'), indexer(), keys),
      () => 0,
      () => true,
    );
    expect(strip(first!)).toEqual({ fn: 'tvsearch', ids: { tvdbid: '7700001', imdbid: '9900001' }, season: '2' });
  });

  test('animeEpisode: t=search with each of the first 3 distinct titles and the zero-padded absolute number, in the anime categories, stopping at the first title that matches', () => {
    const sent = run(
      initialState(group('animeEpisode'), indexer(), { ...keys, units: [{ unitId: unit, season: 1, episode: 5, absolute: 5 }] }),
      () => 1,
      (r) => r.q === 'Harbor Lights 05',
    );
    expect(sent.map((r) => [r.fn, r.q, r.categories])).toEqual([
      ['search', 'Harbour Lights 05', [5070, 100070]],
      ['search', 'Harbor Lights 05', [5070, 100070]],
    ]);
  });

  test('animeSeason: t=tvsearch with ID and season', () => {
    const [first] = run(
      initialState(group('animeSeason'), indexer(), keys),
      () => 0,
      () => true,
    );
    expect(strip(first!)).toEqual({ fn: 'tvsearch', ids: { tvdbid: '7700001', imdbid: '9900001' }, season: '2' });
  });

  test('movie: t=movie with imdbid without its tt prefix, and tmdbid because the caps list it', () => {
    const [first] = run(
      initialState(group('movie', { year: 2020 }), indexer(), { ...keys, units: [] }),
      () => 0,
      () => true,
    );
    expect(first).toEqual({ fn: 'movie', ids: { imdbid: '9900001', tmdbid: '900001' }, categories: [2000], limit: 2, offset: 0 });
  });
});

describe('fallbacks: only when the first request, with all its pages, found no item whose title matches', () => {
  test('episode: t=tvsearch with the title, season and ep, then the air date', () => {
    const sent = run(initialState(group('episode', { airDateUtc: Date.UTC(2023, 2, 16) }), indexer(), keys), () => 1);
    expect(sent.map(strip)).toEqual([
      { fn: 'tvsearch', ids: { tvdbid: '7700001', imdbid: '9900001' }, season: '2', ep: '3' },
      { fn: 'tvsearch', q: 'Harbour Lights', season: '2', ep: '3' },
      { fn: 'search', q: 'Harbour Lights 2023.03.16' },
    ]);
  });

  test('episode without tv-search: t=search with SxxEyy, for each of the first 3 search titles', () => {
    const sent = run(initialState(group('episode'), indexer(caps({ tv: { available: false } })), keys), () => 0);
    expect(sent.map(strip)).toEqual([
      { fn: 'search', q: 'Harbour Lights S02E03' },
      { fn: 'search', q: 'Hafenlichter S02E03' },
      { fn: 'search', q: 'Harbor Lights S02E03' },
    ]);
  });

  test('season: t=tvsearch with the title and season', () => {
    expect(run(initialState(group('season'), indexer(), keys), () => 0).map(strip)).toEqual([
      { fn: 'tvsearch', ids: { tvdbid: '7700001', imdbid: '9900001' }, season: '2' },
      { fn: 'tvsearch', q: 'Harbour Lights', season: '2' },
    ]);
  });

  test('animeEpisode: t=tvsearch with ID, season and ep after the titles', () => {
    const sent = run(initialState(group('animeEpisode'), indexer(), keys), () => 0);
    expect(sent.map(strip)).toEqual([
      { fn: 'search', q: 'Harbour Lights 09' },
      { fn: 'search', q: 'Harbor Lights 09' },
      { fn: 'search', q: 'Les Lumières du Port 09' },
      { fn: 'tvsearch', ids: { tvdbid: '7700001', imdbid: '9900001' }, season: '2', ep: '3' },
    ]);
  });

  describe('animeEpisode without an absolute number', () => {
    const perSeason = { ...keys, units: [{ unitId: unit, season: 2, episode: 4 }] };

    test('the ID request first, then the first 3 distinct titles with the in-season episode', () => {
      const sent = run(initialState(group('animeEpisode'), indexer(), perSeason), () => 0);
      expect(sent.map((r) => [r.fn, r.q, r.categories])).toEqual([
        ['tvsearch', undefined, [5000]],
        ['search', 'Harbour Lights 04', [5070, 100070]],
        ['search', 'Harbor Lights 04', [5070, 100070]],
        ['search', 'Les Lumières du Port 04', [5070, 100070]],
      ]);
      expect(sent[0]).toMatchObject({ ids: { tvdbid: '7700001', imdbid: '9900001' }, season: '2', ep: '4' });
    });

    test("an in-season query's page that matches the title (another season's episode 4) can't keep the ID request from being sent", () => {
      const sent = run(
        initialState(group('animeEpisode'), indexer(), perSeason),
        (r) => (r.fn === 'search' ? 1 : 0),
        (r) => r.fn === 'search',
      );
      expect(sent.map(strip)).toEqual([
        { fn: 'tvsearch', ids: { tvdbid: '7700001', imdbid: '9900001' }, season: '2', ep: '4' },
        { fn: 'search', q: 'Harbour Lights 04' },
      ]);
    });

    test('without IDs: the 3 title requests and no tvsearch', () => {
      // The caps' tv-search takes tvdbid and imdbid, not tmdbid.
      const { tvdbId: _tvdb, imdbId: _imdb, ...noIds } = perSeason;
      expect(run(initialState(group('animeEpisode'), indexer(), noIds), () => 0).map(strip)).toEqual([
        { fn: 'search', q: 'Harbour Lights 04' },
        { fn: 'search', q: 'Harbor Lights 04' },
        { fn: 'search', q: 'Les Lumières du Port 04' },
      ]);
    });
  });

  test('animeSeason: t=search with the title in the anime categories', () => {
    const sent = run(initialState(group('animeSeason'), indexer(), keys), () => 0);
    expect(sent.at(-1)).toEqual({ fn: 'search', q: 'Harbour Lights', categories: [5070, 100070], limit: 2, offset: 0 });
  });

  test('movie: t=search with the title and year', () => {
    const sent = run(initialState(group('movie', { year: 2020 }), indexer(), { ...keys, titles: ['The Quiet Orchard'], units: [] }), () => 0);
    expect(sent.at(-1)).toEqual({ fn: 'search', q: 'The Quiet Orchard 2020', categories: [2000], limit: 2, offset: 0 });
  });

  test('no fallback once a title matched', () => {
    expect(
      run(
        initialState(group('episode'), indexer(), keys),
        () => 1,
        () => true,
      ),
    ).toHaveLength(1);
  });
});

describe('a title-only indexer: one request per search title (the title-only search fix)', () => {
  const titleOnly = indexer(caps({ tv: { available: false }, movie: { available: false } }));
  const anime = { ...keys, units: [{ unitId: unit, season: 2, episode: 4, absolute: 4 }] };

  test("animeEpisode: every search title up to the cap, though the first one's results matched the title", () => {
    const sent = run(
      initialState(group('animeEpisode'), titleOnly, anime),
      () => 1,
      () => true,
    );
    expect(sent.map((r) => [r.fn, r.q, r.categories])).toEqual([
      ['search', 'Harbour Lights 04', [5070, 100070]],
      ['search', 'Hafenlichter 04', [5070, 100070]],
      ['search', 'Harbor Lights 04', [5070, 100070]],
    ]);
  });

  test('a page with an accepted release ends the plan', () => {
    const sent = run(
      initialState(group('animeEpisode'), titleOnly, anime),
      () => 1,
      () => true,
      (r) => r.q === 'Hafenlichter 04',
    );
    expect(sent.map((r) => r.q)).toEqual(['Harbour Lights 04', 'Hafenlichter 04']);
  });

  test('never more than the cap, and fewer when the Work has fewer titles', () => {
    expect(run(initialState(group('animeEpisode'), titleOnly, anime), () => 0)).toHaveLength(3);
    expect(run(initialState(group('animeEpisode'), titleOnly, { ...anime, searchTitles: ['Harbour Lights'] }), () => 0).map((r) => r.q)).toEqual([
      'Harbour Lights 04',
    ]);
  });

  test('animeEpisode without an absolute number: each search title with the in-season episode, as fansub groups number per season', () => {
    const perSeason = { ...keys, units: [{ unitId: unit, season: 2, episode: 4 }] };
    expect(run(initialState(group('animeEpisode'), titleOnly, perSeason), () => 0).map((r) => [r.fn, r.q, r.categories])).toEqual([
      ['search', 'Harbour Lights 04', [5070, 100070]],
      ['search', 'Hafenlichter 04', [5070, 100070]],
      ['search', 'Harbor Lights 04', [5070, 100070]],
    ]);
  });

  test('season, animeSeason: each search title; episode: the air-date fallback only when no title matched', () => {
    expect(run(initialState(group('season'), titleOnly, keys), () => 0).map((r) => r.q)).toEqual([
      'Harbour Lights S02',
      'Hafenlichter S02',
      'Harbor Lights S02',
    ]);
    expect(run(initialState(group('animeSeason'), titleOnly, keys), () => 0).map((r) => r.q)).toEqual(['Harbour Lights', 'Hafenlichter', 'Harbor Lights']);
    const dated = initialState(group('episode', { airDateUtc: Date.UTC(2023, 2, 16) }), titleOnly, keys);
    expect(run(dated, () => 0).map((r) => r.q)).toEqual(['Harbour Lights S02E03', 'Hafenlichter S02E03', 'Harbor Lights S02E03', 'Harbour Lights 2023.03.16']);
    expect(
      run(
        dated,
        () => 1,
        () => true,
      ).map((r) => r.q),
    ).toEqual(['Harbour Lights S02E03', 'Hafenlichter S02E03', 'Harbor Lights S02E03']);
  });

  test('an indexer with tv-search is unaffected: the anime titles come from `titles` and stop at the first that matched', () => {
    const sent = run(
      initialState(group('animeEpisode'), indexer(), anime),
      () => 1,
      () => true,
    );
    expect(sent.map(strip)).toEqual([{ fn: 'search', q: 'Harbour Lights 04' }]);
    expect(run(initialState(group('animeEpisode'), indexer(), anime), () => 0).map(strip)).toEqual([
      { fn: 'search', q: 'Harbour Lights 04' },
      { fn: 'search', q: 'Harbor Lights 04' },
      { fn: 'search', q: 'Les Lumières du Port 04' },
      { fn: 'tvsearch', ids: { tvdbid: '7700001', imdbid: '9900001' }, season: '2', ep: '4' },
    ]);
  });
});

describe('the ID rule', () => {
  test('without explicit supportedParams only the first ID the defaults support is sent; tv-search defaults support none, so the title fallback runs first', () => {
    const defaulted = caps({
      tv: { supportedParams: ['q', 'rid', 'season', 'ep'], defaulted: true },
      movie: { supportedParams: ['q', 'imdbid'], defaulted: true },
    });
    expect(run(initialState(group('episode'), indexer(defaulted), keys), () => 0).map(strip)[0]).toEqual({
      fn: 'tvsearch',
      q: 'Harbour Lights',
      season: '2',
      ep: '3',
    });
    expect(
      run(
        initialState(group('movie', { year: 2020 }), indexer(defaulted), { ...keys, units: [] }),
        () => 0,
        () => true,
      ).map(strip)[0],
    ).toEqual({
      fn: 'movie',
      ids: { imdbid: '9900001' },
    });
  });

  test('tmdbid only when the caps list it', () => {
    const [first] = run(
      initialState(group('movie'), indexer(caps({ movie: { supportedParams: ['q', 'imdbid'] } })), { ...keys, units: [] }),
      () => 0,
      () => true,
    );
    expect(first!.ids).toEqual({ imdbid: '9900001' });
  });
});

describe('paging and the budget', () => {
  test('pages on while the last page was full, offset += limit', () => {
    const pages = [2, 2, 1];
    const sent = run(
      initialState(group('season'), indexer(), keys),
      () => pages.shift() ?? 0,
      () => true,
    );
    expect(sent.map((r) => r.offset)).toEqual([0, 2, 4]);
  });

  test('the page limit is caps max, else default, else 100', () => {
    expect(
      run(
        initialState(group('season'), indexer(caps({ pageLimit: { default: 50 } })), keys),
        () => 0,
        () => true,
      )[0]!.limit,
    ).toBe(50);
    expect(
      run(
        initialState(group('season'), indexer(caps({ pageLimit: {} })), keys),
        () => 0,
        () => true,
      )[0]!.limit,
    ).toBe(100);
  });

  test('at most 4 requests per indexer, pages and fallbacks included; a full last page marks the result truncated', () => {
    const { sent, state } = drive(
      initialState(group('season'), indexer(), keys),
      () => 2,
      () => true,
    );
    expect(sent).toHaveLength(4);
    expect(state).toMatchObject({ spent: 4, truncated: true });
  });

  test('fallbacks count toward the budget; a budget spent on a page that was not full is not truncated', () => {
    const { sent, state } = drive(initialState(group('animeEpisode', { airDateUtc: 0 }), indexer(), keys), () => 1);
    expect(sent).toHaveLength(4);
    expect(state).toMatchObject({ spent: 4, truncated: false });
  });
});

describe('skips', () => {
  const now = Date.UTC(2026, 10, 17);
  const base = {
    enabled: true,
    kind: 'newznab' as const,
    categories: { series: [5000], movies: [2000] },
    usage: [],
    rateLimitedUntil: undefined as number | undefined,
    apiLimit: undefined as { max: number; source: 'user' } | undefined,
  };
  const ctx = { now, origin: 'background' as const, protocols: ['usenet' as const, 'torrent' as const], workKind: 'series' as const };

  test.each([
    ['disabled', { enabled: false }, ctx],
    ['rateLimited', { rateLimitedUntil: now + 1 }, ctx],
    ['share', { apiLimit: { max: 100, source: 'user' as const }, usage: [{ hourStart: now - 3_600_000, requests: 80, errors: 0 }] }, ctx],
    ['protocol', {}, { ...ctx, protocols: ['torrent' as const] }],
    ['noCategories', { categories: { series: [], movies: [2000] } }, ctx],
  ])('%s', (reason, overrides, context) => {
    expect(skipReason({ ...base, ...overrides }, context)).toBe(reason);
  });

  test('an indexer whose limit has passed is not skipped', () => {
    expect(skipReason({ ...base, rateLimitedUntil: now - 1 }, ctx)).toBeUndefined();
  });

  describe('site indexers', () => {
    const nyaa = { ...base, kind: 'nyaa' as const, categories: { series: [5070], movies: [2000] } };

    test('Nyaa is a torrent indexer: skipped when only usenet is wanted', () => {
      expect(skipReason(nyaa, { ...ctx, protocols: ['usenet'], numberingScheme: 'anime' })).toBe('protocol');
      expect(skipReason(nyaa, { ...ctx, protocols: ['torrent'], numberingScheme: 'anime' })).toBeUndefined();
    });

    test('an anime-only indexer is skipped for a standard series, not for an anime series or a movie (Q11)', () => {
      expect(skipReason(nyaa, { ...ctx, numberingScheme: 'standard' })).toBe('animeOnly');
      expect(skipReason(nyaa, { ...ctx, numberingScheme: 'anime' })).toBeUndefined();
      expect(skipReason(nyaa, { ...ctx, workKind: 'movie', numberingScheme: 'standard' })).toBeUndefined();
    });

    test("a Torznab indexer with anime categories only gets the same rule; one that also lists TV doesn't", () => {
      const torznab = {
        ...base,
        kind: 'torznab' as const,
        caps: {
          categories: [
            { id: 5070, name: 'Anime' },
            { id: 105070, name: 'Anime/Subbed', parentId: 5070 },
          ],
        },
      };
      expect(skipReason({ ...torznab, categories: { series: [5070, 105070], movies: [] } }, { ...ctx, numberingScheme: 'standard' })).toBe('animeOnly');
      expect(skipReason({ ...torznab, categories: { series: [5000, 5070], movies: [] } }, { ...ctx, numberingScheme: 'standard' })).toBeUndefined();
    });
  });
});
