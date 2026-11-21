// The definitions sync: the package from the definitions
// server (here an injected fetch answering a zip built in the test from
// hand-written definitions), the user's /definitions files, the support check
// on each, batches of 50, and the end with the ids it found.
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { FinishDefinitionSyncRequest, UpsertDefinitionsRequest } from '@omnarr/contracts';
import { strToU8, zipSync } from 'fflate';
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';

import type { SitesBackend } from '../../src/convex.ts';
import { BATCH_BYTES, BYTES_PER_SECOND, batches as splitBatches, syncDefinitions } from '../../src/sites/sync.ts';
import { JSONSITE_YML, LANTERN_YML, variant } from './fixtures.ts';

const LEASE = { jobId: 'job1' as UpsertDefinitionsRequest['jobId'], leaseEpoch: 1 };

function fakeBackend() {
  const batches: UpsertDefinitionsRequest[] = [];
  const finished: FinishDefinitionSyncRequest[] = [];
  const backend: SitesBackend = {
    reservePacing: async () => ({ waitMs: 0 }),
    siteConfig: async () => null,
    definitionFile: async () => null,
    upsertDefinitions: async (request) => void batches.push(request),
    finishDefinitionSync: async (request) => {
      finished.push(request);
      return { supported: 1, unsupported: 2, pending: 0 };
    },
  };
  return { backend, batches, finished };
}

const NYAA_LIKE = variant(LANTERN_YML, 'id: lanternsite', 'id: nyaasi');
const PRIVATE = variant(variant(LANTERN_YML, 'id: lanternsite', 'id: privy'), 'type: public', 'type: private');

const zip = (files: Record<string, string>) => zipSync(Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)])));

let customDir: string;
beforeEach(async () => {
  customDir = await mkdtemp(join(tmpdir(), 'omnarr-defs-'));
});
afterEach(async () => {
  await rm(customDir, { recursive: true, force: true });
});

describe('syncDefinitions', () => {
  test('fetches v12 package.zip, checks each file and writes rows with their support and metadata', async () => {
    const { backend, batches, finished } = fakeBackend();
    const requests: { url: string; headers: Record<string, string> }[] = [];
    const counts = await syncDefinitions({
      backend,
      lease: LEASE,
      url: 'https://defs.test/master',
      customDir,
      fetch: async (url, init) => {
        requests.push({ url, headers: init.headers as Record<string, string> });
        return new Response(
          zip({
            'lanternsite.yml': LANTERN_YML,
            'jsonsite.yml': JSONSITE_YML,
            'nyaasi.yml': NYAA_LIKE,
            'privy.yml': PRIVATE,
            'README.md': '# not a definition',
          }),
        );
      },
      log: () => {},
    });
    expect(requests.map((request) => request.url)).toEqual(['https://defs.test/master/12/package.zip']);
    expect(requests[0]!.headers['user-agent']).toMatch(/^omnarr\//);
    const rows = batches.flatMap((batch) => batch.rows);
    expect(
      rows.map((row) => [row.definitionId, row.source, row.support.ok ? 'ok' : row.support.reason]).sort((a, b) => a.join().localeCompare(b.join())),
    ).toEqual([
      ['jsonsite', 'upstream', 'ok'],
      ['lanternsite', 'upstream', 'ok'],
      ['nyaasi', 'upstream', 'builtIn'],
      ['privy', 'upstream', 'privateInP2'],
    ]);
    const lantern = rows.find((row) => row.definitionId === 'lanternsite')!;
    expect(lantern.yaml).toBe(LANTERN_YML);
    expect(lantern.sha256).toMatch(/^[0-9a-f]{64}$/);
    expect(lantern.meta?.name).toBe('Lantern Site');
    expect(finished).toEqual([
      { ...LEASE, status: { at: expect.any(Number), ok: true, source: 'defs.test' }, seenIds: ['jsonsite', 'lanternsite', 'nyaasi', 'privy'] },
    ]);
    expect(counts).toEqual({ ok: true, supported: 1, unsupported: 2, pending: 0 });
  });

  test('a user file replaces the upstream one with its id, and is marked custom', async () => {
    const { backend, batches } = fakeBackend();
    await writeFile(join(customDir, 'mine.yml'), variant(LANTERN_YML, 'name: Lantern Site', 'name: My Lantern'));
    await writeFile(join(customDir, 'notes.txt'), 'ignored');
    await syncDefinitions({
      backend,
      lease: LEASE,
      url: 'https://defs.test/master',
      customDir,
      fetch: async () => new Response(zip({ 'lanternsite.yml': LANTERN_YML })),
      log: () => {},
    });
    const rows = batches.flatMap((batch) => batch.rows);
    expect(rows.map((row) => [row.definitionId, row.source, row.meta?.name])).toEqual([['lanternsite', 'custom', 'My Lantern']]);
  });

  test('more than 50 files go in batches of 50', async () => {
    const { backend, batches } = fakeBackend();
    const files = Object.fromEntries(Array.from({ length: 120 }, (_, i) => [`site${i}.yml`, variant(LANTERN_YML, 'id: lanternsite', `id: site${i}`)]));
    await syncDefinitions({ backend, lease: LEASE, url: 'https://defs.test/master', customDir, fetch: async () => new Response(zip(files)), log: () => {} });
    expect(batches.map((batch) => batch.rows.length)).toEqual([50, 50, 20]);
  });

  // Unpaced, the real package's 585 files (3.7 MB) written back to back made
  // Convex refuse writes with TooManyWrites and drop the worker's connection.
  const bytesOf = (batch: UpsertDefinitionsRequest) => batch.rows.reduce((sum, row) => sum + Buffer.byteLength(JSON.stringify(row)), 0);

  /** A sync of 40 files of ~60 KB on a fake clock: each upsert takes `writeMs(i)`, each pause adds its ms. */
  async function pacedSync(writeMs: (i: number) => number) {
    const { backend, batches } = fakeBackend();
    const padding = `\n# ${'x'.repeat(60 * 1024)}\n`;
    const files = Object.fromEntries(Array.from({ length: 40 }, (_, i) => [`site${i}.yml`, variant(LANTERN_YML, 'id: lanternsite', `id: site${i}`) + padding]));
    let clock = 0;
    const sent: number[] = [];
    backend.upsertDefinitions = async (request) => {
      sent.push(clock);
      clock += writeMs(batches.length);
      batches.push(request);
    };
    await syncDefinitions({
      backend,
      lease: LEASE,
      url: 'https://defs.test/master',
      customDir,
      fetch: async () => new Response(zip(files)),
      log: () => {},
      sleep: async (ms) => void (clock += ms),
    });
    return { batches, sent };
  }

  test('large files go in batches of at most 256 KB, paced to 1 MB a second', async () => {
    const { batches, sent } = await pacedSync(() => 0);
    expect(batches.flatMap((batch) => batch.rows)).toHaveLength(40);
    expect(Math.max(...batches.map(bytesOf))).toBeLessThanOrEqual(BATCH_BYTES);
    expect(batches.length).toBeGreaterThanOrEqual(10);
    // Each batch starts only once the one before it fits in 1 MB a second.
    for (let i = 1; i < batches.length; i++) expect(sent[i]! - sent[i - 1]!).toBeCloseTo((bytesOf(batches[i - 1]!) / BYTES_PER_SECOND) * 1000);
  });

  test('a write slowed by a busy backend earns no credit: the batches after it still wait', async () => {
    // The second write takes 5 s (the backend's own retries), more than the whole sync's pacing.
    const { batches, sent } = await pacedSync((i) => (i === 1 ? 5000 : 0));
    for (let i = 2; i < batches.length; i++)
      expect(sent[i]! - sent[i - 1]!).toBeGreaterThanOrEqual((bytesOf(batches[i - 1]!) / BYTES_PER_SECOND) * 1000 - 0.001);
  });

  test('a single row over 256 KB goes alone', () => {
    const big = { definitionId: 'big', source: 'upstream' as const, sha256: 'b', yaml: 'x'.repeat(BATCH_BYTES), support: { ok: true as const } };
    const small = { ...big, definitionId: 'small', yaml: 'y' };
    expect(splitBatches([small, big, small]).map((batch) => batch.rows.map((row) => row.definitionId))).toEqual([['small'], ['big'], ['small']]);
  });

  test.each([
    ['an HTTP error', async () => new Response('down', { status: 503 }), 'defs.test answered HTTP 503 (GET /master/12/package.zip).'],
    ['an unreachable server', async () => Promise.reject(new TypeError('fetch failed')), 'defs.test could not be reached (GET /master/12/package.zip).'],
    ['an archive with no definition', async () => new Response(zip({ 'README.md': 'x' })), 'The package from defs.test has no .yml file.'],
    ['a body that is no zip', async () => new Response('<html>'), 'The package from defs.test is not a zip archive.'],
  ])('%s keeps the stored rows: nothing is written and the failure is recorded', async (_name, fetch, detail) => {
    const { backend, batches, finished } = fakeBackend();
    const counts = await syncDefinitions({ backend, lease: LEASE, url: 'https://defs.test/master', customDir, fetch, log: () => {} });
    expect(batches).toEqual([]);
    expect(finished).toEqual([
      { ...LEASE, status: { at: expect.any(Number), ok: false, source: 'defs.test', failure: { code: 'definitionSyncFailed', detail } } },
    ]);
    expect(counts.ok).toBe(false);
  });

  test('without the /definitions folder the sync goes on with the package', async () => {
    const { backend, batches } = fakeBackend();
    await syncDefinitions({
      backend,
      lease: LEASE,
      url: 'https://defs.test/master',
      customDir: join(customDir, 'missing'),
      fetch: async () => new Response(zip({ 'lanternsite.yml': LANTERN_YML })),
      log: () => {},
    });
    expect(batches.flatMap((batch) => batch.rows).map((row) => row.definitionId)).toEqual(['lanternsite']);
  });
});
