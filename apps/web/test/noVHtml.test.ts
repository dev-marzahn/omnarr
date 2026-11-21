// The app renders untrusted text (release titles, TMDB overviews, file
// names), so no template in apps/web uses `v-html`. oxlint doesn't read Vue
// templates, so this test is the rule.
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { expect, test } from 'vite-plus/test';

const root = fileURLToPath(new URL('..', import.meta.url));
const vueFiles = (dir: string): string[] =>
  readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    if (entry.name === 'node_modules' || entry.name.startsWith('.')) return [];
    const path = join(dir, entry.name);
    return entry.isDirectory() ? vueFiles(path) : entry.name.endsWith('.vue') ? [path] : [];
  });

test('no .vue file uses v-html', () => {
  const files = vueFiles(root);
  expect(files.length).toBeGreaterThan(20);
  expect(files.filter((file) => /\bv-html\b/.test(readFileSync(file, 'utf8'))).map((file) => file.slice(root.length))).toEqual([]);
});
