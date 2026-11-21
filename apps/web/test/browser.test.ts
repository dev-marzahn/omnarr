// Browser helpers that work on a plain-http LAN page (no public URL is the default), where
// `crypto.randomUUID` and `navigator.clipboard` don't exist because the page isn't a secure context.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, test, vi } from 'vite-plus/test';

import { copyText, newId } from '../lib/browser';

const root = fileURLToPath(new URL('..', import.meta.url));
const sources = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name === 'test' || entry.name.startsWith('.')) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? sources(path) : /\.(vue|ts)$/.test(entry.name) ? [path] : [];
  });

test('no app source uses an API that a plain-http page lacks, except lib/browser.ts', () => {
  const files = sources(root).filter((file) => !file.endsWith(join('lib', 'browser.ts')));
  expect(files.length).toBeGreaterThan(20);
  const offenders = files.filter((file) => /crypto\.randomUUID|navigator\.clipboard|crypto\.subtle/.test(readFileSync(file, 'utf8')));
  expect(offenders.map((file) => file.slice(root.length))).toEqual([]);
});

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('newId', () => {
  test('makes a v4 UUID without crypto.randomUUID', () => {
    const insecure = { getRandomValues: crypto.getRandomValues.bind(crypto) } as Crypto;
    const ids = new Set(Array.from({ length: 50 }, () => newId(insecure)));
    expect(ids.size).toBe(50);
    for (const id of ids) expect(id).toMatch(UUID_V4);
  });
});

describe('copyText', () => {
  test('uses the Clipboard API when the page has it', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    const fallback = vi.fn();
    await copyText('abc', { clipboard: { writeText } as unknown as Clipboard, fallback });
    expect(writeText).toHaveBeenCalledWith('abc');
    expect(fallback).not.toHaveBeenCalled();
  });

  test('falls back on a plain-http page, where there is no Clipboard API', async () => {
    const fallback = vi.fn().mockReturnValue(true);
    await copyText('abc', { clipboard: undefined, fallback });
    expect(fallback).toHaveBeenCalledWith('abc');
  });

  test('fails when neither way copies', async () => {
    await expect(copyText('abc', { clipboard: undefined, fallback: () => false })).rejects.toThrow();
  });
});
