// The Work page's numbering panel: the scheme, manual
// aliases and manual mappings, which survive every sync.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';

import { api } from '../../convex/_generated/api';
import type { Id } from '../../convex/_generated/dataModel';
import { asAdmin, drainPool, seedLibraries, setup, useMetadataFakes, type Backend } from '../setup';

let t: Backend;
let admin: Awaited<ReturnType<typeof asAdmin>>;
let workId: Id<'works'>;
let units: { unitId: Id<'units'>; tmdbSeason?: number; tmdbEpisode?: number }[];

beforeEach(async () => {
  vi.useFakeTimers();
  t = setup();
  admin = await asAdmin(t);
  const libraries = await seedLibraries(t);
  useMetadataFakes();
  ({ workId } = await admin.action(api.api.library.subscribe, {
    tmdbId: '900001',
    kind: 'series',
    libraryId: libraries.series,
    releaseProfileId: libraries.releaseProfileId,
    seasons: [1, 2],
  }));
  units = (await admin.query(api.api.library.detail, { workId }))!.units;
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

const unit = (season: number, episode: number) => units.find((u) => u.tmdbSeason === season && u.tmdbEpisode === episode)!.unitId;
const runPool = () => drainPool(t);
const workInfo = async () => (await admin.query(api.api.metadata.workInfo, { workId }))!;

describe('the numbering scheme', () => {
  test('can be changed on the Work page', async () => {
    await admin.mutation(api.api.metadata.setNumberingScheme, { workId, scheme: 'anime' });
    expect((await admin.query(api.api.library.detail, { workId }))!.work.numberingScheme).toBe('anime');
  });
});

describe('manual aliases', () => {
  test('are added, kept by a sync, and removed', async () => {
    const aliasId = await admin.mutation(api.api.metadata.addAlias, { workId, title: 'Lights of the Harbour' });
    expect((await workInfo()).aliases).toContainEqual({ aliasId, title: 'Lights of the Harbour', source: 'manual' });
    await admin.mutation(api.api.metadata.syncNow, { workId });
    await runPool();
    expect((await workInfo()).aliases.map((a) => a.aliasId)).toContain(aliasId);
    await admin.mutation(api.api.metadata.removeAlias, { aliasId });
    expect((await workInfo()).aliases.map((a) => a.aliasId)).not.toContain(aliasId);
  });

  test('only manual aliases can be removed', async () => {
    const tmdbAlias = (await workInfo()).aliases.find((a) => a.source === 'tmdb')!;
    await expect(admin.mutation(api.api.metadata.removeAlias, { aliasId: tmdbAlias.aliasId })).rejects.toThrow(/notManual/);
  });
});

describe('manual mappings', () => {
  test('a manual row takes its number from lower rows at the next sync, which it starts, and survives it', async () => {
    // Absolute 1 is TMDB's S1E1; the user says it is S1E2.
    const mappingId = await admin.mutation(api.api.metadata.setManualMapping, { unitId: unit(1, 2), ordering: 'absolute', absolute: 1 });
    expect((await workInfo()).syncing).toBe(true);
    await runPool();
    expect(await admin.query(api.api.metadata.unitMappings, { unitId: unit(1, 2) })).toEqual(
      expect.arrayContaining([expect.objectContaining({ mappingId, ordering: 'absolute', absolute: 1, source: 'manual' })]),
    );
    expect(await admin.query(api.api.metadata.unitMappings, { unitId: unit(1, 1) })).toEqual([]);

    await admin.mutation(api.api.metadata.removeManualMapping, { mappingId });
    await runPool();
    expect(await admin.query(api.api.metadata.unitMappings, { unitId: unit(1, 1) })).toEqual([expect.objectContaining({ absolute: 1, source: 'tmdb' })]);
  });

  test('needs a season and episode, or an absolute number', async () => {
    await expect(admin.mutation(api.api.metadata.setManualMapping, { unitId: unit(1, 2), ordering: 'scene', season: 1 })).rejects.toThrow();
    await expect(admin.mutation(api.api.metadata.setManualMapping, { unitId: unit(1, 2), ordering: 'scene' })).rejects.toThrow();
  });

  test('only manual rows can be removed', async () => {
    const [tmdbRow] = await admin.query(api.api.metadata.unitMappings, { unitId: unit(1, 1) });
    await expect(admin.mutation(api.api.metadata.removeManualMapping, { mappingId: tmdbRow!.mappingId })).rejects.toThrow(/notManual/);
  });
});

test('only an admin can change numbering', async () => {
  await expect(t.mutation(api.api.metadata.setNumberingScheme, { workId, scheme: 'anime' })).rejects.toThrow(/unauthorized/);
  await expect(t.mutation(api.api.metadata.addAlias, { workId, title: 'x' })).rejects.toThrow(/unauthorized/);
  await expect(t.mutation(api.api.metadata.syncNow, { workId })).rejects.toThrow(/unauthorized/);
});
