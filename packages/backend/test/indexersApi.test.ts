// The indexer functions against the Newznab fake: test,
// create, update, setEnabled, remove, list and get. No DTO carries the key.
import { createNewznabHandler, type NewznabHandler } from '@omnarr/e2e/fakes/newznab';
import { createNyaaHandler, type NyaaHandler } from '@omnarr/e2e/fakes/nyaa';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';

import { api } from '../convex/_generated/api';
import { NYAA_CAPS } from '../convex/indexers/nyaa';
import { asAdmin, INDEXER_KEY, setup, useFetchFakes, type Backend } from './setup';

let t: Backend;
let admin: Awaited<ReturnType<typeof asAdmin>>;
let fake: NewznabHandler;

beforeEach(async () => {
  t = setup();
  admin = await asAdmin(t);
  fake = createNewznabHandler({ apiKey: INDEXER_KEY, pageMax: 50, apiLimits: { current: 3, max: 100 } });
  useFetchFakes({ indexers: { 'indexer.fake': fake.handle } });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const create = (overrides: Record<string, unknown> = {}) =>
  admin.action(api.api.indexers.create, { name: 'Fake', url: 'https://indexer.fake', apiKey: INDEXER_KEY, ...overrides });
const rows = () => t.run((ctx) => ctx.db.query('indexers').collect());

describe('indexers.test', () => {
  test('a new URL and key: the caps, the detected kind and the API limit, without saving or counting anything', async () => {
    const result = await admin.action(api.api.indexers.test, { input: { url: 'https://indexer.fake', apiKey: INDEXER_KEY } });
    expect(result).toMatchObject({ ok: true, kind: 'newznab', apiLimit: { max: 100, source: 'apilimits' } });
    expect(fake.requests.map((q) => q.get('t'))).toEqual(['caps', 'search']);
    expect(await rows()).toEqual([]);
  });

  test('a stored indexer is tested with its stored key, counts both requests and clears a rate limit', async () => {
    const { id } = await create();
    await t.run((ctx) => ctx.db.patch(id, { rateLimitedUntil: Date.now() + 3_600_000, rateLimitReason: 'fallback', consecutiveRateLimits: 2 }));
    const result = await admin.action(api.api.indexers.test, { input: { indexerId: id } });
    expect(result.ok).toBe(true);
    const [row] = await rows();
    expect(row).toMatchObject({ consecutiveRateLimits: 0 });
    expect(row!.rateLimitedUntil).toBeUndefined();
    expect(row!.usage.reduce((sum, hour) => sum + hour.requests, 0)).toBe(4);
  });

  test('a stored indexer tested with an unsaved key or URL keeps its health and usage', async () => {
    const { id } = await create();
    const [before] = await rows();
    const wrongKey = await admin.action(api.api.indexers.test, { input: { indexerId: id, apiKey: 'wrong-key' } });
    expect(wrongKey).toMatchObject({ ok: false, failure: { kind: 'authRejected' } });
    const elsewhere = await admin.action(api.api.indexers.test, { input: { indexerId: id, url: 'https://unreachable.fake' } });
    expect(elsewhere).toMatchObject({ ok: false, failure: { kind: 'unreachable' } });
    const [after] = await rows();
    expect({ health: after!.health, usage: after!.usage }).toEqual({ health: before!.health, usage: before!.usage });
  });

  test('a stored indexer tested with its own URL, typed in again, still counts the test', async () => {
    const { id } = await create();
    await admin.action(api.api.indexers.test, { input: { indexerId: id, url: 'https://indexer.fake' } });
    expect((await rows())[0]!.usage.reduce((sum, hour) => sum + hour.requests, 0)).toBe(4);
  });

  test('a wrong URL is refused as no indexer API, naming only host and path', async () => {
    const result = await admin.action(api.api.indexers.test, { input: { url: 'ftp://indexer.fake', apiKey: INDEXER_KEY } });
    expect(result).toMatchObject({ ok: false, failure: { kind: 'notAnIndexerApi' } });
  });
});

describe('indexers.create', () => {
  test('saves the indexer with its kind, caps, default categories and the reported limit; the list and detail never carry the key', async () => {
    const detail = await create({ priority: 10 });
    expect(detail).toMatchObject({
      name: 'Fake',
      kind: 'newznab',
      host: 'indexer.fake',
      apiUrl: 'https://indexer.fake/api',
      enabled: true,
      priority: 10,
      apiKeySet: true,
      apiLimit: { max: 100, source: 'apilimits' },
      categories: { series: [5000, 5030, 5040, 5070, 105040], movies: [2000, 2040, 2045] },
      effectiveRssIntervalMinutes: 58,
    });
    expect(detail.caps.pageLimit).toEqual({ max: 50, default: 50 });
    const list = await admin.query(api.api.indexers.list, {});
    expect(list).toMatchObject([{ id: detail.id, name: 'Fake', host: 'indexer.fake', apiUse24h: 2, errors24h: 0 }]);
    expect(JSON.stringify([detail, list, await admin.query(api.api.indexers.get, { id: detail.id })])).not.toContain(INDEXER_KEY);
  });

  test('refuses to save when the test fails, saying why', async () => {
    await expect(create({ apiKey: 'wrong-key' })).rejects.toThrow(/authRejected/);
    expect(await rows()).toEqual([]);
  });

  test('names are unique', async () => {
    await create();
    await expect(create()).rejects.toThrow(/nameTaken/);
  });

  test('a user-entered limit wins over the reported one', async () => {
    expect((await create({ apiLimitMax: 500 })).apiLimit).toEqual({ max: 500, source: 'user' });
  });

  test('an ambiguous detection needs the kind', async () => {
    useFetchFakes({
      indexers: {
        'indexer.fake': async (request) => {
          const url = new URL(request.url);
          if (url.searchParams.get('t') === 'caps') return fake.handle(request);
          return new Response('<rss version="2.0"><channel><title>x</title></channel></rss>');
        },
      },
    });
    await expect(create()).rejects.toThrow(/kindRequired/);
    expect((await create({ kind: 'torznab' })).kind).toBe('torznab');
  });
});

describe('indexers.update, setEnabled and remove', () => {
  test('other edits save without a test; a new key is tested; a key-less update keeps the stored key', async () => {
    const { id } = await create();
    const before = fake.requests.length;
    await admin.action(api.api.indexers.update, { id, patch: { name: 'Renamed', priority: 5, rssIntervalMinutes: 30 } });
    expect(fake.requests.length).toBe(before);
    expect((await rows())[0]).toMatchObject({ name: 'Renamed', priority: 5, rssIntervalMinutes: 30, apiKey: INDEXER_KEY });

    await expect(admin.action(api.api.indexers.update, { id, patch: { apiKey: 'wrong-key' } })).rejects.toThrow(/authRejected/);
    expect((await rows())[0]!.apiKey).toBe(INDEXER_KEY);
  });

  test('update keeps names unique', async () => {
    await create();
    const { id } = await create({ name: 'Other' });
    await expect(admin.action(api.api.indexers.update, { id, patch: { name: 'Fake' } })).rejects.toThrow(/nameTaken/);
  });

  test('setEnabled disables, remove deletes the row', async () => {
    const { id } = await create();
    await admin.mutation(api.api.indexers.setEnabled, { id, enabled: false });
    expect((await admin.query(api.api.indexers.get, { id }))!.enabled).toBe(false);
    await admin.mutation(api.api.indexers.remove, { id });
    expect(await admin.query(api.api.indexers.list, {})).toEqual([]);
  });
});

describe('a Nyaa indexer: testSite, createSite, update and test', () => {
  let nyaa: NyaaHandler;
  beforeEach(() => {
    // The fake's base URL, as the e2e stack sets it; and 1 ms pacing, so no test waits the 5 s.
    process.env.NYAA_URL = 'https://nyaa.fake';
    process.env.OMNARR_TEST_LIMITS = JSON.stringify({ nyaaIntervalMs: 1 });
    nyaa = createNyaaHandler({ items: [], origin: 'https://nyaa.fake' });
    useFetchFakes({ indexers: { 'nyaa.fake': nyaa.handle } });
  });
  afterEach(() => {
    delete process.env.NYAA_URL;
    delete process.env.OMNARR_TEST_LIMITS;
  });
  const feedRequest = '/?page=rss&c=1_0&f=0&m=1';
  const requested = () => nyaa.requests.map((r) => `${r.path}?${r.params.toString()}`);

  test("testSite sends one feed request and answers Nyaa's modes and categories, saving and counting nothing", async () => {
    const result = await admin.action(api.api.indexers.testSite, { kind: 'nyaa' });
    expect(result).toMatchObject({
      ok: true,
      kind: 'nyaa',
      searchModes: NYAA_CAPS.searchModes,
      categories: NYAA_CAPS.categories,
      latencyMs: expect.any(Number),
    });
    expect(requested()).toEqual([feedRequest]);
    expect(await rows()).toEqual([]);
  });

  test("a failed testSite names the host: a browser check, a page that isn't Nyaa's feed, an unreachable host", async () => {
    nyaa.setFailure({ kind: 'ddosGuard' });
    expect(await admin.action(api.api.indexers.testSite, { kind: 'nyaa' })).toMatchObject({
      ok: false,
      failure: { kind: 'challenged', httpStatus: 503, challenge: 'ddosGuard', host: 'nyaa.fake', path: '/' },
    });
    nyaa.setFailure({ kind: 'brokenPage' });
    expect(await admin.action(api.api.indexers.testSite, { kind: 'nyaa' })).toMatchObject({
      ok: false,
      failure: { kind: 'unexpectedPage', host: 'nyaa.fake', path: '/' },
    });
    process.env.NYAA_URL = 'https://gone.fake';
    expect(await admin.action(api.api.indexers.testSite, { kind: 'nyaa' })).toMatchObject({
      ok: false,
      failure: { kind: 'unreachable', host: 'gone.fake', path: '/' },
    });
  });

  test('createSite saves kind nyaa at the base URL with no key, the built caps and the anime defaults, and counts the test', async () => {
    const detail = await admin.action(api.api.indexers.createSite, { kind: 'nyaa' });
    expect(detail).toMatchObject({
      name: 'Nyaa',
      kind: 'nyaa',
      host: 'nyaa.fake',
      apiUrl: 'https://nyaa.fake',
      apiKeySet: false,
      categories: { series: [5070], movies: [2000] },
      caps: { searchModes: NYAA_CAPS.searchModes, pageLimit: { max: 75, default: 75 } },
      rssIntervalMinutes: 15,
      // The interval OMNARR_TEST_LIMITS lowered here; production's is 5 000.
      pacingIntervalMs: 1,
    });
    const [row] = await rows();
    expect(row).toMatchObject({ apiKey: '', priority: 25, enabled: true });
    expect(row!.usage.reduce((sum, hour) => sum + hour.requests, 0)).toBe(1);
    expect(requested()).toEqual([feedRequest]);
    expect((await admin.query(api.api.indexers.list, {}))[0]).toMatchObject({ kind: 'nyaa', pacingIntervalMs: 1 });
  });

  test('createSite takes a name, refuses a failed test, and refuses a second Nyaa', async () => {
    nyaa.setFailure({ kind: 'ddosGuard' });
    await expect(admin.action(api.api.indexers.createSite, { kind: 'nyaa' })).rejects.toThrow(/testFailed/);
    nyaa.setFailure(undefined);
    expect((await admin.action(api.api.indexers.createSite, { kind: 'nyaa', name: 'Anime' })).name).toBe('Anime');
    const asked = nyaa.requests.length;
    await expect(admin.action(api.api.indexers.createSite, { kind: 'nyaa' })).rejects.toThrow(/alreadyExists/);
    expect(nyaa.requests.length).toBe(asked);
  });

  test("update edits Nyaa's name, categories, priority and interval, and refuses a URL or a key", async () => {
    const { id } = await admin.action(api.api.indexers.createSite, { kind: 'nyaa' });
    await admin.action(api.api.indexers.update, {
      id,
      patch: { name: 'Anime', priority: 5, rssIntervalMinutes: 30, categories: { series: [5070], movies: [] } },
    });
    expect((await rows())[0]).toMatchObject({ name: 'Anime', priority: 5, rssIntervalMinutes: 30, categories: { series: [5070], movies: [] } });
    await expect(admin.action(api.api.indexers.update, { id, patch: { url: 'https://elsewhere.fake' } })).rejects.toThrow(/notEditable/);
    await expect(admin.action(api.api.indexers.update, { id, patch: { apiKey: 'a-key' } })).rejects.toThrow(/notEditable/);
    expect((await rows())[0]).toMatchObject({ apiUrl: 'https://nyaa.fake', apiKey: '' });
  });

  test('test on a stored Nyaa sends the feed request, counts it and clears a rate limit; a refused pacing slot is "busy", with no request', async () => {
    const { id } = await admin.action(api.api.indexers.createSite, { kind: 'nyaa' });
    await t.run((ctx) => ctx.db.patch(id, { rateLimitedUntil: Date.now() + 3_600_000, rateLimitReason: 'fallback', consecutiveRateLimits: 2 }));
    expect(await admin.action(api.api.indexers.test, { input: { indexerId: id } })).toMatchObject({ ok: true, kind: 'nyaa' });
    const [row] = await rows();
    expect(row).toMatchObject({ consecutiveRateLimits: 0 });
    expect(row!.rateLimitedUntil).toBeUndefined();
    expect(row!.usage.reduce((sum, hour) => sum + hour.requests, 0)).toBe(2);

    await t.run(async (ctx) => {
      const pacing = await ctx.db.query('indexerPacing').unique();
      await ctx.db.patch(pacing!._id, { nextAt: Date.now() + 10 * 60_000 });
    });
    const asked = nyaa.requests.length;
    expect(await admin.action(api.api.indexers.test, { input: { indexerId: id } })).toMatchObject({ ok: false, skipped: 'paced' });
    expect(nyaa.requests.length).toBe(asked);
    expect((await rows())[0]!.usage.reduce((sum, hour) => sum + hour.requests, 0)).toBe(2);
  });
});
