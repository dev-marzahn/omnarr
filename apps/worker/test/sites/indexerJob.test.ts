// The `indexer` job class: the worker reads the indexer's
// config through `sites.config`, runs the engine, and completes the job with
// its IndexerResult. Engine failures are results, not `job.fail`; only a
// missing indexer or definition fails the job.
import type { JobPayload, LeasedJob, ReservePacingRequest, SiteConfig } from '@omnarr/contracts';
import { describe, expect, test } from 'vite-plus/test';

import type { SitesBackend } from '../../src/convex.ts';
import { indexerHandler } from '../../src/jobs/indexer.ts';
import { JobFailure } from '../../src/runtime/lease.ts';
import { LANTERN_PAGE, LANTERN_YML } from './fixtures.ts';

const CONFIG: SiteConfig = {
  indexerId: 'ix1' as SiteConfig['indexerId'],
  name: 'Lantern',
  definitionId: 'lanternsite',
  sha256: 'sha-1',
  yaml: LANTERN_YML,
  baseUrl: 'https://lantern.test/',
  settings: { sort: 'seeders' },
};

function fakeBackend(config: SiteConfig | null = CONFIG, slot: { waitMs: number } | { skip: true } = { waitMs: 0 }) {
  const paced: ReservePacingRequest[] = [];
  const backend: SitesBackend = {
    reservePacing: async (request) => {
      paced.push(request);
      return slot;
    },
    siteConfig: async () => config,
    definitionFile: async ({ definitionId }) => (definitionId === 'lanternsite' ? { name: 'Lantern Site', sha256: 'sha-1', yaml: LANTERN_YML } : null),
    upsertDefinitions: async () => undefined,
    finishDefinitionSync: async () => ({ supported: 0, unsupported: 0, pending: 0 }),
  };
  return { backend, paced };
}

const job = (payload: JobPayload): LeasedJob => ({ jobId: 'job1' as LeasedJob['jobId'], class: 'indexer', leaseEpoch: 3, payload });
const context = { signal: new AbortController().signal, progress: () => {} };
const urls: string[] = [];
const fetchPage = async (url: string) => {
  urls.push(url);
  return new Response(LANTERN_PAGE, { status: 200 });
};

describe('indexerHandler', () => {
  test('a search runs the engine with the stored settings, paced through reservePacing, and completes with the page', async () => {
    const { backend, paced } = fakeBackend();
    const handler = indexerHandler({ backend, fetch: fetchPage, log: () => {} });
    const request = { fn: 'search' as const, q: 'Star Lantern', categories: [], limit: 100, offset: 0 };
    const result = await handler(job({ class: 'indexer', action: 'search', indexerId: CONFIG.indexerId, request }), context);
    expect(result.class).toBe('indexer');
    expect(result.class === 'indexer' && result.outcome?.ok && result.outcome.value.items.map((item) => item.title)).toEqual([
      '[Grp] Star Lantern - 02 (1080p)',
      'Lantern Movie 2024 1080p',
    ]);
    expect(urls.at(-1)).toContain('order=seeders');
    expect(paced).toEqual([{ jobId: 'job1', leaseEpoch: 3, indexerId: CONFIG.indexerId }]);
  });

  test('a refused slot completes with the paced skip', async () => {
    const { backend } = fakeBackend(CONFIG, { skip: true });
    const result = await indexerHandler({ backend, fetch: fetchPage, log: () => {} })(
      job({ class: 'indexer', action: 'rss', indexerId: CONFIG.indexerId }),
      context,
    );
    expect(result).toEqual({ class: 'indexer', outcome: { ok: false, skipped: 'paced' } });
  });

  test("a site failure is the job's result, not a failed job", async () => {
    const { backend } = fakeBackend();
    const handler = indexerHandler({ backend, fetch: async () => new Response('<title>DDOS-GUARD</title>', { status: 503 }), log: () => {} });
    expect(await handler(job({ class: 'indexer', action: 'rss', indexerId: CONFIG.indexerId }), context)).toMatchObject({
      class: 'indexer',
      outcome: { ok: false, failure: { kind: 'challenged', challenge: 'ddosGuard', host: 'lantern.test' } },
    });
  });

  test("a test of the form's values reads the definition file and takes no slot (no indexer yet)", async () => {
    const { backend, paced } = fakeBackend();
    const handler = indexerHandler({ backend, fetch: fetchPage, log: () => {} });
    const result = await handler(
      job({ class: 'indexer', action: 'testDraft', draft: { definitionId: 'lanternsite', baseUrl: 'https://lantern.test/', settings: {} } }),
      context,
    );
    expect(result).toMatchObject({ class: 'indexer', test: { ok: true, kind: 'definition' } });
    expect(paced).toEqual([]);
  });

  test('a stored test runs through the stored config', async () => {
    const { backend } = fakeBackend();
    const result = await indexerHandler({ backend, fetch: fetchPage, log: () => {} })(
      job({ class: 'indexer', action: 'test', indexerId: CONFIG.indexerId }),
      context,
    );
    expect(result).toMatchObject({ class: 'indexer', test: { ok: true } });
  });

  test('a removed indexer fails the job', async () => {
    const { backend } = fakeBackend(null);
    await expect(
      indexerHandler({ backend, fetch: fetchPage, log: () => {} })(job({ class: 'indexer', action: 'rss', indexerId: CONFIG.indexerId }), context),
    ).rejects.toBeInstanceOf(JobFailure);
  });

  test('a legacy base URL is logged once, without the settings', async () => {
    const { backend } = fakeBackend({
      ...CONFIG,
      indexerId: 'ix-legacy' as SiteConfig['indexerId'],
      baseUrl: 'https://old.lantern.test/',
      settings: { sort: 'seeders' },
    });
    const lines: string[] = [];
    const handler = indexerHandler({ backend, fetch: fetchPage, log: (line) => lines.push(line) });
    await handler(job({ class: 'indexer', action: 'rss', indexerId: 'ix-legacy' as SiteConfig['indexerId'] }), context);
    await handler(job({ class: 'indexer', action: 'rss', indexerId: 'ix-legacy' as SiteConfig['indexerId'] }), context);
    expect(lines.filter((line) => line.includes('legacy'))).toEqual([
      'indexer Lantern: its link https://old.lantern.test/ is a legacy link; using https://lantern.test/',
    ]);
  });
});
