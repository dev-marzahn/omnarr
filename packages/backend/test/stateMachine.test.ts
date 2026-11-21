// lib/stateMachine.transition, for search attempts, Grabs and Downloads.
import { beforeEach, describe, expect, test } from 'vite-plus/test';

import type { Id } from '../convex/_generated/dataModel';
import { transition } from '../convex/lib/stateMachine';
import { seedLibraries, setup, type Backend } from './setup';

let t: Backend;
let unitId: Id<'units'>;
let attemptId: Id<'searchAttempts'>;
let grabId: Id<'grabs'>;
let downloadId: Id<'downloads'>;

beforeEach(async () => {
  t = setup();
  const libraries = await seedLibraries(t);
  ({ unitId, attemptId, grabId, downloadId } = await t.run(async (ctx) => {
    const workId = await ctx.db.insert('works', {
      libraryId: libraries.series,
      kind: 'series',
      title: 'The Long Harbor',
      numberingScheme: 'standard',
      releaseProfileId: libraries.releaseProfileId,
      monitorNewUnits: true,
    });
    const unitId = await ctx.db.insert('units', {
      workId,
      kind: 'episode',
      tmdbSeason: 1,
      tmdbEpisode: 1,
      airDateUtc: 0,
      monitored: true,
      derivedState: 'wanted',
    });
    const attemptId = await ctx.db.insert('searchAttempts', {
      unitIds: [unitId],
      wantedUnitIds: [unitId],
      workId,
      groupKind: 'episode',
      trigger: 'manual',
      state: 'running',
      indexerResults: [],
    });
    await ctx.db.patch(unitId, { lastSearchAttemptId: attemptId, derivedState: 'searching' });
    const indexerId = await ctx.db.insert('indexers', {
      name: 'Fake',
      kind: 'newznab',
      apiUrl: 'https://indexer.fake/api',
      apiKey: 'k',
      enabled: true,
      priority: 25,
      categories: { series: [5000], movies: [2000] },
      caps: { searchModes: [], pageLimit: {}, categories: [], fetchedAt: 0 },
      rssIntervalMinutes: 15,
      usage: [],
      consecutiveRateLimits: 0,
      health: { status: 'unknown' },
    });
    const candidateId = await ctx.db.insert('candidates', {
      searchAttemptId: attemptId,
      indexerId,
      guid: 'g',
      title: 't',
      downloadUrl: 'https://indexer.fake/get/g',
      sizeBytes: 1,
      protocol: 'usenet',
      publishedAt: 0,
      parsed: {
        title: 't',
        normalizedTitle: 't',
        episodes: [],
        special: false,
        extras: false,
        hdr: [],
        atmos: false,
        languages: [],
        subtitleLanguages: [],
        hardcodedSubs: false,
        edition: {},
        revision: { version: 1, real: 0, repack: false },
        notes: [],
      },
      unitIds: [unitId],
      alsoContainsUnitIds: [],
      quality: 'webdl-1080p',
      qualityRank: 1,
      qualityAssumed: false,
      baseScore: 0,
      score: 0,
      scoreBreakdown: [],
      preparationStep: 'none',
      preparationAssumed: false,
      outcome: 'picked',
    });
    const grabId = await ctx.db.insert('grabs', { candidateId, protocol: 'usenet', state: 'submitting', cancelRequested: false });
    await ctx.db.insert('grabUnits', { grabId, unitId, outcome: 'pending' });
    const downloadId = await ctx.db.insert('downloads', { grabId, clientKind: 'nzbget', correlationTag: grabId, state: 'active', clientStage: 'queued' });
    return { unitId, attemptId, grabId, downloadId };
  }));
});

const events = () => t.run((ctx) => ctx.db.query('events').collect());

describe('transition', () => {
  test('writes an allowed move, appends its event and recomputes the Units', async () => {
    await t.run((ctx) => transition(ctx, 'searchAttempt', attemptId, 'noAcceptable', { kind: 'decision', message: 'No acceptable release.' }));
    const { attempt, unit } = await t.run(async (ctx) => ({ attempt: await ctx.db.get(attemptId), unit: await ctx.db.get(unitId) }));
    expect(attempt!.state).toBe('noAcceptable');
    expect(unit!.derivedState).toBe('wanted');
    expect(await events()).toMatchObject([
      { unitId, stage: 'search', kind: 'decision', data: { entity: 'searchAttempt', entityId: attemptId, from: 'running', to: 'noAcceptable' } },
    ]);
  });

  test("a Grab's and a Download's events go on the Grab's timeline", async () => {
    await t.run((ctx) => transition(ctx, 'grab', grabId, 'downloading', { kind: 'stageFinished', message: 'The client accepted the release.' }));
    await t.run((ctx) => transition(ctx, 'download', downloadId, 'completed', { kind: 'stageFinished', message: 'Downloaded.' }));
    expect(await events()).toMatchObject([
      { grabId, stage: 'grab', data: { entity: 'grab', from: 'submitting', to: 'downloading' } },
      { grabId, stage: 'download', data: { entity: 'download', from: 'active', to: 'completed' } },
    ]);
  });

  test('rejects a move outside TRANSITIONS for each entity, writing nothing', async () => {
    await expect(t.run((ctx) => transition(ctx, 'searchAttempt', attemptId, 'running', { kind: 'decision', message: '' }))).rejects.toThrow(
      /running → running/,
    );
    await expect(t.run((ctx) => transition(ctx, 'grab', grabId, 'done', { kind: 'stageFinished', message: '' }))).rejects.toThrow(/submitting → done/);
    await t.run((ctx) => transition(ctx, 'download', downloadId, 'removed', { kind: 'stageFinished', message: '' }));
    await expect(t.run((ctx) => transition(ctx, 'download', downloadId, 'active', { kind: 'stageFinished', message: '' }))).rejects.toThrow(/removed → active/);
    expect((await t.run((ctx) => ctx.db.get(grabId)))!.state).toBe('submitting');
  });
});
