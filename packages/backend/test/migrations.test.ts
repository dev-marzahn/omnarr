// The data migrations in convex/migrations/, each run to completion on rows
// stored in the shape before it.
import { runToCompletion } from '@convex-dev/migrations';
import migrationsComponent from '@convex-dev/migrations/test';
import { jojoParts, SERIES } from '@omnarr/e2e/fakes/tmdb/fixtures';
import { normalizeReleaseTitle } from '@omnarr/parser';
import { convexTest } from 'convex-test';
import { defineSchema } from 'convex/server';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';

import { api, components, internal } from '../convex/_generated/api';
import { findWorksByTitle, resolveUnits } from '../convex/metadata/resolve';
import schema from '../convex/schema';
import jojoPartsNames from './fixtures/xem/jojoPartsNames.json';
import jojoPartsShape from './fixtures/xem/jojoPartsShape.json';
import { asAdmin, drainPool, fetchXem, modules, seedLibraries, seedXemList, setup, useFetchFakes } from './setup';

test('0001: blocklist rows get the title key of the current rule, so a blocklisted spelling still blocks the other', async () => {
  const t = setup();
  migrationsComponent.register(t);
  const { series: libraryId, releaseProfileId } = await seedLibraries(t);
  await t.run(async (ctx) => {
    const workId = await ctx.db.insert('works', {
      libraryId,
      kind: 'series',
      title: 'Lantern Keeper',
      numberingScheme: 'anime',
      releaseProfileId,
      monitorNewUnits: true,
    });
    // The key the rule before 2026-11-17 stored for this title.
    await ctx.db.insert('blocklist', {
      workId,
      releaseKey: 'guid-1',
      normalizedTitle: '[subgroup] lantern keeper 1076 (1080p) [5a6b7c8d]',
      title: '[SubGroup] Lantern Keeper - 1076 (1080p) [5A6B7C8D]',
      reason: 'manual',
    });

    await runToCompletion(ctx, components.migrations, internal.migrations['0001_blocklist_release_title_key'].default);

    const [row] = await ctx.db.query('blocklist').collect();
    expect(row!.normalizedTitle).toBe('subgroup lantern keeper 1076 1080p');
    expect(row!.normalizedTitle).toBe(normalizeReleaseTitle('[SubGroup].Lantern.Keeper-1076.1080p'));
  });
});

test('0002: aliases get their compact form, so findWorksByTitle finds them across a hyphen', async () => {
  // Rows from before 0002 have no `compact`; convex-release's first push runs migrations with validation off.
  const t = convexTest(defineSchema(schema.tables, { schemaValidation: false }), modules);
  migrationsComponent.register(t);
  await t.run(async (ctx) => {
    const workId = await ctx.db.insert('works', {} as never);
    const old = (title: string, normalized: string) => ctx.db.insert('workAliases', { workId, title, normalized, source: 'tmdb' } as never);
    await old('Mori-sama Keeps Watch', 'morisama keeps watch');
    await old('Hoshi no Chōchin', 'hoshi no chochin');
    // A row a sync wrote after 0002 keeps its value.
    await ctx.db.insert('workAliases', { workId, title: 'Star Lantern', normalized: 'star lantern', compact: 'starlantern', source: 'tmdb' });

    await runToCompletion(ctx, components.migrations, internal.migrations['0002_work_alias_compact'].default);

    expect((await ctx.db.query('workAliases').collect()).map((a) => [a.normalized, a.compact])).toEqual([
      ['morisama keeps watch', 'morisamakeepswatch'],
      ['hoshi no chochin', 'hoshinochochin'],
      ['star lantern', 'starlantern'],
    ]);
    expect((await findWorksByTitle(ctx, 'mori sama keeps watch')).map((m) => m.workId)).toEqual([workId]);
    expect((await findWorksByTitle(ctx, 'hoshinochochin')).map((m) => m.workId)).toEqual([workId]);
  });
});

describe('0003: Works with XEM aliases sync again, so the aliases get their scene seasons', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  test("the next tick syncs the Work, and its part's name reads the number in its scene season", async () => {
    const t = setup();
    migrationsComponent.register(t);
    const admin = await asAdmin(t);
    const { series: libraryId, releaseProfileId } = await seedLibraries(t);
    await seedXemList(t, [7700009]);
    useFetchFakes({ series: [...SERIES, jojoParts()], xem: { shows: { 7700009: { all: jojoPartsShape, names: jojoPartsNames } } } });
    await fetchXem(t);
    const subscribe = (tmdbId: string, numberingScheme: 'anime' | 'standard') =>
      admin.action(api.api.library.subscribe, { tmdbId, kind: 'series', libraryId, releaseProfileId, seasons: [], numberingScheme });
    const { workId } = await subscribe('900009', 'anime');
    const { workId: otherId } = await subscribe('900001', 'standard');
    const later = Date.now() + 30 * 86_400_000;
    // `Stone Ocean - 01` resolved through its alias, as matchTitle passes it: the TMDB seasons of the Units found.
    const stoneOcean = () =>
      t.run(async (ctx) => {
        const alias = (await ctx.db.query('workAliases').collect()).find((a) => a.normalized === 'jojos bizarre adventure stone ocean')!;
        const matched =
          alias.sceneSeason === undefined ? ({ kind: 'plain' } as const) : ({ kind: 'partSeason', season: alias.sceneSeason, ordering: 'scene' } as const);
        const result = await resolveUnits(ctx, workId, [{ absolute: 1 }], undefined, matched);
        return Promise.all(result.unitIds.map(async (id) => (await ctx.db.get(id))!.tmdbSeason));
      });

    // The rows as a sync before the fix left them: XEM aliases without a scene season, the next sync a month away.
    await t.run(async (ctx) => {
      for (const alias of await ctx.db.query('workAliases').collect()) if (alias.source === 'xem') await ctx.db.patch(alias._id, { sceneSeason: undefined });
      for (const row of await ctx.db.query('workMetadata').collect()) await ctx.db.patch(row._id, { nextSyncAt: later });
    });
    expect(await stoneOcean()).toEqual([]);

    await t.run((ctx) => runToCompletion(ctx, components.migrations, internal.migrations['0003_work_alias_scene_season'].default));
    const nextSync = await t.run(async (ctx) => Object.fromEntries((await ctx.db.query('workMetadata').collect()).map((row) => [row.workId, row.nextSyncAt])));
    expect(nextSync[workId]).toBeLessThan(later);
    expect(nextSync[otherId]).toBe(later);

    // The hourly tick, a little later.
    vi.advanceTimersByTime(60_000);
    await t.mutation(internal.metadata.schedule.tick, {});
    await drainPool(t);
    expect(await stoneOcean()).toEqual([5]);
  });
});
