// RSS over the Newznab fake: an anime episode arriving, only matched items
// stored, the high-water mark, the first fetch, two Works sharing a title,
// and the dispatch cron.
import { createNewznabHandler, type FakeItem } from '@omnarr/e2e/fakes/newznab';
import { createNyaaHandler, type NyaaItem, type NyaaRequest } from '@omnarr/e2e/fakes/nyaa';
import { jojoParts, SERIES } from '@omnarr/e2e/fakes/tmdb/fixtures';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';

import { api, internal } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import { NYAA_CAPS } from '../convex/indexers/nyaa';
import jojoPartsNames from './fixtures/xem/jojoPartsNames.json';
import jojoPartsShape from './fixtures/xem/jojoPartsShape.json';
import {
  asAdmin,
  INDEXER_KEY,
  seedAnimeLists,
  seedIndexer,
  seedLibraries,
  seedNyaa,
  seedXemList,
  settleSearches,
  setup,
  shippedProfile,
  useFetchFakes,
  withPacing,
  type Backend,
  type Libraries,
} from './setup';

let t: Backend;
let admin: Awaited<ReturnType<typeof asAdmin>>;
let libraries: Libraries;

beforeEach(async () => {
  vi.useFakeTimers();
  t = setup();
  admin = await asAdmin(t);
  libraries = await seedLibraries(t);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const item = (guid: string, title: string, publishedAt: string, extra: Partial<FakeItem> = {}): FakeItem => ({
  guid,
  title,
  categories: [5070],
  sizeBytes: 1_400_000_000,
  publishedAt,
  ...extra,
});

/** Serves `items` from the fake indexer; returns its request log. */
const serve = (items: FakeItem[]) => {
  const fake = createNewznabHandler({ apiKey: INDEXER_KEY, items });
  useFetchFakes({ indexers: { 'indexer.fake': fake.handle } });
  return fake;
};

/** Star Lantern (anime, absolute 1–24) on the Anime profile, its subscribe search done with nothing found. */
async function subscribeStarLantern(): Promise<Id<'works'>> {
  await seedAnimeLists(t);
  const animeProfile = await t.run((ctx) => ctx.db.insert('releaseProfiles', shippedProfile('anime-1080p')));
  serve([]);
  const { workId } = await admin.action(api.api.library.subscribe, {
    tmdbId: '900002',
    kind: 'series',
    libraryId: libraries.series,
    releaseProfileId: animeProfile,
    seasons: [1, 2],
  });
  await settleSearches(t);
  return workId;
}

const fetchRss = async (indexerId: Id<'indexers'>) => {
  await withPacing(t.action(internal.pipeline.rssAction.fetch, { indexerId }));
  await settleSearches(t);
};
const rssAttempts = async () => (await t.run((ctx) => ctx.db.query('searchAttempts').collect())).filter((a) => a.trigger === 'rss');
const candidates = () => t.run((ctx) => ctx.db.query('candidates').collect());

describe('an anime episode arrives on RSS', () => {
  test('matches the Work through its alias, resolves the absolute number, scores it on the Anime profile and picks it; other items are not stored', async () => {
    const workId = await subscribeStarLantern();
    const indexerId = await seedIndexer(t, { rssHighWaterMark: `${Date.parse('2026-11-01T00:00:00Z')}:old` });
    const fake = serve([
      item('sl13', '[SubsPlease] Star Lantern - 13 (1080p) [ABCD1234].mkv', '2026-11-15T10:00:00Z'),
      item('other', '[SubsPlease] Another Show - 05 (1080p) [0000AAAA].mkv', '2026-11-15T09:00:00Z'),
      item('movie', 'Quiet.Orchard.2024.1080p.WEB-DL.DDP5.1.H.264-GRPB', '2026-11-15T08:00:00Z', { categories: [2040] }),
    ]);
    await fetchRss(indexerId);

    expect(Object.fromEntries(fake.requests[0]!)).toMatchObject({ t: 'search', offset: '0' });
    expect(fake.requests[0]!.has('q')).toBe(false);
    const [attempt] = await rssAttempts();
    const s2e1 = (await t.run((ctx) => ctx.db.query('units').collect())).find((u) => u.workId === workId && u.tmdbSeason === 2 && u.tmdbEpisode === 1)!;
    expect(attempt).toMatchObject({ workId, unitIds: [s2e1._id], wantedUnitIds: [s2e1._id], state: 'picked' });
    const stored = await candidates();
    expect(stored.map((c) => [c.title, c.outcome, c.parsed.group, c.parsed.episodes])).toEqual([
      ['[SubsPlease] Star Lantern - 13 (1080p) [ABCD1234].mkv', 'picked', 'SubsPlease', [{ absolute: 13 }]],
    ]);
    expect((await t.run((ctx) => ctx.db.get(s2e1._id)))!.activeGrabId).toEqual(expect.any(String));

    const indexer = (await t.run((ctx) => ctx.db.get(indexerId)))!;
    expect(indexer.rssHighWaterMark).toBe(`${Date.parse('2026-11-15T10:00:00Z')}:${'https://indexer.fake/details/sl13'}`);
    expect(indexer.rssLastFetchAt).toEqual(expect.any(Number));
    expect(indexer.health.lastRss).toMatchObject({ newItems: 3, matched: 1 });
  });

  test('predicts preparation against the Work’s library target: with a target that takes HEVC, an HEVC episode needs no video step', async () => {
    await subscribeStarLantern();
    await admin.mutation(api.api.playback.update, {
      libraryId: libraries.series,
      draft: { mode: 'devices', devices: ['jellyfinFireTv'], keepOriginal: false },
    });
    const indexerId = await seedIndexer(t, { rssHighWaterMark: `${Date.parse('2026-11-01T00:00:00Z')}:old` });
    serve([item('sl13', '[SubsPlease] Star Lantern - 13 (1080p HEVC 10bit AAC) [ABCD1234].mkv', '2026-11-15T10:00:00Z')]);
    await fetchRss(indexerId);
    expect((await candidates()).map((c) => [c.parsed.videoCodec, c.preparationStep])).toEqual([['h265', 'remux']]);
  });

  test('a page with apilimits at their maximum is still matched and picked, and the indexer waits before its next request', async () => {
    await subscribeStarLantern();
    const indexerId = await seedIndexer(t, {
      rssHighWaterMark: '0:old',
      caps: { searchModes: [], pageLimit: { max: 1 }, categories: [], fetchedAt: Date.now() },
    });
    const fake = createNewznabHandler({
      apiKey: INDEXER_KEY,
      items: [
        item('sl13', '[SubsPlease] Star Lantern - 13 (1080p) [ABCD1234].mkv', '2026-11-15T10:00:00Z'),
        item('sl14', '[SubsPlease] Star Lantern - 14 (1080p) [ABCD1235].mkv', '2026-11-14T10:00:00Z'),
      ],
      apiLimits: { current: 100, max: 100 },
    });
    useFetchFakes({ indexers: { 'indexer.fake': fake.handle } });
    await fetchRss(indexerId);

    // A full page newer than the mark would be followed by another; the limit stops it.
    expect(fake.requests).toHaveLength(1);
    expect((await rssAttempts()).map((a) => a.state)).toEqual(['picked']);
    const indexer = (await t.run((ctx) => ctx.db.get(indexerId)))!;
    expect(indexer.rateLimitedUntil).toBeGreaterThan(Date.now());
    expect(indexer.health.status).toBe('ok');
  });

  test('the next fetch matches only items newer than the high-water mark', async () => {
    await subscribeStarLantern();
    const indexerId = await seedIndexer(t, { rssHighWaterMark: `${Date.parse('2026-11-15T10:00:00Z')}:x` });
    serve([item('sl13', '[SubsPlease] Star Lantern - 13 (1080p) [ABCD1234].mkv', '2026-11-15T10:00:00Z')]);
    await fetchRss(indexerId);
    expect(await rssAttempts()).toEqual([]);
  });

  test("the first fetch of a new indexer only sets the high-water mark, so its backlog isn't matched", async () => {
    await subscribeStarLantern();
    const indexerId = await seedIndexer(t);
    serve([item('sl13', '[SubsPlease] Star Lantern - 13 (1080p) [ABCD1234].mkv', '2026-11-15T10:00:00Z')]);
    await fetchRss(indexerId);
    expect(await rssAttempts()).toEqual([]);
    expect((await t.run((ctx) => ctx.db.get(indexerId)))!.rssHighWaterMark).toBe(`${Date.parse('2026-11-15T10:00:00Z')}:https://indexer.fake/details/sl13`);
  });

  test('an item whose title matches two Works that neither IDs nor a year tell apart is stored for neither', async () => {
    const workId = await subscribeStarLantern();
    const other = await t.run(async (ctx) => {
      const work = (await ctx.db.get(workId))!;
      const { _id, _creationTime, ...copy } = work;
      const otherId = await ctx.db.insert('works', { ...copy, title: 'Star Lantern (remake)' });
      await ctx.db.insert('workAliases', { workId: otherId, title: 'Star Lantern', normalized: 'star lantern', compact: 'starlantern', source: 'manual' });
      return otherId;
    });
    void other;
    const indexerId = await seedIndexer(t, { rssHighWaterMark: '0:old' });
    serve([item('sl13', '[SubsPlease] Star Lantern - 13 (1080p) [ABCD1234].mkv', '2026-11-15T10:00:00Z')]);
    await fetchRss(indexerId);
    expect(await rssAttempts()).toEqual([]);
    expect(await candidates()).toEqual([]);
  });
});

describe('an RSS item without IDs whose title differs from an alias', () => {
  const unitAt = (workId: Id<'works'>, season: number, episode: number) =>
    t.run(async (ctx) => (await ctx.db.query('units').collect()).find((u) => u.workId === workId && u.tmdbSeason === season && u.tmdbEpisode === episode)!);

  test('by a season mark: the title without it finds the Work, and the number is read within the season', async () => {
    const workId = await subscribeStarLantern();
    const indexerId = await seedIndexer(t, { rssHighWaterMark: '0:old' });
    serve([item('s2', '[New-raws] Star Lantern.S2 - 03 (1080p) [ABCD0001].mkv', '2026-11-15T10:00:00Z')]);
    await fetchRss(indexerId);
    expect((await rssAttempts()).map((a) => [a.workId, a.unitIds])).toEqual([[workId, [(await unitAt(workId, 2, 3))._id]]]);
  });

  test("by a part's XEM name: the number is read within the name's scene season", async () => {
    await seedXemList(t, [7700009]);
    const animeProfile = await t.run((ctx) => ctx.db.insert('releaseProfiles', shippedProfile('anime-1080p')));
    useFetchFakes({ series: [...SERIES, jojoParts()], xem: { shows: { 7700009: { all: jojoPartsShape, names: jojoPartsNames } } } });
    const { workId } = await admin.action(api.api.library.subscribe, {
      tmdbId: '900009',
      kind: 'series',
      libraryId: libraries.series,
      releaseProfileId: animeProfile,
      seasons: [5, 6],
      numberingScheme: 'anime',
    });
    await settleSearches(t);
    const indexerId = await seedIndexer(t, { rssHighWaterMark: '0:old' });
    serve([item('sbr', '[Erai-raws] JoJo no Kimyou na Bouken-Steel Ball Run-01 [1080p][ABCD0003].mkv', '2026-11-15T10:00:00Z')]);
    await fetchRss(indexerId);
    expect((await rssAttempts()).map((a) => [a.workId, a.unitIds])).toEqual([[workId, [(await unitAt(workId, 6, 1))._id]]]);
  });

  test("by the show's name and a TMDB season's name: the Work is found and the number read in the season's scene season (the part-title fix)", async () => {
    await seedXemList(t, [7700009]);
    const animeProfile = await t.run((ctx) => ctx.db.insert('releaseProfiles', shippedProfile('anime-1080p')));
    useFetchFakes({ series: [...SERIES, jojoParts()], xem: { shows: { 7700009: { all: jojoPartsShape, names: jojoPartsNames } } } });
    const { workId } = await admin.action(api.api.library.subscribe, {
      tmdbId: '900009',
      kind: 'series',
      libraryId: libraries.series,
      releaseProfileId: animeProfile,
      seasons: [5, 6],
      numberingScheme: 'anime',
    });
    await settleSearches(t);
    const indexerId = await seedIndexer(t, { rssHighWaterMark: '0:old' });
    serve([item('sbr', "[Anku & mutagenb] JoJo's Bizarre Adventure Steel Ball Run - 03 [1080p rus].mkv", '2026-11-15T10:00:00Z')]);
    await fetchRss(indexerId);
    expect((await rssAttempts()).map((a) => [a.workId, a.unitIds])).toEqual([[workId, [(await unitAt(workId, 6, 3))._id]]]);
  });

  test('by one side of a dual title (`中文名 / English Title`, test-install backlog)', async () => {
    const workId = await subscribeStarLantern();
    const indexerId = await seedIndexer(t, { rssHighWaterMark: '0:old' });
    serve([item('dual', '[CNSubs] 星之灯笼 / Star Lantern - 14 [1080p][CHS]', '2026-11-15T10:00:00Z')]);
    await fetchRss(indexerId);
    expect((await rssAttempts()).map((a) => [a.workId, a.unitIds])).toEqual([[workId, [(await unitAt(workId, 2, 2))._id]]]);
  });

  test("by hyphens: the alias's compact form finds the Work", async () => {
    // The alias "Hoshi no Chōchin" (TMDB's original name) is `hoshi no chochin`; the release's title is `hoshinochochin`.
    const workId = await subscribeStarLantern();
    const indexerId = await seedIndexer(t, { rssHighWaterMark: '0:old' });
    serve([item('hy', '[Erai-raws] Hoshi-no-Chochin - 14 [1080p][ABCD0002].mkv', '2026-11-15T10:00:00Z')]);
    await fetchRss(indexerId);
    expect((await rssAttempts()).map((a) => [a.workId, a.unitIds])).toEqual([[workId, [(await unitAt(workId, 2, 2))._id]]]);
  });
});

describe('rss.dispatch (every 5 minutes)', () => {
  test('starts a fetch for each enabled indexer whose effective interval has passed, and none for the others', async () => {
    serve([]);
    const due = await seedIndexer(t, { rssLastFetchAt: Date.now() - 20 * 60_000 });
    const early = await seedIndexer(t, { host: 'early.fake', rssLastFetchAt: Date.now() - 5 * 60_000 });
    const limited = await seedIndexer(t, { host: 'limited.fake', rssLastFetchAt: Date.now() - 20 * 60_000, apiLimit: { max: 100, source: 'user' } });
    const disabled = await seedIndexer(t, { host: 'off.fake', enabled: false });
    await t.mutation(internal.pipeline.rss.dispatch, {});
    await settleSearches(t);
    const fetched = (await t.run((ctx) => ctx.db.query('indexers').collect())).filter(
      (i) => i.rssLastFetchAt !== undefined && i.rssLastFetchAt > Date.now() - 60_000,
    );
    expect(fetched.map((i) => i._id)).toEqual([due]);
    void [early, limited, disabled];
  });

  test('skips the indexers of a protocol whose client row is disabled, so RSS starts no Grab for it', async () => {
    serve([]);
    await seedIndexer(t, { rssLastFetchAt: Date.now() - 20 * 60_000 });
    await t.run((ctx) => ctx.db.insert('downloadClients', { kind: 'nzbget', enabled: false, configVersion: 1 }));
    await t.mutation(internal.pipeline.rss.dispatch, {});
    await settleSearches(t);
    const fetched = (await t.run((ctx) => ctx.db.query('indexers').collect())).filter(
      (i) => i.rssLastFetchAt !== undefined && i.rssLastFetchAt > Date.now() - 60_000,
    );
    expect(fetched).toEqual([]);
  });

  test("a Nyaa indexer is a torrent indexer: dispatched unless qBittorrent's row is disabled", async () => {
    useFetchFakes({ indexers: { 'nyaa.fake': createNyaaHandler({ items: [] }).handle } });
    await seedNyaa(t, { rssLastFetchAt: Date.now() - 20 * 60_000 });
    await t.run((ctx) => ctx.db.insert('downloadClients', { kind: 'nzbget', enabled: false, configVersion: 1 }));
    await t.mutation(internal.pipeline.rss.dispatch, {});
    await settleSearches(t);
    const [nyaa] = await t.run((ctx) => ctx.db.query('indexers').collect());
    expect(nyaa!.rssLastFetchAt).toBeGreaterThan(Date.now() - 60_000);
  });
});

describe('a Nyaa indexer', () => {
  const nyaaItem = (id: number, title: string, publishedAt: string, extra: Partial<NyaaItem> = {}): NyaaItem => ({
    id,
    title,
    infoHash: id.toString(16).padStart(40, 'b'),
    size: '1.4 GiB',
    publishedAt,
    seeders: 20,
    leechers: 2,
    ...extra,
  });
  const serveNyaa = (items: NyaaItem[]) => {
    const fake = createNyaaHandler({ items, origin: 'https://nyaa.fake' });
    useFetchFakes({ indexers: { 'nyaa.fake': fake.handle } });
    return fake;
  };
  const request = (r: NyaaRequest) => `${r.path}?${r.params.toString()}`;
  const backlog = [nyaaItem(3001, '[SubsPlease] Star Lantern - 12 (1080p) [ABCD0012].mkv', '2026-11-08T10:00:00Z')];

  test('the first fetch sets the high-water mark from the feed; the next one picks a new episode with its magnet and peers', async () => {
    const workId = await subscribeStarLantern();
    const fake = serveNyaa(backlog);
    const nyaaId = await seedNyaa(t);
    await fetchRss(nyaaId);
    expect(fake.requests.map(request)).toEqual(['/?page=rss&c=1_0&f=0&m=1']);
    expect(await rssAttempts()).toEqual([]);
    expect((await t.run((ctx) => ctx.db.get(nyaaId)))!.rssHighWaterMark).toBe(`${Date.parse('2026-11-08T10:00:00Z')}:https://nyaa.fake/view/3001`);

    fake.setItems([nyaaItem(3002, '[SubsPlease] Star Lantern - 13 (1080p) [ABCD1234].mkv', '2026-11-15T10:00:00Z', { seeders: 120, leechers: 8 }), ...backlog]);
    await fetchRss(nyaaId);
    const [attempt] = await rssAttempts();
    const s2e1 = (await t.run((ctx) => ctx.db.query('units').collect())).find((u) => u.workId === workId && u.tmdbSeason === 2 && u.tmdbEpisode === 1)!;
    expect(attempt).toMatchObject({ workId, unitIds: [s2e1._id], state: 'picked', indexerResults: [{ indexerId: nyaaId, status: 'ok', count: 1, pages: 1 }] });
    expect((await candidates()).map((c) => [c.guid, c.outcome, c.torrent])).toEqual([
      ['https://nyaa.fake/view/3002', 'picked', expect.objectContaining({ infoHash: (3002).toString(16).padStart(40, 'b'), seeders: 120, peers: 128 })],
    ]);
    const nyaa = (await t.run((ctx) => ctx.db.get(nyaaId)))!;
    expect(nyaa.rssHighWaterMark).toBe(`${Date.parse('2026-11-15T10:00:00Z')}:https://nyaa.fake/view/3002`);
    expect(nyaa.health.lastRss).toMatchObject({ newItems: 1, matched: 1 });
  });

  test('a full feed of new items is followed by the listing page 2, without q', async () => {
    await subscribeStarLantern();
    const fake = serveNyaa(
      Array.from({ length: 80 }, (_, i) =>
        nyaaItem(4000 + i, `[Group${i}] Other Show - 01 (1080p).mkv`, new Date(Date.parse('2026-11-15T10:00:00Z') + i * 60_000).toISOString()),
      ),
    );
    const nyaaId = await seedNyaa(t, { rssHighWaterMark: `${Date.parse('2026-11-01T00:00:00Z')}:old` });
    await fetchRss(nyaaId);
    expect(fake.requests.map(request)).toEqual(['/?page=rss&c=1_0&f=0&m=1', '/?c=1_0&f=0&s=id&o=desc&p=2']);
    expect((await t.run((ctx) => ctx.db.get(nyaaId)))!.usage.reduce((sum, hour) => sum + hour.requests, 0)).toBe(2);
  });

  test('caps older than 24 h are rebuilt without a request or a recorded call', async () => {
    const fake = serveNyaa(backlog);
    const nyaaId = await seedNyaa(t, { caps: { ...NYAA_CAPS, fetchedAt: Date.now() - 2 * 86_400_000 } });
    await fetchRss(nyaaId);
    const nyaa = (await t.run((ctx) => ctx.db.get(nyaaId)))!;
    expect(fake.requests).toHaveLength(1);
    expect(nyaa.caps.fetchedAt).toBeGreaterThan(Date.now() - 60_000);
    expect(nyaa.usage.reduce((sum, hour) => sum + hour.requests, 0)).toBe(1);
  });

  test('a refused pacing slot ends the fetch with no request and no call; the next interval retries', async () => {
    const fake = serveNyaa(backlog);
    const nyaaId = await seedNyaa(t);
    await t.run((ctx) => ctx.db.insert('indexerPacing', { indexerId: nyaaId, nextAt: Date.now() + 10 * 60_000 }));
    const before = (await t.run((ctx) => ctx.db.get(nyaaId)))!;
    await fetchRss(nyaaId);
    const after = (await t.run((ctx) => ctx.db.get(nyaaId)))!;
    expect(fake.requests).toEqual([]);
    for (const field of ['health', 'usage', 'rateLimitedUntil', 'consecutiveRateLimits', 'rssHighWaterMark'] as const)
      expect(after[field]).toEqual(before[field]);
    expect(after.rssLastFetchAt).toBeGreaterThan(Date.now() - 60_000);
  });

  test("an item of a standard series isn't taken from an anime-only indexer (Q11)", async () => {
    serve([]);
    await admin.action(api.api.library.subscribe, {
      tmdbId: '900001',
      kind: 'series',
      libraryId: libraries.series,
      releaseProfileId: libraries.releaseProfileId,
      seasons: [1],
    });
    await settleSearches(t);
    serveNyaa([nyaaItem(5001, 'Harbour.Lights.S01E01.1080p.WEB-DL.AAC2.0.H.264-GRPB', '2026-11-15T10:00:00Z')]);
    const nyaaId = await seedNyaa(t, { rssHighWaterMark: `${Date.parse('2026-11-01T00:00:00Z')}:old` });
    await fetchRss(nyaaId);
    expect(await rssAttempts()).toEqual([]);
    expect((await t.run((ctx) => ctx.db.get(nyaaId)))!.health.lastRss).toMatchObject({ newItems: 1, matched: 0 });
  });
});
