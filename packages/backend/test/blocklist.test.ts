// The blocklist through the search path: both keys, and a
// re-post of a blocked release under a new GUID.
import { createNewznabHandler, type FakeItem } from '@omnarr/e2e/fakes/newznab';
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test';

import { api, internal } from '../convex/_generated/api';
import { addToBlocklist, keysForWork, removeForCandidate } from '../convex/pipeline/blocklist';
import { asAdmin, INDEXER_KEY, seedIndexer, seedLibraries, settleSearches, setup, useFetchFakes, type Backend } from './setup';

let t: Backend;

beforeEach(() => {
  vi.useFakeTimers();
  t = setup();
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

const TITLE = 'Harbour.Lights.S01E01.1080p.WEB-DL.DDP5.1.H.264-GRPB';

const serve = (items: FakeItem[]) => useFetchFakes({ indexers: { 'indexer.fake': createNewznabHandler({ apiKey: INDEXER_KEY, items }).handle } });

test('a release blocked by GUID, and its re-post under a new GUID by normalized title, are rejected as blocklisted', async () => {
  const admin = await asAdmin(t);
  const libraries = await seedLibraries(t);
  serve([]);
  await seedIndexer(t);
  const { workId } = await admin.action(api.api.library.subscribe, {
    tmdbId: '900001',
    kind: 'series',
    libraryId: libraries.series,
    releaseProfileId: libraries.releaseProfileId,
    seasons: [1],
  });
  await settleSearches(t);

  await t.run((ctx) =>
    addToBlocklist(ctx, { workId, item: { guid: 'https://indexer.fake/details/old', title: TITLE, protocol: 'usenet' }, reason: 'fakeOrWrongContent' }),
  );
  expect(await t.run((ctx) => keysForWork(ctx, workId))).toEqual({
    releaseKeys: ['https://indexer.fake/details/old'],
    normalizedTitles: ['harbour lights s01e01 1080p web dl ddp5 1 h 264 grpb'],
  });

  // The same release, re-posted with a new GUID and a re-poster suffix.
  const repost = `${TITLE}-Obfuscated`;
  serve([{ guid: 'new', title: repost, categories: [5040], sizeBytes: 1_500_000_000, publishedAt: '2026-11-10T18:30:00Z', ids: { tvdbid: '7700001' } }]);
  const e1 = (await t.run((ctx) => ctx.db.query('units').collect())).find((u) => u.tmdbSeason === 1 && u.tmdbEpisode === 1)!;
  await t.mutation(internal.pipeline.search.start, { unitIds: [e1._id], trigger: 'manual' });
  await settleSearches(t);
  const candidates = await t.run((ctx) => ctx.db.query('candidates').collect());
  expect(candidates.map((c) => [c.title, c.outcome, c.reason])).toEqual([[repost, 'rejected', 'blocklisted']]);

  // Removing it for a candidate clears both keys.
  await t.run((ctx) => removeForCandidate(ctx, candidates[0]!._id));
  expect(await t.run((ctx) => keysForWork(ctx, workId))).toEqual({ releaseKeys: [], normalizedTitles: [] });
});

test('a missing-articles failure blocks its own Usenet post only: a repost under a new GUID and the torrent of the same title stay open', async () => {
  const admin = await asAdmin(t);
  const libraries = await seedLibraries(t);
  serve([]);
  await seedIndexer(t);
  await seedIndexer(t, { host: 'tracker.fake', kind: 'torznab' });
  const { workId } = await admin.action(api.api.library.subscribe, {
    tmdbId: '900001',
    kind: 'series',
    libraryId: libraries.series,
    releaseProfileId: libraries.releaseProfileId,
    seasons: [1],
  });
  await settleSearches(t);

  const takenDown = 'https://indexer.fake/details/old';
  await t.run((ctx) => addToBlocklist(ctx, { workId, item: { guid: takenDown, title: TITLE, protocol: 'usenet' }, reason: 'missingArticles' }));
  expect(await t.run((ctx) => keysForWork(ctx, workId))).toEqual({ releaseKeys: [takenDown], normalizedTitles: [] });

  const usenet = (guid: string): FakeItem => ({
    guid,
    title: TITLE,
    categories: [5040],
    sizeBytes: 1_500_000_000,
    publishedAt: '2026-11-10T18:30:00Z',
    ids: { tvdbid: '7700001' },
  });
  useFetchFakes({
    indexers: {
      'indexer.fake': createNewznabHandler({ apiKey: INDEXER_KEY, items: [usenet('old'), usenet('repost')] }).handle,
      'tracker.fake': createNewznabHandler({
        apiKey: INDEXER_KEY,
        kind: 'torznab',
        items: [{ ...usenet('t1'), torrent: { infoHash: '0123456789abcdef0123456789abcdef01234567', seeders: 5 } }],
      }).handle,
    },
  });
  const e1 = (await t.run((ctx) => ctx.db.query('units').collect())).find((u) => u.tmdbSeason === 1 && u.tmdbEpisode === 1)!;
  await t.mutation(internal.pipeline.search.start, { unitIds: [e1._id], trigger: 'manual' });
  await settleSearches(t);
  const candidates = await t.run((ctx) => ctx.db.query('candidates').collect());
  const blocklisted = Object.fromEntries(candidates.map((c) => [`${c.protocol}:${c.guid}`, c.reason === 'blocklisted']));
  expect(blocklisted).toEqual({
    [`usenet:${takenDown}`]: true,
    'usenet:https://indexer.fake/details/repost': false,
    'torrent:https://tracker.fake/details/t1': false,
  });
});

test('a content failure still blocks by normalized title, so a torrent of the same release is rejected too', async () => {
  const admin = await asAdmin(t);
  const libraries = await seedLibraries(t);
  serve([]);
  await seedIndexer(t, { host: 'tracker.fake', kind: 'torznab' });
  const { workId } = await admin.action(api.api.library.subscribe, {
    tmdbId: '900001',
    kind: 'series',
    libraryId: libraries.series,
    releaseProfileId: libraries.releaseProfileId,
    seasons: [1],
  });
  await settleSearches(t);

  await t.run((ctx) =>
    addToBlocklist(ctx, { workId, item: { guid: 'https://indexer.fake/details/old', title: TITLE, protocol: 'usenet' }, reason: 'fakeOrWrongContent' }),
  );
  useFetchFakes({
    indexers: {
      'tracker.fake': createNewznabHandler({
        apiKey: INDEXER_KEY,
        kind: 'torznab',
        items: [
          {
            guid: 't1',
            title: TITLE,
            categories: [5040],
            sizeBytes: 1_500_000_000,
            publishedAt: '2026-11-10T18:30:00Z',
            ids: { tvdbid: '7700001' },
            torrent: { infoHash: '0123456789abcdef0123456789abcdef01234567', seeders: 5 },
          },
        ],
      }).handle,
    },
  });
  const e1 = (await t.run((ctx) => ctx.db.query('units').collect())).find((u) => u.tmdbSeason === 1 && u.tmdbEpisode === 1)!;
  await t.mutation(internal.pipeline.search.start, { unitIds: [e1._id], trigger: 'manual' });
  await settleSearches(t);
  const candidates = await t.run((ctx) => ctx.db.query('candidates').collect());
  expect(candidates.map((c) => [c.protocol, c.guid, c.reason])).toEqual([['torrent', 'https://tracker.fake/details/t1', 'blocklisted']]);
});

test('Settings › Blocklist lists every entry newest first with its Work and protocol; an old row has none, and unblock removes only that entry', async () => {
  const admin = await asAdmin(t);
  const libraries = await seedLibraries(t);
  serve([]);
  const { workId } = await admin.action(api.api.library.subscribe, {
    tmdbId: '900001',
    kind: 'series',
    libraryId: libraries.series,
    releaseProfileId: libraries.releaseProfileId,
    seasons: [1],
  });
  await settleSearches(t);

  // A row from before the protocol was stored, written without a protocol.
  const oldId = await t.run((ctx) =>
    ctx.db.insert('blocklist', { workId, releaseKey: 'old-guid', title: 'Harbour.Lights.S01E02.720p.HDTV-OLD', reason: 'parFailed' }),
  );
  await t.run((ctx) =>
    addToBlocklist(ctx, { workId, item: { guid: 'https://indexer.fake/details/u1', title: TITLE, protocol: 'usenet' }, reason: 'missingArticles' }),
  );
  await t.run((ctx) =>
    addToBlocklist(ctx, {
      workId,
      item: { guid: 't1', title: `${TITLE}-T`, protocol: 'torrent', torrent: { infoHash: '0123456789abcdef0123456789abcdef01234567', seeders: 1 } },
      reason: 'torrentStalled',
    }),
  );

  const entries = await admin.query(api.api.settings.blocklist, {});
  const work = (await t.run((ctx) => ctx.db.get(workId)))!;
  expect(entries.map(({ entryId: _id, addedAt: _at, ...rest }) => rest)).toEqual([
    { workId, workTitle: work.title, workKind: 'series', title: `${TITLE}-T`, protocol: 'torrent', reason: 'torrentStalled' },
    { workId, workTitle: work.title, workKind: 'series', title: TITLE, protocol: 'usenet', reason: 'missingArticles' },
    { workId, workTitle: work.title, workKind: 'series', title: 'Harbour.Lights.S01E02.720p.HDTV-OLD', reason: 'parFailed' },
  ]);

  await admin.mutation(api.api.settings.unblock, { entryId: oldId });
  expect((await admin.query(api.api.settings.blocklist, {})).map((entry) => entry.reason)).toEqual(['torrentStalled', 'missingArticles']);
  await expect(t.query(api.api.settings.blocklist, {})).rejects.toThrow();
});
