// The worker's two watched queries read a bounded number of documents, however
// many jobs, sessions and rows a big library has (CI run 44448549101: both
// neared Convex's 1 s limit on a loaded runner; reads weren't the cause, and
// this keeps them from becoming one).
import { QUEUE_COUNT_CAP, SETTINGS_BLOCKLIST_CAP } from '@omnarr/contracts';
import { beforeEach, expect, test } from 'vite-plus/test';

import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import { blocklistEntries } from '../convex/api/settings';
import { connectionOf } from '../convex/jellyfin/setup';
import { queueCounts } from '../convex/jobs/queue';
import { catalogue, definitionDetail } from '../convex/sites/definitions';
import { countingReads } from './reads';
import { capabilities, seedLibraries, setup, worker, type Backend } from './setup';

let t: Backend;
let sessionId: Id<'workerSessions'>;

beforeEach(async () => {
  t = setup();
  const response = await t.mutation(api.jobs.worker.connect, { ...worker, workerId: 'w1', capabilities });
  if (!response.accepted) throw new Error('not accepted');
  sessionId = response.sessionId;
});

const job = (cls: 'prepare' | 'import' | 'maintenance', status: 'queued' | 'done' | 'leased', i: number) => ({
  class: cls,
  status: status as 'queued' | 'done' | 'leased',
  priority: 1,
  attempt: 0,
  maxAttempts: 2,
  leaseEpoch: 0,
  cancelRequested: false,
  protocolVersion: 1,
  idempotencyKey: `${cls}:${status}:${i}`,
});

/** A big library's queue: thousands of finished jobs, some leased, and more queued than the cap. */
const bigQueue = () =>
  t.run(async (ctx) => {
    for (let i = 0; i < 2000; i++) await ctx.db.insert('jobs', job('prepare', 'done', i));
    for (let i = 0; i < 50; i++) await ctx.db.insert('jobs', job('import', 'leased', i));
    for (let i = 0; i < QUEUE_COUNT_CAP + 50; i++) await ctx.db.insert('jobs', job('prepare', 'queued', i));
    for (let i = 0; i < 3; i++) await ctx.db.insert('jobs', job('maintenance', 'queued', i));
  });

test('the counter sees a full scan, a get and an iterated query', async () => {
  await bigQueue();
  const reads = await t.run(async (ctx) => {
    const { ctx: counted, counter } = countingReads(ctx);
    await counted.db.query('jobs').collect();
    await counted.db.get(sessionId);
    for await (const _ of counted.db.query('workerSessions')) void _;
    return counter.reads;
  });
  expect(reads).toBe(2000 + 50 + QUEUE_COUNT_CAP + 50 + 3 + 1 + 1);
});

test("jobs/queue:queue reads each class's queued jobs up to the cap, and nothing else", async () => {
  await bigQueue();
  const classes = ['prepare', 'import', 'maintenance'] as const;
  const { counts, reads } = await t.run(async (ctx) => {
    const { ctx: counted, counter } = countingReads(ctx);
    return { counts: await queueCounts(counted, [...classes]), reads: counter.reads };
  });
  expect(counts).toEqual([
    { class: 'prepare', count: QUEUE_COUNT_CAP },
    { class: 'import', count: 0 },
    { class: 'maintenance', count: 3 },
  ]);
  // The 2,000 done and 50 leased jobs are never read: the index starts at status queued.
  expect(reads).toBe(QUEUE_COUNT_CAP + 3);
});

test('jellyfin/setup:connection reads the session and the one server row, however many sessions there are', async () => {
  await t.run(async (ctx) => {
    for (let i = 0; i < 500; i++)
      await ctx.db.insert('workerSessions', { workerId: `old-${i}`, accepted: false, protocolVersion: 1, capabilities, connectedAt: 0, lastSeenAt: 0 });
    await ctx.db.insert('jellyfinServer', {
      state: 'ready',
      steps: [],
      locale: { uiCulture: 'en-US', metadataCountry: 'US', metadataLanguage: 'en' },
      apiKey: 'key',
      libraries: [],
      ownerUserId: 'owner',
    });
  });
  const reads = await t.run(async (ctx) => {
    const { ctx: counted, counter } = countingReads(ctx);
    await connectionOf(counted, sessionId);
    return counter.reads;
  });
  expect(reads).toBe(2);
});

test("sites/definitions:list and get don't read the definition files (~1.2 MB of YAML)", async () => {
  await t.run(async (ctx) => {
    for (let i = 0; i < 20; i++) {
      const definitionId = `site${i}`;
      await ctx.db.insert('siteDefinitions', {
        definitionId,
        source: 'upstream',
        sha256: `s${i}`,
        meta: { name: `Site ${i}`, type: 'public', links: [], settings: [], modes: {}, categories: [] },
        support: { ok: true },
        supported: true,
        syncedAt: 0,
      });
      await ctx.db.insert('siteDefinitionFiles', { definitionId, yaml: 'x'.repeat(60_000) });
    }
  });
  const tables = await t.run(async (ctx) => {
    const { ctx: counted, counter } = countingReads(ctx);
    expect(await catalogue(counted, {})).toHaveLength(20);
    expect(await definitionDetail(counted, 'site3')).toMatchObject({ definitionId: 'site3' });
    return counter.tables;
  });
  expect(tables).toEqual({ siteDefinitions: 21 });
});

test('settings.blocklist reads the newest entries up to the cap, and each Work once', async () => {
  const libraries = await seedLibraries(t);
  await t.run(async (ctx) => {
    const works = [];
    for (let w = 0; w < 3; w++)
      works.push(
        await ctx.db.insert('works', {
          libraryId: libraries.series,
          kind: 'series',
          title: `Show ${w}`,
          numberingScheme: 'standard',
          releaseProfileId: libraries.releaseProfileId,
          monitorNewUnits: true,
        }),
      );
    for (let i = 0; i < SETTINGS_BLOCKLIST_CAP + 200; i++)
      await ctx.db.insert('blocklist', { workId: works[i % 3]!, releaseKey: `k${i}`, title: `Release.${i}`, reason: 'missingArticles', protocol: 'usenet' });
  });
  const { entries, tables } = await t.run(async (ctx) => {
    const { ctx: counted, counter } = countingReads(ctx);
    return { entries: await blocklistEntries(counted), tables: counter.tables };
  });
  expect(entries).toHaveLength(SETTINGS_BLOCKLIST_CAP);
  expect(entries[0]!.title).toBe(`Release.${SETTINGS_BLOCKLIST_CAP + 199}`);
  // The counter files a `get` under "get": here, the three Works, each read once.
  expect(tables).toEqual({ blocklist: SETTINGS_BLOCKLIST_CAP, get: 3 });
});
