// The mapping sources: the daily Anime-Lists and XEM `havemap`
// fetches, their health and Issues, and the syncs they start.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';

import { api, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import xml from '../fixtures/animeLists/anime-list.xml?raw';
import blackLagoonShape from '../fixtures/xem/blackLagoonShape.json';
import { asAdmin, drainPool, seedLibraries, setup, useMetadataFakes, type Backend, type FakeRequests, type Libraries } from '../setup';

const HOUR = 60 * 60 * 1000;
const DAY = 24 * HOUR;

let t: Backend;
let admin: Awaited<ReturnType<typeof asAdmin>>;
let libraries: Libraries;
let requests: FakeRequests;

beforeEach(async () => {
  vi.useFakeTimers();
  t = setup();
  // These tests move the clock by days.
  admin = await asAdmin(t, 30 * DAY);
  libraries = await seedLibraries(t);
  requests = useMetadataFakes();
  await t.mutation(internal.metadata.schedule.tick, {});
  await runPool();
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const runPool = () => drainPool(t);
const subscribe = (tmdbId: string) =>
  admin.action(api.api.library.subscribe, { tmdbId, kind: 'series', libraryId: libraries.series, releaseProfileId: libraries.releaseProfileId, seasons: [1] });
const fetchAnimeLists = () => t.action(internal.mapping.animeLists.fetchAnimeLists, {});
const fetchHavemap = () => t.action(internal.mapping.xem.fetchHavemap, {});
const entries = () => t.run((ctx) => ctx.db.query('animeListEntries').collect());
const syncing = (workId: Id<'works'>) =>
  t.run(
    async (ctx) =>
      (
        await ctx.db
          .query('workMetadata')
          .withIndex('by_work', (q) => q.eq('workId', workId))
          .unique()
      )?.syncWorkId !== undefined,
  );
const openIssues = () =>
  t.run(async (ctx) =>
    (
      await ctx.db
        .query('issues')
        .withIndex('by_state_scope', (q) => q.eq('state', 'open').eq('scope', 'system'))
        .collect()
    ).map(({ failureCode, fixActions, detail }) => ({ failureCode, fixActions, detail })),
  );

describe('the first tick', () => {
  test("fetches Anime-Lists, the XEM list and Sonarr's scene mappings, and not again within 24 hours", async () => {
    expect(await entries()).toHaveLength(7);
    expect(await t.run((ctx) => ctx.db.query('sceneMappings').collect())).toHaveLength(3);
    const settings = await admin.query(api.api.metadata.settings, {});
    expect(settings.sources.find((s) => s.name === 'animeLists')).toMatchObject({
      version: expect.stringMatching(/^[0-9a-f]{64}$/),
      lastSuccessAt: expect.any(Number),
    });
    expect(settings.sources.find((s) => s.name === 'xem')).toMatchObject({ version: expect.any(String), lastSuccessAt: expect.any(Number) });
    const count = requests.length;
    vi.advanceTimersByTime(23 * HOUR);
    await t.mutation(internal.metadata.schedule.tick, {});
    await runPool();
    expect(requests.length).toBe(count);
    vi.advanceTimersByTime(2 * HOUR);
    await t.mutation(internal.metadata.schedule.tick, {});
    await runPool();
    expect(requests.filter((url) => url.hostname !== 'tmdb.fake').length).toBe(6);
  });
});

describe('the Anime-Lists fetch', () => {
  test('a 304 writes nothing', async () => {
    const before = await entries();
    await fetchAnimeLists();
    expect(requests.at(-1)!.hostname).toBe('raw.githubusercontent.com');
    expect(await entries()).toEqual(before);
  });

  test('a changed file rewrites the changed entry, stamps every entry with the new version, and syncs only the Works it links', async () => {
    useMetadataFakes();
    const star = await subscribe('900002');
    const harbour = await subscribe('900001');
    useMetadataFakes({ animeLists: { xml: xml.replace('episodeoffset="12"', 'episodeoffset="13"'), etag: '"v2"' } });
    await fetchAnimeLists();
    const after = await entries();
    expect(after.find((e) => e.anidbId === 17002)).toMatchObject({ episodeOffset: 13 });
    expect(new Set(after.map((e) => e.seenVersion)).size).toBe(1);
    expect(await syncing(star.workId)).toBe(true);
    expect(await syncing(harbour.workId)).toBe(false);
  });

  test('deletes the entries the new file no longer has, and syncs the Works they linked', async () => {
    useMetadataFakes();
    const star = await subscribe('900002');
    const without = xml.replace(/<anime anidbid="17002"[\s\S]*?<\/anime>/, '');
    useMetadataFakes({ animeLists: { xml: without, etag: '"v3"' } });
    await fetchAnimeLists();
    expect((await entries()).map((e) => e.anidbId)).not.toContain(17002);
    expect(await entries()).toHaveLength(6);
    expect(await syncing(star.workId)).toBe(true);
    await runPool();
    const { workIds } = await t.run(async (ctx) => ({
      workIds: (
        await ctx.db
          .query('externalIds')
          .withIndex('by_work', (q) => q.eq('workId', star.workId))
          .collect()
      ).map((row) => [row.provider, row.value]),
    }));
    expect(workIds).not.toContainEqual(['anidb', '17002']);
  });
});

describe('the XEM havemap fetch', () => {
  test('syncs the Works whose TVDB ID entered the list, which then get scene rows', async () => {
    const { workId } = await subscribe('900003');
    useMetadataFakes({ xem: { havemap: [7700003], shows: { 7700003: { all: blackLagoonShape } } } });
    await fetchHavemap();
    expect(await syncing(workId)).toBe(true);
    await runPool();
    const scene = await t.run((ctx) =>
      ctx.db
        .query('unitMappings')
        .withIndex('by_ordering', (q) => q.eq('workId', workId).eq('ordering', 'scene'))
        .collect(),
    );
    expect(scene).toHaveLength(24);
    await fetchHavemap();
    expect(await syncing(workId)).toBe(false);
  });
});

describe("Sonarr's scene mappings", () => {
  const aliasesOf = async (workId: Id<'works'>) =>
    (await admin.query(api.api.metadata.workInfo, { workId }))!.aliases.filter((a) => a.source === 'sceneMapping').map((a) => a.title);
  const fetchSceneMappings = () => t.action(internal.mapping.sceneMappings.fetchSceneMappings, {});
  const list = (entries: { mappingId: string; tvdbId: number; title: string; season?: number }[]) => entries.map((e) => ({ season: -1, ...e }));

  test('a subscribed Work gets its all-seasons names as aliases, by its TVDB ID', async () => {
    const { workId } = await subscribe('900001');
    await runPool();
    expect(await aliasesOf(workId)).toEqual(['Harbour Lights UK', 'The Harbour Lights']);
  });

  test('sends the omnarr User-Agent', async () => {
    const seen: Headers[] = [];
    useMetadataFakes({ sceneMappings: { seen, list: list([{ mappingId: 's-1', tvdbId: 7700001, title: 'Harbour Lights UK' }]) } });
    await fetchSceneMappings();
    expect(seen.at(-1)!.get('user-agent')).toMatch(/^omnarr\//);
  });

  test('a changed list syncs only the Works whose names changed, and their aliases follow', async () => {
    const harbour = await subscribe('900001');
    const northbound = await subscribe('900003');
    await runPool();
    useMetadataFakes({
      sceneMappings: {
        list: list([
          { mappingId: 's-0000000000000000000000a1', tvdbId: 7700001, title: 'Harbour Lights GB' },
          { mappingId: 's-0000000000000000000000a6', tvdbId: 7700003, title: 'Northbound Signal US' },
        ]),
      },
    });
    await fetchSceneMappings();
    expect(await syncing(harbour.workId)).toBe(true);
    expect(await syncing(northbound.workId)).toBe(false);
    await runPool();
    expect(await aliasesOf(harbour.workId)).toEqual(['Harbour Lights GB']);
    expect(await aliasesOf(northbound.workId)).toEqual(['Northbound Signal US']);
  });

  test('a failed fetch keeps the stored names for the next sync, and counts toward the source health', async () => {
    const { workId } = await subscribe('900001');
    await runPool();
    useMetadataFakes({ sceneMappings: { down: true } });
    await expect(fetchSceneMappings()).rejects.toThrow();
    useMetadataFakes({ sceneMappings: { list: [] } });
    await expect(fetchSceneMappings()).rejects.toThrow();
    await admin.mutation(api.api.metadata.syncNow, { workId });
    await runPool();
    expect(await aliasesOf(workId)).toEqual(['Harbour Lights UK', 'The Harbour Lights']);
    const health = (await admin.query(api.api.metadata.settings, {})).sources.find((s) => s.name === 'sceneMapping')!;
    expect(health.firstFailureAt).toEqual(expect.any(Number));
  });
});

describe('a mapping source is down', () => {
  test('XEM failing: the stored rows stay in use, the settings show the first failure, and the Issue opens only after 7 days', async () => {
    useMetadataFakes({ xem: { down: true } });
    const firstFailure = Date.now();
    await expect(fetchHavemap()).rejects.toThrow();
    vi.advanceTimersByTime(6 * DAY);
    await expect(fetchHavemap()).rejects.toThrow();
    expect(await openIssues()).toEqual([]);
    const xemHealth = (await admin.query(api.api.metadata.settings, {})).sources.find((s) => s.name === 'xem')!;
    expect(xemHealth.firstFailureAt! - firstFailure).toBeLessThan(1000);
    expect(await entries()).toHaveLength(7);

    vi.advanceTimersByTime(DAY + 60_000);
    await expect(fetchHavemap()).rejects.toThrow();
    expect(await openIssues()).toEqual([{ failureCode: 'metadataSourceUnavailable', fixActions: ['retryNow'], detail: 'Not reachable: TheXEM.' }]);

    useMetadataFakes();
    await fetchHavemap();
    expect(await openIssues()).toEqual([]);
    expect((await admin.query(api.api.metadata.settings, {})).sources.find((s) => s.name === 'xem')).not.toHaveProperty('firstFailureAt');
  });

  test('TMDB failing for 24 hours opens the Issue; a success resolves it', async () => {
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    const search = () => admin.action(api.api.metadata.search, { query: 'harbour', kind: 'series' });
    await expect(search()).rejects.toThrow(/metadataUnavailable/);
    vi.advanceTimersByTime(23 * HOUR);
    await expect(search()).rejects.toThrow();
    expect(await openIssues()).toEqual([]);
    vi.advanceTimersByTime(HOUR + 60_000);
    await expect(search()).rejects.toThrow();
    expect(await openIssues()).toEqual([{ failureCode: 'metadataSourceUnavailable', fixActions: ['retryNow'], detail: 'Not reachable: TMDB.' }]);
    useMetadataFakes();
    await search();
    expect(await openIssues()).toEqual([]);
  });
});
