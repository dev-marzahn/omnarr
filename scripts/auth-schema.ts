// Regenerates packages/backend/convex/betterAuth/schema.ts (committed) after a
// change to convex/authOptions.ts.
//
// The Better Auth CLI writes the absolute output path into the file's header,
// which would leak the generating machine's paths into the repository, so this
// rewrites it to the relative one.
//
//   bun run auth:schema
import { spawnSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const backendDir = join(root, 'packages/backend');
const authDir = join(backendDir, 'convex/betterAuth');
const output = join(authDir, 'schema.ts');

const result = spawnSync(join(backendDir, 'node_modules/.bin/auth'), ['generate', '--config', 'auth.ts', '--output', 'schema.ts', '--yes'], {
  cwd: authDir,
  stdio: 'inherit',
});
if (result.status !== 0) throw new Error('auth generate failed');

const generated = readFileSync(output, 'utf8');
const relative = generated.replaceAll(output, 'schema.ts');
if (relative.includes(root)) throw new Error(`${output} still contains an absolute path`);
writeFileSync(output, relative);
