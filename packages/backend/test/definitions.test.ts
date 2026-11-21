import { runToCompletion } from '@convex-dev/migrations';
import migrationsComponent from '@convex-dev/migrations/test';
// The definition catalogue the worker's sync writes (`upsertBatch`,
// `finishSync`), the picker's list, and "Check for definition updates".
import { DEFINITION_BATCH_SIZE, type DefinitionMeta, type SiteDefinitionUpsert } from '@omnarr/contracts';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';

import { api, components, internal } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import { definitionYaml } from '../convex/sites/definitions';
import { asAdmin, capabilities, setup, worker, type Backend } from './setup';

let t: Backend;
let sessionId: Id<'workerSessions'>;
/** The lease of a `syncDefinitions` job, which the sync's writes are fenced on. */
let lease: { jobId: Id<'jobs'>; leaseEpoch: number };
beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 10, 20, 2, 30));
  t = setup();
  const connected = await t.mutation(api.jobs.worker.connect, { ...worker, workerId: 'w1', capabilities });
  if (!connected.accepted) throw new Error('not accepted');
  sessionId = connected.sessionId;
  await t.mutation(internal.jobs.queue.enqueue, { payload: { class: 'maintenance', action: 'syncDefinitions' }, idempotencyKey: 'syncDefinitions:test' });
  const [job] = await t.mutation(api.jobs.queue.claim, { ...worker, sessionId, class: 'maintenance', max: 1 });
  lease = { jobId: job!.jobId, leaseEpoch: job!.leaseEpoch };
});
afterEach(() => vi.useRealTimers());

const meta = (name: string, extra: Partial<DefinitionMeta> = {}): DefinitionMeta => ({
  name,
  type: 'public',
  language: 'en-US',
  links: [`https://${name.toLowerCase()}.test/`],
  settings: [],
  modes: { search: ['q'] },
  categories: [5070],
  ...extra,
});

const row = (definitionId: string, sha256: string, extra: Partial<SiteDefinitionUpsert> = {}): SiteDefinitionUpsert => ({
  definitionId,
  source: 'upstream',
  sha256,
  yaml: `id: ${definitionId}\n# ${sha256}`,
  meta: meta(definitionId),
  support: { ok: true },
  ...extra,
});

const upsert = (rows: SiteDefinitionUpsert[], syncedAt = Date.now()) => t.mutation(api.sites.definitions.upsertBatch, { ...worker, ...lease, syncedAt, rows });
const finish = (seenIds?: string[], ok = true) =>
  t.mutation(api.sites.definitions.finishSync, {
    ...worker,
    ...lease,
    status: { at: Date.now(), ok, source: 'indexers.prowlarr.com', ...(ok ? {} : { failure: { code: 'definitionSyncFailed' as const, detail: 'HTTP 503' } }) },
    ...(seenIds ? { seenIds } : {}),
  });
const stored = () => t.run((ctx) => ctx.db.query('siteDefinitions').collect());
const files = async () => Object.fromEntries((await t.run((ctx) => ctx.db.query('siteDefinitionFiles').collect())).map((f) => [f.definitionId, f.yaml]));

describe('upsertBatch', () => {
  test('inserts new rows, skips unchanged ones and replaces changed ones', async () => {
    await upsert([row('alpha', 'a1'), row('beta', 'b1')]);
    const first = await stored();
    vi.advanceTimersByTime(86_400_000);
    await upsert([row('alpha', 'a1'), row('beta', 'b2')]);
    const second = await stored();
    const alpha = second.find((r) => r.definitionId === 'alpha')!;
    const beta = second.find((r) => r.definitionId === 'beta')!;
    expect(alpha.syncedAt).toBe(first.find((r) => r.definitionId === 'alpha')!.syncedAt);
    expect(beta.sha256).toBe('b2');
    expect(beta.syncedAt).toBe(Date.now());
  });

  test('keeps each file in siteDefinitionFiles, not on the catalogue row, and a replaced row its new file', async () => {
    await upsert([row('alpha', 'a1')]);
    await upsert([row('alpha', 'a2', { support: { ok: false, reason: 'captcha' } })]);
    expect((await stored())[0]).not.toHaveProperty('yaml');
    // The failing update is pending, so the passing file stays.
    expect(await files()).toEqual({ alpha: 'id: alpha\n# a1' });
    await upsert([row('alpha', 'a3')]);
    expect(await files()).toEqual({ alpha: 'id: alpha\n# a3' });
  });

  test('a failing update of a supported definition is kept as pendingUpdate; the stored file stays in use', async () => {
    await upsert([row('alpha', 'a1')]);
    await upsert([row('alpha', 'a2', { support: { ok: false, reason: 'unknownFilter', detail: 'foo in search.fields.title' } })]);
    const [alpha] = await stored();
    expect(alpha).toMatchObject({
      sha256: 'a1',
      support: { ok: true },
      supported: true,
      pendingUpdate: { sha256: 'a2', reason: 'unknownFilter', detail: 'foo in search.fields.title' },
    });
    // A later fixed file replaces it and clears the pending update.
    await upsert([row('alpha', 'a3')]);
    const [fixed] = await stored();
    expect(fixed).toMatchObject({ sha256: 'a3', supported: true });
    expect(fixed!.pendingUpdate).toBeUndefined();
  });

  test('an unsupported definition is replaced by a newer unsupported one', async () => {
    await upsert([row('gamma', 'g1', { support: { ok: false, reason: 'privateInP2' } })]);
    await upsert([row('gamma', 'g2', { support: { ok: false, reason: 'captcha' } })]);
    expect((await stored())[0]).toMatchObject({ sha256: 'g2', support: { ok: false, reason: 'captcha' }, supported: false });
  });

  test('refuses a stale lease, and the lease of a job that is not the sync', async () => {
    await expect(
      t.mutation(api.sites.definitions.upsertBatch, { ...worker, ...lease, leaseEpoch: lease.leaseEpoch + 1, syncedAt: 0, rows: [] }),
    ).rejects.toThrow(/staleLease/);
    await t.mutation(internal.jobs.queue.enqueue, {
      payload: { class: 'maintenance', action: 'cleanStaging', paths: [] },
      idempotencyKey: 'cleanStaging:test',
    });
    const [other] = await t.mutation(api.jobs.queue.claim, { ...worker, sessionId, class: 'maintenance', max: 1 });
    await expect(
      t.mutation(api.sites.definitions.upsertBatch, { ...worker, jobId: other!.jobId, leaseEpoch: other!.leaseEpoch, syncedAt: 0, rows: [] }),
    ).rejects.toThrow(/invalidResult/);
  });

  test(`takes ${DEFINITION_BATCH_SIZE} rows in one call and refuses more (the sync stays inside Convex's write limits)`, async () => {
    const rows = Array.from({ length: DEFINITION_BATCH_SIZE + 1 }, (_, i) => row(`site${i}`, `s${i}`));
    await expect(upsert(rows)).rejects.toThrow();
    await upsert(rows.slice(0, DEFINITION_BATCH_SIZE));
    expect(await stored()).toHaveLength(DEFINITION_BATCH_SIZE);
  });
});

test("migration 0005 moves a stored row's file to siteDefinitionFiles; the engine's file reads the same before and after", async () => {
  migrationsComponent.register(t);
  const yamlOf = () =>
    t.run(async (ctx) => {
      const stored = await ctx.db.query('siteDefinitions').first();
      return definitionYaml(ctx, stored!);
    });
  await t.run((ctx) => ctx.db.insert('siteDefinitions', { ...row('alpha', 'a1'), supported: true, syncedAt: 0 }));
  expect(await yamlOf()).toBe('id: alpha\n# a1');
  await t.run((ctx) => runToCompletion(ctx, components.migrations, internal.migrations['0005_definition_yaml_table'].default));
  expect((await stored())[0]).not.toHaveProperty('yaml');
  expect(await files()).toEqual({ alpha: 'id: alpha\n# a1' });
  expect(await yamlOf()).toBe('id: alpha\n# a1');
});

describe('finishSync', () => {
  test('records the status with the counts, and marks the ids it no longer found', async () => {
    await upsert([row('alpha', 'a1'), row('beta', 'b1', { support: { ok: false, reason: 'captcha' } }), row('gone', 'g1')]);
    await upsert([row('alpha', 'a2', { support: { ok: false, reason: 'regex' } })]);
    const counts = await finish(['alpha', 'beta']);
    expect(counts).toEqual({ supported: 1, unsupported: 1, pending: 1 });
    const admin = await asAdmin(t);
    expect(await admin.query(api.sites.definitions.status, {})).toEqual({
      at: Date.now(),
      ok: true,
      source: 'indexers.prowlarr.com',
      supported: 1,
      unsupported: 1,
      pending: 1,
    });
    // An unused removed definition goes; one an indexer uses stays, marked.
    expect((await stored()).map((r) => r.definitionId).sort()).toEqual(['alpha', 'beta']);
    expect(Object.keys(await files()).sort()).toEqual(['alpha', 'beta']);
  });

  test('a removed definition an indexer uses stays, marked removedUpstream', async () => {
    await upsert([row('alpha', 'a1')]);
    await t.run((ctx) =>
      ctx.db.insert('indexers', {
        name: 'Alpha',
        kind: 'definition',
        apiUrl: 'https://alpha.test/',
        apiKey: '',
        enabled: true,
        priority: 25,
        categories: { series: [5070], movies: [] },
        caps: { searchModes: [], pageLimit: {}, categories: [], fetchedAt: 0 },
        rssIntervalMinutes: 15,
        usage: [],
        consecutiveRateLimits: 0,
        health: { status: 'unknown' },
        site: { definitionId: 'alpha', baseUrl: 'https://alpha.test/', settings: {}, definitionName: 'alpha' },
      }),
    );
    await finish([]);
    expect(await stored()).toMatchObject([{ definitionId: 'alpha', removedUpstream: true }]);
    await finish(['alpha']);
    expect((await stored())[0]!.removedUpstream).toBeUndefined();
  });

  test('a failed sync keeps every row and records the failure', async () => {
    await upsert([row('alpha', 'a1')]);
    await finish(undefined, false);
    expect(await stored()).toHaveLength(1);
    const admin = await asAdmin(t);
    expect(await admin.query(api.sites.definitions.status, {})).toMatchObject({ ok: false, failure: { code: 'definitionSyncFailed', detail: 'HTTP 503' } });
  });
});

describe('the catalogue', () => {
  test('lists every definition, unsupported ones with their reason, filtered by search and type, Nyaa included', async () => {
    await upsert([
      row('tokyotosho', 't1', { meta: meta('Tokyo Toshokan', { language: 'en-US' }) }),
      row('privy', 'p1', { meta: meta('Privy', { type: 'private' }), support: { ok: false, reason: 'privateInP2' } }),
      row('nyaasi', 'n1', { meta: meta('Nyaa.si'), support: { ok: false, reason: 'builtIn', detail: 'Built in: add Nyaa from the Site list' } }),
    ]);
    const admin = await asAdmin(t);
    const all = await admin.query(api.sites.definitions.list, {});
    expect(all.map((r) => [r.definitionId, r.name, r.type, r.support.ok])).toEqual([
      ['nyaasi', 'Nyaa.si', 'public', false],
      ['privy', 'Privy', 'private', false],
      ['tokyotosho', 'Tokyo Toshokan', 'public', true],
    ]);
    expect((await admin.query(api.sites.definitions.list, { search: 'tokyo' })).map((r) => r.definitionId)).toEqual(['tokyotosho']);
    expect((await admin.query(api.sites.definitions.list, { type: 'private' })).map((r) => r.definitionId)).toEqual(['privy']);
    expect(all[0]).not.toHaveProperty('yaml');
    expect(await admin.query(api.sites.definitions.get, { definitionId: 'tokyotosho' })).toMatchObject({
      definitionId: 'tokyotosho',
      meta: { links: ['https://tokyo toshokan.test/'] },
    });
  });

  test('"Check for definition updates" enqueues a sync with its own key each time', async () => {
    const admin = await asAdmin(t);
    await admin.mutation(api.sites.definitions.syncNow, {});
    await admin.mutation(api.sites.definitions.syncNow, {});
    const jobs = (await t.run((ctx) => ctx.db.query('jobs').collect())).filter((job) => job.idempotencyKey.includes(':manual:'));
    expect(jobs.map((job) => [job.class, job.payload, job.idempotencyKey])).toEqual([
      ['maintenance', { class: 'maintenance', action: 'syncDefinitions' }, 'syncDefinitions:manual:0'],
      ['maintenance', { class: 'maintenance', action: 'syncDefinitions' }, 'syncDefinitions:manual:1'],
    ]);
  });

  test('the daily cron and a connect after 24 h enqueue the dated sync once', async () => {
    const connect = async () => {
      await t.mutation(api.jobs.worker.connect, { ...worker, workerId: 'w1', capabilities });
      await t.finishInProgressScheduledFunctions();
      await t.finishAllScheduledFunctions(() => vi.advanceTimersByTime(1));
    };
    await connect();
    // Without the test's own leased sync job.
    const keys = async () =>
      (await t.run((ctx) => ctx.db.query('jobs').collect())).map((job) => job.idempotencyKey).filter((key) => key !== 'syncDefinitions:test');
    expect(await keys()).toEqual(['syncDefinitions:2026-11-20']);
    await t.mutation(internal.sites.definitions.dailySync, {});
    expect(await keys()).toEqual(['syncDefinitions:2026-11-20']);
    // A sync within the last 24 h: a connect enqueues nothing.
    await finish([]);
    vi.advanceTimersByTime(86_400_000 - 60_000);
    await connect();
    expect(await keys()).toEqual(['syncDefinitions:2026-11-20']);
    // A day later, it does.
    vi.advanceTimersByTime(120_000);
    await connect();
    expect(await keys()).toEqual(['syncDefinitions:2026-11-20', 'syncDefinitions:2026-11-21']);
  });
});
