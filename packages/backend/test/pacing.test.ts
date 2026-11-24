// The pacing slot one site indexer's requests share.
import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test';

import { api, internal } from '../convex/_generated/api';
import { MAX_PACING_WAIT_MS } from '../convex/indexers/pacing';
import { asAdmin, seedIndexer, setup, type Backend } from './setup';

let t: Backend;
beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 10, 19, 12, 0));
  t = setup();
});
afterEach(() => vi.useRealTimers());

const pacingRows = () => t.run((ctx) => ctx.db.query('indexerPacing').collect());

/** The wait, in whole intervals: convex-test's clock moves a millisecond or so between calls. */
const slots = (reservation: { waitMs: number } | { skip: true }, intervalMs: number) =>
  'skip' in reservation ? 'skip' : Math.round(reservation.waitMs / intervalMs);

test('two concurrent reservations get slots one interval apart, and a third the one after', async () => {
  const indexerId = await seedIndexer(t, { kind: 'nyaa' });
  const reserve = async () =>
    slots(await t.mutation(internal.indexers.pacing.reserve, { indexerId, intervalMs: 5_000, longestWaitMs: MAX_PACING_WAIT_MS }), 5_000);
  expect((await Promise.all([reserve(), reserve()])).sort((a, b) => String(a).localeCompare(String(b)))).toEqual([0, 1]);
  expect(await reserve()).toBe(2);
  // Once the slots have passed, the next request goes at once.
  vi.advanceTimersByTime(60_000);
  expect(await reserve()).toBe(0);
});

test('a reservation more than 5 minutes away is a skip and writes nothing', async () => {
  const indexerId = await seedIndexer(t, { kind: 'nyaa' });
  const reserve = async () =>
    slots(await t.mutation(internal.indexers.pacing.reserve, { indexerId, intervalMs: 100_000, longestWaitMs: MAX_PACING_WAIT_MS }), 100_000);
  expect([await reserve(), await reserve(), await reserve()]).toEqual([0, 1, 2]);
  // The fourth slot is just under 300 s away (the clock moved), so it's taken; the fifth, at 400 s, isn't.
  expect(await reserve()).toBe(3);
  const before = await pacingRows();
  expect(await reserve()).toBe('skip');
  expect(await pacingRows()).toEqual(before);
});

test('removing an indexer deletes its pacing row', async () => {
  const indexerId = await seedIndexer(t, { kind: 'nyaa' });
  const other = await seedIndexer(t, { kind: 'nyaa', host: 'other.fake' });
  await t.mutation(internal.indexers.pacing.reserve, { indexerId, intervalMs: 5_000, longestWaitMs: MAX_PACING_WAIT_MS });
  await t.mutation(internal.indexers.pacing.reserve, { indexerId: other, intervalMs: 5_000, longestWaitMs: MAX_PACING_WAIT_MS });
  const admin = await asAdmin(t);
  await admin.mutation(api.api.indexers.remove, { id: indexerId });
  expect((await pacingRows()).map((row) => row.indexerId)).toEqual([other]);
});
