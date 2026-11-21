// The backend image's hooks, which convex-release runs on every start:
//
//   node /omnarr/hooks.mjs pre-push     the deployment variables, before the first push
//   node /omnarr/hooks.mjs post-apply   the reference seeds, after the release is applied
//
// Each gets CONVEX_URL and CONVEX_ADMIN_KEY from convex-release. Every line it
// prints is `[omnarr] …` and names a variable, a file or a rule, never a value.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

import { adminApi } from './admin.ts';
import { desiredVariables, diff, MANAGED } from './variables.ts';

export type HookOptions = {
  env: Record<string, string | undefined>;
  secretsDir?: string;
  tmdbTokenFile?: string;
  log?: (line: string) => void;
};

const readOptional = (path: string): string | undefined => {
  try {
    return readFileSync(path, 'utf8').trim() || undefined;
  } catch {
    return undefined;
  }
};

/** Runs one hook and answers its exit code. */
export async function runHook(
  name: string,
  { env, secretsDir = '/run/omnarr/backend-secrets', tmdbTokenFile = '/omnarr/tmdb_token', log = console.log }: HookOptions,
): Promise<number> {
  try {
    const api = adminApi(env.CONVEX_URL ?? 'http://127.0.0.1:3210', env.CONVEX_ADMIN_KEY ?? '');
    if (name === 'pre-push') {
      const { set: desired, errors } = desiredVariables(env, {
        workerToken: readOptional(join(secretsDir, 'worker_token')),
        betterAuthSecret: readOptional(join(secretsDir, 'better_auth_secret')),
        setupPassword: readOptional(join(secretsDir, 'setup_password')),
        tmdbToken: readOptional(tmdbTokenFile),
      });
      if (errors.length > 0) {
        for (const error of errors) log(`[omnarr] pre-push failed: ${error}`);
        return 1;
      }
      const { set, remove } = diff(await api.listVariables(), desired, MANAGED);
      const changes = { ...set, ...Object.fromEntries(remove.map((variable) => [variable, null])) };
      if (Object.keys(changes).length > 0) await api.updateVariables(changes);
      log(`[omnarr] pre-push: ok (${Object.keys(changes).length === 0 ? 'no change' : `set ${Object.keys(changes).sort().join(', ')}`})`);
      return 0;
    }
    if (name === 'post-apply') {
      await api.run('seeds/_reference:apply');
      log('[omnarr] post-apply: ok');
      return 0;
    }
    log(`[omnarr] unknown hook ${name}; use pre-push or post-apply`);
    return 1;
  } catch (error) {
    log(`[omnarr] ${name} failed: ${error instanceof Error ? error.message : String(error)}`);
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await runHook(process.argv[2] ?? '', { env: process.env });
}
