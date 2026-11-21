// The backend's admin API, as convex-release's entrypoint calls it:
// `Authorization: Convex <key>` on every request, and functions through
// `POST /api/function`. An error carries the path and status, never the key.
import { execFileSync } from 'node:child_process';

export type AdminApi = {
  listVariables: () => Promise<Record<string, string>>;
  /** `null` removes a variable. */
  updateVariables: (changes: Record<string, string | null>) => Promise<void>;
  /** Runs a function, internal ones included, and answers its value. */
  run: (path: string, args?: Record<string, unknown>) => Promise<unknown>;
};

export function adminApi(url: string, key: string): AdminApi {
  const post = async (path: string, body: unknown) => {
    const response = await fetch(`${url}${path}`, {
      method: 'POST',
      headers: { authorization: `Convex ${key}`, 'content-type': 'application/json', 'convex-client': 'omnarr-hooks' },
      body: JSON.stringify(body),
    });
    if (!response.ok) throw new Error(`${path} answered HTTP ${response.status}`);
    const text = await response.text();
    return text ? (JSON.parse(text) as { status?: string; value?: unknown; errorMessage?: string }) : {};
  };
  const call = async (endpoint: string, path: string, args: Record<string, unknown>) => {
    const result = await post(endpoint, { path, format: 'json', args });
    if (result.status !== 'success') throw new Error(`${path} failed: ${result.errorMessage ?? 'no result'}`);
    return result.value;
  };
  return {
    listVariables: async () =>
      Object.fromEntries(
        ((await call('/api/query', '_system/cli/queryEnvironmentVariables', {})) as { name: string; value: string }[]).map((v) => [v.name, v.value]),
      ),
    updateVariables: async (changes) => {
      await post('/api/update_environment_variables', { changes: Object.entries(changes).map(([name, value]) => ({ name, value })) });
    },
    run: (path, args = {}) => call('/api/function', path, args),
  };
}

/** The admin key, derived inside the backend container as convex-release does; it never leaves it. */
export const derivedAdminKey = (): string =>
  execFileSync('./generate_admin_key.sh', { cwd: '/convex', encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] })
    .trim()
    .split('\n')
    .at(-1)!;
