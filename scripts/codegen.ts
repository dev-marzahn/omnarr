// Rewrites packages/backend/convex/_generated/ (committed), and convex-release's
// migrations/_generated.ts and seeds/_generated.ts; then the upgrade e2e's
// fixture apps' _generated/.
//
// Component codegen pulls deployment state, so this runs against a throwaway
// self-hosted backend in Docker (scripts/backend.ts). Nothing is deployed
// there; the container is removed afterwards.
//
//   bun run codegen
import { spawnSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startBackend } from './backend.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const backendDir = join(root, 'packages/backend');
const FIXTURE_APPS = ['e2e/apps/upgrade-v1', 'e2e/apps/upgrade-v2'].map((dir) => join(root, dir));

function run(cwd: string, cmd: string, args: string[], env?: NodeJS.ProcessEnv): void {
  const result = spawnSync(join(cwd, 'node_modules/.bin', cmd), args, { cwd, env, stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed in ${cwd}`);
}

// convex-release's files first: Convex codegen then includes their functions.
run(backendDir, 'convex-release', ['codegen']);

const backend = await startBackend('omnarr-codegen');
try {
  for (const dir of [backendDir, ...FIXTURE_APPS]) run(dir, 'convex', ['codegen', '--typecheck', 'disable'], backend.env);
} finally {
  backend.stop();
}
