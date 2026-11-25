// The mapping sources: the daily Anime-Lists and XEM `havemap`
// fetches, their health and Issues, and the syncs they start.
import { runToCompletion } from '@convex-dev/migrations';
import migrationsComponent from '@convex-dev/migrations/test';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';

import { api, components, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { RESYNC_BATCH } from '../../convex/mapping/listStore';
import xml from '../fixtures/animeLists/anime-list.xml?raw';
import blackLagoonShape from '../fixtures/xem/blackLagoonShape.json';
import { asAdmin, drainPool, fetchXem, seedLibraries, setup, useMetadataFakes, type Backend, type FakeRequests, type Libraries } from '../setup';

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
    expect(await t.run((ctx) => ctx.db.query('sceneMappings').collect())).toHaveLength(6);
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
    const daily = ['raw.githubusercontent.com', 'services.sonarr.tv/v1/scenemapping', 'thexem.info/map/allNames', 'thexem.info/map/havemap'];
    const sourceRequests = requests
      .filter((url) => url.hostname !== 'tmdb.fake')
      .map((url) => (url.hostname === 'raw.githubusercontent.com' ? url.hostname : `${url.hostname}${url.pathname}`));
    expect(sourceRequests.sort()).toEqual([...daily, ...daily].sort());
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

describe("XEM's names, the xemNames source", () => {
  const xemAliases = (workId: Id<'works'>) =>
    t.run(async (ctx) =>
      (
        await ctx.db
          .query('workAliases')
          .withIndex('by_work', (q) => q.eq('workId', workId))
          .collect()
      )
        .filter((alias) => alias.source === 'xem')
        .map(({ title, partSeason }) => ({ title, sceneSeason: partSeason?.season })),
    );
  const storedNames = () =>
    t.run(async (ctx) => (await ctx.db.query('xemNames').collect()).map(({ tvdbId, names, seenVersion }) => ({ tvdbId, names, seenVersion })));
  const versionOf = (source: 'xem' | 'xemNames') =>
    t.run(
      async (ctx) =>
        (
          await ctx.db
            .query('mappingSourceState')
            .withIndex('by_source', (q) => q.eq('source', source))
            .unique()
        )?.version,
    );
  const namesVersion = () => versionOf('xemNames');
  const fetchXemNames = () => t.action(internal.mapping.xem.fetchXemNames, {});
  const fetchBoth = () => fetchXem(t);
  const health = (job: 'xem' | 'xemNames') => t.run(async (ctx) => (await ctx.db.query('metadataSettings').first())!.sourceHealth[job]!);
  const shownXem = async () => (await admin.query(api.api.metadata.settings, {})).sources.find((s) => s.name === 'xem')!;
  const northbound = (names: unknown[]) => ({ 7700003: { all: blackLagoonShape, names } });
  const harbour = (names: unknown[]) => ({ 7700001: { all: { result: 'failure', data: [], message: 'no show found' }, names } });

  test('asks for allNames with seasonNumbers once per run, and a subscribed Work gets the names with their scene seasons', async () => {
    const fakes = useMetadataFakes({ xem: { shows: northbound([{ Northbound: -1 }, { 'Northbound Signal': 2 }]) } });
    await fetchBoth();
    expect(fakes.filter((url) => url.pathname === '/map/allNames').map((url) => url.searchParams.toString())).toEqual(['origin=tvdb&seasonNumbers=1']);
    const { workId } = await subscribe('900003');
    await runPool();
    expect(await xemAliases(workId)).toEqual([
      { title: 'Northbound Signal', sceneSeason: 2 },
      { title: 'Northbound', sceneSeason: undefined },
    ]);
  });

  test('the same answer again writes nothing and syncs no Work', async () => {
    useMetadataFakes({ xem: { shows: northbound([{ Northbound: -1 }]) } });
    await fetchBoth();
    const { workId } = await subscribe('900003');
    await runPool();
    const before = await storedNames();
    await fetchXemNames();
    expect(await storedNames()).toEqual(before);
    expect(await syncing(workId)).toBe(false);
  });

  test('a changed answer syncs only the Works whose names changed, and a show it drops loses its names', async () => {
    useMetadataFakes({ xem: { shows: { ...northbound([{ Northbound: -1 }]), ...harbour([{ 'Harbour Lights JP': -1 }]) } } });
    await fetchBoth();
    const harbourWork = await subscribe('900001');
    const northboundWork = await subscribe('900003');
    await runPool();
    useMetadataFakes({ xem: { havemap: [7700001, 7700003], shows: { ...northbound([{ 'Northbound Signal': 2 }]), 7700001: harbour([])[7700001] } } });
    await fetchXemNames();
    expect(await syncing(northboundWork.workId)).toBe(true);
    expect(await syncing(harbourWork.workId)).toBe(true);
    await runPool();
    expect(await xemAliases(northboundWork.workId)).toEqual([{ title: 'Northbound Signal', sceneSeason: 2 }]);
    expect(await xemAliases(harbourWork.workId)).toEqual([]);
    expect((await storedNames()).map((row) => row.tvdbId).sort((a, b) => a - b)).toEqual([7700003, 7799999]);

    useMetadataFakes({ xem: { havemap: [7700001, 7700003], shows: { ...northbound([{ 'Northbound Signal': 2 }, { 'Northbound Again': -1 }]) } } });
    await fetchXemNames();
    expect(await syncing(northboundWork.workId)).toBe(true);
    expect(await syncing(harbourWork.workId)).toBe(false);
  });

  test.each([
    ['a failure envelope', { allNames: { result: 'failure', data: [], message: 'no show found' } }],
    ['an empty object', { allNames: { result: 'success', data: {}, message: '' } }],
    ['an empty list', { allNames: { result: 'success', data: [], message: '' } }],
    ['no show with a usable name', { allNames: { result: 'success', data: { 7700003: [{ '': -1 }] }, message: '' } }],
    ['a timeout', { namesDown: true }],
    ['an error status', { allNames: new Response('busy', { status: 503 }) }],
    [
      'a body over 16 MB',
      {
        allNames: new Response(JSON.stringify({ result: 'success', data: { 7700003: [{ 'Northbound Renamed': -1 }] }, message: '' }), {
          headers: { 'content-length': String(17 * 1024 * 1024) },
        }),
      },
    ],
    [
      'valid JSON over 16 MB with no length header',
      {
        allNames: new Response(
          JSON.stringify({ result: 'success', data: { 7700003: [{ 'Northbound Renamed': -1 }] }, message: '' }) + ' '.repeat(16 * 1024 * 1024),
        ),
      },
    ],
  ])(
    "%s keeps every stored name and the version, counts toward the names' health, which a Work's sync does not clear, and fails the job",
    async (_case, answer) => {
      useMetadataFakes({ xem: { shows: northbound([{ Northbound: -1 }]) } });
      await fetchBoth();
      const { workId } = await subscribe('900003');
      await runPool();
      const names = await storedNames();
      const version = await namesVersion();
      useMetadataFakes({ xem: { shows: northbound([{ Northbound: -1 }]), ...answer } });
      await expect(fetchXemNames()).rejects.toThrow();
      expect(await storedNames()).toEqual(names);
      expect(await namesVersion()).toBe(version);
      expect((await health('xemNames')).firstFailureAt).toEqual(expect.any(Number));
      await admin.mutation(api.api.metadata.syncNow, { workId });
      await runPool();
      expect(await xemAliases(workId)).toEqual([{ title: 'Northbound', sceneSeason: undefined }]);
      expect((await health('xem')).firstFailureAt).toBeUndefined();
      expect((await health('xemNames')).firstFailureAt).toEqual(expect.any(Number));
    },
  );

  test('while allNames is down, the havemap is still stored and a show that entered it syncs', async () => {
    useMetadataFakes({ xem: { havemap: [], namesDown: true } });
    const { workId } = await subscribe('900003');
    await runPool();
    useMetadataFakes({ xem: { shows: northbound([{ Northbound: -1 }]), namesDown: true } });
    await fetchHavemap();
    await expect(fetchXemNames()).rejects.toThrow();
    expect(await syncing(workId)).toBe(true);
    await runPool();
    const scene = await t.run((ctx) =>
      ctx.db
        .query('unitMappings')
        .withIndex('by_ordering', (q) => q.eq('workId', workId).eq('ordering', 'scene'))
        .collect(),
    );
    expect(scene).toHaveLength(24);
  });

  test("Settings shows one TheXEM with the stalest job's success and version: healthy when both jobs are, failing while allNames is down", async () => {
    const havemapVersion = () => versionOf('xem');
    useMetadataFakes({ xem: { shows: northbound([{ Northbound: -1 }]) } });
    await fetchHavemap();
    const havemapSuccess = (await health('xem')).lastSuccessAt;
    vi.advanceTimersByTime(HOUR);
    await fetchXemNames();
    expect((await admin.query(api.api.metadata.settings, {})).sources.map((s) => s.name)).toEqual(['tmdb', 'xem', 'animeLists', 'sceneMapping']);
    expect(await shownXem()).toEqual({ name: 'xem', version: await havemapVersion(), lastSuccessAt: havemapSuccess });

    vi.advanceTimersByTime(DAY);
    const namesSuccess = (await health('xemNames')).lastSuccessAt;
    useMetadataFakes({ xem: { shows: northbound([{ Northbound: -1 }]), namesDown: true } });
    await fetchHavemap();
    await expect(fetchXemNames()).rejects.toThrow();
    expect(await shownXem()).toEqual({
      name: 'xem',
      version: await namesVersion(),
      firstFailureAt: (await health('xemNames')).firstFailureAt,
      lastSuccessAt: namesSuccess,
    });
  });

  test('Settings shows TheXEM failing since the earlier of the two failures', async () => {
    useMetadataFakes({ xem: { down: true, namesDown: true } });
    await expect(fetchHavemap()).rejects.toThrow();
    const havemapFailure = (await health('xem')).firstFailureAt!;
    vi.advanceTimersByTime(HOUR);
    await expect(fetchXemNames()).rejects.toThrow();
    expect((await health('xemNames')).firstFailureAt).toBeGreaterThan(havemapFailure);
    expect((await shownXem()).firstFailureAt).toBe(havemapFailure);
  });

  test('both XEM jobs failing for seven days open one Issue for TheXEM, which stays open until both succeed', async () => {
    useMetadataFakes({ xem: { down: true, namesDown: true } });
    await expect(fetchHavemap()).rejects.toThrow();
    await expect(fetchXemNames()).rejects.toThrow();
    vi.advanceTimersByTime(7 * DAY + 60_000);
    await expect(fetchHavemap()).rejects.toThrow();
    await expect(fetchXemNames()).rejects.toThrow();
    const issue = { failureCode: 'metadataSourceUnavailable', fixActions: ['retryNow'], detail: 'Not reachable: TheXEM.' };
    expect(await openIssues()).toEqual([issue]);

    useMetadataFakes({ xem: { namesDown: true } });
    await fetchHavemap();
    expect(await openIssues()).toEqual([issue]);
    useMetadataFakes();
    await fetchXemNames();
    expect(await openIssues()).toEqual([]);
  });

  test('seven days of allNames failures open the Issue for TheXEM, which havemap and map successes leave open and an allNames success resolves', async () => {
    useMetadataFakes({ xem: { shows: northbound([{ Northbound: -1 }]) } });
    await fetchBoth();
    const { workId } = await subscribe('900003');
    await runPool();
    useMetadataFakes({ xem: { shows: northbound([{ Northbound: -1 }]), namesDown: true } });
    await expect(fetchXemNames()).rejects.toThrow();
    vi.advanceTimersByTime(6 * DAY);
    await expect(fetchXemNames()).rejects.toThrow();
    expect(await openIssues()).toEqual([]);

    vi.advanceTimersByTime(DAY + 60_000);
    await expect(fetchXemNames()).rejects.toThrow();
    const issue = { failureCode: 'metadataSourceUnavailable', fixActions: ['retryNow'], detail: 'Not reachable: TheXEM.' };
    expect(await openIssues()).toEqual([issue]);
    await fetchHavemap();
    await admin.mutation(api.api.metadata.syncNow, { workId });
    await runPool();
    expect((await health('xem')).lastSuccessAt).toEqual(expect.any(Number));
    expect(await openIssues()).toEqual([issue]);

    useMetadataFakes({ xem: { shows: northbound([{ Northbound: -1 }]) } });
    await fetchXemNames();
    expect(await openIssues()).toEqual([]);
  });

  test('a first fetch that changes more shows than one batch holds resyncs the Works it names', async () => {
    const { workId } = await subscribe('900003');
    await runPool();
    const otherShowCount = 2 * RESYNC_BATCH;
    const others = Object.fromEntries(Array.from({ length: otherShowCount }, (_, i) => [7800000 + i, [{ [`Other Show ${i}`]: -1 }]]));
    useMetadataFakes({ xem: { havemap: [7700003], allNames: { result: 'success', data: { ...others, 7700003: [{ Northbound: -1 }] }, message: '' } } });
    await fetchHavemap();
    await runPool();
    await fetchXemNames();
    expect(await storedNames()).toHaveLength(otherShowCount + 1);
    expect(await syncing(workId)).toBe(true);
    await runPool();
    expect(await xemAliases(workId)).toEqual([{ title: 'Northbound', sceneSeason: undefined }]);
  });

  test('one show in a bad shape is skipped, and the rest are stored', async () => {
    useMetadataFakes({ xem: { allNames: { result: 'success', data: { 7700003: [{ Northbound: -1 }], 7700001: 'not a list' }, message: '' } } });
    await fetchXemNames();
    expect((await storedNames()).map(({ tvdbId, names }) => ({ tvdbId, names }))).toEqual([{ tvdbId: 7700003, names: [{ title: 'Northbound' }] }]);
  });
});

describe("Sonarr's scene mappings", () => {
  const aliasesOf = async (workId: Id<'works'>) =>
    (await admin.query(api.api.metadata.workInfo, { workId }))!.aliases.filter((a) => a.source === 'sceneMapping').map((a) => a.title);
  const fetchSceneMappings = () => t.action(internal.mapping.sceneMappings.fetchSceneMappings, {});
  const list = (entries: { mappingId: string; tvdbId: number; title: string; season?: number; filterRegex?: string }[]) =>
    entries.map((e) => ({ season: -1, ...e }));

  const sceneAliasRows = (workId: Id<'works'>) =>
    t.run(async (ctx) =>
      (
        await ctx.db
          .query('workAliases')
          .withIndex('by_work', (q) => q.eq('workId', workId))
          .collect()
      )
        .filter((alias) => alias.source === 'sceneMapping')
        .map(({ title, partSeason, releaseSeason, filter }) => ({ title, partSeason, releaseSeason, filter })),
    );

  test("a subscribed Work gets its names as aliases by its TVDB ID, with their season and filter; a season TMDB doesn't list leaves its name out", async () => {
    const { workId } = await subscribe('900001');
    await runPool();
    expect(await sceneAliasRows(workId)).toEqual([
      { title: 'Harbour Lights UK' },
      { title: 'The Harbour Lights' },
      { title: 'Harbour Lights Winter Tales', partSeason: { season: 0, ordering: 'tmdb' }, releaseSeason: 0 },
      { title: 'Harbour', filter: '(?i)^Harbour\\.S01E' },
    ]);
  });

  test('a name stored before seasons and filters were kept still reads; after migration 0006 the next fetch of the same list rewrites it with them', async () => {
    migrationsComponent.register(t);
    await t.run(async (ctx) => {
      for (const row of await ctx.db.query('sceneMappings').collect()) await ctx.db.delete(row._id);
      await ctx.db.insert('sceneMappings', { mappingId: 's-0000000000000000000000a1', tvdbId: 7700001, title: 'Harbour Lights UK', seenVersion: 'old' });
    });
    const { workId } = await subscribe('900001');
    await runPool();
    expect(await sceneAliasRows(workId)).toEqual([{ title: 'Harbour Lights UK' }]);
    await fetchSceneMappings();
    expect(await syncing(workId)).toBe(false);

    await t.run((ctx) => runToCompletion(ctx, components.migrations, internal.migrations['0006_scene_mapping_seasons_and_filters'].default));
    await fetchSceneMappings();
    expect(await syncing(workId)).toBe(true);
    await runPool();
    expect((await sceneAliasRows(workId)).map((alias) => alias.title)).toEqual([
      'Harbour Lights UK',
      'The Harbour Lights',
      'Harbour Lights Winter Tales',
      'Harbour',
    ]);
  });

  test("an entry with a pattern RE2 can't read is skipped, and the rest of the list is stored", async () => {
    useMetadataFakes({
      sceneMappings: {
        list: list([
          { mappingId: 's-bad', tvdbId: 7700001, title: 'Harbour Lights Lookbehind', filterRegex: '(?<=x)y' },
          { mappingId: 's-good', tvdbId: 7700001, title: 'Harbour Lights GB' },
        ]),
      },
    });
    await fetchSceneMappings();
    expect((await t.run((ctx) => ctx.db.query('sceneMappings').collect())).map((row) => row.mappingId)).toEqual(['s-good']);
  });

  test('a name whose season changed syncs its Work, and the alias carries the new season', async () => {
    const harbour = await subscribe('900001');
    await runPool();
    const entry = { mappingId: 's-0000000000000000000000a3', tvdbId: 7700001, title: 'Harbour Lights Winter Tales' };
    useMetadataFakes({ sceneMappings: { list: list([{ ...entry, season: 1 }]) } });
    await fetchSceneMappings();
    expect(await syncing(harbour.workId)).toBe(true);
    await runPool();
    expect(await sceneAliasRows(harbour.workId)).toEqual([
      { title: 'Harbour Lights Winter Tales', partSeason: { season: 1, ordering: 'tmdb' }, releaseSeason: 1 },
    ]);
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

  test('a body past 16 MB with no length header is refused while it streams, and the stored names stay', async () => {
    const before = await t.run((ctx) => ctx.db.query('sceneMappings').collect());
    useMetadataFakes({ sceneMappings: { streamedBytes: 17 * 1024 * 1024 } });
    await expect(fetchSceneMappings()).rejects.toThrow("Sonarr's scene mappings is too large.");
    expect(await t.run((ctx) => ctx.db.query('sceneMappings').collect())).toEqual(before);
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
    expect(await aliasesOf(workId)).toEqual(['Harbour Lights UK', 'The Harbour Lights', 'Harbour Lights Winter Tales', 'Harbour']);
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
