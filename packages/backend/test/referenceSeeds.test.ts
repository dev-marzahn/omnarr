import { SHIPPED_PROFILES } from '@omnarr/scoring';
import { describe, expect, test } from 'vite-plus/test';

import { applyDraft } from '../convex/playback/profiles';
import { applyShippedProfileVersion } from '../convex/referenceSeeds/shippedProfiles';
import { applyReferenceSeeds, REFERENCE_SEEDS, type ReferenceSeed } from '../convex/seeds/_reference';
import { seedLibraries, setup, shippedProfile } from './setup';

const profiles = (t: ReturnType<typeof setup>) => t.run((ctx) => ctx.db.query('releaseProfiles').collect());

test('a reference seed runs once per deployment, and a later one still runs', async () => {
  const t = setup();
  const profile: ReferenceSeed = { name: '0001_profile', apply: async (ctx) => void (await ctx.db.insert('releaseProfiles', shippedProfile())) };
  const later: ReferenceSeed = { name: '0002_more', apply: async (ctx) => void (await ctx.db.insert('releaseProfiles', shippedProfile('anime-1080p'))) };

  expect(await t.run((ctx) => applyReferenceSeeds(ctx, [profile]))).toEqual(['0001_profile']);
  expect(await t.run((ctx) => applyReferenceSeeds(ctx, [profile]))).toEqual([]);
  expect(await t.run((ctx) => applyReferenceSeeds(ctx, [profile, later]))).toEqual(['0002_more']);
  expect(await profiles(t)).toHaveLength(2);
});

const byKey = (a: unknown[], b: unknown[]) => String(a[0]).localeCompare(String(b[0]));

test('seed 0001_release_profiles inserts the three shipped profiles at version 1', async () => {
  const t = setup();
  expect(await t.run((ctx) => applyReferenceSeeds(ctx, REFERENCE_SEEDS.slice(0, 1)))).toEqual(['0001_release_profiles']);
  const stored = await profiles(t);
  expect(stored.map((p) => [p.shippedKey, p.shippedVersion, p.name, p.editedByUser, p.preferSeasonPacks]).sort(byKey)).toEqual([
    ['anime-1080p', 1, 'Anime 1080p', false, undefined],
    ['uhd-2160p', 1, '2160p', false, undefined],
    ['web-1080p', 1, '1080p WEB', false, undefined],
  ]);
  const web = stored.find((p) => p.shippedKey === 'web-1080p')!;
  expect(web.qualities).toEqual(SHIPPED_PROFILES['web-1080p'].content.qualities);
});

test('the seeds, in order', () => {
  expect(REFERENCE_SEEDS.map((seed) => seed.name)).toEqual(['0001_release_profiles', '0002_release_profiles_v2', '0003_playback_profile_defaults']);
});

test('a fresh install applies every seed: the three shipped profiles at version 2, preferring season packs', async () => {
  const t = setup();
  expect(await t.run((ctx) => applyReferenceSeeds(ctx, REFERENCE_SEEDS))).toEqual([
    '0001_release_profiles',
    '0002_release_profiles_v2',
    '0003_playback_profile_defaults',
  ]);
  expect((await profiles(t)).map((p) => [p.shippedKey, p.shippedVersion, p.preferSeasonPacks, p.editedByUser]).sort(byKey)).toEqual([
    ['anime-1080p', 2, true, false],
    ['uhd-2160p', 2, true, false],
    ['web-1080p', 2, true, false],
  ]);
});

test('seed 0002 on an install that seeded version 1: unedited profiles get version 2, an edited one keeps its content and learns of it', async () => {
  const t = setup();
  await t.run((ctx) => applyReferenceSeeds(ctx, REFERENCE_SEEDS.slice(0, 1)));
  const edited = (await profiles(t)).find((p) => p.shippedKey === 'web-1080p')!;
  await t.run((ctx) => ctx.db.patch(edited._id, { minimumScore: 100, editedByUser: true }));

  expect(await t.run((ctx) => applyReferenceSeeds(ctx, REFERENCE_SEEDS.slice(0, 2)))).toEqual(['0002_release_profiles_v2']);
  const after = await profiles(t);
  expect(after.find((p) => p.shippedKey === 'anime-1080p')).toMatchObject({ shippedVersion: 2, preferSeasonPacks: true, editedByUser: false });
  expect(after.find((p) => p.shippedKey === 'uhd-2160p')).toMatchObject({ shippedVersion: 2, preferSeasonPacks: true, editedByUser: false });
  const web = after.find((p) => p.shippedKey === 'web-1080p')!;
  expect(web).toMatchObject({ shippedVersion: 1, pendingShippedVersion: 2, minimumScore: 100, editedByUser: true });
  expect(web.preferSeasonPacks).toBeUndefined();
});

test('a later-version seed updates an unedited shipped profile and marks an edited one pending', async () => {
  const t = setup();
  await t.run((ctx) => applyReferenceSeeds(ctx, REFERENCE_SEEDS));
  const edited = (await profiles(t)).find((p) => p.shippedKey === 'anime-1080p')!;
  await t.run((ctx) => ctx.db.patch(edited._id, { minimumScore: 42, editedByUser: true }));

  const v3 = (key: 'web-1080p' | 'anime-1080p') => ({ ...SHIPPED_PROFILES[key].content, minimumScore: 7 });
  await t.run(async (ctx) => {
    await applyShippedProfileVersion(ctx, 'web-1080p', 3, v3('web-1080p'));
    await applyShippedProfileVersion(ctx, 'anime-1080p', 3, v3('anime-1080p'));
  });

  const after = await profiles(t);
  expect(after.find((p) => p.shippedKey === 'web-1080p')).toMatchObject({ shippedVersion: 3, minimumScore: 7, editedByUser: false });
  expect(after.find((p) => p.shippedKey === 'web-1080p')!.pendingShippedVersion).toBeUndefined();
  expect(after.find((p) => p.shippedKey === 'anime-1080p')).toMatchObject({
    shippedVersion: 2,
    pendingShippedVersion: 3,
    minimumScore: 42,
    editedByUser: true,
  });
});

describe('seed 0003_playback_profile_defaults', () => {
  const seed0003 = REFERENCE_SEEDS.find((seed) => seed.name === '0003_playback_profile_defaults')!;

  test('gives an install from before playback profiles one profile per library with the default devices and target, splitting the shared row', async () => {
    const t = setup();
    const { series, movies, shared } = await t.run(async (ctx) => {
      const releaseProfileId = await ctx.db.insert('releaseProfiles', shippedProfile());
      const shared = await ctx.db.insert('playbackProfiles', { name: 'Series' });
      const insert = (kind: 'series' | 'movies') =>
        ctx.db.insert('libraries', {
          kind,
          name: kind,
          rootPath: `/data/library/${kind}`,
          playbackProfileId: shared,
          defaultReleaseProfileId: releaseProfileId,
        });
      return { series: await insert('series'), movies: await insert('movies'), shared };
    });
    await t.run((ctx) => seed0003.apply(ctx));

    const rows = await t.run(async (ctx) => {
      const of = async (id: typeof series) => (await ctx.db.get((await ctx.db.get(id))!.playbackProfileId))!;
      return [await of(series), await of(movies)];
    });
    expect(rows[0]!._id).toBe(shared);
    expect(rows[1]!._id).not.toBe(shared);
    expect(rows.map((row) => [row.name, row.mode, row.devices, row.target?.containers, row.target?.video.maxHeight, row.deviceTableVersion])).toEqual([
      ['Series', 'devices', ['chrome', 'jellyfinAndroid'], ['mp4'], 1080, 1],
      ['Movies', 'devices', ['chrome', 'jellyfinAndroid'], ['mp4'], 1080, 1],
    ]);
  });

  test('leaves profiles that have a target as they are', async () => {
    const t = setup();
    const { series } = await seedLibraries(t);
    const profileId = await t.run(async (ctx) => (await ctx.db.get(series))!.playbackProfileId);
    await t.run((ctx) => applyDraft(ctx, profileId, { mode: 'devices', devices: ['jellyfinFireTv'], keepOriginal: false }));
    const before = await t.run((ctx) => ctx.db.query('playbackProfiles').collect());
    await t.run((ctx) => seed0003.apply(ctx));
    expect(await t.run((ctx) => ctx.db.query('playbackProfiles').collect())).toEqual(before);
  });
});

test('a later seed inserts a shipped profile no profile has the key of', async () => {
  const t = setup();
  await t.run((ctx) => applyShippedProfileVersion(ctx, 'uhd-2160p', 3, SHIPPED_PROFILES['uhd-2160p'].content));
  expect(await profiles(t)).toMatchObject([{ shippedKey: 'uhd-2160p', shippedVersion: 3, editedByUser: false }]);
});
