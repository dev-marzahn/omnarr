// The control secrets the setup container generates: one
// file per secret in its secrets volume, which the worker mounts read-only.
// A value is never logged; an error names the secret, never its content.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

export const secretsDir = (env: NodeJS.ProcessEnv = process.env): string => env.OMNARR_SECRETS_DIR || '/run/omnarr/secrets';

/**
 * The worker token: `WORKER_TOKEN` when set, else
 * the file `WORKER_TOKEN_FILE` names (default /run/omnarr/secrets/worker_token),
 * which the setup container copies from backend-secrets.
 */
export function readWorkerToken(env: NodeJS.ProcessEnv = process.env): string {
  if (env.WORKER_TOKEN) return env.WORKER_TOKEN;
  const path = env.WORKER_TOKEN_FILE || '/run/omnarr/secrets/worker_token';
  let value = '';
  try {
    value = readFileSync(path, 'utf8').trim();
  } catch {
    // Reported below, with the path.
  }
  if (!value) throw new Error(`The worker token file ${path} is missing or empty.`);
  return value;
}

export function readSecret(name: string, dir: string = secretsDir()): string {
  let text: string;
  try {
    text = readFileSync(join(dir, name), 'utf8');
  } catch {
    throw new Error(`The secret ${name} is missing from ${dir}.`);
  }
  const value = text.replace(/\s+$/, '');
  if (value === '') throw new Error(`The secret ${name} in ${dir} is empty.`);
  return value;
}
