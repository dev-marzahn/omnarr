import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';

import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import { PREPARED_PROBE, seedFile, WEBDL_PATH } from './fakePrepare';
import { asAdmin, seedLibraries, settleSearches, setup, useMetadataFakes, worker, type Backend } from './setup';

let t: Backend;
let admin: Awaited<ReturnType<typeof asAdmin>>;
let workId: Id<'works'>;

/** Harbour Lights in the fake: specials (1), season 1 (6) and season 2 (6), all aired. */
beforeEach(async () => {
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
  // The subscribe search fails without an indexer, so the Units show "wanted".
  await settleSearches(t);
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const detail = async () => (await admin.query(api.api.library.detail, { workId }))!;
const statesOfSeason = async (season: number) => (await detail()).units.filter((u) => u.tmdbSeason === season).map((u) => [u.monitored, u.state]);

describe('units.setMonitored', () => {
  test('unmonitoring a season makes its Units "not monitored" and leaves the others', async () => {
    await admin.mutation(api.api.units.setMonitored, { target: { kind: 'season', workId, season: 1 }, monitored: false });
    expect(await statesOfSeason(1)).toEqual(Array(6).fill([false, 'notMonitored']));
    expect(await statesOfSeason(2)).toEqual(Array(6).fill([true, 'wanted']));
    expect((await detail()).work).toMatchObject({ monitored: 6 });
  });

  test('monitoring a season again derives each Unit afresh', async () => {
    await admin.mutation(api.api.units.setMonitored, { target: { kind: 'season', workId, season: 1 }, monitored: false });
    await admin.mutation(api.api.units.setMonitored, { target: { kind: 'season', workId, season: 1 }, monitored: true });
    expect(await statesOfSeason(1)).toEqual(Array(6).fill([true, 'wanted']));
  });

  test('specials can be monitored as season 0', async () => {
    await admin.mutation(api.api.units.setMonitored, { target: { kind: 'season', workId, season: 0 }, monitored: true });
    expect(await statesOfSeason(0)).toEqual([[true, 'wanted']]);
  });

  test('single Units can be unmonitored by ID', async () => {
    const [first, second] = (await detail()).units.filter((u) => u.tmdbSeason === 2);
    const result = await admin.mutation(api.api.units.setMonitored, { target: { kind: 'units', unitIds: [first!.unitId, second!.unitId] }, monitored: false });
    expect(result).toEqual({ changed: 2 });
    expect(await statesOfSeason(2)).toEqual([[false, 'notMonitored'], [false, 'notMonitored'], ...Array(4).fill([true, 'wanted'])]);
  });

  test('counts only the Units whose flag changed', async () => {
    const result = await admin.mutation(api.api.units.setMonitored, { target: { kind: 'season', workId, season: 1 }, monitored: true });
    expect(result).toEqual({ changed: 0 });
  });

  test('only an admin can change monitoring', async () => {
    await expect(t.mutation(api.api.units.setMonitored, { target: { kind: 'season', workId, season: 1 }, monitored: false })).rejects.toThrow(/unauthorized/);
  });
});

describe('preparation on the item page', () => {
  let unitId: Id<'units'>;
  beforeEach(async () => {
    unitId = (await detail()).units.find((u) => u.tmdbSeason === 1 && u.tmdbEpisode === 1)!.unitId;
  });
  const renditions = () => t.run((ctx) => ctx.db.query('renditions').collect());
  const state = async () => (await t.run((ctx) => ctx.db.get(unitId)))!.derivedState;

  test('preparationPlan: the primary’s name, origin and comparison with the library’s target; queued once a Rendition is pending', async () => {
    expect(await admin.query(api.api.units.preparationPlan, { unitId })).toBeNull();
    await seedFile(t, { unitIds: [unitId], path: WEBDL_PATH });
    const plan = (await admin.query(api.api.units.preparationPlan, { unitId }))!;
    expect(plan).toMatchObject({
      fileName: 'Show (2019) - S01E02 - Pilot [AMZN][WEBDL-1080p][EAC3 5.1][h264]-GRP.mkv',
      origin: 'download',
      queued: false,
      comparison: { fits: false, steps: ['audio', 'subtitle', 'remux'], container: { from: 'matroska', to: 'mp4', change: true } },
    });
    expect(plan.comparison.streams.map((stream) => [stream.kind, stream.action])).toEqual([
      ['video', 'copy'],
      ['audio', 'transcode'],
      ['subtitle', 'extract'],
      ['subtitle', 'extract'],
    ]);
    await admin.mutation(api.api.units.prepareNow, { unitId });
    expect((await admin.query(api.api.units.preparationPlan, { unitId }))!.queued).toBe(true);
  });

  test('prepareNow starts a Rendition in group 0 ("manual"); with a transcodeFailed Issue open it is the retry', async () => {
    await seedFile(t, { unitIds: [unitId], path: WEBDL_PATH });
    expect(await admin.mutation(api.api.units.prepareNow, { unitId })).toEqual({ queued: 1 });
    await t.run((ctx) =>
      ctx.db.insert('issues', { scope: 'unit', unitId, failureCode: 'transcodeFailed', class: 'preparation', state: 'open', fixActions: [] }),
    );
    await admin.mutation(api.api.units.prepareNow, { unitId });
    expect((await renditions()).map((rendition) => [rendition.reason, rendition.state])).toEqual([
      ['manual', 'cancelled'],
      ['retry', 'pending'],
    ]);
    expect(await state()).toBe('preparing');
  });

  test('prepareNow prepares a scanned file on demand, and queues nothing for a file that fits', async () => {
    await seedFile(t, { unitIds: [unitId], origin: 'scan', keepsName: true, release: null, path: '/data/library/series/Old/Old - 1.mkv' });
    expect(await admin.mutation(api.api.units.prepareNow, { unitId })).toEqual({ queued: 1 });
    const other = (await detail()).units.find((u) => u.tmdbSeason === 1 && u.tmdbEpisode === 2)!.unitId;
    await seedFile(t, { unitIds: [other], probe: PREPARED_PROBE, path: '/data/library/series/Show/E2.mp4', fits: true });
    expect(await admin.mutation(api.api.units.prepareNow, { unitId: other })).toEqual({ queued: 0 });
  });

  test('cancelPreparation cancels the pending Rendition, with no Issue; the Unit is "not yet in target format"', async () => {
    await seedFile(t, { unitIds: [unitId], path: WEBDL_PATH });
    await admin.mutation(api.api.units.prepareNow, { unitId });
    await admin.mutation(api.api.units.cancelPreparation, { unitId });
    expect((await renditions()).map((rendition) => rendition.state)).toEqual(['cancelled']);
    expect(await t.run((ctx) => ctx.db.query('issues').collect())).toEqual([]);
    expect(await state()).toBe('notInTargetFormat');
  });

  test('each refuses a caller without an admin session, and a worker', async () => {
    await expect(t.query(api.api.units.preparationPlan, { unitId })).rejects.toThrow(/unauthorized/);
    await expect(t.mutation(api.api.units.prepareNow, { unitId })).rejects.toThrow(/unauthorized/);
    await expect(t.mutation(api.api.units.cancelPreparation, { unitId })).rejects.toThrow(/unauthorized/);
    await expect(t.query(api.api.units.preparationPlan, { ...worker, unitId } as never)).rejects.toThrow();
    await expect(t.mutation(api.api.units.prepareNow, { ...worker, unitId } as never)).rejects.toThrow();
    await expect(t.mutation(api.api.units.cancelPreparation, { ...worker, unitId } as never)).rejects.toThrow();
  });
});
