// THIRD_PARTY_NOTICES.md for one workspace: every package
// the workspace bundles, from bun.lock, with its version, its SPDX ID (its
// package.json `license`) and its licence file. Dependencies of the
// workspace's own workspace dependencies count; dev dependencies don't, and
// the platform's own workspaces (GPL-3.0) aren't listed. Each project
// Dockerfile runs it in its build stage.
//
//   node scripts/notices.ts --workspace @omnarr/web --out /licenses/THIRD_PARTY_NOTICES.md
import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';

type Workspace = { name: string; dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> };
/** `[name@version, registry, { dependencies, … }, integrity]`, or `[name@workspace:path]` for a workspace. */
type Entry = [string, string?, { dependencies?: Record<string, string>; optionalDependencies?: Record<string, string> }?, string?];
type Lock = { workspaces: Record<string, Workspace>; packages: Record<string, Entry> };

/** bun.lock is JSON with trailing commas. */
const parseLock = (text: string): Lock => JSON.parse(text.replace(/,(\s*[}\]])/g, '$1')) as Lock;

const LICENCE_FILE = /^(licen[cs]e|copying|unlicense)(\.|-|$)/i;

/** The folder `bun install` put a package in: nested under its parent, hoisted, or in bun's isolated store. */
async function folderOf(root: string, key: string, name: string, version: string): Promise<string | undefined> {
  const modules = join(root, 'node_modules');
  const parts = key.split('/');
  // A key `vue/nanoid` (or `@scope/a/b`) is a copy nested under its parent.
  const scoped = (from: number) => (parts[from]?.startsWith('@') ? 2 : 1);
  const chain: string[] = [];
  for (let i = 0; i < parts.length; i += scoped(i)) chain.push(parts.slice(i, i + scoped(i)).join('/'));
  const candidates = [join(modules, ...chain.flatMap((part, i) => (i === 0 ? [part] : ['node_modules', part])))];
  const store = join(modules, '.bun');
  const prefix = `${name.replace('/', '+')}@${version}`;
  for (const entry of await readdir(store).catch(() => [] as string[]))
    if (entry === prefix || entry.startsWith(`${prefix}+`)) candidates.push(join(store, entry, 'node_modules', name));
  for (const dir of candidates) if (await readFile(join(dir, 'package.json')).catch(() => undefined)) return dir;
  return undefined;
}

async function licenceOf(dir: string): Promise<{ spdx: string; text?: string }> {
  const manifest = JSON.parse(await readFile(join(dir, 'package.json'), 'utf8')) as { license?: string | { type?: string } };
  const spdx = (typeof manifest.license === 'string' ? manifest.license : manifest.license?.type) ?? 'UNKNOWN';
  const file = (await readdir(dir)).sort().find((name) => LICENCE_FILE.test(name));
  return file ? { spdx, text: (await readFile(join(dir, file), 'utf8')).trim() } : { spdx };
}

export async function thirdPartyNotices({ root, workspace }: { root: string; workspace: string }): Promise<string> {
  const lock = parseLock(await readFile(join(root, 'bun.lock'), 'utf8'));
  const byName = new Map(Object.entries(lock.workspaces).map(([path, entry]) => [entry.name, path]));
  const start = lock.workspaces[workspace] ?? lock.workspaces[byName.get(workspace) ?? ''];
  if (!start) throw new Error(`no workspace ${workspace} in bun.lock`);

  const found = new Map<string, { key: string; name: string; version: string }>();
  const visitedWorkspaces = new Set<string>();
  const walk = (deps: Record<string, string> | undefined, parent: string | undefined) => {
    for (const dep of Object.keys(deps ?? {})) {
      const key = parent && lock.packages[`${parent}/${dep}`] ? `${parent}/${dep}` : dep;
      const entry = lock.packages[key];
      if (!entry) continue;
      const at = entry[0].lastIndexOf('@');
      const name = entry[0].slice(0, at);
      const version = entry[0].slice(at + 1);
      if (version.startsWith('workspace:')) {
        const path = version.slice('workspace:'.length);
        if (visitedWorkspaces.has(path)) continue;
        visitedWorkspaces.add(path);
        const own = lock.workspaces[path];
        walk({ ...own?.dependencies, ...own?.optionalDependencies }, undefined);
        continue;
      }
      if (found.has(key)) continue;
      found.set(key, { key, name, version });
      walk({ ...entry[2]?.dependencies, ...entry[2]?.optionalDependencies }, key);
    }
  };
  walk({ ...start.dependencies, ...start.optionalDependencies }, undefined);

  const sections: string[] = [];
  const unique = new Map([...found.values()].map((pkg) => [`${pkg.name}@${pkg.version}`, pkg]));
  for (const pkg of [...unique.values()].sort((a, b) => a.name.localeCompare(b.name) || a.version.localeCompare(b.version))) {
    const folder = await folderOf(root, pkg.key, pkg.name, pkg.version);
    // Not installed (an optional package for another platform): not in the image either.
    if (!folder) continue;
    const { spdx, text } = await licenceOf(folder);
    sections.push(`## ${pkg.name} ${pkg.version} (${spdx})\n\n${text ? `\`\`\`text\n${text}\n\`\`\`` : 'The package ships no licence file.'}`);
  }
  return [
    `# Third-party notices: ${start.name}`,
    '',
    "The npm packages this image bundles, from bun.lock, with each package's licence. omnarr's own code is GPL-3.0-only.",
    '',
    ...sections.flatMap((section) => [section, '']),
  ].join('\n');
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const { values } = parseArgs({ options: { workspace: { type: 'string' }, out: { type: 'string' }, root: { type: 'string' } } });
  if (!values.workspace || !values.out) {
    console.error('usage: node scripts/notices.ts --workspace <name> --out <file> [--root <dir>]');
    process.exit(2);
  }
  const root = values.root ?? join(fileURLToPath(import.meta.url), '../..');
  await writeFile(values.out, await thirdPartyNotices({ root, workspace: values.workspace }));
}
