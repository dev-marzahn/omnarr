// The release-profile functions: the edit flag, reset,
// create and duplicate, delete while in use, and the target warnings.
import { targetForDevices } from '@omnarr/contracts';
import { SHIPPED_PROFILES } from '@omnarr/scoring';
import { beforeEach, describe, expect, test } from 'vite-plus/test';

import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import { applyReferenceSeeds, REFERENCE_SEEDS } from '../convex/seeds/_reference';
import { asAdmin, setup, type Backend } from './setup';

let t: Backend;
let admin: Awaited<ReturnType<typeof asAdmin>>;
let ids: Record<'web-1080p' | 'uhd-2160p' | 'anime-1080p', Id<'releaseProfiles'>>;

beforeEach(async () => {
  t = setup();
  admin = await asAdmin(t);
  await t.run((ctx) => applyReferenceSeeds(ctx, REFERENCE_SEEDS));
  const rows = await t.run((ctx) => ctx.db.query('releaseProfiles').collect());
  ids = Object.fromEntries(rows.map((row) => [row.shippedKey, row._id])) as typeof ids;
});

/** The two libraries first run creates, defaulting to `web-1080p`, each with its playback profile. */
const seedLibraries = () =>
  t.run(async (ctx) => {
    for (const kind of ['series', 'movies'] as const) {
      const name = kind === 'series' ? 'Series' : 'Movies';
      const playbackProfileId = await ctx.db.insert('playbackProfiles', { name });
      await ctx.db.insert('libraries', { kind, name, rootPath: `/data/${kind}`, playbackProfileId, defaultReleaseProfileId: ids['web-1080p'] });
    }
  });

describe('releaseProfiles.list and get', () => {
  test('lists the shipped profiles with their state and use', async () => {
    await seedLibraries();
    const list = await admin.query(api.api.releaseProfiles.list, {});
    expect(list.find((p) => p.shippedKey === 'web-1080p')).toEqual({
      id: ids['web-1080p'],
      name: '1080p WEB',
      shippedKey: 'web-1080p',
      edited: false,
      updateAvailable: false,
      usedBy: 2,
    });
  });

  test('the detail has the format catalogue, the users and, for a profile most of whose qualities need a transcode, a warning per library', async () => {
    await seedLibraries();
    const uhd = (await admin.query(api.api.releaseProfiles.get, { id: ids['uhd-2160p'] }))!;
    expect(uhd.targetWarnings.map((w) => w.message)).toEqual([
      'Most releases this profile prefers will need a full video transcode for Series.',
      'Most releases this profile prefers will need a full video transcode for Movies.',
    ]);
    const web = (await admin.query(api.api.releaseProfiles.get, { id: ids['web-1080p'] }))!;
    expect(web.targetWarnings).toEqual([]);
    expect(web.usedBy.libraries.map((l) => l.name)).toEqual(['Series', 'Movies']);
    expect(web.formatCatalogue).toContainEqual({ id: 'prep.video', name: 'Needs video transcode', kind: 'preparation' });
  });

  test('the warnings read each library’s own target: a library on Fire TV takes 2160p HEVC, so only the other one warns', async () => {
    await seedLibraries();
    await t.run(async (ctx) => {
      const series = (await ctx.db.query('libraries').collect()).find((library) => library.kind === 'series')!;
      await ctx.db.patch(series.playbackProfileId, { mode: 'devices', devices: ['jellyfinFireTv'], target: targetForDevices(['jellyfinFireTv']) });
    });
    const uhd = (await admin.query(api.api.releaseProfiles.get, { id: ids['uhd-2160p'] }))!;
    expect(uhd.targetWarnings.map((w) => w.message)).toEqual(['Most releases this profile prefers will need a full video transcode for Movies.']);
  });
});

describe('editing', () => {
  test('a saved change marks the profile edited; a later seed then only marks an update available; reset applies it', async () => {
    const content = { ...SHIPPED_PROFILES['web-1080p'].content, minimumScore: 200 };
    const saved = await admin.mutation(api.api.releaseProfiles.update, { id: ids['web-1080p'], profile: content });
    expect(saved.profile).toMatchObject({ minimumScore: 200, editedByUser: true, shippedKey: 'web-1080p' });

    await t.run((ctx) => ctx.db.patch(ids['web-1080p'], { pendingShippedVersion: 2 }));
    expect((await admin.query(api.api.releaseProfiles.list, {})).find((p) => p.id === ids['web-1080p'])).toMatchObject({ edited: true, updateAvailable: true });

    const reset = await admin.mutation(api.api.releaseProfiles.resetToShipped, { id: ids['web-1080p'] });
    expect(reset.profile).toMatchObject({ minimumScore: 0, editedByUser: false, shippedVersion: 2, preferSeasonPacks: true });
    expect(reset.profile.pendingShippedVersion).toBeUndefined();
  });

  test('turning preferSeasonPacks off is saved like any other field', async () => {
    const content = { ...SHIPPED_PROFILES['web-1080p'].content, preferSeasonPacks: false };
    const saved = await admin.mutation(api.api.releaseProfiles.update, { id: ids['web-1080p'], profile: content });
    expect(saved.profile).toMatchObject({ preferSeasonPacks: false, editedByUser: true });
  });

  test('a profile that breaks the rules is refused: a quality missing', async () => {
    const content = { ...SHIPPED_PROFILES['web-1080p'].content, qualities: SHIPPED_PROFILES['web-1080p'].content.qualities.slice(1) };
    await expect(admin.mutation(api.api.releaseProfiles.update, { id: ids['web-1080p'], profile: content })).rejects.toThrow();
  });

  test('names are unique', async () => {
    await expect(
      admin.mutation(api.api.releaseProfiles.update, { id: ids['web-1080p'], profile: { ...SHIPPED_PROFILES['web-1080p'].content, name: '2160p' } }),
    ).rejects.toThrow(/nameTaken/);
  });

  test('reset is only for shipped profiles', async () => {
    const created = await admin.mutation(api.api.releaseProfiles.create, { name: 'Mine' });
    await expect(admin.mutation(api.api.releaseProfiles.resetToShipped, { id: created.id })).rejects.toThrow(/notShipped/);
  });
});

describe('create, duplicate and remove', () => {
  test('"New profile" copies the latest shipped web-1080p content; "Duplicate" copies any profile as stored, without its shipped key', async () => {
    const created = await admin.mutation(api.api.releaseProfiles.create, { name: 'Mine' });
    expect(created.profile).toMatchObject({ ...SHIPPED_PROFILES['web-1080p'].content, name: 'Mine', editedByUser: false });
    expect(created.profile.shippedKey).toBeUndefined();

    await admin.mutation(api.api.releaseProfiles.update, { id: ids['anime-1080p'], profile: { ...SHIPPED_PROFILES['anime-1080p'].content, minimumScore: 7 } });
    const copy = await admin.mutation(api.api.releaseProfiles.duplicate, { id: ids['anime-1080p'], name: 'Anime copy' });
    expect(copy.profile).toMatchObject({ name: 'Anime copy', minimumScore: 7 });
    expect(copy.profile.shippedKey).toBeUndefined();
    expect(copy.profile.shippedVersion).toBeUndefined();
  });

  test('a profile a library or Work uses cannot be deleted; an unused one can', async () => {
    await seedLibraries();
    await expect(admin.mutation(api.api.releaseProfiles.remove, { id: ids['web-1080p'] })).rejects.toThrow(/inUse/);
    await admin.mutation(api.api.releaseProfiles.remove, { id: ids['uhd-2160p'] });
    expect(new Set((await admin.query(api.api.releaseProfiles.list, {})).map((p) => p.shippedKey))).toEqual(new Set(['anime-1080p', 'web-1080p']));
  });
});
