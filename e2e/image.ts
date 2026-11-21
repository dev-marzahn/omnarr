// The project's three images every scenario's stack runs, built
// once per run: run.ts builds them before the first scenario and hands their
// names on in E2E_IMAGES_BUILT, so the scenarios (and a file with two stacks)
// skip the build; a test file run alone builds them on its first stack.
// Docker's layer cache makes a build with no change a few seconds. No imports
// beyond node's, so run.ts can load it.
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROJECT } from './host.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');

/** The compose project: one per checkout, or `E2E_PROJECT` (host.ts). */
export { PROJECT };
/** The images, per project (or `E2E_WORKER_IMAGE`, …), so two runs never swap them. */
export const WORKER_IMAGE = process.env.E2E_WORKER_IMAGE || `omnarr-worker:${PROJECT}`;
export const BACKEND_IMAGE = process.env.E2E_BACKEND_IMAGE || `omnarr-backend:${PROJECT}`;
export const WEB_IMAGE = process.env.E2E_WEB_IMAGE || `omnarr-web:${PROJECT}`;
const IMAGES = [
  { tag: WORKER_IMAGE, dockerfile: 'apps/worker/Dockerfile' },
  { tag: BACKEND_IMAGE, dockerfile: 'packages/backend/Dockerfile' },
  { tag: WEB_IMAGE, dockerfile: 'apps/web/Dockerfile' },
];
const names = IMAGES.map((image) => image.tag).join(',');

let built = process.env.E2E_IMAGES_BUILT === names;

/** Builds the three images unless this run already has; answers the seconds it took. */
export function buildImages(): number {
  if (built) return 0;
  const started = Date.now();
  for (const { tag, dockerfile } of IMAGES) execFileSync('docker', ['build', '-q', '-f', join(root, dockerfile), '-t', tag, root], { stdio: 'inherit' });
  built = true;
  return (Date.now() - started) / 1000;
}

/** What run.ts hands its scenarios, so they skip the build. */
export const BUILT_MARKER = names;
