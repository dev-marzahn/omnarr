// Smoke checks against a real backend: deploys packages/backend to a
// throwaway self-hosted backend with convex-release (migrations, then a
// validated push), then runs the built worker twice: with the backend's
// protocol version, which connects, and with another, which is rejected and
// keeps retrying.
//
//   bun run build && bun run smoke
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { startBackend } from './backend.ts';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const backendDir = join(root, 'packages/backend');
const workerBundle = join(root, 'apps/worker/dist/main.mjs');

function run(cmd: string, args: string[], env: NodeJS.ProcessEnv): string {
  const result = spawnSync(join(backendDir, 'node_modules/.bin', cmd), args, { cwd: backendDir, env, encoding: 'utf8' });
  if (result.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${result.stdout}\n${result.stderr}`);
  return result.stdout;
}

/** Runs the worker until a line matches `until`, then stops it with SIGTERM. Returns its output. */
function runWorker(env: NodeJS.ProcessEnv, until: RegExp, timeoutMs = 30_000): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn('node', [workerBundle], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let output = '';
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`The worker never printed ${until}:\n${output}`));
    }, timeoutMs);
    const onData = (chunk: Buffer) => {
      output += chunk.toString();
      if (until.test(output)) child.kill('SIGTERM');
    };
    child.stdout.on('data', onData);
    child.stderr.on('data', onData);
    child.on('exit', () => {
      clearTimeout(timer);
      resolve(output);
    });
  });
}

const workerToken = randomBytes(24).toString('hex');
const backend = await startBackend('omnarr-smoke');
try {
  const env = backend.env;
  for (const [name, value] of Object.entries({
    WORKER_TOKEN: workerToken,
    BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
    SITE_URL: 'http://127.0.0.1:3000',
  })) {
    run('convex', ['env', 'set', name, value], env);
  }
  console.log('deploy: convex-release deploy');
  run('convex-release', ['deploy'], env);
  console.log('deploy: ok');

  // The worker reads NZBGet's control password at start; setup-clients writes it.
  const secrets = mkdtempSync(join(tmpdir(), 'omnarr-smoke-secrets-'));
  spawnSync('node', [workerBundle, 'setup-clients'], { env: { ...process.env, OMNARR_SECRETS_DIR: secrets, NZBGET_CONFIG: join(secrets, 'nzbget.conf') } });
  const workerEnv = { ...process.env, CONVEX_URL: backend.url, WORKER_TOKEN: workerToken, WORKER_ID: 'smoke', DATA_DIR: root, OMNARR_SECRETS_DIR: secrets };
  const accepted = await runWorker(workerEnv, /connected as session/);
  console.log(`worker, matching version: ${accepted.match(/connected as session \S+/)![0]}`);

  const rejected = await runWorker({ ...workerEnv, WORKER_ID: 'smoke-old', WORKER_PROTOCOL_VERSION: '0' }, /protocol version mismatch.*retrying in 60 s/);
  console.log(`worker, version 0: ${rejected.match(/protocol version mismatch[^\n]*/)![0]}`);

  const issues = run('convex', ['data', 'issues', '--format', 'jsonLines'], env)
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { failureCode: string; state: string });
  const mismatch = issues.filter((issue) => issue.failureCode === 'protocolMismatch' && issue.state === 'open');
  if (mismatch.length !== 1) throw new Error(`Expected one open protocolMismatch Issue, found ${mismatch.length}.`);
  console.log('issues: one open protocolMismatch Issue');
  console.log('smoke: ok');
} finally {
  backend.stop();
}
