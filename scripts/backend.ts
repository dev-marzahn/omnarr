// A throwaway self-hosted Convex backend in Docker, for codegen (component
// codegen pulls deployment state, so it needs a backend) and for checking
// that the schema deploys.
import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';

/** The backend build @dev-marzahn/convex-release 100.2.1 pins. Bump with it. */
export const BACKEND_IMAGE = 'ghcr.io/convex/convex-backend:d1fcbeaf939502a23a0f4b7e9095a12e84866294';

export type Backend = {
  url: string;
  /** Environment for the Convex CLI: this backend, and no other deployment config. */
  env: NodeJS.ProcessEnv;
  /** Removes the container. */
  stop: () => void;
};

const docker = (args: string[]) => execFileSync('docker', args, { encoding: 'utf8' });

export async function startBackend(name: string, timeoutMs = 120_000): Promise<Backend> {
  spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  // auth.config.ts reads CONVEX_SITE_URL, which the backend derives from
  // CONVEX_SITE_ORIGIN; the push fails without one.
  docker([
    'run',
    '-d',
    '--name',
    name,
    '-p',
    '127.0.0.1::3210',
    '-p',
    '127.0.0.1::3211',
    '-e',
    `INSTANCE_SECRET=${randomBytes(32).toString('hex')}`,
    '-e',
    'CONVEX_SITE_ORIGIN=http://127.0.0.1:3211',
    BACKEND_IMAGE,
  ]);
  const stop = () => void spawnSync('docker', ['rm', '-f', name], { stdio: 'ignore' });
  try {
    const port = docker(['port', name, '3210/tcp']).trim().split('\n')[0]!.split(':').at(-1);
    const url = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + timeoutMs;
    while (
      !(await fetch(`${url}/version`).then(
        (r) => r.ok,
        () => false,
      ))
    ) {
      if (Date.now() > deadline) throw new Error(`The backend at ${url} didn't come up within ${timeoutMs / 1000}s.`);
      await sleep(500);
    }
    const adminKey = docker(['exec', name, './generate_admin_key.sh']).trim().split('\n').at(-1)!;
    const env = { ...process.env, CONVEX_SELF_HOSTED_URL: url, CONVEX_SELF_HOSTED_ADMIN_KEY: adminKey, CONVEX_DEPLOYMENT: '', CONVEX_DEPLOY_KEY: '' };
    return { url, env, stop };
  } catch (error) {
    stop();
    throw error;
  }
}
