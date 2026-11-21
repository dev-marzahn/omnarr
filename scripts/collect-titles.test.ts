import { execFile } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createNewznabFake } from '@omnarr/e2e/fakes/newznab/server';
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const script = join(root, 'scripts/collect-titles.ts');
const KEY = 'planted-collect-key';

// Two items a page, so `--pages` decides how far it reads.
const fake = createNewznabFake({ apiKey: KEY, pageMax: 2 });
let url: string;
let outDir: string;
beforeAll(async () => {
  await new Promise<void>((resolve) => fake.server.listen(0, '127.0.0.1', resolve));
  url = `http://127.0.0.1:${(fake.server.address() as AddressInfo).port}`;
  outDir = mkdtempSync(join(tmpdir(), 'collect-titles-'));
});
afterAll(async () => {
  rmSync(outDir, { recursive: true, force: true });
  await new Promise<void>((resolve) => fake.server.close(() => resolve()));
});

/** Runs the script the way the author does: plain Node, the key in the environment. */
function run(args: string[], env: Record<string, string> = { COLLECT_INDEXER_KEY: KEY }) {
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    execFile(process.execPath, [script, ...args], { env: { PATH: process.env.PATH ?? '', ...env }, cwd: root }, (error, stdout, stderr) => {
      resolve({ code: error ? Number(error.code ?? 1) : 0, stdout, stderr });
    });
  });
}

const lines = (path: string) =>
  readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>);

describe('collect-titles', () => {
  test('writes one { title, categories } line per item, newest first, across pages', async () => {
    const out = join(outDir, 'series.jsonl');
    const result = await run(['--url', url, '--categories', '5000', '--pages', '2', '--out', out]);
    expect(result).toMatchObject({ code: 0, stderr: '' });
    expect(lines(out)).toEqual([
      { title: 'The.Long.Harbor.S01.1080p.WEB-DL.DDP5.1.H.264-GRPA', categories: [5000, 5040] },
      { title: '[SubGroup] Lantern Keeper - 12 (1080p) [0A1B2C3D].mkv', categories: [5070] },
      { title: 'The.Long.Harbor.S01E02.1080p.WEB-DL.DDP5.1.H.264-GRPA', categories: [5000, 5040] },
      { title: 'The.Long.Harbor.S01E01.720p.HDTV.x264-GRPC', categories: [5000, 5030] },
    ]);
  });

  test('stops at --pages, and asks with every category it was given', async () => {
    const out = join(outDir, 'one-page.jsonl');
    const before = fake.requests.length;
    expect((await run(['--url', url, '--categories', '5000,2000', '--pages', '1', '--out', out])).code).toBe(0);
    expect(lines(out)).toHaveLength(2);
    expect(fake.requests.slice(before).map((query) => [query.get('t'), query.get('cat')])).toEqual([['search', '5000,2000']]);
  });

  test('writes no GUID, URL or key, and prints none', async () => {
    const out = join(outDir, 'clean.jsonl');
    const result = await run(['--url', url, '--categories', '5000,2000', '--pages', '5', '--out', out]);
    const written = readFileSync(out, 'utf8');
    for (const text of [written, result.stdout, result.stderr]) {
      expect(text).not.toContain(KEY);
      expect(text).not.toMatch(/https?:|getnzb|details\//);
    }
    expect(lines(out).every((line) => Object.keys(line).sort().join() === 'categories,title')).toBe(true);
  });

  test.each([
    ['the parser corpus', 'packages/parser/test/golden/collected.jsonl'],
    ['anywhere in the repository', 'collected.jsonl'],
  ])('refuses an --out inside the repository (%s)', async (_name, relative) => {
    const out = join(root, relative);
    const result = await run(['--url', url, '--categories', '5000', '--out', out]);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/outside the repository/);
    expect(existsSync(out)).toBe(false);
  });

  test('refuses to run without the key in COLLECT_INDEXER_KEY', async () => {
    const result = await run(['--url', url, '--categories', '5000', '--out', join(outDir, 'nokey.jsonl')], {});
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/COLLECT_INDEXER_KEY/);
  });

  test('reports a rejected key by host and path, without the URL', async () => {
    const result = await run(['--url', url, '--categories', '5000', '--out', join(outDir, 'rejected.jsonl')], { COLLECT_INDEXER_KEY: 'wrong' });
    expect(result.code).not.toBe(0);
    expect(result.stderr).toMatch(/authRejected/);
    expect(result.stderr).toContain(`127.0.0.1 /api`);
    expect(result.stderr).not.toContain('apikey');
  });
});
