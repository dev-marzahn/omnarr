// The matching functions: findWorksByTitle, resolveUnits and searchKeys,
// against Works written by the real subscribe path with TMDB, XEM and
// Anime-Lists behind fakes.
import type { IndexerItem, MatchedAlias, ResolveOrdering } from '@omnarr/contracts';
import { attackOnTitan as attackOnTitanSeries, emberRite as emberRiteSeries, jojoParts, SERIES } from '@omnarr/e2e/fakes/tmdb/fixtures';
import { parseRelease } from '@omnarr/parser';
import { matchTitle } from '@omnarr/scoring';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';

import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { findWorksByTitle, resolveUnits, searchKeys } from '../../convex/metadata/resolve';
import { workForSearch } from '../../convex/pipeline/search';
import missingSeasonXml from '../fixtures/animeLists/missingSeason.xml?raw';
import blackLagoonShape from '../fixtures/xem/blackLagoonShape.json';
import jojoPartsNames from '../fixtures/xem/jojoPartsNames.json';
import jojoPartsShape from '../fixtures/xem/jojoPartsShape.json';
import missingSeasonShape from '../fixtures/xem/missingSeasonShape.json';
import { asAdmin, seedAnimeLists, seedLibraries, seedXemList, setup, useMetadataFakes, type Backend, type Libraries } from '../setup';

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

const subscribe = async (tmdbId: string, seasons: number[]) =>
  (
    await admin.action(api.api.library.subscribe, {
      tmdbId,
      kind: 'series',
      libraryId: libraries.series,
      releaseProfileId: libraries.releaseProfileId,
      seasons,
    })
  ).workId;

/** The Unit's TMDB numbers, as `S2E1`. */
const label = (unitId: Id<'units'>) =>
  t.run(async (ctx) => {
    const unit = (await ctx.db.get(unitId))!;
    return `S${unit.tmdbSeason}E${unit.tmdbEpisode}`;
  });

/** Parses a release title and resolves it the way search and RSS do: through the alias the title matched. */
async function resolveTitle(workId: Id<'works'>, title: string) {
  const parsed = parseRelease(title, 'series');
  return t.run(async (ctx) => {
    const anidbId = (await findWorksByTitle(ctx, parsed.normalizedTitle)).find((match) => match.workId === workId)?.anidbId;
    return resolveUnits(ctx, workId, parsed.episodes, parsed.airDate, anidbId === undefined ? { kind: 'plain' } : { kind: 'anidb', anidbId });
  });
}

describe('a release resolves to its Unit', () => {
  test('Harbour.Lights.S02E03 resolves to TMDB S2E3 with confidence assumed', async () => {
    const workId = await subscribe('900001', [1, 2]);
    const result = await resolveTitle(workId, 'Harbour.Lights.S02E03.1080p.WEB-DL.DDP5.1.H.264-GRP');
    expect(result).toMatchObject({ confidence: 'assumed', via: { ordering: 'tmdb', source: 'tmdb' } });
    expect(result.problem).toBeUndefined();
    expect(await Promise.all(result.unitIds.map(label))).toEqual(['S2E3']);
  });

  test('"Star Lantern - 13" resolves by absolute number to S2E1 (mapped), skipping the AniDB ordering', async () => {
    await seedAnimeLists(t);
    const workId = await subscribe('900002', [1, 2]);
    const result = await resolveTitle(workId, '[Group] Star Lantern - 13 [1080p]');
    expect(result).toMatchObject({ confidence: 'mapped', via: { ordering: 'absolute', source: 'tmdb' } });
    expect(await Promise.all(result.unitIds.map(label))).toEqual(['S2E1']);
  });

  test('"Star Lantern 2nd Season - 01" resolves through the anidb:17002 alias to the same Unit', async () => {
    await seedAnimeLists(t);
    const workId = await subscribe('900002', [1, 2]);
    const result = await resolveTitle(workId, '[Group] Star Lantern 2nd Season - 01 [1080p]');
    expect(result).toMatchObject({ confidence: 'mapped', via: { ordering: 'anidb:17002', source: 'animeLists' } });
    expect(await Promise.all(result.unitIds.map(label))).toEqual(['S2E1']);
  });

  test('Show.S02E01 resolves through its scene row to TMDB S2E1 (mapped)', async () => {
    await seedXemList(t, [7700003]);
    useMetadataFakes({ xem: { shows: { 7700003: { all: blackLagoonShape } } } });
    const workId = await subscribe('900003', [1, 2]);
    const result = await resolveTitle(workId, 'Northbound.Signal.S02E01.1080p.WEB-DL.DDP5.1.H.264-GRP');
    expect(result).toMatchObject({ confidence: 'mapped', via: { ordering: 'scene', source: 'xem' } });
    expect(await Promise.all(result.unitIds.map(label))).toEqual(['S2E1']);
  });
});

/** Northbound Signal with XEM's map: scene 2 × 12, TVDB 1 × 24, TMDB 2 × 12. */
async function northbound() {
  await seedXemList(t, [7700003]);
  useMetadataFakes({ xem: { shows: { 7700003: { all: blackLagoonShape } } } });
  return subscribe('900003', [1, 2]);
}

const unitAt = (workId: Id<'works'>, season: number, episode: number) =>
  t.run(
    async (ctx) =>
      (await ctx.db
        .query('units')
        .withIndex('by_work_tmdb', (q) => q.eq('workId', workId).eq('tmdbSeason', season).eq('tmdbEpisode', episode))
        .unique())!,
  );

const resolve = (
  workId: Id<'works'>,
  episodes: { season?: number; episode?: number; absolute?: number }[],
  airDate?: string,
  alias: MatchedAlias = { kind: 'plain' },
) => t.run((ctx) => resolveUnits(ctx, workId, episodes, airDate, alias));

describe('resolveUnits rules', () => {
  test('rule 1: an air date names the Unit on that calendar day (mapped)', async () => {
    const workId = await subscribe('900001', [1, 2]);
    // Harbour Lights S1 starts on 2021-03-04, weekly.
    const result = await resolve(workId, [], '2021-03-11');
    expect(result).toMatchObject({ confidence: 'mapped', via: { ordering: 'airDate', source: 'tmdb' } });
    expect(await Promise.all(result.unitIds.map(label))).toEqual(['S1E2']);
  });

  test('rule 1: two Units on one date are ambiguous', async () => {
    const workId = await subscribe('900001', [1, 2]);
    const second = await unitAt(workId, 1, 3);
    await t.run((ctx) => ctx.db.patch(second._id, { airDateUtc: Date.parse('2021-03-11T00:00:00Z') }));
    expect((await resolve(workId, [], '2021-03-11')).problem).toBe('ambiguous');
  });

  test('rule 1 falls through to the numbers when no Unit aired that day', async () => {
    const workId = await subscribe('900001', [1, 2]);
    const result = await resolve(workId, [{ season: 1, episode: 4 }], '1999-01-01');
    expect(await Promise.all(result.unitIds.map(label))).toEqual(['S1E4']);
  });

  test('rule 2 falls through when the AniDB ordering lacks the number', async () => {
    await seedAnimeLists(t);
    const workId = await subscribe('900002', [1, 2]);
    const result = await resolve(workId, [{ absolute: 14 }], undefined, { kind: 'anidb', anidbId: 17002 });
    expect(result).toMatchObject({ via: { ordering: 'absolute' } });
    expect(await Promise.all(result.unitIds.map(label))).toEqual(['S2E2']);
  });

  test('rule 3: a TVDB number (S01E13) resolves through the tvdb row when no scene row has it', async () => {
    const workId = await northbound();
    const result = await resolve(workId, [{ season: 1, episode: 13 }]);
    expect(result).toMatchObject({ confidence: 'mapped', via: { ordering: 'tvdb', source: 'xem' } });
    expect(await Promise.all(result.unitIds.map(label))).toEqual(['S2E1']);
  });

  test('rule 3: a season with no episode returns the whole season in the ordering used', async () => {
    const workId = await northbound();
    const result = await resolve(workId, [{ season: 2 }]);
    expect(result.via.ordering).toBe('scene');
    expect((await Promise.all(result.unitIds.map(label))).sort()).toEqual(Array.from({ length: 12 }, (_, i) => `S2E${i + 1}`).sort());
  });

  test('rule 3: TMDB numbers are unverified for a Work with partial mapping data', async () => {
    const workId = await subscribe('900001', [1, 2]);
    const metadata = await t.run(async (ctx) => (await ctx.db.query('workMetadata').first())!);
    await t.run((ctx) => ctx.db.patch(metadata._id, { mappingStatus: 'partial' }));
    expect((await resolve(workId, [{ season: 1, episode: 1 }])).confidence).toBe('unverified');
  });

  test('rule 4: absolute numbers on a standard Work are a scheme mismatch', async () => {
    const workId = await subscribe('900001', [1, 2]);
    expect((await resolve(workId, [{ absolute: 3 }])).problem).toBe('schemeMismatch');
  });

  test('rule 4: a manual row wins over the absolute row', async () => {
    await seedAnimeLists(t);
    const workId = await subscribe('900002', [1, 2]);
    const target = await unitAt(workId, 1, 5);
    await t.run((ctx) => ctx.db.insert('unitMappings', { unitId: target._id, workId, ordering: 'absolute', absolute: 13, source: 'manual' }));
    const result = await resolve(workId, [{ absolute: 13 }]);
    expect(result).toMatchObject({ via: { ordering: 'absolute', source: 'manual' } });
    expect(await Promise.all(result.unitIds.map(label))).toEqual(['S1E5']);
  });

  test('rule 5: SxxEyy and an absolute number naming different Units are ambiguous', async () => {
    await seedAnimeLists(t);
    const workId = await subscribe('900002', [1, 2]);
    expect((await resolve(workId, [{ season: 1, episode: 1, absolute: 13 }])).problem).toBe('ambiguous');
    expect((await resolve(workId, [{ season: 2, episode: 1, absolute: 13 }])).problem).toBeUndefined();
  });

  test('rule 5: a multi-episode release with an unresolvable number is notFound', async () => {
    const workId = await subscribe('900001', [1, 2]);
    const result = await resolve(workId, [
      { season: 1, episode: 6 },
      { season: 1, episode: 7 },
    ]);
    expect(result).toMatchObject({ unitIds: [], problem: 'notFound' });
  });

  test('retired Units are never returned', async () => {
    const workId = await subscribe('900001', [1, 2]);
    const unit = await unitAt(workId, 1, 2);
    await t.run(async (ctx) => {
      const meta = await ctx.db
        .query('unitMetadata')
        .withIndex('by_unit', (q) => q.eq('unitId', unit._id))
        .unique();
      await ctx.db.patch(meta!._id, { retiredAt: Date.now() });
    });
    expect((await resolve(workId, [{ season: 1, episode: 2 }])).problem).toBe('notFound');
    expect((await resolve(workId, [], '2021-03-11')).problem).toBe('notFound');
  });

  test('a movie resolves to its one Unit', async () => {
    const workId = (
      await admin.action(api.api.library.subscribe, {
        tmdbId: '900101',
        kind: 'movie',
        libraryId: libraries.movies,
        releaseProfileId: libraries.releaseProfileId,
        seasons: [],
      })
    ).workId;
    const result = await resolve(workId, []);
    expect(result).toMatchObject({ confidence: 'mapped', unitIds: [expect.any(String)] });
  });
});

describe("resolveUnits' orderings argument (the scan's ordering trial)", () => {
  const resolveIn = (workId: Id<'works'>, episodes: { season?: number; episode?: number; absolute?: number }[], orderings: ResolveOrdering[]) =>
    t.run((ctx) => resolveUnits(ctx, workId, episodes, undefined, { kind: 'plain' }, { orderings }));

  test('tmdb alone reads TMDB numbers and skips the scene and tvdb rows', async () => {
    const workId = await northbound();
    // S01E13 is TVDB's; TMDB's season 1 has 12 episodes.
    expect(await resolveIn(workId, [{ season: 1, episode: 13 }], ['tmdb'])).toMatchObject({ unitIds: [], problem: 'notFound' });
    const result = await resolveIn(workId, [{ season: 2, episode: 1 }], ['tmdb']);
    expect(result.via).toEqual({ ordering: 'tmdb', source: 'tmdb' });
    expect(await Promise.all(result.unitIds.map(label))).toEqual(['S2E1']);
  });

  test('tvdb alone reads only tvdb rows', async () => {
    const workId = await northbound();
    const result = await resolveIn(workId, [{ season: 1, episode: 13 }], ['tvdb']);
    expect(result).toMatchObject({ via: { ordering: 'tvdb', source: 'xem' }, confidence: 'mapped' });
    expect(await Promise.all(result.unitIds.map(label))).toEqual(['S2E1']);
    // TVDB has one season, so S02E01 isn't one of its numbers, and TMDB's isn't tried.
    expect(await resolveIn(workId, [{ season: 2, episode: 1 }], ['tvdb'])).toMatchObject({ unitIds: [], problem: 'notFound' });
  });

  test('scene alone reads only scene rows', async () => {
    const workId = await northbound();
    expect((await resolveIn(workId, [{ season: 2, episode: 1 }], ['scene'])).via.ordering).toBe('scene');
    expect((await resolveIn(workId, [{ season: 1, episode: 13 }], ['scene'])).problem).toBe('notFound');
  });

  test('absolute alone reads absolute rows and ignores season and episode', async () => {
    await seedAnimeLists(t);
    const workId = await subscribe('900002', [1, 2]);
    const result = await resolveIn(workId, [{ absolute: 13 }], ['absolute']);
    expect(result.via.ordering).toBe('absolute');
    expect(await Promise.all(result.unitIds.map(label))).toEqual(['S2E1']);
    expect((await resolveIn(workId, [{ season: 1, episode: 2 }], ['absolute'])).problem).toBe('notFound');
    expect((await resolveIn(workId, [{ absolute: 13 }], ['tmdb'])).problem).toBe('notFound');
  });

  test('without the argument the rules are unchanged', async () => {
    const workId = await northbound();
    expect((await t.run((ctx) => resolveUnits(ctx, workId, [{ season: 1, episode: 13 }], undefined, { kind: 'plain' }, {}))).via.ordering).toBe('tvdb');
  });
});

/**
 * Ember Rite (TMDB 900007), the real JUJUTSU KAISEN shape: TMDB
 * merged it into one season of 10; TVDB, by XEM, has 4 + 3 + 3; XEM's scene
 * numbering has seasons 1 (1–7) and 3 (absolute 1–3 again); Anime-Lists
 * points the second-season entry (17012) at a TMDB season 2 that's gone.
 */
async function emberRite(options: { xem?: boolean; xemMap?: typeof missingSeasonShape } = {}) {
  const xem = options.xem ?? true;
  await seedAnimeLists(t, 'fixture-v1', missingSeasonXml);
  if (xem) await seedXemList(t, [7700007]);
  useMetadataFakes({
    series: [...SERIES, emberRiteSeries()],
    ...(xem ? { xem: { shows: { 7700007: { all: options.xemMap ?? missingSeasonShape } } } } : {}),
  });
  return subscribe('900007', [1]);
}

/** XEM's map with scene season 3 listed first. */
const sceneSeason3First = { ...missingSeasonShape, data: [...missingSeasonShape.data.slice(7), ...missingSeasonShape.data.slice(0, 7)] };

/** Parses a release title and resolves it the way search does: matchTitle on the Work's view, then resolveUnits with what it matched. */
async function matchAndResolve(workId: Id<'works'>, title: string, options: { ids?: boolean } = {}) {
  const parsed = parseRelease(title, 'series');
  return t.run(async (ctx) => {
    const work = await workForSearch(ctx, (await ctx.db.get(workId))!);
    const item = indexerItem(title, work.ids.tvdb!);
    const matched = matchTitle(parsed, options.ids === false ? { ...item, ids: {} } : item, work);
    if (!matched.ok) return matched;
    const resolved = await resolveUnits(ctx, workId, parsed.episodes, parsed.airDate, matched.alias);
    return {
      ...resolved,
      labels: await Promise.all(resolved.unitIds.map(async (id) => `S${(await ctx.db.get(id))!.tmdbSeason}E${(await ctx.db.get(id))!.tmdbEpisode}`)),
    };
  });
}

/** An indexer result carrying the Work's TVDB ID, as real indexer results for it do. */
const indexerItem = (title: string, tvdbid: string): IndexerItem => ({
  guid: title,
  title,
  downloadUrl: 'https://indexer.fake/get',
  sizeBytes: 1,
  protocol: 'usenet',
  publishedAt: 0,
  categories: [5070],
  ids: { tvdbid },
});

describe('a season-numbered anime release on a Work TMDB merged into one season', () => {
  test.each(['[Erai-raws] Ember Rite 2nd Season - 02 [1080p]', '[New-raws] Ember Rite.S2 - 02 [1080p]', '[DMFS] Ember Rite S02 - 02 [1080p]'])(
    '%s is TVDB S2E2, TMDB E6, not E2',
    async (title) => {
      const workId = await emberRite();
      const result = await matchAndResolve(workId, title);
      expect(result).toMatchObject({ labels: ['S1E6'], confidence: 'mapped' });
      expect(result).not.toHaveProperty('problem');
    },
  );

  describe('rule 4: scene season 3 reuses absolute 1–3, so two scene rows share each of those numbers', () => {
    test.each([
      ['in XEM order', missingSeasonShape],
      ['with scene season 3 listed first', sceneSeason3First],
    ])('the release is ambiguous, though the absolute row names E2 (%s)', async (_order, xemMap) => {
      const workId = await emberRite({ xemMap });
      expect(await matchAndResolve(workId, '[SubsPlease] Ember Rite - 02 (1080p)')).toMatchObject({ labels: [], problem: 'ambiguous' });
    });

    test('a manual row still answers', async () => {
      const workId = await emberRite();
      const e2 = await unitAt(workId, 1, 2);
      await t.run((ctx) => ctx.db.insert('unitMappings', { unitId: e2._id, workId, ordering: 'absolute', absolute: 2, source: 'manual' }));
      expect(await matchAndResolve(workId, '[SubsPlease] Ember Rite - 02 (1080p)')).toMatchObject({
        labels: ['S1E2'],
        via: { ordering: 'absolute', source: 'manual' },
      });
    });

    test('a number only one scene row carries still resolves through it', async () => {
      const workId = await emberRite({ xemMap: sceneSeason3First });
      expect(await matchAndResolve(workId, '[SubsPlease] Ember Rite - 05 (1080p)')).toMatchObject({
        labels: ['S1E5'],
        via: { ordering: 'scene', source: 'xem' },
      });
    });
  });

  test('without XEM nothing places season 2 on TMDB, so the release is notFound rather than E2', async () => {
    const workId = await emberRite({ xem: false });
    for (const title of ['[Erai-raws] Ember Rite 2nd Season - 02 [1080p]', '[DMFS] Ember Rite S02 - 02 [1080p]'])
      expect(await matchAndResolve(workId, title)).toMatchObject({ labels: [], problem: 'notFound' });
  });

  test('a hyphenated cour title matches its alias and resolves through its AniDB entry', async () => {
    const workId = await emberRite();
    // As `Jujutsu Kaisen-Shimetsu Kaiyuu-Zenpen-12`: too few whole words left for the ID rule.
    expect(await matchAndResolve(workId, '[Erai-raws] Ember Rite-Ashen Vigil-Arc-03 [1080p]')).toMatchObject({
      labels: ['S1E10'],
      via: { ordering: 'anidb:17013' },
    });
  });

  test("the second-season entry's own alias, whose TMDB season is gone, is notFound rather than E2", async () => {
    const workId = await emberRite();
    expect(await matchAndResolve(workId, '[Group] Ember Rite (2023) - 02 [1080p]')).toMatchObject({ labels: [], problem: 'notFound' });
  });
});

/**
 * JoJo's Bizarre Adventure (TMDB 900009), in the real show's shape,
 * subscribed with anime numbering: six parts, one season each on TMDB and
 * TVDB; XEM's scene numbering restarts at absolute 1 in every part, and XEM
 * names Stardust Crusaders, Stone Ocean and Steel Ball Run under their scene
 * seasons 2, 5 and 6.
 */
async function jojo() {
  await seedXemList(t, [7700009]);
  useMetadataFakes({ series: [...SERIES, jojoParts()], xem: { shows: { 7700009: { all: jojoPartsShape, names: jojoPartsNames } } } });
  return (
    await admin.action(api.api.library.subscribe, {
      tmdbId: '900009',
      kind: 'series',
      libraryId: libraries.series,
      releaseProfileId: libraries.releaseProfileId,
      seasons: [5, 6],
      numberingScheme: 'anime',
    })
  ).workId;
}

describe('a part named by its XEM season name', () => {
  test.each([
    ['[SubsPlease] JoJos Bizarre Adventure - Stone Ocean - 01 (1080p)', 'S5E1'],
    ['[Erai-raws] JoJo no Kimyou na Bouken-Steel Ball Run-01', 'S6E1'],
  ])("%s reads its number within the alias's scene season: %s, not S1E1", async (title, label) => {
    const workId = await jojo();
    const result = await matchAndResolve(workId, title);
    expect(result).toMatchObject({ labels: [label], via: { ordering: 'scene', source: 'xem' }, confidence: 'mapped' });
    expect(result).not.toHaveProperty('problem');
  });

  test("a number the part doesn't have is notFound, not the Unit with that TMDB absolute number (S2E1)", async () => {
    const workId = await jojo();
    expect(await matchAndResolve(workId, '[SubsPlease] JoJos Bizarre Adventure - Stone Ocean - 07 (1080p)')).toMatchObject({ labels: [], problem: 'notFound' });
  });

  describe("SxxEyy after a part's name is read within the part", () => {
    test.each([
      ['S01E05', 'the part numbered as its own season 1, not TMDB S1E5'],
      ['S05E05', "the part's scene season"],
    ])('Stone Ocean %s is S5E5: %s', async (numbers) => {
      const workId = await jojo();
      const result = await matchAndResolve(workId, `JoJos.Bizarre.Adventure.Stone.Ocean.${numbers}.1080p.WEB-DL.AAC2.0.H.264-GRP`);
      expect(result).toMatchObject({ labels: ['S5E5'], via: { ordering: 'scene', source: 'xem' }, confidence: 'mapped' });
      expect(result).not.toHaveProperty('problem');
    });

    test("Stone Ocean S03E05 is ambiguous: another part's season, not TMDB S3E5", async () => {
      const workId = await jojo();
      expect(await matchAndResolve(workId, 'JoJos.Bizarre.Adventure.Stone.Ocean.S03E05.1080p.WEB-DL.AAC2.0.H.264-GRP')).toMatchObject({
        labels: [],
        problem: 'ambiguous',
      });
    });

    test('a pack of the part as season 1 is the whole part, not TMDB season 1', async () => {
      const workId = await jojo();
      const result = await matchAndResolve(workId, 'JoJos.Bizarre.Adventure.Stone.Ocean.S01.1080p.WEB-DL.AAC2.0.H.264-GRP');
      expect(result).toMatchObject({ via: { ordering: 'scene', source: 'xem' } });
      expect(result).not.toHaveProperty('problem');
      expect((result as { labels: string[] }).labels.sort()).toEqual(['S5E1', 'S5E2', 'S5E3', 'S5E4', 'S5E5', 'S5E6']);
    });
  });

  describe("a title naming the show and a TMDB season's name reads the season's scene season (the part-title fix)", () => {
    // Nyaa's real titles for Steel Ball Run (TMDB season 6, XEM scene season 6); Nyaa's items carry no IDs.
    test.each([
      [
        "[Anime Chap] JoJo's Bizarre Adventure Part 7: Steel Ball Run S06E03 [WEB 1080p] {Corrected Names} Episode 03 [Dual Audio]",
        '<alias> Part N: <season>, SxxEyy',
      ],
      ["[Anku & mutagenb] JoJo's Bizarre Adventure Steel Ball Run - 03 [1080p rus].mkv", '<alias> <season>'],
      ["[Some-Stuffs] Steel Ball Run - JoJo's Bizarre Adventure 03 (1080p) [D145F34D]", "<season> - <alias>, TMDB's own alias"],
      ["[Group] JoJo's Bizarre Adventure: Steel Ball Run - 03 [1080p]", '<alias>: <season>'],
      ["[Group] JoJo's Bizarre Adventure Steel Ball Run S01E03 [1080p]", 'the part numbered as its own season 1'],
    ])('%s is S6E3 (%s)', async (title) => {
      const workId = await jojo();
      const result = await matchAndResolve(workId, title, { ids: false });
      expect(result).toMatchObject({ labels: ['S6E3'], via: { ordering: 'scene', source: 'xem' }, confidence: 'mapped' });
      expect(result).not.toHaveProperty('problem');
    });

    test('a season name alone, or after a word that is not an alias, is not the Work', async () => {
      const workId = await jojo();
      for (const title of ['[Group] Steel Ball Run - 03 [1080p]', '[Group] Bizarre Steel Ball Run - 03 [1080p]'])
        expect(await matchAndResolve(workId, title, { ids: false })).toEqual({ ok: false, detail: 'title' });
    });
  });

  describe("a season's name without XEM rows reads the season's TMDB numbers", () => {
    async function jojoWithoutXem(options: { numberingScheme?: 'anime' | 'standard' } = {}) {
      useMetadataFakes({ series: [...SERIES, jojoParts()] });
      return (
        await admin.action(api.api.library.subscribe, {
          tmdbId: '900009',
          kind: 'series',
          libraryId: libraries.series,
          releaseProfileId: libraries.releaseProfileId,
          seasons: [5, 6],
          numberingScheme: options.numberingScheme ?? 'anime',
        })
      ).workId;
    }
    const steelBallRun = { kind: 'partSeason', season: 6, ordering: 'tmdb' } as const;

    test.each([
      ["[Anku & mutagenb] JoJo's Bizarre Adventure Steel Ball Run - 03 [1080p rus].mkv", 'S6E3'],
      ["[Group] JoJo's Bizarre Adventure - Stone Ocean - 05 [1080p]", 'S5E5'],
      ["[Group] JoJo's Bizarre Adventure Steel Ball Run S01E03 [1080p]", 'S6E3'],
      ["[Group] STEEL BALL RUN JoJo's Bizarre Adventure - 03 [1080p]", 'S6E3'],
    ])("%s is %s, read within the named season, not season 1's", async (title, label) => {
      const workId = await jojoWithoutXem();
      const result = await matchAndResolve(workId, title, { ids: false });
      expect(result).toMatchObject({ labels: [label], via: { ordering: 'tmdb', source: 'tmdb' } });
      expect(result).not.toHaveProperty('problem');
    });

    test("a scene-mapping name and TMDB's title of the show and a season's name are stored, and their - 03 is still S6E3, not S1E3", async () => {
      await t.run((ctx) =>
        ctx.db.insert('sceneMappings', { mappingId: 's-sbr', tvdbId: 7700009, title: "JoJo's Bizarre Adventure Steel Ball Run", seenVersion: 'fixture-v1' }),
      );
      const workId = await jojoWithoutXem();
      const aliases = await t.run((ctx) =>
        ctx.db
          .query('workAliases')
          .withIndex('by_work', (q) => q.eq('workId', workId))
          .collect(),
      );
      expect(aliases.map((alias) => alias.normalized)).toEqual(
        expect.arrayContaining(['jojos bizarre adventure steel ball run', 'steel ball run jojos bizarre adventure']),
      );
      for (const title of ["[Group] JoJo's Bizarre Adventure Steel Ball Run - 03 [1080p]", "[Group] STEEL BALL RUN JoJo's Bizarre Adventure - 03 [1080p]"])
        expect(await matchAndResolve(workId, title, { ids: false })).toMatchObject({ labels: ['S6E3'], via: { ordering: 'tmdb', source: 'tmdb' } });
    });

    test("a manual alias of the show and a season's name reads that season too: - 03 is S6E3", async () => {
      const workId = await jojoWithoutXem();
      await admin.mutation(api.api.metadata.addAlias, { workId, title: "JoJo's Bizarre Adventure Steel Ball Run" });
      expect(await matchAndResolve(workId, "[Group] JoJo's Bizarre Adventure Steel Ball Run - 03 [1080p]", { ids: false })).toMatchObject({
        labels: ['S6E3'],
        via: { ordering: 'tmdb', source: 'tmdb' },
      });
    });

    test("SxxEyy naming another season than the name's is ambiguous: Stone Ocean S06E03", async () => {
      const workId = await jojoWithoutXem();
      expect(await matchAndResolve(workId, "[Group] JoJo's Bizarre Adventure Stone Ocean S06E03 [1080p]", { ids: false })).toMatchObject({
        labels: [],
        problem: 'ambiguous',
      });
    });

    test('an absolute number beside SxxEyy that names another Unit is ambiguous', async () => {
      const workId = await jojoWithoutXem();
      expect(await resolve(workId, [{ season: 6, episode: 3, absolute: 1 }], undefined, steelBallRun)).toMatchObject({ unitIds: [], problem: 'ambiguous' });
    });

    test('a number read as an episode and as an absolute number on different Units of the season is ambiguous', async () => {
      const workId = await jojoWithoutXem();
      const s6e1 = await unitAt(workId, 6, 1);
      await t.run((ctx) => ctx.db.insert('unitMappings', { unitId: s6e1._id, workId, ordering: 'absolute', absolute: 2, source: 'manual' }));
      expect(await resolve(workId, [{ absolute: 2 }], undefined, steelBallRun)).toMatchObject({ unitIds: [], problem: 'ambiguous' });
    });

    test('an absolute number after the name of a show not on anime numbering is schemeMismatch', async () => {
      const workId = await jojoWithoutXem({ numberingScheme: 'standard' });
      expect(await matchAndResolve(workId, "[Group] JoJo's Bizarre Adventure Steel Ball Run - 03 [1080p]", { ids: false })).toMatchObject({
        labels: [],
        problem: 'schemeMismatch',
      });
    });

    test('a release with no numbers after the name of a show not on anime numbering is notFound, not schemeMismatch', async () => {
      const workId = await jojoWithoutXem({ numberingScheme: 'standard' });
      expect(await resolve(workId, [], undefined, steelBallRun)).toMatchObject({ unitIds: [], problem: 'notFound' });
    });

    test("a number the season doesn't have is notFound, not the Unit with that TMDB absolute number", async () => {
      const workId = await jojoWithoutXem();
      expect(await matchAndResolve(workId, "[Group] JoJo's Bizarre Adventure Steel Ball Run - 05 [1080p]", { ids: false })).toMatchObject({
        labels: [],
        problem: 'notFound',
      });
    });

    test('an absolute number that lands in the named season is its Unit: Stone Ocean - 18 is S5E1', async () => {
      const workId = await jojoWithoutXem();
      expect(await matchAndResolve(workId, "[Group] JoJo's Bizarre Adventure - Stone Ocean - 18 [1080p]", { ids: false })).toMatchObject({
        labels: ['S5E1'],
        via: { ordering: 'absolute', source: 'tmdb' },
      });
    });

    test.each([["[Group] JoJo's Bizarre Adventure Steel Ball Run - 03 [1080p]"], ["[Group] JoJo's Bizarre Adventure Steel Ball Run S01E03 [1080p]"]])(
      "a tvdb row that puts another season's Unit at the name's season is not read: %s is S6E3, not S1E3",
      async (title) => {
        await seedAnimeLists(
          t,
          'fixture-v1',
          `<anime-list>
  <anime anidbid="9901" tvdbid="7700009" defaulttvdbseason="6" episodeoffset="" tmdbtv="900009" tmdbseason="1" tmdboffset="" tmdbid="" imdbid="">
    <name>Phantom Blood</name>
  </anime>
</anime-list>`,
        );
        const workId = await jojoWithoutXem();
        const tvdbRow = await t.run(async (ctx) =>
          ctx.db
            .query('unitMappings')
            .withIndex('by_ordering', (q) => q.eq('workId', workId).eq('ordering', 'tvdb').eq('season', 6).eq('episode', 3))
            .first(),
        );
        expect(tvdbRow).toMatchObject({ unitId: (await unitAt(workId, 1, 3))._id });
        expect(await matchAndResolve(workId, title, { ids: false })).toMatchObject({
          labels: ['S6E3'],
          via: { ordering: 'tmdb', source: 'tmdb' },
        });
      },
    );
  });

  test('a XEM name with a scene season XEM has no rows for is read in scene rows only, never as that TMDB season: notFound', async () => {
    await seedXemList(t, [7700009]);
    useMetadataFakes({
      series: [...SERIES, jojoParts()],
      xem: { shows: { 7700009: { all: { result: 'success', data: [] }, names: { result: 'success', data: { 6: { en: ['JoJo Kimyou Part Six'] } } } } } },
    });
    const { workId } = await admin.action(api.api.library.subscribe, {
      tmdbId: '900009',
      kind: 'series',
      libraryId: libraries.series,
      releaseProfileId: libraries.releaseProfileId,
      seasons: [6],
      numberingScheme: 'anime',
    });
    expect(await matchAndResolve(workId, '[Group] JoJo Kimyou Part Six - 02 [1080p]', { ids: false })).toMatchObject({ labels: [], problem: 'notFound' });
  });

  test('the general alias with a number every part restarts at is ambiguous, not S1E1', async () => {
    const workId = await jojo();
    for (const title of ['[SubsPlease] JoJos Bizarre Adventure - 01 (1080p)', '[Erai-raws] JoJo no Kimyou na Bouken - 01 [1080p]'])
      expect(await matchAndResolve(workId, title)).toMatchObject({ labels: [], problem: 'ambiguous' });
  });
});

/**
 * Attack on Titan (TMDB 900010), subscribed with anime numbering, with XEM
 * modelled two ways (not XEM's real rows): `whole`, one scene season per TMDB
 * season and general names only; `split`, TMDB's "The Final Season" in scene
 * seasons 4 (E1–16) and 5 (E17–28), with XEM's names for both cours.
 */
async function attackOnTitan(xem: 'whole' | 'split') {
  const series = attackOnTitanSeries();
  let absolute = 0;
  const data = series.seasons.flatMap((s) =>
    s.episodes.map((e) => {
      absolute += 1;
      const secondCour = xem === 'split' && s.season_number === 4 && e.episode_number > 16;
      const scene = secondCour ? { season: 5, episode: e.episode_number - 16, absolute } : { season: s.season_number, episode: e.episode_number, absolute };
      return { scene, tvdb: { season: s.season_number, episode: e.episode_number, absolute } };
    }),
  );
  const names = {
    result: 'success',
    data: {
      all: { ja: ['Shingeki no Kyojin'] },
      ...(xem === 'split' ? { 4: { ja: ['Shingeki no Kyojin: The Final Season'] }, 5: { ja: ['Shingeki no Kyojin: The Final Season Part 2'] } } : {}),
    },
    message: '',
  };
  await seedXemList(t, [7700010]);
  useMetadataFakes({ series: [...SERIES, series], xem: { shows: { 7700010: { all: { result: 'success', data, message: '' }, names } } } });
  return (
    await admin.action(api.api.library.subscribe, {
      tmdbId: '900010',
      kind: 'series',
      libraryId: libraries.series,
      releaseProfileId: libraries.releaseProfileId,
      seasons: [4],
      numberingScheme: 'anime',
    })
  ).workId;
}

describe('a cour after a season name is never dropped (Attack on Titan, the part-title fix)', () => {
  const rejected = { ok: false, detail: 'title' };
  // A wrong grab is worse than a miss: each title is its episode or rejected, never S4E5 or S3E1 with the part dropped.
  test.each([
    ['whole', '[SubsPlease] Shingeki no Kyojin (The Final Season Part 2) - 05 (1080p)', rejected],
    ['whole', 'Attack on Titan The Final Season Part 2 - 05', rejected],
    ['whole', '[Erai-raws] Shingeki no Kyojin - The Final Season - 05', 'S4E5'],
    ['whole', 'Shingeki no Kyojin Season 3 Part 2 - 01', rejected],
    ['split', '[SubsPlease] Shingeki no Kyojin (The Final Season Part 2) - 05 (1080p)', 'S4E21'],
    ['split', 'Attack on Titan The Final Season Part 2 - 05', rejected],
    ['split', '[Erai-raws] Shingeki no Kyojin - The Final Season - 05', 'S4E5'],
    ['split', 'Shingeki no Kyojin Season 3 Part 2 - 01', rejected],
  ] as const)('XEM %s: %s → %j', async (xem, title, expected) => {
    const workId = await attackOnTitan(xem);
    // With the item's IDs (the ID rule may run) and without them (Nyaa).
    for (const ids of [true, false]) {
      const result = await matchAndResolve(workId, title, { ids });
      if (typeof expected === 'string') {
        expect(result).toMatchObject({ labels: [expected], via: { ordering: 'scene', source: 'xem' } });
        expect(result).not.toHaveProperty('problem');
      } else expect(result).toEqual(expected);
    }
  });
});

describe('an ambiguous answer names the Units its readings found', () => {
  const labels = (ids: Id<'units'>[] | undefined) => Promise.all((ids ?? []).map(label)).then((all) => all.sort());

  test('rule 1: both Units that aired that day', async () => {
    const workId = await subscribe('900001', [1, 2]);
    const third = await unitAt(workId, 1, 3);
    await t.run((ctx) => ctx.db.patch(third._id, { airDateUtc: Date.parse('2021-03-11T00:00:00Z') }));
    const result = await resolve(workId, [], '2021-03-11');
    expect(result).toMatchObject({ unitIds: [], problem: 'ambiguous' });
    expect(await labels(result.possibleUnitIds)).toEqual(['S1E2', 'S1E3']);
  });

  test('rule 5: the Unit SxxEyy names and the one the absolute number names', async () => {
    await seedAnimeLists(t);
    const workId = await subscribe('900002', [1, 2]);
    const result = await resolve(workId, [{ season: 1, episode: 1, absolute: 13 }]);
    expect(await labels(result.possibleUnitIds)).toEqual(['S1E1', 'S2E1']);
  });

  test("the general alias with a number every part restarts at: each part's episode 1", async () => {
    const workId = await jojo();
    const result = await matchAndResolve(workId, '[SubsPlease] JoJos Bizarre Adventure - 01 (1080p)');
    expect(await labels((result as { possibleUnitIds?: Id<'units'>[] }).possibleUnitIds)).toEqual(['S1E1', 'S2E1', 'S3E1', 'S4E1', 'S5E1', 'S6E1']);
  });

  test("another part's season after a part's name: the part's reading and the season's", async () => {
    const workId = await jojo();
    const result = await matchAndResolve(workId, 'JoJos.Bizarre.Adventure.Stone.Ocean.S03E05.1080p.WEB-DL.AAC2.0.H.264-GRP');
    expect(await labels((result as { possibleUnitIds?: Id<'units'>[] }).possibleUnitIds)).toEqual(['S3E5', 'S5E5']);
  });

  test('an answer that is not ambiguous names no possible Units', async () => {
    const workId = await subscribe('900001', [1, 2]);
    expect(await resolve(workId, [{ season: 1, episode: 2 }])).not.toHaveProperty('possibleUnitIds');
  });
});

describe('searchKeys', () => {
  test("gives the Work's IDs, its titles with the display title first, and scene numbers where they exist", async () => {
    const workId = await northbound();
    const s1e1 = await unitAt(workId, 1, 1);
    const s2e1 = await unitAt(workId, 2, 1);
    const keys = await t.run((ctx) => searchKeys(ctx, workId, [s1e1._id, s2e1._id]));
    expect(keys).toMatchObject({ tmdbId: '900003', tvdbId: '7700003', imdbId: 'tt9900003' });
    expect(keys.titles[0]).toBe('Northbound Signal');
    expect(new Set(keys.titles).size).toBe(keys.titles.length);
    expect(keys.units).toEqual([
      { unitId: s1e1._id, season: 1, episode: 1, absolute: 1 },
      { unitId: s2e1._id, season: 2, episode: 1, absolute: 13 },
    ]);
  });

  test("searchTitles: the display title, then the scene names of the Units' scene season and the general ones, then the rest; one per compact form", async () => {
    const workId = await jojo();
    // The user's alias differs from XEM's name only by hyphens: the same compact form.
    await admin.mutation(api.api.metadata.addAlias, { workId, title: 'JoJo-no-Kimyou-na-Bouken' });
    const unit = await unitAt(workId, 6, 3);
    const keys = await t.run((ctx) => searchKeys(ctx, workId, [unit._id]));
    expect(keys.searchTitles).toEqual([
      "JoJo's Bizarre Adventure",
      // XEM's names: season 6's part name, then the general ones; Stardust Crusaders (2) and Stone Ocean (5) are other scene seasons'.
      'JoJo no Kimyou na Bouken: Steel Ball Run',
      "JoJo's Bizarre Adventure (2012)",
      'JoJo no Kimyou na Bouken',
      // TMDB's.
      'ジョジョの奇妙な冒険',
      "STEEL BALL RUN JoJo's Bizarre Adventure",
    ]);
    expect(keys.titles).toContain('JoJo-no-Kimyou-na-Bouken');
  });

  test('falls back to TMDB numbers without scene rows', async () => {
    const workId = await subscribe('900001', [1, 2]);
    const unit = await unitAt(workId, 2, 3);
    const keys = await t.run((ctx) => searchKeys(ctx, workId, [unit._id]));
    expect(keys.units).toEqual([{ unitId: unit._id, season: 2, episode: 3, absolute: 9 }]);
  });
});

describe('findWorksByTitle', () => {
  test('lists every Work with the alias, and per Work the alias without an AniDB link first', async () => {
    await seedAnimeLists(t);
    const workId = await subscribe('900002', [1, 2]);
    const matches = await t.run((ctx) => findWorksByTitle(ctx, 'star lantern'));
    expect(matches.map((m) => [m.workId, m.anidbId])).toEqual([
      [workId, undefined],
      [workId, 17001],
    ]);
    expect(await t.run((ctx) => findWorksByTitle(ctx, 'no such show'))).toEqual([]);
  });
});
