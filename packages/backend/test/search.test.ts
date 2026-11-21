// The search pipeline against the Newznab
// fake behind `fetch`: the subscribe search from the first write, candidates
// per page, the pick, the Grab's run up to `download.submit`, and the fake
// worker completing the job.
import { createNewznabHandler, type FakeItem, type NewznabHandler } from '@omnarr/e2e/fakes/newznab';
import { createNyaaHandler, type NyaaItem, type NyaaRequest } from '@omnarr/e2e/fakes/nyaa';
import { jojoParts, SERIES } from '@omnarr/e2e/fakes/tmdb/fixtures';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';

import { api, internal } from '../convex/_generated/api';
import type { Doc, Id } from '../convex/_generated/dataModel';
import jojoPartsNames from './fixtures/xem/jojoPartsNames.json';
import jojoPartsShape from './fixtures/xem/jojoPartsShape.json';
import {
  asAdmin,
  capabilities,
  INDEXER_KEY,
  seedAnimeLists,
  seedIndexer,
  seedLibraries,
  seedNyaa,
  seedXemList,
  settleSearches,
  setup,
  shippedProfile,
  useFetchFakes,
  worker,
  type Backend,
  type Libraries,
} from './setup';

/** Harbour Lights (TMDB 900001, TVDB 7700001) on the fake: a season-1 pack and single episodes. */
const release = (guid: string, title: string, extra: Partial<FakeItem> = {}): FakeItem => ({
  guid,
  title,
  categories: [5000, 5040],
  sizeBytes: 1_500_000_000,
  publishedAt: '2026-11-10T18:30:00Z',
  ids: { tvdbid: '7700001' },
  ...extra,
});
const HARBOUR_ITEMS: FakeItem[] = [
  release('pack1', 'Harbour.Lights.S01.1080p.WEB-DL.DDP5.1.H.264-GRPA', { sizeBytes: 9_000_000_000 }),
  release('s1e1', 'Harbour.Lights.S01E01.1080p.WEB-DL.DDP5.1.H.264-GRPB'),
  release('s1e2hdtv', 'Harbour.Lights.S01E02.720p.HDTV.x264-GRPC'),
  release('s1e3hevc', 'Harbour.Lights.S01E03.1080p.WEB-DL.DDP5.1.H.265-GRPD'),
  release('wrong', 'Lighthouse.Keepers.S01E04.1080p.WEB-DL.DDP5.1.H.264-GRPE'),
  release('s2e1', 'Harbour.Lights.S02E01.1080p.WEB-DL.DDP5.1.H.264-GRPB'),
  release('s2e2', 'Harbour.Lights.S02E02.1080p.WEB-DL.DDP5.1.H.264-GRPB'),
];

/** The fake indexer with Harbour Lights' releases, behind `fetch` with TMDB. */
function harbourIndexer(options: { items?: FakeItem[]; pageMax?: number } = {}): NewznabHandler {
  const fake = createNewznabHandler({ apiKey: INDEXER_KEY, items: options.items ?? HARBOUR_ITEMS, pageMax: options.pageMax });
  useFetchFakes({ indexers: { 'indexer.fake': fake.handle } });
  return fake;
}

const candidatesOf = (attemptId: Id<'searchAttempts'>) =>
  t.run((ctx) =>
    ctx.db
      .query('candidates')
      .withIndex('by_attempt', (q) => q.eq('searchAttemptId', attemptId))
      .collect(),
  );

/** The attempt of season `n`: subscribe starts them in season order. */
const seasonAttempt = async (n: number): Promise<Doc<'searchAttempts'>> => (await attempts()).filter((a) => a.groupKind === 'season')[n - 1]!;

let t: Backend;
let admin: Awaited<ReturnType<typeof asAdmin>>;
let libraries: Libraries;

beforeEach(async () => {
  vi.useFakeTimers();
  t = setup();
  admin = await asAdmin(t);
  libraries = await seedLibraries(t);
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
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

const attempts = () => t.run((ctx) => ctx.db.query('searchAttempts').collect());

const unitsOf = (workId: Id<'works'>) =>
  t.run((ctx) =>
    ctx.db
      .query('units')
      .withIndex('by_work', (q) => q.eq('workId', workId))
      .collect(),
  );

describe("the subscribe search, started by the metadata sync's first write", () => {
  test('one SearchAttempt per wanted season, with lastSearchAt and lastSearchAttemptId on every Unit it searches', async () => {
    useFetchFakes();
    const workId = await subscribe('900001', [1, 2]);
    const units = await unitsOf(workId);
    const regular = (season: number) =>
      units
        .filter((u) => u.tmdbSeason === season)
        .sort((a, b) => a.tmdbEpisode! - b.tmdbEpisode!)
        .map((u) => u._id);

    expect((await attempts()).map((a) => [a.trigger, a.groupKind, a.unitIds, a.wantedUnitIds, a.workId])).toEqual([
      ['subscribe', 'season', regular(1), regular(1), workId],
      ['subscribe', 'season', regular(2), regular(2), workId],
    ]);
    for (const unit of units.filter((u) => u.tmdbSeason !== 0)) {
      expect(unit.lastSearchAt).toEqual(expect.any(Number));
      expect(unit.lastSearchAttemptId).toEqual(expect.any(String));
    }
    // Specials stay unmonitored and aren't searched.
    expect(units.filter((u) => u.tmdbSeason === 0).every((u) => u.lastSearchAt === undefined)).toBe(true);
  });

  test('a later sync starts no second subscribe search', async () => {
    useFetchFakes();
    const workId = await subscribe('900001', [1, 2]);
    await admin.mutation(api.api.metadata.syncNow, { workId });
    await t.finishAllScheduledFunctions(vi.runAllTimers);
    expect((await attempts()).filter((a) => a.trigger === 'subscribe')).toHaveLength(2);
  });

  test('without any indexer the attempts end failed', async () => {
    useFetchFakes();
    await subscribe('900001', [1, 2]);
    await settleSearches(t);
    expect((await attempts()).map((a) => a.state)).toEqual(['failed', 'failed']);
  });
});

describe('the search action', () => {
  test('sends t=tvsearch with the TVDB ID and season per season group, and records every result as a candidate with its decision', async () => {
    const fake = harbourIndexer();
    const indexerId = await seedIndexer(t);
    await subscribe('900001', [1, 2]);
    await settleSearches(t);

    expect(fake.requests.map((q) => [q.get('t'), q.get('tvdbid'), q.get('season'), q.get('ep')])).toEqual([
      ['tvsearch', '7700001', '1', null],
      ['tvsearch', '7700001', '2', null],
    ]);

    const season1 = await seasonAttempt(1);
    expect(season1.indexerResults).toEqual([{ indexerId, status: 'ok', count: 5, pages: 1 }]);
    const rows = await candidatesOf(season1._id);
    const byGuid = Object.fromEntries(rows.map((row) => [row.guid.split('/').at(-1), row]));
    expect(byGuid.pack1).toMatchObject({ quality: 'webdl-1080p', qualityRank: 1, baseScore: 150, score: 150, preparationStep: 'audio' });
    expect(byGuid.pack1!.unitIds).toHaveLength(6);
    expect(byGuid.s1e2hdtv).toMatchObject({ outcome: 'rejected', reason: 'notInProfile', quality: 'hdtv-720p' });
    expect(byGuid.s1e3hevc).toMatchObject({ preparationStep: 'video', baseScore: 150, score: -9850 });
    expect(byGuid.wrong).toMatchObject({ outcome: 'rejected', reason: 'wrongTitleOrEpisode', matchDetail: 'title' });
    expect(byGuid.s1e1!.matchDetail).toBe('tmdb/tmdb, assumed');
    // The attempt led to a Grab, so its candidates no longer expire.
    expect(byGuid.s1e1!.expiresAt).toBeUndefined();
  });

  describe('predicts preparation against the Work’s library target', () => {
    const items = [
      release('opus', 'Harbour.Lights.S01E01.1080p.WEB-DL.Opus.2.0.H.264-GRPA'),
      release('hevc', 'Harbour.Lights.S01E02.1080p.WEB-DL.AAC2.0.H.265-GRPB'),
    ];
    const steps = async () =>
      Object.fromEntries((await t.run((ctx) => ctx.db.query('candidates').collect())).map((row) => [row.guid.split('/').at(-1), row.preparationStep]));

    test('the default target takes MP3, Opus and FLAC besides AAC: an Opus release needs no audio step', async () => {
      harbourIndexer({ items });
      await seedIndexer(t);
      await subscribe('900001', [1]);
      await settleSearches(t);
      expect(await steps()).toEqual({ opus: 'remux', hevc: 'video' });
    });

    test('a library whose target takes HEVC: the HEVC release needs no video step, only the remux to its first container', async () => {
      harbourIndexer({ items });
      await seedIndexer(t);
      await admin.mutation(api.api.playback.update, {
        libraryId: libraries.series,
        draft: { mode: 'devices', devices: ['jellyfinFireTv'], keepOriginal: false },
      });
      await subscribe('900001', [1]);
      await settleSearches(t);
      expect(await steps()).toEqual({ opus: 'remux', hevc: 'remux' });
    });
  });

  test('the pick takes the season pack when it ranks first, and gives every other candidate its reason, rank and lostOn', async () => {
    harbourIndexer();
    await seedIndexer(t);
    await subscribe('900001', [1, 2]);
    await settleSearches(t);

    const season1 = await seasonAttempt(1);
    expect(season1.state).toBe('picked');
    const verdicts = Object.fromEntries(
      (await candidatesOf(season1._id)).map((row) => [row.guid.split('/').at(-1), [row.outcome, row.reason, row.rank, row.lostOn]]),
    );
    expect(verdicts).toEqual({
      pack1: ['picked', undefined, 1, undefined],
      s1e1: ['rejected', 'lowerScore', 2, 'tieBreak'],
      s1e3hevc: ['rejected', 'needsMorePreparation', 3, 'preparation'],
      s1e2hdtv: ['rejected', 'notInProfile', undefined, undefined],
      wrong: ['rejected', 'wrongTitleOrEpisode', undefined, undefined],
    });

    const season2 = await seasonAttempt(2);
    expect(season2.state).toBe('picked');
    expect((await candidatesOf(season2._id)).map((row) => row.outcome)).toEqual(['picked', 'picked']);
  });

  describe('prefer full-season packs', () => {
    // The Andor case: an untiered pack (150) against a tier-1 single episode (1650).
    const items = [
      release('pack1', 'Harbour.Lights.S01.1080p.WEB-DL.DDP5.1.H.264-GRPA', { sizeBytes: 9_000_000_000 }),
      release('flux', 'Harbour.Lights.S01E01.1080p.WEB-DL.DDP5.1.H.264-FLUX'),
    ];
    const verdictsOf = async () =>
      Object.fromEntries(
        (await candidatesOf((await seasonAttempt(1))._id)).map((row) => [row.guid.split('/').at(-1), [row.outcome, row.baseScore, row.lostOn]]),
      );

    test('the shipped profile picks the pack over a higher-scoring episode, which loses on seasonPack', async () => {
      harbourIndexer({ items });
      await seedIndexer(t);
      await subscribe('900001', [1]);
      await settleSearches(t);
      expect(await verdictsOf()).toEqual({ pack1: ['picked', 150, undefined], flux: ['rejected', 1650, 'seasonPack'] });
    });

    test('with the setting off, the episode wins on score as before', async () => {
      harbourIndexer({ items });
      await seedIndexer(t);
      await t.run((ctx) => ctx.db.patch(libraries.releaseProfileId, { preferSeasonPacks: false }));
      await subscribe('900001', [1]);
      await settleSearches(t);
      expect(await verdictsOf()).toEqual({ pack1: ['rejected', 150, 'score'], flux: ['picked', 1650, undefined] });
    });
  });

  test('an attempt with nothing acceptable ends noAcceptable', async () => {
    harbourIndexer({ items: [release('hdtv', 'Harbour.Lights.S01E02.720p.HDTV.x264-GRPC')] });
    await seedIndexer(t);
    await subscribe('900001', [1]);
    await settleSearches(t);
    expect((await seasonAttempt(1)).state).toBe('noAcceptable');
  });

  test("records the requests in the indexer's hourly usage and its health", async () => {
    harbourIndexer();
    const indexerId = await seedIndexer(t);
    await subscribe('900001', [1, 2]);
    await settleSearches(t);
    const indexer = (await t.run((ctx) => ctx.db.get(indexerId)))!;
    expect(indexer.usage).toEqual([{ hourStart: expect.any(Number), requests: 2, errors: 0 }]);
    expect(indexer.health).toMatchObject({ status: 'ok', lastSearch: { status: 'ok', count: 2 } });
  });
});

describe('a fansub season-numbered episode (the S2-01 parser fix)', () => {
  test('`[SubsPlease] Harbour Lights S2-01v2` covers exactly S02E01 and is not a season pack', async () => {
    harbourIndexer({ items: [release('s2dash', '[SubsPlease] Harbour Lights S2-01v2 [1080p] [6504C9CC]')] });
    await seedIndexer(t);
    const workId = await subscribe('900001', [2]);
    await settleSearches(t);

    const s2e1 = (await unitsOf(workId)).find((unit) => unit.tmdbSeason === 2 && unit.tmdbEpisode === 1)!;
    const [row] = await candidatesOf((await seasonAttempt(1))._id);
    expect(row).toMatchObject({ unitIds: [s2e1._id], alsoContainsUnitIds: [] });
    expect(row!.parsed).toMatchObject({ episodes: [{ season: 2, episode: 1 }], revision: { version: 2 } });
    expect(row!.parsed.pack).toBeUndefined();
  });
});

describe('Grabs and the run, to download.submit', () => {
  /** A worker session, as the fake worker in convex-test. */
  const connectWorker = async () => {
    const response = await t.mutation(api.jobs.worker.connect, { ...worker, workerId: 'w1', capabilities });
    if (!response.accepted) throw new Error('not accepted');
    return response.sessionId;
  };

  const grabs = () => t.run((ctx) => ctx.db.query('grabs').collect());
  const jobs = () => t.run((ctx) => ctx.db.query('jobs').collect());

  test('each pick starts a Grab whose run enqueues download.submit; the fake worker completes it and the Grab is downloading', async () => {
    harbourIndexer();
    await seedIndexer(t);
    const workId = await subscribe('900001', [1, 2]);
    await settleSearches(t);

    // Season 1's pack and season 2's two episodes.
    const started = await grabs();
    expect(started).toHaveLength(3);
    expect(started.every((grab) => grab.state === 'submitting' && grab.workflowId !== undefined)).toBe(true);
    const submits = (await jobs()).filter((job) => job.class === 'download.submit');
    expect(submits).toHaveLength(3);
    expect(submits[0]!.payload).toMatchObject({
      class: 'download.submit',
      source: { kind: 'nzbUrl', url: expect.stringContaining('/getnzb/pack1.nzb') },
      category: 'platform-series',
      // The client names the item after it, so NZBGet deobfuscates.
      releaseTitle: 'Harbour.Lights.S01.1080p.WEB-DL.DDP5.1.H.264-GRPA',
    });
    expect(submits.map((job) => job.idempotencyKey).sort()).toEqual(started.map((grab) => `${grab._id}:download.submit`).sort());
    const units = (await unitsOf(workId)).filter((u) => u.tmdbSeason === 1);
    expect(units.map((u) => [u.activeGrabId, u.derivedState])).toEqual(units.map(() => [started[0]!._id, 'grabbed']));

    const sessionId = await connectWorker();
    const claimed = await t.mutation(api.jobs.queue.claim, { ...worker, sessionId, class: 'download.submit', max: 10 });
    for (const job of claimed) {
      await t.mutation(api.jobs.queue.complete, {
        ...worker,
        jobId: job.jobId,
        leaseEpoch: job.leaseEpoch,
        result: { class: 'download.submit', clientRef: `nzb-${job.jobId}` },
      });
    }
    await settleSearches(t);

    const after = await grabs();
    expect(after.map((grab) => grab.state)).toEqual(['downloading', 'downloading', 'downloading']);
    const downloads = await t.run((ctx) => ctx.db.query('downloads').collect());
    expect(downloads.every((d) => d.clientRef?.startsWith('nzb-') && d.state === 'active')).toBe(true);
    const season1 = (await unitsOf(workId)).filter((u) => u.tmdbSeason === 1);
    expect(season1.map((u) => [u.activeGrabId, u.derivedState])).toEqual(season1.map(() => [started[0]!._id, 'downloading']));
    expect((await admin.query(api.api.library.detail, { workId }))!.units.find((u) => u.tmdbSeason === 1)!.state).toBe('downloading');

    // A second search for the same Units grabs nothing again.
    await t.mutation(internal.pipeline.search.start, { unitIds: season1.map((u) => u._id), trigger: 'manual' });
    await settleSearches(t);
    expect(await grabs()).toHaveLength(3);
  });

  test('a terminally failed download.submit ends the Grab failed and frees its Units', async () => {
    harbourIndexer({ items: [release('s1e1', 'Harbour.Lights.S01E01.1080p.WEB-DL.DDP5.1.H.264-GRPB')] });
    await seedIndexer(t);
    const workId = await subscribe('900001', [1]);
    await settleSearches(t);
    const sessionId = await connectWorker();
    const [job] = await t.mutation(api.jobs.queue.claim, { ...worker, sessionId, class: 'download.submit', max: 1 });
    await t.mutation(api.jobs.queue.fail, {
      ...worker,
      jobId: job!.jobId,
      leaseEpoch: job!.leaseEpoch,
      failureCode: 'fakeOrWrongContent',
      detail: 'not a video',
    });
    await settleSearches(t);

    expect((await grabs()).map((grab) => grab.state)).toEqual(['failed']);
    const unit = (await unitsOf(workId)).find((u) => u.tmdbSeason === 1 && u.tmdbEpisode === 1)!;
    expect(unit.activeGrabId).toBeUndefined();
    // A bad release with no other acceptable release left is raised.
    expect(unit.derivedState).toBe('failed');
  });
});

describe('an anime part named by its XEM season name', () => {
  test("searching JoJo's season 5: the Stone Ocean `- 01` covers S5E1 through the scene season, and the general `- 01` is ambiguous", async () => {
    const fake = createNewznabHandler({
      apiKey: INDEXER_KEY,
      items: [
        release('so01', '[SubsPlease] JoJos Bizarre Adventure - Stone Ocean - 01 (1080p)', { categories: [5070], ids: { tvdbid: '7700009' } }),
        release('general01', '[SubsPlease] JoJos Bizarre Adventure - 01 (1080p)', { categories: [5070], ids: { tvdbid: '7700009' } }),
      ],
    });
    // The fake compares `q` word by word and reads seasons from `S05`; an indexer that ignores the apostrophe in
    // "JoJo's" and the part's absolute numbering returns both items, so this one answers every request with them.
    const anyQuery = (request: Request) => {
      const url = new URL(request.url);
      for (const name of ['q', 'season', 'ep']) url.searchParams.delete(name);
      return fake.handle(new Request(url));
    };
    await seedXemList(t, [7700009]);
    useFetchFakes({
      series: [...SERIES, jojoParts()],
      xem: { shows: { 7700009: { all: jojoPartsShape, names: jojoPartsNames } } },
      indexers: { 'indexer.fake': anyQuery },
    });
    await seedIndexer(t);
    const { workId } = await admin.action(api.api.library.subscribe, {
      tmdbId: '900009',
      kind: 'series',
      libraryId: libraries.series,
      releaseProfileId: libraries.releaseProfileId,
      seasons: [5],
      numberingScheme: 'anime',
    });
    await settleSearches(t);

    const [attempt] = await attempts();
    const s5e1 = (await unitsOf(workId)).find((unit) => unit.tmdbSeason === 5 && unit.tmdbEpisode === 1)!;
    const byGuid = Object.fromEntries((await candidatesOf(attempt!._id)).map((row) => [row.guid.split('/').at(-1), row]));
    expect(byGuid.so01).toMatchObject({ unitIds: [s5e1._id], matchDetail: 'scene/xem, mapped' });
    expect(byGuid.general01).toMatchObject({ unitIds: [], outcome: 'rejected', reason: 'wrongTitleOrEpisode', matchDetail: 'episode' });
  });
});

describe('a Torznab indexer', () => {
  const HASH_E1 = 'C12FE1C06BBA254A9DC9F519B335AA7C1367A88A';
  const torznabItems: FakeItem[] = [
    release('t1', 'Harbour.Lights.S01E01.1080p.WEB-DL.DDP5.1.H.264-GRPB', { torrent: { infoHash: HASH_E1, seeders: 5, peers: 7, file: new Uint8Array([1]) } }),
    release('t2', 'Harbour.Lights.S01E02.1080p.WEB-DL.DDP5.1.H.264-GRPB', { torrent: { infoHash: '0123456789abcdef0123456789abcdef01234567', seeders: 3 } }),
    release('t3', 'Harbour.Lights.S01E03.1080p.WEB-DL.DDP5.1.H.264-GRPB', {
      torrent: { infoHash: 'fedcba9876543210fedcba9876543210fedcba98', seeders: 0, file: new Uint8Array([1]) },
    }),
  ];
  const submits = async () => (await t.run((ctx) => ctx.db.query('jobs').collect())).filter((job) => job.class === 'download.submit');

  beforeEach(async () => {
    useFetchFakes({ indexers: { 'tracker.fake': createNewznabHandler({ apiKey: INDEXER_KEY, kind: 'torznab', items: torznabItems }).handle } });
    await seedIndexer(t, { host: 'tracker.fake', kind: 'torznab' });
    await subscribe('900001', [1]);
    await settleSearches(t);
  });

  test('records candidates with the normalized info hash and seeders; 0 seeders is rejected as noSeeders', async () => {
    const candidates = await candidatesOf((await seasonAttempt(1))._id);
    const byGuid = new Map(candidates.map((c) => [c.guid.replace('https://tracker.fake/details/', ''), c]));
    expect(byGuid.get('t1')).toMatchObject({ protocol: 'torrent', torrent: { infoHash: HASH_E1.toLowerCase(), seeders: 5, peers: 7 } });
    expect(byGuid.get('t3')).toMatchObject({ reason: 'noSeeders' });
  });

  test('a candidate with an http(s) link submits its .torrent file, one with only a magnet submits the magnet', async () => {
    const sources = (await submits()).map((job) => (job.payload as { source: unknown }).source);
    expect(sources).toEqual(
      expect.arrayContaining([
        { kind: 'torrentUrl', url: `https://tracker.fake/dl/t1.torrent?apikey=${INDEXER_KEY}` },
        { kind: 'magnet', uri: expect.stringMatching(/^magnet:\?xt=urn:btih:0123456789abcdef0123456789abcdef01234567&/) },
      ]),
    );
    expect(sources).toHaveLength(2);
  });

  test('a bad torrent release is blocklisted under its normalized info hash', async () => {
    const response = await t.mutation(api.jobs.worker.connect, { ...worker, workerId: 'w1', capabilities });
    if (!response.accepted) throw new Error('not accepted');
    const claimed = await t.mutation(api.jobs.queue.claim, { ...worker, sessionId: response.sessionId, class: 'download.submit', max: 10 });
    const e1 = claimed.find((job) => job.payload.class === 'download.submit' && job.payload.source.kind === 'torrentUrl')!;
    await t.mutation(api.jobs.queue.fail, {
      ...worker,
      jobId: e1.jobId,
      leaseEpoch: e1.leaseEpoch,
      failureCode: 'releaseFileInvalid',
      detail: 'not a torrent',
    });
    await settleSearches(t);
    const blocklist = await t.run((ctx) => ctx.db.query('blocklist').collect());
    expect(blocklist.map((row) => row.releaseKey)).toContain(HASH_E1.toLowerCase());
  });
});

describe('an indexer hits its API limit', () => {
  const HOUR = 3_600_000;

  test('error 500 without Retry-After: rateLimited on the attempt, rateLimitedUntil by the fallback rule, other indexers still serve, no Issue', async () => {
    const limited = createNewznabHandler({ apiKey: INDEXER_KEY, items: HARBOUR_ITEMS, failure: { kind: 'limit500' } });
    const good = createNewznabHandler({ apiKey: INDEXER_KEY, items: HARBOUR_ITEMS });
    useFetchFakes({ indexers: { 'limited.fake': limited.handle, 'indexer.fake': good.handle } });
    const limitedId = await seedIndexer(t, { host: 'limited.fake' });
    const goodId = await seedIndexer(t);
    const before = Date.now();
    const workId = await subscribe('900001', [1]);
    await settleSearches(t);

    const attempt = await seasonAttempt(1);
    expect(attempt.state).toBe('picked');
    expect(attempt.indexerResults).toEqual(
      expect.arrayContaining([
        { indexerId: limitedId, status: 'rateLimited', count: 0, pages: 1, failureCode: 'indexerRateLimited' },
        { indexerId: goodId, status: 'ok', count: 5, pages: 1 },
      ]),
    );
    const indexer = (await t.run((ctx) => ctx.db.get(limitedId)))!;
    expect(indexer).toMatchObject({
      rateLimitReason: 'fallback',
      consecutiveRateLimits: 1,
      health: { status: 'rateLimited', failureCode: 'indexerRateLimited' },
    });
    expect(indexer.rateLimitedUntil).toBeGreaterThanOrEqual(before + HOUR);
    expect(indexer.rateLimitedUntil).toBeLessThan(Date.now() + HOUR + 1000);
    expect(await t.run((ctx) => ctx.db.query('issues').collect())).toEqual([]);

    // Until then, searches skip it without asking.
    const asked = limited.requests.length;
    const unit = (await unitsOf(workId)).find((u) => u.tmdbSeason === 1 && u.tmdbEpisode === 1)!;
    await t.run((ctx) => ctx.db.patch(unit._id, { activeGrabId: undefined, derivedState: 'wanted' }));
    await t.mutation(internal.pipeline.search.start, { unitIds: [unit._id], trigger: 'backfill' });
    await settleSearches(t);
    const next = (await attempts()).at(-1)!;
    expect(next.indexerResults).toContainEqual({ indexerId: limitedId, status: 'error', count: 0, pages: 0, skipped: 'rateLimited' });
    expect(limited.requests.length).toBe(asked);
  });

  test('HTTP 429 with Retry-After sets rateLimitedUntil from the header', async () => {
    const limited = createNewznabHandler({ apiKey: INDEXER_KEY, items: HARBOUR_ITEMS, failure: { kind: 'http429', retryAfter: '600' } });
    useFetchFakes({ indexers: { 'indexer.fake': limited.handle } });
    const indexerId = await seedIndexer(t);
    const before = Date.now();
    await subscribe('900001', [1]);
    await settleSearches(t);
    const indexer = (await t.run((ctx) => ctx.db.get(indexerId)))!;
    expect(indexer.rateLimitReason).toBe('retryAfter');
    // 600 s after the call, which happened between `before` and now.
    expect(indexer.rateLimitedUntil).toBeGreaterThanOrEqual(before + 600_000);
    expect(indexer.rateLimitedUntil).toBeLessThanOrEqual(Date.now() + 600_000);
  });

  test('a page with apilimits at their maximum: its candidates are recorded, the next request waits, and health counts no failure', async () => {
    const fake = createNewznabHandler({ apiKey: INDEXER_KEY, items: HARBOUR_ITEMS, pageMax: 2, apiLimits: { current: 100, max: 100 } });
    useFetchFakes({ indexers: { 'indexer.fake': fake.handle } });
    const indexerId = await seedIndexer(t, { caps: { ...(await defaultCaps()), pageLimit: { max: 2 } } });
    await subscribe('900001', [1]);
    await settleSearches(t);

    // A full first page would page on; the limit stops the indexer after it.
    expect(fake.requests).toHaveLength(1);
    const attempt = await seasonAttempt(1);
    expect(attempt.indexerResults).toEqual([{ indexerId, status: 'ok', count: 2, pages: 1 }]);
    expect(await candidatesOf(attempt._id)).toHaveLength(2);
    const indexer = (await t.run((ctx) => ctx.db.get(indexerId)))!;
    expect(indexer.rateLimitedUntil).toBeGreaterThan(Date.now());
    expect(indexer).toMatchObject({ apiLimit: { max: 100, source: 'apilimits' }, health: { status: 'ok' } });
    expect(indexer.health.failureCode).toBeUndefined();
    expect(indexer.usage).toEqual([{ hourStart: expect.any(Number), requests: 1, errors: 0 }]);
  });

  test("an indexer of a protocol whose client row is disabled is skipped as 'protocol'", async () => {
    const fake = harbourIndexer();
    const indexerId = await seedIndexer(t);
    await t.run((ctx) => ctx.db.insert('downloadClients', { kind: 'nzbget', enabled: false, configVersion: 1 }));
    await subscribe('900001', [1]);
    await settleSearches(t);
    expect((await seasonAttempt(1)).indexerResults).toEqual([{ indexerId, status: 'error', count: 0, pages: 0, skipped: 'protocol' }]);
    expect(fake.requests).toHaveLength(0);
  });

  test('a missing client row disables nothing', async () => {
    harbourIndexer();
    await seedIndexer(t);
    await subscribe('900001', [1]);
    await settleSearches(t);
    expect((await seasonAttempt(1)).indexerResults).toEqual([expect.objectContaining({ status: 'ok' })]);
  });

  test('when every indexer was skipped or failed, the attempt ends failed', async () => {
    harbourIndexer();
    await seedIndexer(t, { rateLimitedUntil: Date.now() + HOUR });
    await subscribe('900001', [1]);
    await settleSearches(t);
    const attempt = await seasonAttempt(1);
    expect(attempt.state).toBe('failed');
    expect(attempt.indexerResults).toEqual([expect.objectContaining({ status: 'error', skipped: 'rateLimited', pages: 0 })]);
  });
});

describe('the shares', () => {
  const at = (requests: number) => ({ apiLimit: { max: 100, source: 'user' as const }, usage: [{ hourStart: Date.now() - 3_600_000, requests, errors: 0 }] });

  test('background work stops at 80 % of a known limit; work the user starts goes on to 95 %', async () => {
    const fake = harbourIndexer();
    await seedIndexer(t, at(80));
    const workId = await subscribe('900001', [1]);
    await settleSearches(t);
    // Subscribe is started by the user: 80 of 100 still leaves it room.
    expect((await seasonAttempt(1)).indexerResults).toEqual([expect.objectContaining({ status: 'ok', pages: 1 })]);

    const unit = (await unitsOf(workId)).find((u) => u.tmdbSeason === 1 && u.tmdbEpisode === 1)!;
    await t.run(async (ctx) => {
      for (const grab of await ctx.db.query('grabs').collect()) await ctx.db.delete(grab._id);
      for (const u of await ctx.db.query('units').collect()) await ctx.db.patch(u._id, { activeGrabId: undefined, derivedState: 'wanted' });
    });
    const asked = fake.requests.length;
    await t.mutation(internal.pipeline.search.start, { unitIds: [unit._id], trigger: 'nextBest' });
    await settleSearches(t);
    expect((await attempts()).at(-1)!.indexerResults).toEqual([expect.objectContaining({ skipped: 'share' })]);
    expect(fake.requests.length).toBe(asked);
  });
});

describe('nextBest', () => {
  test('starts a fresh search for the Units with trigger nextBest, under the background share', async () => {
    harbourIndexer({ items: [] });
    await seedIndexer(t);
    const workId = await subscribe('900001', [1]);
    await settleSearches(t);
    const e1 = (await unitsOf(workId)).find((u) => u.tmdbSeason === 1 && u.tmdbEpisode === 1)!;
    await t.mutation(internal.pipeline.search.nextBest, { unitIds: [e1._id] });
    expect((await attempts()).at(-1)).toMatchObject({ trigger: 'nextBest', unitIds: [e1._id], groupKind: 'episode' });
  });
});

describe('paging and follow-ups', () => {
  // Released when season 2 aired (last episode 2023-04-06), so the budget isn't extended.
  const season2 = Array.from({ length: 5 }, (_, i) =>
    release(`s2e${i + 1}`, `Harbour.Lights.S02E0${i + 1}.1080p.WEB-DL.DDP5.1.H.264-GRPB`, { publishedAt: '2023-04-10T12:00:00Z' }),
  );

  test('a season result cut off by the budget is truncated, and the uncovered Units get per-episode follow-ups', async () => {
    const fake = harbourIndexer({ items: season2, pageMax: 1 });
    await seedIndexer(t, { caps: { ...(await defaultCaps()), pageLimit: { max: 1 } } });
    await subscribe('900001', [2]);
    await settleSearches(t);

    const season = await seasonAttempt(1);
    expect(season.indexerResults).toEqual([expect.objectContaining({ status: 'ok', pages: 4, count: 4, truncated: true })]);
    expect(fake.requests.slice(0, 4).map((q) => q.get('offset'))).toEqual(['0', '1', '2', '3']);
    const followUps = (await attempts()).filter((a) => a.groupKind === 'episode');
    expect(followUps).toHaveLength(2);
    expect(followUps.every((a) => a.trigger === 'subscribe')).toBe(true);
  });

  describe('searching further back for an old season', () => {
    // Harbour Lights season 1 last aired on 2021-04-08: paging goes on while the
    // oldest result is newer than 2021-05-08. One result per page.
    const episodes = (count: number, publishedAt: (i: number) => string) =>
      Array.from({ length: count }, (_, i) =>
        release(`s1-${i}`, `Harbour.Lights.S01E0${(i % 6) + 1}.1080p.WEB-DL.DDP5.1.H.264-GRP${String.fromCharCode(65 + i)}`, { publishedAt: publishedAt(i) }),
      );
    const recent = (i: number) => `2026-11-${String(15 - i).padStart(2, '0')}T12:00:00Z`;
    const HOUR = 3_600_000;
    const seasonRequests = (fake: NewznabHandler) => fake.requests.filter((q) => q.get('t') === 'tvsearch' && !q.has('ep'));
    const onePerPage = async (fields: Partial<Doc<'indexers'>> = {}) =>
      seedIndexer(t, { caps: { ...(await defaultCaps()), pageLimit: { max: 1 } }, ...fields });

    test('pages past the budget until a result is older than the last air date plus 30 days', async () => {
      // Six recent results, then the season's original releases from April 2021.
      const items = [...episodes(6, recent), ...episodes(8, () => '2021-04-09T12:00:00Z').slice(6)];
      const fake = harbourIndexer({
        items: [...items, release('older', 'Harbour.Lights.S01E01.1080p.WEB-DL.H.264-OLD', { publishedAt: '2021-04-01T12:00:00Z' })],
        pageMax: 1,
      });
      await onePerPage();
      await subscribe('900001', [1]);
      await settleSearches(t);

      expect(seasonRequests(fake).map((q) => q.get('offset'))).toEqual(['0', '1', '2', '3', '4', '5', '6']);
      expect((await seasonAttempt(1)).indexerResults).toEqual([expect.objectContaining({ status: 'ok', pages: 7, truncated: true })]);
    });

    test('stops at 10 requests per group', async () => {
      const fake = harbourIndexer({ items: episodes(12, recent), pageMax: 1 });
      await onePerPage();
      await subscribe('900001', [1]);
      await settleSearches(t);
      expect(seasonRequests(fake)).toHaveLength(10);
      expect((await seasonAttempt(1)).indexerResults).toEqual([expect.objectContaining({ pages: 10, truncated: true })]);
    });

    test('a recent season gets no more than the 4-request budget', async () => {
      // Season 2 last aired on 2023-04-06; two weeks later its releases are all newer than that.
      vi.setSystemTime(new Date('2023-04-20T12:00:00Z'));
      t = setup();
      admin = await asAdmin(t);
      libraries = await seedLibraries(t);
      const fake = harbourIndexer({
        items: Array.from({ length: 8 }, (_, i) =>
          release(`s2-${i}`, `Harbour.Lights.S02E0${(i % 6) + 1}.1080p.WEB-DL.DDP5.1.H.264-GRP${String.fromCharCode(65 + i)}`, {
            publishedAt: `2023-04-${String(19 - i).padStart(2, '0')}T12:00:00Z`,
          }),
        ),
        pageMax: 1,
      });
      await onePerPage();
      await subscribe('900001', [2]);
      await settleSearches(t);
      expect(seasonRequests(fake)).toHaveLength(4);
    });

    test("the indexer's share still stops it", async () => {
      const fake = harbourIndexer({ items: episodes(12, recent), pageMax: 1 });
      // A user-started search may spend up to 95 of 100: 5 requests are left.
      await onePerPage({ apiLimit: { max: 100, source: 'user' }, usage: [{ hourStart: Date.now() - HOUR, requests: 90, errors: 0 }] });
      await subscribe('900001', [1]);
      await settleSearches(t);
      expect(seasonRequests(fake)).toHaveLength(5);
    });

    test('a rate limit still stops it', async () => {
      const fake = createNewznabHandler({ apiKey: INDEXER_KEY, items: episodes(12, recent), pageMax: 1 });
      const limited = (request: Request, init?: { signal?: AbortSignal }) => {
        if (fake.requests.length === 5) fake.setFailure({ kind: 'http429', retryAfter: '3600' });
        return fake.handle(request, init);
      };
      useFetchFakes({ indexers: { 'indexer.fake': limited } });
      const indexerId = await onePerPage();
      await subscribe('900001', [1]);
      await settleSearches(t);
      expect(seasonRequests(fake)).toHaveLength(6);
      expect((await t.run((ctx) => ctx.db.get(indexerId)))!.rateLimitedUntil).toBeGreaterThan(Date.now());
    });
  });

  test('without truncation the uncovered Units wait: no follow-ups', async () => {
    harbourIndexer();
    await seedIndexer(t);
    await subscribe('900001', [2]);
    await settleSearches(t);
    expect((await attempts()).map((a) => a.groupKind)).toEqual(['season']);
  });

  test('a first request whose results match no title falls back to the title search', async () => {
    const fake = harbourIndexer({ items: [release('noid', 'Harbour.Lights.S01E01.1080p.WEB-DL.DDP5.1.H.264-GRPB', { ids: {} })] });
    await seedIndexer(t);
    await subscribe('900001', [1]);
    await settleSearches(t);
    expect(fake.requests.map((q) => [q.get('t'), q.get('tvdbid'), q.get('q'), q.get('season')])).toEqual([
      ['tvsearch', '7700001', null, '1'],
      ['tvsearch', null, 'Harbour Lights', '1'],
    ]);
    expect((await seasonAttempt(1)).state).toBe('picked');
  });
});

/** seedIndexer's caps, to change one field of. */
describe('a Nyaa indexer', () => {
  const hash = (n: number) => n.toString(16).padStart(40, 'a');
  const nyaaItem = (id: number, title: string, extra: Partial<NyaaItem> = {}): NyaaItem => ({
    id,
    title,
    infoHash: hash(id),
    size: '1.4 GiB',
    publishedAt: '2024-11-10T18:30:00Z',
    seeders: 20,
    leechers: 2,
    ...extra,
  });
  /** Four groups' releases of Star Lantern's 24 episodes: 96 matches for its title, more than the feed's 75. */
  const STAR_LANTERN = ['GroupA', 'GroupB', 'GroupC', 'GroupD'].flatMap((group, g) =>
    Array.from({ length: 24 }, (_, i) => nyaaItem(1000 + g * 24 + i, `[${group}] Star Lantern - ${String(i + 1).padStart(2, '0')} (1080p) [ABCD${g}${i}].mkv`)),
  );

  function serveNyaa(items: NyaaItem[]) {
    const fake = createNyaaHandler({ items, origin: 'https://nyaa.fake' });
    useFetchFakes({ indexers: { 'nyaa.fake': fake.handle } });
    return fake;
  }

  async function subscribeStarLantern(seasons = [1]) {
    await seedAnimeLists(t);
    const animeProfile = await t.run((ctx) => ctx.db.insert('releaseProfiles', shippedProfile('anime-1080p')));
    const { workId } = await admin.action(api.api.library.subscribe, {
      tmdbId: '900002',
      kind: 'series',
      libraryId: libraries.series,
      releaseProfileId: animeProfile,
      seasons,
    });
    await settleSearches(t);
    return workId;
  }

  const request = (r: NyaaRequest) => `${r.path}?${r.params.toString()}`;

  test('a season search sends the title to the feed, and a full feed pages into the listing; every request counts in usage', async () => {
    const fake = serveNyaa(STAR_LANTERN);
    const nyaaId = await seedNyaa(t);
    await subscribeStarLantern([1]);

    const attempt = (await attempts()).find((a) => a.groupKind === 'animeSeason')!;
    expect(fake.requests.map(request)).toEqual(['/?page=rss&q=Star+Lantern&c=1_0&f=0&m=1', '/?q=Star+Lantern&c=1_0&f=0&s=id&o=desc&p=2']);
    expect(fake.requests.every((r) => r.userAgent?.startsWith('omnarr/'))).toBe(true);
    expect(attempt.indexerResults).toEqual([{ indexerId: nyaaId, status: 'ok', count: 96, pages: 2 }]);
    const nyaa = (await t.run((ctx) => ctx.db.get(nyaaId)))!;
    expect(nyaa.usage.reduce((sum, hour) => sum + hour.requests, 0)).toBe(2);
    expect(nyaa.health).toMatchObject({ status: 'ok', lastSearch: { status: 'ok', count: 21 } });
  });

  test('an anime episode search sends the "<title> <nn>" query to the feed, and its result becomes a candidate with its magnet and peers', async () => {
    const fake = serveNyaa([]);
    await seedNyaa(t);
    const workId = await subscribeStarLantern([1]);
    fake.setItems([nyaaItem(2001, '[SubsPlease] Star Lantern - 03 (1080p) [ABCD1234].mkv', { seeders: 120, leechers: 8 })]);
    const unit = (await unitsOf(workId)).find((u) => u.tmdbSeason === 1 && u.tmdbEpisode === 3)!;
    const asked = fake.requests.length;
    await t.mutation(internal.pipeline.search.start, { unitIds: [unit._id], trigger: 'manual' });
    await settleSearches(t);

    expect(fake.requests.slice(asked).map(request)).toEqual(['/?page=rss&q=Star+Lantern+03&c=1_0&f=0&m=1']);
    const attempt = (await attempts()).at(-1)!;
    expect(attempt).toMatchObject({ groupKind: 'animeEpisode', state: 'picked' });
    const [candidate] = await candidatesOf(attempt._id);
    expect(candidate).toMatchObject({
      guid: 'https://nyaa.fake/view/2001',
      protocol: 'torrent',
      sizeBytes: 1_503_238_554,
      outcome: 'picked',
      unitIds: [unit._id],
      torrent: { infoHash: hash(2001), seeders: 120, peers: 128 },
    });
    expect(candidate!.downloadUrl).toMatch(/^magnet:\?xt=urn:btih:/);
  });

  test("a standard series isn't searched on Nyaa: skipped with `animeOnly`, no request", async () => {
    const fake = serveNyaa(STAR_LANTERN);
    const nyaaId = await seedNyaa(t);
    await subscribe('900001', [1]);
    await settleSearches(t);
    expect(fake.requests).toEqual([]);
    expect((await seasonAttempt(1)).indexerResults).toEqual([{ indexerId: nyaaId, status: 'error', count: 0, pages: 0, skipped: 'animeOnly' }]);
  });

  test("a refused pacing slot is the `paced` skip: no request, and the indexer's health, usage and rate limit stay as they were", async () => {
    const fake = serveNyaa(STAR_LANTERN);
    const nyaaId = await seedNyaa(t, { consecutiveRateLimits: 2 });
    await t.run((ctx) => ctx.db.insert('indexerPacing', { indexerId: nyaaId, nextAt: Date.now() + 10 * 60_000 }));
    const before = (await t.run((ctx) => ctx.db.get(nyaaId)))!;
    await subscribeStarLantern([1]);

    expect(fake.requests).toEqual([]);
    const attempt = (await attempts()).find((a) => a.groupKind === 'animeSeason')!;
    expect(attempt.indexerResults).toEqual([{ indexerId: nyaaId, status: 'error', count: 0, pages: 0, skipped: 'paced' }]);
    const after = (await t.run((ctx) => ctx.db.get(nyaaId)))!;
    for (const field of ['health', 'usage', 'rateLimitedUntil', 'rateLimitReason', 'consecutiveRateLimits'] as const)
      expect(after[field]).toEqual(before[field]);
  });

  test('a DDoS-Guard check is `challenged`: rateLimited health, the fallback backoff, no Issue', async () => {
    const fake = serveNyaa(STAR_LANTERN);
    fake.setFailure({ kind: 'ddosGuard' });
    const nyaaId = await seedNyaa(t);
    const before = Date.now();
    await subscribeStarLantern([1]);

    const attempt = (await attempts()).find((a) => a.groupKind === 'animeSeason')!;
    expect(attempt.indexerResults).toEqual([{ indexerId: nyaaId, status: 'rateLimited', count: 0, pages: 1, failureCode: 'indexerRateLimited' }]);
    const nyaa = (await t.run((ctx) => ctx.db.get(nyaaId)))!;
    expect(nyaa).toMatchObject({
      rateLimitReason: 'fallback',
      consecutiveRateLimits: 1,
      health: { status: 'rateLimited', failureCode: 'indexerRateLimited', detail: { kind: 'challenged', httpStatus: 503, challenge: 'ddosGuard' } },
    });
    expect(nyaa.rateLimitedUntil).toBeGreaterThanOrEqual(before + 3_600_000);
    expect(await t.run((ctx) => ctx.db.query('issues').collect())).toEqual([]);
  });

  describe('title-only search (the title-only search fix)', () => {
    /**
     * Star Lantern as the real install's Work: XEM names it by its romaji,
     * as the fansub groups do, and its scene absolute restarts with each
     * season, so S02E04 is searched as `… 04` (the install's query was).
     */
    async function subscribeWithXem(items: NyaaItem[]) {
      const fake = createNyaaHandler({ items: [], origin: 'https://nyaa.fake' });
      const data = [1, 2].flatMap((s) =>
        Array.from({ length: 12 }, (_, i) => ({
          scene: { season: s, episode: i + 1, absolute: i + 1 },
          tvdb: { season: s, episode: i + 1, absolute: (s - 1) * 12 + i + 1 },
        })),
      );
      const names = { result: 'success', data: { all: { ja: ['Hoshi no Chouchin'] } }, message: '' };
      await seedXemList(t, [7700002]);
      useFetchFakes({ indexers: { 'nyaa.fake': fake.handle }, xem: { shows: { 7700002: { all: { result: 'success', data, message: '' }, names } } } });
      const nyaaId = await seedNyaa(t);
      const workId = await subscribeStarLantern([2]);
      fake.setItems(items);
      return { fake, nyaaId, workId };
    }

    test('S02E04 sends the English title, then the XEM romaji; the SubsPlease `S2 - 04` only the romaji finds is picked, and each request counts in usage', async () => {
      const { fake, nyaaId, workId } = await subscribeWithXem([
        nyaaItem(3001, '[Ohys-Raws] Star Lantern - 04 (BS11 1280x720 x264 AAC).mp4', { publishedAt: '2022-04-28T18:30:00Z' }),
        nyaaItem(3002, '[SubsPlease] Hoshi no Chouchin S2 - 04 (1080p) [ABCD3002].mkv', { seeders: 300 }),
      ]);
      const unit = (await unitsOf(workId)).find((u) => u.tmdbSeason === 2 && u.tmdbEpisode === 4)!;
      const asked = fake.requests.length;
      const usageBefore = (await t.run((ctx) => ctx.db.get(nyaaId)))!.usage.reduce((sum, hour) => sum + hour.requests, 0);
      await t.mutation(internal.pipeline.search.start, { unitIds: [unit._id], trigger: 'manual' });
      await settleSearches(t);

      expect(fake.requests.slice(asked).map((r) => r.params.get('q'))).toEqual(['Star Lantern 04', 'Hoshi no Chouchin 04']);
      const attempt = (await attempts()).at(-1)!;
      expect(attempt).toMatchObject({ groupKind: 'animeEpisode', state: 'picked' });
      expect(attempt.indexerResults).toEqual([{ indexerId: nyaaId, status: 'ok', count: 2, pages: 2 }]);
      const picked = (await candidatesOf(attempt._id)).find((c) => c.outcome === 'picked');
      expect(picked).toMatchObject({ guid: 'https://nyaa.fake/view/3002', unitIds: [unit._id] });
      const usageAfter = (await t.run((ctx) => ctx.db.get(nyaaId)))!.usage.reduce((sum, hour) => sum + hour.requests, 0);
      expect(usageAfter - usageBefore).toBe(2);
    });
  });
});

const defaultCaps = async () => {
  const indexerId = await seedIndexer(t, { host: 'scratch.fake', enabled: false });
  const caps = (await t.run((ctx) => ctx.db.get(indexerId)))!.caps;
  await t.run((ctx) => ctx.db.delete(indexerId));
  return caps;
};
