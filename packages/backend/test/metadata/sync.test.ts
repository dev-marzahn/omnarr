import { harbourLightsRestructured, jojoParts, longSeries, SERIES } from '@omnarr/e2e/fakes/tmdb/fixtures';
// The write path through library.subscribe and syncWork, with
// TMDB, XEM and Anime-Lists behind fakes. Mapping rows and external IDs have
// no public reader of their own, so these tests read the tables.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';

import { api, internal } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { UNITS_PER_BATCH, unitBatches } from '../../convex/metadata/sync';

// Fault injection: no outside input makes the first write fail once TMDB has
// answered, so the test for a failed first write makes reconciliation throw.
const failures = vi.hoisted(() => ({ write: false }));
vi.mock('../../convex/metadata/reconcile', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../convex/metadata/reconcile')>();
  return {
    ...actual,
    reconcileUnits: (...args: Parameters<typeof actual.reconcileUnits>) => {
      if (failures.write) throw new Error('injected write failure');
      return actual.reconcileUnits(...args);
    },
  };
});
import { seedFile } from '../fakePrepare';
import blackLagoonShape from '../fixtures/xem/blackLagoonShape.json';
import jojoPartsNames from '../fixtures/xem/jojoPartsNames.json';
import jojoPartsShape from '../fixtures/xem/jojoPartsShape.json';
import partial from '../fixtures/xem/partial.json';
import { asAdmin, fetchXem, seedAnimeLists, seedLibraries, seedXemList, setup, useMetadataFakes, type Backend, type Libraries } from '../setup';

let t: Backend;
let admin: Awaited<ReturnType<typeof asAdmin>>;
let libraries: Libraries;

beforeEach(async () => {
  t = setup();
  admin = await asAdmin(t);
  libraries = await seedLibraries(t);
  useMetadataFakes();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const subscribe = (tmdbId: string, seasons: number[]) =>
  admin.action(api.api.library.subscribe, { tmdbId, kind: 'series', libraryId: libraries.series, releaseProfileId: libraries.releaseProfileId, seasons });

/** What the sync wrote for a Work: its external IDs, Units, mapping rows, aliases and metadata row. */
function stored(workId: Id<'works'>) {
  return t.run(async (ctx) => {
    const units = await ctx.db
      .query('units')
      .withIndex('by_work', (q) => q.eq('workId', workId))
      .collect();
    const label = (unitId: Id<'units'>) => {
      const unit = units.find((u) => u._id === unitId)!;
      return `S${unit.tmdbSeason}E${unit.tmdbEpisode}`;
    };
    const unitIds = await Promise.all(
      units.map(async (unit) => ({
        unit: label(unit._id),
        ids: (
          await ctx.db
            .query('externalIds')
            .withIndex('by_unit', (q) => q.eq('unitId', unit._id))
            .collect()
        ).map((row) => [row.provider, row.value]),
      })),
    );
    const mappings = await ctx.db
      .query('unitMappings')
      .withIndex('by_ordering', (q) => q.eq('workId', workId))
      .collect();
    return {
      workIds: (
        await ctx.db
          .query('externalIds')
          .withIndex('by_work', (q) => q.eq('workId', workId))
          .collect()
      ).map((row) => [row.provider, row.value]),
      units,
      unitIds,
      mappings: mappings.map((m) => ({
        unit: label(m.unitId),
        ordering: m.ordering,
        season: m.season,
        episode: m.episode,
        absolute: m.absolute,
        source: m.source,
      })),
      aliases: (
        await ctx.db
          .query('workAliases')
          .withIndex('by_work', (q) => q.eq('workId', workId))
          .collect()
      ).map(({ title, source, anidbId }) => ({ title, source, anidbId })),
      metadata: await ctx.db
        .query('workMetadata')
        .withIndex('by_work', (q) => q.eq('workId', workId))
        .unique(),
    };
  });
}

describe('subscribe to an anime with Anime-Lists entries', () => {
  test('writes both AniDB IDs and the TVDB ID, absolute rows 1–24, an anidb ordering per entry, and the entry names as aliases', async () => {
    await seedAnimeLists(t);
    const { workId } = await subscribe('900002', [1, 2]);
    const { workIds, mappings, aliases, metadata } = await stored(workId);

    expect(workIds).toEqual([
      ['tmdb', '900002'],
      ['tvdb', '7700002'],
      ['anidb', '17001'],
      ['anidb', '17002'],
    ]);
    const absolute = mappings.filter((m) => m.ordering === 'absolute');
    expect(absolute.map((m) => m.absolute).sort((a, b) => a! - b!)).toEqual(Array.from({ length: 24 }, (_, i) => i + 1));
    expect(absolute.find((m) => m.absolute === 13)!.unit).toBe('S2E1');
    expect(mappings.filter((m) => m.ordering === 'anidb:17001')).toHaveLength(12);
    expect(mappings.filter((m) => m.ordering === 'anidb:17002' && m.unit === 'S2E1')).toEqual([
      { unit: 'S2E1', ordering: 'anidb:17002', season: 1, episode: 1, absolute: undefined, source: 'animeLists' },
    ]);
    expect(aliases).toEqual(
      expect.arrayContaining([
        { title: 'Star Lantern', source: 'animeLists', anidbId: 17001 },
        { title: 'Star Lantern 2nd Season', source: 'animeLists', anidbId: 17002 },
      ]),
    );
    expect(metadata).toMatchObject({ buildState: 'ready', mappingStatus: 'complete', numberingSuggestion: { scheme: 'anime', reason: 'animeLists' } });
    expect((await admin.query(api.api.library.detail, { workId }))!.work.numberingScheme).toBe('anime');
  });

  test("a TMDB title that repeats a later entry's name is not written; one that repeats the first entry's name is", async () => {
    await seedAnimeLists(t);
    const { workId } = await subscribe('900002', [1, 2]);
    const { aliases } = await stored(workId);
    expect(
      aliases.filter((a) => a.title.startsWith('Star Lantern')).sort((a, b) => a.title.localeCompare(b.title) || a.source.localeCompare(b.source)),
    ).toEqual([
      { title: 'Star Lantern', source: 'animeLists', anidbId: 17001 },
      { title: 'Star Lantern', source: 'tmdb', anidbId: undefined },
      { title: 'Star Lantern 2nd Season', source: 'animeLists', anidbId: 17002 },
    ]);
  });

  test("anidb rows carry the Anime-Lists file's version", async () => {
    await seedAnimeLists(t, 'sha-of-the-file');
    const { workId } = await subscribe('900002', [1, 2]);
    const versions = await t.run(async (ctx) =>
      (
        await ctx.db
          .query('unitMappings')
          .withIndex('by_ordering', (q) => q.eq('workId', workId).eq('ordering', 'anidb:17001'))
          .collect()
      ).map((m) => m.sourceVersion),
    );
    expect(new Set(versions)).toEqual(new Set(['sha-of-the-file']));
  });
});

describe('scene numbering differs from TMDB', () => {
  test('links XEM by absolute position when TVDB has one season of 24 and TMDB two of 12 (rule 3)', async () => {
    await seedXemList(t, [7700003]);
    useMetadataFakes({ xem: { shows: { 7700003: { all: blackLagoonShape, names: [{ Northbound: -1 }] } } } });
    await fetchXem(t);
    const { workId } = await subscribe('900003', [1, 2]);
    const { mappings, aliases, metadata } = await stored(workId);
    expect(mappings.filter((m) => m.ordering === 'scene' && m.unit === 'S2E1')).toEqual([
      { unit: 'S2E1', ordering: 'scene', season: 2, episode: 1, absolute: 13, source: 'xem' },
    ]);
    expect(mappings.filter((m) => m.ordering === 'tvdb' && m.unit === 'S2E1')).toEqual([
      { unit: 'S2E1', ordering: 'tvdb', season: 1, episode: 13, absolute: undefined, source: 'xem' },
    ]);
    expect(metadata).toMatchObject({ mappingStatus: 'complete', mappingNotes: [] });
    expect(aliases).toContainEqual({ title: 'Northbound', source: 'xem', anidbId: undefined });
  });

  test('a partial XEM map writes no XEM rows: "partly mapped", with the counts', async () => {
    await seedXemList(t, [7700003]);
    useMetadataFakes({ xem: { shows: { 7700003: { all: partial } } } });
    const { workId } = await subscribe('900003', [1, 2]);
    const { mappings, metadata } = await stored(workId);
    expect(mappings.filter((m) => m.source === 'xem')).toEqual([]);
    expect(metadata).toMatchObject({ mappingStatus: 'partial', mappingNotes: ['XEM lists 23 regular episodes, TMDB 24; XEM numbers are not linked.'] });
  });
});

describe("XEM's names in a sync", () => {
  const xemAliases = (workId: Id<'works'>) =>
    t.run(async (ctx) =>
      (
        await ctx.db
          .query('workAliases')
          .withIndex('by_work', (q) => q.eq('workId', workId))
          .collect()
      )
        .filter((alias) => alias.source === 'xem')
        .map(({ title, sceneSeason }) => ({ title, sceneSeason })),
    );

  test("a sync asks XEM only for the Work's map and takes its names from the daily fetch, each with its scene season", async () => {
    const requests = useMetadataFakes({ series: [...SERIES, jojoParts()], xem: { shows: { 7700009: { all: jojoPartsShape, names: jojoPartsNames } } } });
    await fetchXem(t);
    requests.length = 0;
    const { workId } = await subscribe('900009', [5, 6]);
    expect(requests.filter((url) => url.hostname === 'thexem.info').map((url) => url.pathname)).toEqual(['/map/all']);
    expect(await xemAliases(workId)).toEqual(
      expect.arrayContaining([
        { title: "JoJo's Bizarre Adventure - Stone Ocean", sceneSeason: 5 },
        { title: "JoJo's Bizarre Adventure (2012)", sceneSeason: undefined },
      ]),
    );
  });

  test('a Work XEM has a map for but no names gets no XEM aliases', async () => {
    useMetadataFakes({ xem: { shows: { 7700003: { all: blackLagoonShape } } } });
    await fetchXem(t);
    const { workId } = await subscribe('900003', [1, 2]);
    expect(await xemAliases(workId)).toEqual([]);
  });
});

describe('TMDB restructures a season', () => {
  test('moves Units by their TMDB IDs, retires the deleted one, rebuilds absolute rows and keeps manual ones', async () => {
    const { workId } = await subscribe('900001', [1, 2]);
    const before = await stored(workId);
    const unitOf = (tmdbId: string) => before.unitIds.find((u) => u.ids.some(([, value]) => value === tmdbId))!.unit;
    const moved = before.units.find((u) => `S${u.tmdbSeason}E${u.tmdbEpisode}` === unitOf('910103'))!;
    const placeholder = before.units.find((u) => `S${u.tmdbSeason}E${u.tmdbEpisode}` === unitOf('910205'))!;
    // S1E4 has a file and a visible Publication; the user mapped S1E1 by hand.
    const versionId = await t.run(async (ctx) => {
      const playbackProfileId = (await ctx.db.query('playbackProfiles').first())!._id;
      const fileId = await ctx.db.insert('files', { path: '/data/library/series/hl.mkv', sizeBytes: 1, inode: '1:1', origin: 'scan', role: 'source' });
      await ctx.db.insert('fileUnits', { fileId, unitId: moved._id });
      const fileVersionId = await ctx.db.insert('fileVersions', { unitId: moved._id, fileId, kind: 'primary', playbackProfileId, fits: true });
      const jobId = await ctx.db.insert('jobs', {
        class: 'publish',
        status: 'done',
        attempt: 1,
        maxAttempts: 5,
        leaseEpoch: 1,
        idempotencyKey: 'publish:1',
        protocolVersion: 1,
        cancelRequested: false,
      });
      await ctx.db.insert('publications', { unitId: moved._id, fileVersionId, jobId, generation: 0, target: 'jellyfin', state: 'visible' });
      const s1e1 = before.units.find((u) => u.tmdbSeason === 1 && u.tmdbEpisode === 1)!;
      await ctx.db.insert('unitMappings', { unitId: s1e1._id, workId, ordering: 'scene', season: 1, episode: 1, source: 'manual' });
      return fileVersionId;
    });

    useMetadataFakes({ series: [harbourLightsRestructured()] });
    await t.action(internal.metadata.sync.syncWork, { workId });
    const after = await stored(workId);

    expect(after.units.find((u) => u._id === moved._id)).toMatchObject({ tmdbSeason: 2, tmdbEpisode: 1 });
    expect(await t.run((ctx) => ctx.db.get(versionId))).toMatchObject({ unitId: moved._id });
    expect(after.units.find((u) => u._id === placeholder._id)).toMatchObject({ monitored: false });
    const retired = await t.run((ctx) =>
      ctx.db
        .query('unitMetadata')
        .withIndex('by_unit', (q) => q.eq('unitId', placeholder._id))
        .unique(),
    );
    expect(retired).toMatchObject({ retiredAt: expect.any(Number) });
    expect(retired).not.toHaveProperty('overview');

    const absolute = after.mappings.filter((m) => m.ordering === 'absolute').sort((a, b) => a.absolute! - b.absolute!);
    expect(absolute.map((m) => m.unit)).toEqual(['S1E1', 'S1E2', 'S1E3', 'S2E1', 'S2E2', 'S2E3', 'S3E1', 'S3E2', 'S3E3', 'S3E4', 'S3E5']);
    expect(after.mappings.filter((m) => m.source === 'manual')).toEqual([
      { unit: 'S1E1', ordering: 'scene', season: 1, episode: 1, absolute: undefined, source: 'manual' },
    ]);

    const events = await t.run((ctx) =>
      ctx.db
        .query('events')
        .withIndex('by_unit_at', (q) => q.eq('unitId', moved._id))
        .collect(),
    );
    // The subscribe search's event comes first.
    expect(events.filter((e) => e.stage === 'system')).toEqual([
      expect.objectContaining({ stage: 'system', kind: 'metadataChanged', data: { from: 'S01E04', to: 'S02E01' } }),
    ]);

    // The Work page hides the retired Unit, which has no file.
    const detail = await admin.query(api.api.library.detail, { workId });
    expect(detail!.units.map((u) => u.unitId)).not.toContain(placeholder._id);
    expect(detail!.units).toHaveLength(12);
  });

  test('a retired Unit with a file version stays on the Work page', async () => {
    const { workId } = await subscribe('900001', [1, 2]);
    const placeholder = (await stored(workId)).units.find((u) => u.tmdbSeason === 2 && u.tmdbEpisode === 6)!;
    await t.run(async (ctx) => {
      const playbackProfileId = (await ctx.db.query('playbackProfiles').first())!._id;
      const fileId = await ctx.db.insert('files', { path: '/data/x.mkv', sizeBytes: 1, inode: '1:2', origin: 'scan', role: 'source' });
      await ctx.db.insert('fileVersions', { unitId: placeholder._id, fileId, kind: 'primary', playbackProfileId, fits: true });
    });
    useMetadataFakes({ series: [harbourLightsRestructured()] });
    await t.action(internal.metadata.sync.syncWork, { workId });
    expect((await admin.query(api.api.library.detail, { workId }))!.units.map((u) => u.unitId)).toContain(placeholder._id);
  });
});

describe('a sync that changes Unit titles calls naming.unitsRetitled', () => {
  const SEASON_1 = '/data/library/series/Harbour Lights (2021) [tmdbid-900001]/Season 01';
  const NAME = (title: string) => `${SEASON_1}/Harbour Lights (2021) - S01E01${title} [AMZN][WEBDL-1080p][EAC3 5.1][h264]-GRP.mkv`;
  const renames = () => t.run(async (ctx) => (await ctx.db.query('jobs').collect()).filter((job) => job.class === 'maintenance').map((job) => job.payload));

  async function harbourWithFile(path: string) {
    const { workId } = await subscribe('900001', [1]);
    const s1e1 = await t.run(
      async (ctx) =>
        (await ctx.db
          .query('units')
          .withIndex('by_work_tmdb', (q) => q.eq('workId', workId).eq('tmdbSeason', 1).eq('tmdbEpisode', 1))
          .unique())!,
    );
    await seedFile(t, { unitIds: [s1e1._id], path });
    return workId;
  }

  const retitled = (name: string) => {
    const series = SERIES[0]!;
    return {
      ...series,
      seasons: series.seasons.map((season) =>
        season.season_number === 1 ? { ...season, episodes: season.episodes.map((e) => (e.episode_number === 1 ? { ...e, name } : e)) } : season,
      ),
    };
  };

  test('a placeholder title replaced by a real one renames the file', async () => {
    const workId = await harbourWithFile(NAME(''));
    useMetadataFakes({ series: [retitled('Lamplight'), ...SERIES.slice(1)] });
    await t.action(internal.metadata.sync.syncWork, { workId });
    expect(await renames()).toEqual([expect.objectContaining({ action: 'renameLibraryFile', from: NAME(''), to: NAME(' - Lamplight') })]);
  });

  test('a sync that changes no title renames nothing, even a file whose name is out of date', async () => {
    const workId = await harbourWithFile(`${SEASON_1}/Harbour Lights - 1x01.mkv`);
    await t.action(internal.metadata.sync.syncWork, { workId });
    expect(await renames()).toEqual([]);
  });
});

describe('sync failures and limits', () => {
  test('a failed TMDB fetch changes nothing, and the sync fails for the pool to retry', async () => {
    const { workId } = await subscribe('900001', [1, 2]);
    const before = await stored(workId);
    vi.stubGlobal('fetch', async () => {
      throw new TypeError('fetch failed');
    });
    await expect(t.action(internal.metadata.sync.syncWork, { workId })).rejects.toThrow(/metadataUnavailable/);
    expect(await stored(workId)).toEqual(before);
  });

  test('a XEM timeout keeps the xem rows, XEM aliases and status, with a note', async () => {
    await seedXemList(t, [7700003]);
    useMetadataFakes({ xem: { shows: { 7700003: { all: blackLagoonShape, names: [{ Northbound: -1 }] } } } });
    await fetchXem(t);
    const { workId } = await subscribe('900003', [1, 2]);
    const before = await stored(workId);
    useMetadataFakes({ xem: { down: true } });
    await t.action(internal.metadata.sync.syncWork, { workId });
    const after = await stored(workId);
    expect(after.mappings.filter((m) => m.source === 'xem')).toEqual(before.mappings.filter((m) => m.source === 'xem'));
    expect(after.aliases).toContainEqual({ title: 'Northbound', source: 'xem', anidbId: undefined });
    expect(after.metadata).toMatchObject({
      mappingStatus: 'complete',
      mappingNotes: ['XEM could not be reached; its numbers are from the last successful fetch.'],
    });
  });

  test("a XEM timeout keeps the stored season names, whose scene seasons come from XEM's rows", async () => {
    const season6AsScene7 = {
      ...jojoPartsShape,
      data: jojoPartsShape.data.map((entry) => (entry.scene.season === 6 ? { ...entry, scene: { ...entry.scene, season: 7 } } : entry)),
    };
    await seedXemList(t, [7700009]);
    useMetadataFakes({ series: [...SERIES, jojoParts()], xem: { shows: { 7700009: { all: season6AsScene7, names: jojoPartsNames } } } });
    await fetchXem(t);
    const { workId } = await subscribe('900009', [5, 6]);
    const before = (await stored(workId)).metadata?.seasonNames;
    expect(before).toContainEqual(expect.objectContaining({ season: 6, sceneSeason: 7 }));
    useMetadataFakes({ series: [...SERIES, jojoParts()], xem: { down: true } });
    await t.action(internal.metadata.sync.syncWork, { workId });
    expect((await stored(workId)).metadata?.seasonNames).toEqual(before);
  });

  test('a Work deleted while its sync runs makes every write a no-op', async () => {
    const { workId } = await subscribe('900001', [1]);
    await t.run(async (ctx) => {
      for (const unit of await ctx.db.query('units').collect()) await ctx.db.delete(unit._id);
      await ctx.db.delete(workId);
    });
    await t.mutation(internal.metadata.write.applyUnitPlan, {
      workId,
      batch: { creates: [{ unit: { kind: 'episode', tmdbId: '1', tmdbSeason: 1, tmdbEpisode: 1 }, monitored: true }], updates: [], unretires: [], retires: [] },
    });
    await t.mutation(internal.metadata.write.applyMappings, { workId, version: 9, rows: [{ key: '1', ordering: 'absolute', absolute: 1, source: 'tmdb' }] });
    const page = await t.mutation(internal.metadata.write.finishWrite, {
      workId,
      version: 9,
      cursor: null,
      keepXem: { rows: false, aliases: false },
      aliases: [{ title: 'X', normalized: 'x', source: 'tmdb' }],
      fields: {
        title: 'X',
        genreIds: [],
        originCountry: [],
        numberingSuggestion: { scheme: 'standard', reason: 'none' },
        mappingStatus: 'tmdbOnly',
        mappingNotes: [],
        nextSyncAt: 0,
        externalIds: [],
      },
    });
    expect(page).toEqual({ done: true, cursor: null });
    expect(await t.run((ctx) => ctx.db.query('units').collect())).toEqual([]);
    expect(await t.run((ctx) => ctx.db.query('workAliases').collect())).toHaveLength(1);
  });

  test('the 1,100-episode series is written in full, at most 200 Units per write', async () => {
    useMetadataFakes({ series: [longSeries()] });
    const { workId } = await subscribe('900004', [1, 2]);
    const { units, mappings, metadata } = await stored(workId);
    expect(units).toHaveLength(1100);
    expect(mappings.filter((m) => m.ordering === 'absolute')).toHaveLength(1100);
    expect(metadata).toMatchObject({ buildState: 'ready' });
    expect(units.filter((u) => u.monitored)).toHaveLength(100);
    // CPU-bound in convex-test: 2–6 s alone, up to 7 s beside the other packages' tests in `bun run ready`,
    // past the 5 s default. The ceiling is for a hang, not for speed.
  }, 60_000);

  test('the plan is cut into batches of at most 200 Units, in order', () => {
    const creates = Array.from({ length: 450 }, (_, i) => ({ unit: { kind: 'episode' as const, tmdbId: String(i) }, monitored: true }));
    const retires = [{ unitId: 'u' as Id<'units'>, change: { from: 'S01E01', to: 'retired' } }];
    const cut = unitBatches({ creates, updates: [], unretires: [], retires }, UNITS_PER_BATCH);
    expect(cut.map((b) => b.creates.length + b.retires.length)).toEqual([200, 200, 51]);
    expect(cut[2]!.retires).toEqual(retires);
  });

  test('subscribe fetches TMDB once: one details call, one per season, no external IDs call', async () => {
    const requests = useMetadataFakes();
    await subscribe('900002', [1, 2]);
    const tmdb = requests.filter((url) => url.hostname === 'tmdb.fake').map((url) => url.pathname);
    expect(tmdb.sort()).toEqual(['/3/tv/900002', '/3/tv/900002/season/1', '/3/tv/900002/season/2', '/3/tv/episode_group/5f0000000000000000000001']);
  });

  test('a failed first write ends "failed"; the Work and its TMDB ID stay, so a retry cannot duplicate it', async () => {
    failures.write = true;
    const { workId, created } = await subscribe('900001', [1, 2]);
    failures.write = false;
    expect(created).toBe(true);
    const { workIds, units, metadata } = await stored(workId);
    expect(metadata).toMatchObject({ buildState: 'failed' });
    expect(workIds).toEqual([['tmdb', '900001']]);
    expect(units).toEqual([]);
    expect(await subscribe('900001', [1, 2])).toEqual({ workId, created: false });
  });

  test('a retry of a failed first write monitors the seasons ticked at subscribe, then forgets them', async () => {
    failures.write = true;
    const { workId } = await subscribe('900001', [2]);
    failures.write = false;
    expect((await stored(workId)).metadata).toMatchObject({ buildState: 'failed', initialSeasons: [2] });

    // "Try again" and the tick both retry through syncWork.
    await t.action(internal.metadata.sync.syncWork, { workId });
    const { units, metadata } = await stored(workId);
    const monitored = (season: number) => units.filter((u) => u.tmdbSeason === season).map((u) => u.monitored);
    expect(monitored(0)).toEqual([false]);
    expect(monitored(1)).toEqual(Array(6).fill(false));
    expect(monitored(2)).toEqual(Array(6).fill(true));
    expect(metadata).toMatchObject({ buildState: 'ready' });
    expect(metadata).not.toHaveProperty('initialSeasons');
  });

  test('a successful first write at subscribe forgets the ticked seasons', async () => {
    const { workId } = await subscribe('900001', [2]);
    expect((await stored(workId)).metadata).not.toHaveProperty('initialSeasons');
  });
});

describe('season names', () => {
  test('a series XEM does not list names each named season, with no scene season', async () => {
    useMetadataFakes({ series: [...SERIES, jojoParts()] });
    const { workId } = await subscribe('900009', [5, 6]);
    expect((await stored(workId)).metadata?.seasonNames).toEqual([
      { season: 1, name: 'Phantom Blood & Battle Tendency', normalized: 'phantom blood and battle tendency' },
      { season: 2, name: 'Stardust Crusaders', normalized: 'stardust crusaders' },
      { season: 3, name: 'Diamond Is Unbreakable', normalized: 'diamond is unbreakable' },
      { season: 4, name: 'Golden Wind', normalized: 'golden wind' },
      { season: 5, name: 'Stone Ocean', normalized: 'stone ocean' },
      { season: 6, name: 'Steel Ball Run', normalized: 'steel ball run' },
    ]);
  });
});

describe('subscribe to a standard series', () => {
  test('writes the Work, its external IDs, one Unit per TMDB episode with its ID, and absolute rows only', async () => {
    const { workId } = await subscribe('900001', [1, 2]);
    const { workIds, units, unitIds, mappings, aliases, metadata } = await stored(workId);

    expect(workIds).toEqual([
      ['tmdb', '900001'],
      ['tvdb', '7700001'],
      ['imdb', 'tt9900001'],
    ]);
    expect(units).toHaveLength(13);
    expect(unitIds.find((u) => u.unit === 'S2E6')!.ids).toEqual([['tmdb', '910205']]);
    expect(units.find((u) => u.tmdbSeason === 0)).toMatchObject({ kind: 'special', monitored: false });

    expect(mappings.filter((m) => m.ordering !== 'absolute')).toEqual([]);
    expect(mappings.map((m) => [m.unit, m.absolute, m.source]).sort((a, b) => (a[1] as number) - (b[1] as number))).toEqual([
      ...[1, 2, 3, 4, 5, 6].map((e) => [`S1E${e}`, e, 'tmdb']),
      ...[1, 2, 3, 4, 5, 6].map((e) => [`S2E${e}`, 6 + e, 'tmdb']),
    ]);

    expect(metadata).toMatchObject({
      buildState: 'ready',
      mappingStatus: 'tmdbOnly',
      mappingNotes: [],
      numberingSuggestion: { scheme: 'standard', reason: 'none' },
      overview: 'A lighthouse keeper and the town below.',
      posterPath: '/harbour-lights.jpg',
      originalLanguage: 'en',
      tmdbStatus: 'Returning Series',
      projectionVersion: 1,
    });
    expect(aliases).toEqual([{ title: 'Harbour Lights', source: 'tmdb', anidbId: undefined }]);
  });

  test('gives each Unit its display data', async () => {
    const { workId } = await subscribe('900001', [1, 2]);
    const s1e1 = await t.run(async (ctx) => {
      const unit = await ctx.db
        .query('units')
        .withIndex('by_work_tmdb', (q) => q.eq('workId', workId).eq('tmdbSeason', 1).eq('tmdbEpisode', 1))
        .unique();
      return await ctx.db
        .query('unitMetadata')
        .withIndex('by_unit', (q) => q.eq('unitId', unit!._id))
        .unique();
    });
    expect(s1e1).toMatchObject({ overview: 'Season 1, episode 1.', stillPath: '/still-910100.jpg', runtimeMin: 45 });
  });
});
