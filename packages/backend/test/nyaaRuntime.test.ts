// What the Nyaa adapter needs of Convex's default runtime, checked
// in the edge runtime convex-test runs functions in. htmlparser2 and
// css-select read the listing table; setTimeout is pacing's wait.
// The e2e scenario `nyaa` repeats both on the real backend.
import { createNyaaHandler, type NyaaHandler } from '@omnarr/e2e/fakes/nyaa';
import { selectAll } from 'css-select';
import { parseDocument } from 'htmlparser2';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';

import { api } from '../convex/_generated/api';
import listing from './fixtures/nyaa/listing.html?raw';
import { asAdmin, setup, useFetchFakes, withPacing, type Backend } from './setup';

test('htmlparser2 and css-select parse the listing and select its rows', () => {
  const rows = selectAll('table.torrent-list tbody tr', parseDocument(listing));
  expect(rows.map((row) => (row as unknown as { attribs: Record<string, string> }).attribs.class)).toEqual([
    'default',
    'success',
    'danger',
    'deleted',
    'warning',
    'default',
  ]);
});

test('setTimeout waits', async () => {
  const started = Date.now();
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(Date.now() - started).toBeGreaterThanOrEqual(45);
});

// "Test connection" on the Nyaa form before saving takes the site's
// pacing slot, which the save's test shares and the new indexer inherits.
describe('the pre-save Nyaa test is paced', () => {
  const intervalMs = 300;
  let t: Backend;
  let admin: Awaited<ReturnType<typeof asAdmin>>;
  let nyaa: NyaaHandler;
  // Fake timers, so the interval is the clock's and not a loaded
  // machine's; `withPacing` moves the clock through each wait.
  beforeEach(async () => {
    vi.useFakeTimers();
    process.env.NYAA_URL = 'https://nyaa.fake';
    process.env.OMNARR_TEST_LIMITS = JSON.stringify({ nyaaIntervalMs: intervalMs });
    t = setup();
    admin = await asAdmin(t);
    nyaa = createNyaaHandler({ items: [], origin: 'https://nyaa.fake' });
    useFetchFakes({ indexers: { 'nyaa.fake': nyaa.handle } });
  });
  afterEach(() => {
    delete process.env.NYAA_URL;
    delete process.env.OMNARR_TEST_LIMITS;
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });
  const gaps = () => nyaa.requests.slice(1).map((request, i) => request.at - nyaa.requests[i]!.at);
  const pacingRows = () => t.run((ctx) => ctx.db.query('indexerPacing').collect());
  const testSite = () => withPacing(admin.action(api.api.indexers.testSite, { kind: 'nyaa' }));
  const createSite = () => withPacing(admin.action(api.api.indexers.createSite, { kind: 'nyaa' }));
  const atLeastInterval = (gap: number) => gap >= intervalMs;

  test('two tests in a row are an interval apart', async () => {
    await testSite();
    await testSite();
    expect(gaps()).toHaveLength(1);
    expect(gaps().every(atLeastInterval)).toBe(true);
  });

  test("saving after a test waits for the next slot, and the site's row becomes the indexer's", async () => {
    await testSite();
    const { id } = await createSite();
    expect(gaps()).toHaveLength(1);
    expect(gaps().every(atLeastInterval)).toBe(true);
    const rows = await pacingRows();
    expect(rows).toEqual([expect.objectContaining({ indexerId: id })]);
    expect(rows[0]!.site).toBeUndefined();
    // The saved Nyaa's next request waits for the slot after the save's test.
    expect(rows[0]!.nextAt).toBeGreaterThanOrEqual(nyaa.requests.at(-1)!.at + intervalMs);
  });

  test('a test that is never saved blocks nothing once its interval has passed', async () => {
    await testSite();
    expect(await pacingRows()).toEqual([expect.objectContaining({ site: 'nyaa' })]);
    vi.advanceTimersByTime(intervalMs + 20);
    const started = Date.now();
    expect(await testSite()).toMatchObject({ ok: true });
    expect(Date.now() - started).toBeLessThan(intervalMs);
    expect(await pacingRows()).toHaveLength(1);
  });

  test('a refused site slot is "busy" with no request, and refuses the save', async () => {
    await testSite();
    await t.run(async (ctx) => {
      const [row] = await ctx.db.query('indexerPacing').collect();
      await ctx.db.patch(row!._id, { nextAt: Date.now() + 10 * 60_000 });
    });
    const asked = nyaa.requests.length;
    expect(await testSite()).toMatchObject({ ok: false, skipped: 'paced' });
    // A refused slot never waits, and `withPacing` would leave the rejection unhandled while it ticks.
    await expect(admin.action(api.api.indexers.createSite, { kind: 'nyaa' })).rejects.toThrow(/testFailed/);
    expect(nyaa.requests.length).toBe(asked);
  });
});
