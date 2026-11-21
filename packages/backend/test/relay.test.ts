// A definition indexer reached through `indexer` jobs. The relay enqueues a
// job and polls it every 250 ms; a worker (here, the test, through the worker
// functions) answers it; 90 s without an answer is `workerUnavailable` and
// the job is cancelled. Also the API's definition rules, `sites.config` and
// `worker.reservePacing`.
import type { DefinitionMeta, IndexerTestResult, JobResult, LeasedJob } from '@omnarr/contracts';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';

import { api, internal } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import { createRelayAdapter } from '../convex/indexers/relay';
import { asAdmin, capabilities, seedLibraries, settleSearches, setup, useFetchFakes, worker, type Backend } from './setup';

let t: Backend;
let sessionId: Id<'workerSessions'>;
let admin: Awaited<ReturnType<typeof asAdmin>>;
beforeEach(async () => {
  vi.useFakeTimers();
  vi.setSystemTime(Date.UTC(2026, 10, 20, 12));
  process.env.OMNARR_TEST_LIMITS = JSON.stringify({ definitionMinIntervalMs: 100 });
  t = setup();
  admin = await asAdmin(t);
  const connected = await t.mutation(api.jobs.worker.connect, { ...worker, workerId: 'w1', capabilities });
  if (!connected.accepted) throw new Error('not accepted');
  sessionId = connected.sessionId;
});
afterEach(() => {
  vi.useRealTimers();
  delete process.env.OMNARR_TEST_LIMITS;
});

const LANTERN_META: DefinitionMeta = {
  name: 'Lantern Site',
  type: 'public',
  language: 'en-US',
  links: ['https://lantern.test/', 'https://mirror.lantern.test/'],
  settings: [
    {
      name: 'sort',
      type: 'select',
      default: 'added',
      options: [
        { value: 'added', label: 'Added' },
        { value: 'seeders', label: 'Seeders' },
      ],
    },
    { name: 'freeleech', type: 'checkbox', default: false },
    { name: 'passkey', type: 'text' },
    { name: 'note', type: 'info', default: 'Paced.' },
  ],
  modes: { search: ['q'], 'tv-search': ['q', 'season', 'ep'] },
  categories: [2000, 5070],
  requestDelay: 3,
};

/** A synced definition, as the sync's upsertBatch stores it (definitions.test.ts covers that function). */
async function seedDefinition(definitionId = 'lanternsite', support: { ok: true } | { ok: false; reason: 'captcha' } = { ok: true }) {
  await t.run((ctx) =>
    ctx.db.insert('siteDefinitions', {
      definitionId,
      source: 'upstream',
      sha256: `sha-${definitionId}`,
      yaml: `id: ${definitionId}`,
      meta: LANTERN_META,
      support,
      supported: support.ok,
      syncedAt: Date.now(),
    }),
  );
}

/** The lease of a queued RSS job for the indexer, as the worker holds one while it runs (the site functions are fenced on it). */
async function rssLease(indexerId: Id<'indexers'>): Promise<{ jobId: Id<'jobs'>; leaseEpoch: number }> {
  await t.mutation(internal.indexers.relay.enqueue, { payload: { class: 'indexer', action: 'rss', indexerId } });
  const [job] = await t.mutation(api.jobs.queue.claim, { ...worker, sessionId, class: 'indexer', max: 1 });
  return { jobId: job!.jobId, leaseEpoch: job!.leaseEpoch };
}

const PASSED: IndexerTestResult = { ok: true, kind: 'definition', searchModes: [], categories: [], latencyMs: 12 };

/**
 * Runs `action` while answering its indexer jobs as a worker would: each
 * 250 ms poll, claims the queued `indexer` jobs and completes them with
 * `answer`. Returns the action's result and the jobs it saw.
 */
async function withWorker<T>(action: Promise<T>, answer: (job: LeasedJob) => JobResult | 'silent'): Promise<{ result: T; jobs: LeasedJob[] }> {
  let done = false;
  const settled = action.finally(() => {
    done = true;
  });
  const jobs: LeasedJob[] = [];
  while (!done) {
    await vi.advanceTimersByTimeAsync(250);
    const claimed = await t.mutation(api.jobs.queue.claim, { ...worker, sessionId, class: 'indexer', max: 4 });
    for (const job of claimed) {
      jobs.push(job);
      const result = answer(job);
      if (result !== 'silent') await t.mutation(api.jobs.queue.complete, { ...worker, jobId: job.jobId, leaseEpoch: job.leaseEpoch, result });
    }
  }
  return { result: await settled, jobs };
}

describe('testSite and createSite for a definition', () => {
  test('the test is an indexer job carrying the form values; it passes and the indexer is saved with the built caps', async () => {
    await seedDefinition();
    const input = { kind: 'definition' as const, definitionId: 'lanternsite', settings: { sort: 'seeders', passkey: 'planted-passkey-41' } };
    const tested = await withWorker(admin.action(api.api.indexers.testSite, input), () => ({ class: 'indexer', test: PASSED }));
    expect(tested.result).toEqual(PASSED);
    expect(tested.jobs.map((job) => job.payload)).toEqual([
      {
        class: 'indexer',
        action: 'testDraft',
        draft: { definitionId: 'lanternsite', baseUrl: 'https://lantern.test/', settings: { sort: 'seeders', passkey: 'planted-passkey-41' } },
      },
    ]);
    // The finished job keeps no payload (it held the form's values) and the relay removed it.
    expect(
      await t.run((ctx) =>
        ctx.db
          .query('jobs')
          .filter((q) => q.eq(q.field('class'), 'indexer'))
          .collect(),
      ),
    ).toEqual([]);

    const created = await withWorker(admin.action(api.api.indexers.createSite, { ...input, baseUrl: 'https://mirror.lantern.test/' }), () => ({
      class: 'indexer',
      test: PASSED,
    }));
    expect(created.result).toMatchObject({
      name: 'Lantern Site',
      kind: 'definition',
      host: 'mirror.lantern.test',
      definitionName: 'Lantern Site',
      pacingIntervalMs: 3000,
      caps: {
        searchModes: [
          { mode: 'search', available: true, supportedParams: ['q'] },
          { mode: 'tv-search', available: true, supportedParams: ['q', 'season', 'ep'] },
          { mode: 'movie-search', available: false, supportedParams: [] },
        ],
        pageLimit: {},
      },
      categories: { series: [5070], movies: [2000] },
      // The passkey is a text setting: never returned, only that it is set.
      site: { definitionId: 'lanternsite', baseUrl: 'https://mirror.lantern.test/', settings: { sort: 'seeders' }, secretsSet: ['passkey'] },
    });
    expect(JSON.stringify(created.result)).not.toContain('planted-passkey-41');
    // A second indexer may use the same definition.
    const second = await withWorker(admin.action(api.api.indexers.createSite, { ...input, name: 'Lantern 2' }), () => ({ class: 'indexer', test: PASSED }));
    expect(second.result.name).toBe('Lantern 2');
  });

  test.each([
    ['a definition without its id', {}, 'definitionRequired'],
    ['an unsupported definition', { definitionId: 'captchasite' }, 'definitionUnsupported'],
    ['an unknown definition', { definitionId: 'nope' }, 'notFound'],
    ['a base URL outside its links', { definitionId: 'lanternsite', baseUrl: 'https://evil.test/' }, 'invalidBaseUrl'],
    ['a setting it does not have', { definitionId: 'lanternsite', settings: { bogus: 'x' } }, 'invalidSettings'],
    ['a select value outside its options', { definitionId: 'lanternsite', settings: { sort: 'size' } }, 'invalidSettings'],
  ])('refuses %s', async (_name, input, code) => {
    await seedDefinition();
    await seedDefinition('captchasite', { ok: false, reason: 'captcha' });
    await expect(admin.action(api.api.indexers.testSite, { kind: 'definition', ...input })).rejects.toThrow(code);
  });

  test('a failed test is refused with its failure, and nothing is saved', async () => {
    await seedDefinition();
    const failed: IndexerTestResult = { ...PASSED, ok: false, failure: { kind: 'unexpectedPage', host: 'lantern.test', path: '/latest' } };
    const attempt = withWorker(
      admin.action(api.api.indexers.createSite, { kind: 'definition', definitionId: 'lanternsite' }).catch((error: Error) => error),
      () => ({ class: 'indexer', test: failed }),
    );
    expect(String((await attempt).result as Error)).toContain('testFailed');
    expect(await t.run((ctx) => ctx.db.query('indexers').collect())).toEqual([]);
  });
});

describe('the relay', () => {
  test('90 s without an answer is workerUnavailable, and the job is cancelled', async () => {
    await seedDefinition();
    const { result } = await withWorker(admin.action(api.api.indexers.testSite, { kind: 'definition', definitionId: 'lanternsite' }), () => 'silent');
    expect(result).toMatchObject({ ok: false, failure: { kind: 'workerUnavailable', host: 'lantern.test' } });
    const [job] = await t.run((ctx) =>
      ctx.db
        .query('jobs')
        .filter((q) => q.eq(q.field('class'), 'indexer'))
        .collect(),
    );
    expect(job).toMatchObject({ cancelRequested: true });
    expect(job?.payload).toBeDefined();
  });

  test('an offset past 0 answers an empty page with no job', async () => {
    const ctx = {
      runMutation: () => {
        throw new Error('no job expected');
      },
      runQuery: () => {
        throw new Error('no job expected');
      },
    };
    const adapter = createRelayAdapter({ id: 'i1' as Id<'indexers'>, apiUrl: 'https://lantern.test/' }, ctx as never);
    expect(await adapter.search({ fn: 'search', q: 'x', categories: [], limit: 100, offset: 100 })).toEqual({ ok: true, value: { items: [], offset: 100 } });
    expect(await adapter.rss({ offset: 100 })).toEqual({ ok: true, value: { items: [], offset: 100 } });
  });

  test("an RSS fetch answers with the worker's page, recorded as one call; the caps refresh sends nothing", async () => {
    await seedDefinition();
    const created = await withWorker(admin.action(api.api.indexers.createSite, { kind: 'definition', definitionId: 'lanternsite' }), () => ({
      class: 'indexer',
      test: PASSED,
    }));
    const indexerId = created.result.id;
    vi.advanceTimersByTime(2 * 86_400_000);
    const item = {
      guid: 'https://lantern.test/torrent/1',
      title: '[Grp] Star Lantern - 02 (1080p)',
      downloadUrl: 'https://lantern.test/get/1.torrent',
      sizeBytes: 1,
      protocol: 'torrent' as const,
      publishedAt: Date.now(),
      categories: [],
      ids: {},
    };
    const fetched = await withWorker(t.action(internal.pipeline.rssAction.fetch, { indexerId }), () => ({
      class: 'indexer',
      outcome: { ok: true, value: { items: [item], offset: 0 } },
    }));
    expect(fetched.jobs.map((job) => job.payload)).toEqual([{ class: 'indexer', action: 'rss', indexerId }]);
    const indexer = await t.run((ctx) => ctx.db.get(indexerId));
    expect(indexer?.rssHighWaterMark).toBe(`${item.publishedAt}:${item.guid}`);
    expect(indexer?.caps.fetchedAt).toBeGreaterThan(Date.now() - 60_000);
    // Two days after the create's test, the RSS page is the only request: the caps refresh made none.
    expect(indexer?.usage.filter((hour) => hour.hourStart > Date.now() - 86_400_000).reduce((sum, hour) => sum + hour.requests, 0)).toBe(1);
  });

  // A full page asks for the next one, which the relay answers itself; usage counts only the job.
  const lastDay = (usage: { requests: number }[]) => usage.reduce((sum, hour) => sum + hour.requests, 0);
  const lanternItem = (n: number) => ({
    guid: `https://lantern.test/torrent/${n}`,
    title: `Harbour.Lights.S01E0${n}.1080p.WEB-DL.DDP5.1.H.264-GRPB`,
    downloadUrl: `https://lantern.test/get/${n}.torrent`,
    sizeBytes: 1_500_000_000,
    protocol: 'torrent' as const,
    publishedAt: Date.now(),
    categories: [5000],
    ids: {},
  });
  async function fullPageIndexer(): Promise<Id<'indexers'>> {
    await seedDefinition();
    const created = await withWorker(admin.action(api.api.indexers.createSite, { kind: 'definition', definitionId: 'lanternsite' }), () => ({
      class: 'indexer',
      test: PASSED,
    }));
    const indexerId = created.result.id;
    // A page of one item is full, so the loops ask for offset 1; the create's test is cleared from usage.
    // Series category 5000, so a non-anime search doesn't skip it.
    await t.run(async (ctx) => {
      const indexer = (await ctx.db.get(indexerId))!;
      await ctx.db.patch(indexerId, {
        caps: { ...indexer.caps, pageLimit: { max: 1 } },
        categories: { series: [5000], movies: [2000] },
        rssHighWaterMark: `0:old`,
        usage: [],
      });
    });
    return indexerId;
  }

  test('a full RSS page records one call: the empty page past it sent nothing', async () => {
    const indexerId = await fullPageIndexer();
    const fetched = await withWorker(t.action(internal.pipeline.rssAction.fetch, { indexerId }), () => ({
      class: 'indexer',
      outcome: { ok: true, value: { items: [lanternItem(1)], offset: 0 } },
    }));
    expect(fetched.jobs).toHaveLength(1);
    expect(lastDay((await t.run((ctx) => ctx.db.get(indexerId)))!.usage)).toBe(1);
  });

  test('a full search page counts one request and one page: the offsets past 0 sent nothing', async () => {
    const indexerId = await fullPageIndexer();
    useFetchFakes();
    const libraries = await seedLibraries(t);
    const searched = await withWorker(
      (async () => {
        await admin.action(api.api.library.subscribe, {
          tmdbId: '900001',
          kind: 'series',
          libraryId: libraries.series,
          releaseProfileId: libraries.releaseProfileId,
          seasons: [1],
        });
        await settleSearches(t);
      })(),
      () => ({ class: 'indexer', outcome: { ok: true, value: { items: [lanternItem(1)], offset: 0 } } }),
    );
    const searches = searched.jobs.filter((job) => job.payload.class === 'indexer' && job.payload.action === 'search');
    expect(searches.length).toBeGreaterThan(0);
    expect(lastDay((await t.run((ctx) => ctx.db.get(indexerId)))!.usage)).toBe(searches.length);
    const attempts = await t.run((ctx) => ctx.db.query('searchAttempts').collect());
    const pages = attempts.flatMap((attempt) => attempt.indexerResults).reduce((sum, result) => sum + result.pages, 0);
    expect(pages).toBe(searches.length);
  });
});

describe('the worker functions', () => {
  test('sites.config returns the settings with their secrets, and reservePacing paces by requestDelay', async () => {
    await seedDefinition();
    const created = await withWorker(
      admin.action(api.api.indexers.createSite, { kind: 'definition', definitionId: 'lanternsite', settings: { passkey: 'planted-passkey-41' } }),
      () => ({ class: 'indexer', test: PASSED }),
    );
    const indexerId = created.result.id;
    const lease = await rssLease(indexerId);
    expect(await t.query(api.sites.config.config, { ...worker, ...lease, indexerId })).toEqual({
      indexerId,
      name: 'Lantern Site',
      definitionId: 'lanternsite',
      sha256: 'sha-lanternsite',
      yaml: 'id: lanternsite',
      baseUrl: 'https://lantern.test/',
      settings: { passkey: 'planted-passkey-41' },
    });
    // createSite took the first slot for its test; the next two are 3 s apart (requestDelay over the 100 ms minimum).
    const first = await t.mutation(api.jobs.worker.reservePacing, { ...worker, ...lease, indexerId });
    const second = await t.mutation(api.jobs.worker.reservePacing, { ...worker, ...lease, indexerId });
    expect('waitMs' in first && 'waitMs' in second && Math.round((second.waitMs - first.waitMs) / 1000)).toBe(3);
  });

  test("sites.config refuses a lease of another indexer's job", async () => {
    await seedDefinition();
    const create = (name: string) =>
      withWorker(admin.action(api.api.indexers.createSite, { kind: 'definition', definitionId: 'lanternsite', name }), () => ({
        class: 'indexer',
        test: PASSED,
      }));
    const a = (await create('A')).result.id;
    const b = (await create('B')).result.id;
    const lease = await rssLease(a);
    await expect(t.query(api.sites.config.config, { ...worker, ...lease, indexerId: b })).rejects.toThrow(/invalidResult/);
  });

  test('update changes the base URL and settings; an empty secret keeps the stored one', async () => {
    await seedDefinition();
    const created = await withWorker(
      admin.action(api.api.indexers.createSite, {
        kind: 'definition',
        definitionId: 'lanternsite',
        settings: { passkey: 'planted-passkey-41', sort: 'added' },
      }),
      () => ({ class: 'indexer', test: PASSED }),
    );
    const updated = await withWorker(
      admin.action(api.api.indexers.update, {
        id: created.result.id,
        patch: { baseUrl: 'https://mirror.lantern.test/', settings: { passkey: '', sort: 'seeders' } },
      }),
      () => ({ class: 'indexer', test: PASSED }),
    );
    expect(updated.result.site).toEqual({
      definitionId: 'lanternsite',
      baseUrl: 'https://mirror.lantern.test/',
      settings: { sort: 'seeders' },
      secretsSet: ['passkey'],
    });
    const lease = await rssLease(created.result.id);
    expect((await t.query(api.sites.config.config, { ...worker, ...lease, indexerId: created.result.id }))?.settings).toEqual({
      passkey: 'planted-passkey-41',
      sort: 'seeders',
    });
  });
});
