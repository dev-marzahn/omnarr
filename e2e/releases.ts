// The releases stackUpgrade upgrades between: their compose files
// and their three images.
//
// "from": with E2E_FROM_VERSION (the release workflow), the GitHub release's
// compose files and the images they pin; otherwise an older commit,
// E2E_FROM_COMMIT or 62f05fc, built here as E2E_FROM_LOCAL_VERSION.
// "to": this checkout's files, and E2E_TO_*_IMAGE when the workflow built
// them, else this checkout built here as E2E_TO_VERSION.
// The crash-loop fixture is "to"'s backend with a migration that throws.
import { execFileSync, execSync } from 'node:child_process';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROJECT } from './image.ts';
import type { ProjectImages } from './stack.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

export type Release = { version: string; dir: string; images: ProjectImages };

const DOCKERFILES = { backend: 'packages/backend/Dockerfile', worker: 'apps/worker/Dockerfile', web: 'apps/web/Dockerfile' } as const;

/** A commit's files in a new temporary folder, as `git archive` gives them. */
function archive(rev: string): string {
  const dir = mkdtempSync(join(tmpdir(), `omnarr-release-${rev}-`));
  execSync(`git archive ${rev} | tar -x -C ${JSON.stringify(dir)}`, { cwd: root, stdio: 'inherit' });
  return dir;
}

function build(context: string, name: keyof typeof DOCKERFILES, version: string, tag: string): string {
  execFileSync('docker', ['build', '-q', '-f', join(context, DOCKERFILES[name]), '--build-arg', `OMNARR_VERSION=${version}`, '-t', tag, context], {
    stdio: 'inherit',
  });
  return tag;
}

const buildAll = (context: string, version: string, suffix: string): ProjectImages => ({
  backend: build(context, 'backend', version, `omnarr-backend:${PROJECT}-${suffix}`),
  worker: build(context, 'worker', version, `omnarr-worker:${PROJECT}-${suffix}`),
  web: build(context, 'web', version, `omnarr-web:${PROJECT}-${suffix}`),
});

async function releaseFile(version: string, name: string): Promise<string> {
  const response = await fetch(`https://github.com/dev-marzahn/omnarr/releases/download/v${version}/${name}`);
  if (!response.ok) throw new Error(`release v${version} has no ${name} (HTTP ${response.status})`);
  return response.text();
}

export async function publishedRelease(version: string): Promise<Release> {
  const dir = mkdtempSync(join(tmpdir(), `omnarr-release-${version}-`));
  for (const file of ['compose.yml', 'compose.vpn.yml']) writeFileSync(join(dir, file), await releaseFile(version, file));
  const pinned = (name: string) => readFileSync(join(dir, 'compose.yml'), 'utf8').match(new RegExp(`image:\\s*(\\S*/${name}:\\S+)`))![1]!;
  return { version, dir, images: { backend: pinned('omnarr-backend'), worker: pinned('omnarr-worker'), web: pinned('omnarr-web') } };
}

/** The release to upgrade from. */
export async function fromRelease(): Promise<Release> {
  const published = process.env.E2E_FROM_VERSION;
  if (published) return publishedRelease(published);
  const version = process.env.E2E_FROM_LOCAL_VERSION || '0.1.0-p1';
  const dir = archive(process.env.E2E_FROM_COMMIT || '62f05fc');
  return { version, dir, images: buildAll(dir, version, version) };
}

/** This checkout, as the release under test. */
export function toRelease(): Release {
  const version = process.env.E2E_TO_VERSION || '0.2.0-p2';
  const given = { backend: process.env.E2E_TO_BACKEND_IMAGE, worker: process.env.E2E_TO_WORKER_IMAGE, web: process.env.E2E_TO_WEB_IMAGE };
  const images = given.backend && given.worker && given.web ? (given as ProjectImages) : buildAll(root, version, version);
  return { version, dir: root, images };
}

/**
 * The upgrade's crash loop: "to"'s backend, built from HEAD with one more
 * migration, which throws on the first row. Only the e2e builds it.
 */
export function failingBackend(to: Release): string {
  const dir = archive('HEAD');
  const migrations = join(dir, 'packages/backend/convex/migrations');
  writeFileSync(
    join(migrations, '9999_fails_on_purpose.ts'),
    [
      "import { defineMigration } from './_generated';",
      '',
      "// stackUpgrade's fixture: a migration that fails on purpose.",
      "export default defineMigration({ table: 'works', migrateOne: () => { throw new Error('fails on purpose'); } });",
      '',
    ].join('\n'),
  );
  const generated = join(migrations, '_generated.ts');
  const list = readFileSync(generated, 'utf8');
  const last = /( *)internal\.migrations\["[^"]+"\]\.default,\n(?!\s*internal)/.exec(list)!;
  writeFileSync(generated, list.replace(last[0], `${last[0]}${last[1]}internal.migrations["9999_fails_on_purpose"].default,\n`));
  return build(dir, 'backend', to.version, `omnarr-backend:${PROJECT}-failing`);
}
