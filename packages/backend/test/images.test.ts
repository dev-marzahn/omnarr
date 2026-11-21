// Images fetched once and served by omnarr: posters w342 and backdrops w780
// for every Work, stills w300 for seasons with a monitored or present Unit,
// fetched again after 30 days, a changed path replacing its file, the storage
// URLs on the DTOs, and add-title search's w92 posters as data URIs. The browser never talks to TMDB.
import { beforeEach, describe, expect, test } from 'vite-plus/test';

import { api, internal } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import { pipelineHarness } from './harness';
import { settleSearches, useFetchFakes } from './setup';

const h = pipelineHarness();
let workId: Id<'works'>;
let requests: URL[];

const DAY = 86_400_000;
const images = async () => (await h.all('images')).map((row) => `${row.size} ${row.path}`).sort();
const imageRequests = () => requests.filter((url) => url.pathname.startsWith('/t/p/')).map((url) => url.pathname);

beforeEach(async () => {
  requests = useFetchFakes();
  workId = await h.subscribe([1]);
});

describe('fetching', () => {
  test("a subscribe stores the Work's poster and backdrop, and the stills of its monitored season only", async () => {
    const stored = await images();
    expect(stored).toContain('w342 /harbour-lights.jpg');
    expect(stored).toContain('w780 /harbour-lights-backdrop.jpg');
    const stills = stored.filter((row) => row.startsWith('w300'));
    // Season 1 has 6 episodes; season 2 and the specials aren't monitored.
    expect(stills).toHaveLength(6);
    expect(imageRequests().every((path) => /^\/t\/p\/(w342|w780|w300)\//.test(path))).toBe(true);
  });

  test('an image is fetched once: a sync within 30 days fetches nothing again', async () => {
    const before = imageRequests().length;
    await h.t.action(internal.metadata.images.fetchForWork, { workId });
    expect(imageRequests().length).toBe(before);
  });

  test('an image older than 30 days is fetched again, replacing its file', async () => {
    const [poster] = (await h.all('images')).filter((row) => row.size === 'w342');
    await h.t.run((ctx) => ctx.db.patch(poster!._id, { fetchedAt: Date.now() - 31 * DAY }));
    await h.t.action(internal.metadata.images.fetchForWork, { workId });
    const after = (await h.all('images')).filter((row) => row.size === 'w342');
    expect(after).toHaveLength(1);
    expect(after[0]!.fetchedAt).toBeGreaterThan(Date.now() - DAY);
    expect(after[0]!.storageId).not.toBe(poster!.storageId);
    expect(await h.t.run((ctx) => ctx.storage.getUrl(poster!.storageId))).toBeNull();
  });

  test("a changed path fetches the new image and deletes the old one's row and file", async () => {
    const [poster] = (await h.all('images')).filter((row) => row.size === 'w342');
    await h.t.run(async (ctx) => {
      const meta = await ctx.db
        .query('workMetadata')
        .withIndex('by_work', (q) => q.eq('workId', workId))
        .unique();
      await ctx.db.patch(meta!._id, { posterPath: '/star-lantern.jpg' });
    });
    await h.t.action(internal.metadata.images.fetchForWork, { workId });
    const stored = await images();
    expect(stored).toContain('w342 /star-lantern.jpg');
    expect(stored).not.toContain('w342 /harbour-lights.jpg');
    expect(await h.t.run((ctx) => ctx.storage.getUrl(poster!.storageId))).toBeNull();
  });

  test('monitoring another season fetches its stills', async () => {
    await h.admin.mutation(api.api.units.setMonitored, { target: { kind: 'season', workId, season: 2 }, monitored: true });
    await settleSearches(h.t);
    expect((await images()).filter((row) => row.startsWith('w300'))).toHaveLength(12);
  });
});

describe('serving', () => {
  test('the DTOs carry storage URLs: the poster on the list, the backdrop on the Work page, stills on the rows', async () => {
    const { works } = await h.admin.query(api.api.library.list, { kind: 'series' });
    expect(works[0]!.posterUrl).toMatch(/^https?:\/\//);
    const detail = (await h.admin.query(api.api.library.detail, { workId }))!;
    expect(detail.work.posterUrl).toMatch(/^https?:\/\//);
    expect(detail.work.backdropUrl).toMatch(/^https?:\/\//);
    expect(detail.work.overview).toBeTruthy();
    const s1 = detail.units.find((unit) => unit.tmdbSeason === 1 && unit.tmdbEpisode === 1)!;
    const s2 = detail.units.find((unit) => unit.tmdbSeason === 2 && unit.tmdbEpisode === 1)!;
    expect(s1.stillUrl).toMatch(/^https?:\/\//);
    expect(s2.stillUrl).toBeUndefined();
    const timeline = (await h.admin.query(api.api.units.timeline, { unitId: s1.unitId }))!;
    expect(timeline.posterUrl).toBe(detail.work.posterUrl);
    expect(timeline.stillUrl).toBe(s1.stillUrl);
  });

  test('no TMDB address reaches a DTO', async () => {
    const detail = await h.admin.query(api.api.library.detail, { workId });
    expect(JSON.stringify(detail)).not.toMatch(/tmdb\.fake|image\.tmdb\.org|\/t\/p\//i);
  });
});

describe('add-title search', () => {
  test("each result's w92 poster comes as a data URI, fetched by the backend and not stored", async () => {
    const stored = await images();
    const hits = await h.admin.action(api.api.metadata.search, { query: 'harbour', kind: 'series' });
    expect(hits[0]!.posterDataUri).toMatch(/^data:image\/svg\+xml;base64,/);
    expect(imageRequests()).toContain('/t/p/w92/harbour-lights.jpg');
    expect(await images()).toEqual(stored);
  });

  test('a result without a poster has none', async () => {
    const hits = await h.admin.action(api.api.metadata.search, { query: 'old show', kind: 'series' });
    expect(hits[0]!.posterDataUri).toBeUndefined();
  });
});
