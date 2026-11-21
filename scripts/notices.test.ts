// The licence notices, from a hand-written bun.lock and
// package folders in a temporary directory, as `bun install` lays them out:
// hoisted under node_modules/, or in bun's isolated store (node_modules/.bun/).
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, expect, test } from 'vite-plus/test';

import { thirdPartyNotices } from './notices.ts';

let root: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'omnarr-notices-'));
});
afterEach(() => rm(root, { recursive: true, force: true }));

/** bun.lock's text format: JSON with trailing commas. */
const LOCK = `{
  "lockfileVersion": 2,
  "workspaces": {
    "apps/web": {
      "name": "@omnarr/web",
      "dependencies": { "@omnarr/contracts": "workspace:*", "vue": "^3.5.0", },
      "devDependencies": { "vite-plus": "1.6.0", },
    },
    "packages/contracts": {
      "name": "@omnarr/contracts",
      "dependencies": { "zod": "^4.0.0", },
    },
  },
  "packages": {
    "@omnarr/contracts": ["@omnarr/contracts@workspace:packages/contracts"],
    "@vue/shared": ["@vue/shared@3.5.22", "", {}, "sha512-x"],
    "vite-plus": ["vite-plus@1.6.0", "", {}, "sha512-x"],
    "vue": ["vue@3.5.22", "", { "dependencies": { "@vue/shared": "3.5.22", "nanoid": "^3.0.0" }, "optionalDependencies": { "@esbuild/aix-ppc64": "0.27.0" } }, "sha512-x"],
    "@esbuild/aix-ppc64": ["@esbuild/aix-ppc64@0.27.0", "", { "os": "aix" }, "sha512-x"],
    "vue/nanoid": ["nanoid@3.3.11", "", {}, "sha512-x"],
    "nanoid": ["nanoid@5.1.0", "", {}, "sha512-x"],
    "zod": ["zod@4.6.7", "", {}, "sha512-x"],
  }
}
`;

/** A package folder with its package.json and, unless `licence` is null, a LICENSE file. */
async function pkg(dir: string, name: string, version: string, license: string, licence: string | null = `${name} licence text`) {
  await mkdir(dir, { recursive: true });
  await writeFile(join(dir, 'package.json'), JSON.stringify({ name, version, license }));
  if (licence !== null) await writeFile(join(dir, 'LICENSE'), licence);
}

async function tree() {
  await writeFile(join(root, 'bun.lock'), LOCK);
  const modules = join(root, 'node_modules');
  await pkg(join(modules, 'vue'), 'vue', '3.5.22', 'MIT');
  await pkg(join(modules, 'vue/node_modules/nanoid'), 'nanoid', '3.3.11', 'MIT');
  await pkg(join(modules, 'nanoid'), 'nanoid', '5.1.0', 'MIT');
  // Only in bun's isolated store, under its versioned folder.
  await pkg(join(modules, '.bun/@vue+shared@3.5.22/node_modules/@vue/shared'), '@vue/shared', '3.5.22', 'MIT');
  await pkg(join(modules, '.bun/zod@4.6.7+abc123/node_modules/zod'), 'zod', '4.6.7', 'MIT', null);
  await pkg(join(modules, 'vite-plus'), 'vite-plus', '1.6.0', 'MIT');
}

test("a workspace's notices list every package it bundles, through its workspace dependencies, with version and SPDX ID", async () => {
  await tree();
  const notices = await thirdPartyNotices({ root, workspace: '@omnarr/web' });
  const headings = notices.split('\n').filter((line) => line.startsWith('## '));
  expect(headings).toEqual(['## @vue/shared 3.5.22 (MIT)', '## nanoid 3.3.11 (MIT)', '## vue 3.5.22 (MIT)', '## zod 4.6.7 (MIT)']);
});

test("dev dependencies and the platform's own workspaces are left out", async () => {
  await tree();
  const notices = await thirdPartyNotices({ root, workspace: 'apps/web' });
  expect(notices).not.toContain('vite-plus');
  expect(notices).not.toContain('## @omnarr/');
  // The nested nanoid is vue's, not the hoisted 5.1.0.
  expect(notices).not.toContain('nanoid 5.1.0');
  // An optional package for another platform isn't installed, so it isn't bundled.
  expect(notices).not.toContain('@esbuild/aix-ppc64');
});

test("each package's licence file is included; one without a file says so", async () => {
  await tree();
  const notices = await thirdPartyNotices({ root, workspace: '@omnarr/web' });
  expect(notices).toContain('vue licence text');
  expect(notices).toContain('@vue/shared licence text');
  expect(notices).toMatch(/## zod 4\.6\.7 \(MIT\)\n\nThe package ships no licence file\./);
});

test('an unknown workspace fails', async () => {
  await tree();
  await expect(thirdPartyNotices({ root, workspace: '@omnarr/nope' })).rejects.toThrow(/no workspace/);
});
