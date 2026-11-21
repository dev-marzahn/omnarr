// The pre-push hook's rules: validate the .env values the backend's
// environment holds, build the deployment variables from them and from
// backend-secrets, and diff them against the deployment. An error names a
// variable or a file and the rule, never a value.
import { createHash } from 'node:crypto';

/** The deployment variables the hook owns. It never touches any other, convex-release's `CONVEX_RELEASE_*` among them. */
export const MANAGED = ['WORKER_TOKEN', 'BETTER_AUTH_SECRET', 'SITE_URL', 'WEB_PORT', 'TMDB_API_TOKEN', 'SETUP_PASSWORD_HASH', 'UPDATE_CHECK'] as const;

/** The files the values come from, already read: backend-secrets' three, and the image's built-in TMDB token. */
export type SecretFiles = { workerToken?: string; betterAuthSecret?: string; setupPassword?: string; tmdbToken?: string };

const PLATFORM_URLS = ['OMNARR_WEB_URL', 'OMNARR_CONVEX_URL', 'OMNARR_CONVEX_SITE_URL'] as const;
const URLS = [...PLATFORM_URLS, 'OMNARR_JELLYFIN_URL'] as const;
const PORTS = ['OMNARR_WEB_PORT', 'OMNARR_CONVEX_PORT', 'OMNARR_CONVEX_SITE_PORT', 'OMNARR_JELLYFIN_PORT'] as const;

/** An http(s) URL with no path, query or fragment, as its origin; otherwise undefined. */
function originOf(text: string): string | undefined {
  try {
    const url = new URL(text);
    if ((url.protocol !== 'http:' && url.protocol !== 'https:') || url.pathname !== '/' || url.search || url.hash || url.username) return undefined;
    return url.origin;
  } catch {
    return undefined;
  }
}

export function desiredVariables(env: Record<string, string | undefined>, files: SecretFiles): { set: Record<string, string>; errors: string[] } {
  // An empty value counts as unset everywhere.
  const value = (name: string) => env[name] || undefined;
  const errors: string[] = [];

  const origins: Partial<Record<(typeof URLS)[number], string>> = {};
  for (const name of URLS) {
    const text = value(name);
    if (text === undefined) continue;
    const origin = originOf(text);
    if (origin) origins[name] = origin;
    else errors.push(`${name} is not an http(s) URL without a path`);
  }
  const three = 'OMNARR_WEB_URL, OMNARR_CONVEX_URL and OMNARR_CONVEX_SITE_URL';
  const platform = PLATFORM_URLS.filter((name) => value(name) !== undefined);
  const schemes = new Set(PLATFORM_URLS.flatMap((name) => (origins[name] ? [origins[name].split(':')[0]] : [])));
  if (platform.length > 0 && platform.length < PLATFORM_URLS.length) errors.push(`${three} must be set together`);
  else if (schemes.size > 1) errors.push(`${three} must use the same scheme`);

  for (const name of PORTS) {
    const text = value(name);
    if (text !== undefined && !(/^\d+$/.test(text) && Number(text) >= 1 && Number(text) <= 65535)) errors.push(`${name} is not a port from 1 to 65535`);
  }
  const updateCheck = value('OMNARR_UPDATE_CHECK') ?? 'on';
  if (updateCheck !== 'on' && updateCheck !== 'off') errors.push('OMNARR_UPDATE_CHECK is neither on nor off');

  if (!files.workerToken) errors.push('backend-secrets/worker_token is missing');
  if (!files.betterAuthSecret) errors.push('backend-secrets/better_auth_secret is missing');
  const setupPassword = value('OMNARR_SETUP_PASSWORD') ?? files.setupPassword;
  if (!setupPassword) errors.push('backend-secrets/setup_password is missing and OMNARR_SETUP_PASSWORD is unset');

  if (errors.length > 0) return { set: {}, errors };
  const tmdb = value('TMDB_API_TOKEN') ?? (files.tmdbToken || undefined);
  return {
    set: {
      WORKER_TOKEN: files.workerToken!,
      BETTER_AUTH_SECRET: files.betterAuthSecret!,
      ...(origins.OMNARR_WEB_URL ? { SITE_URL: origins.OMNARR_WEB_URL } : {}),
      WEB_PORT: value('OMNARR_WEB_PORT') ?? '3000',
      ...(tmdb ? { TMDB_API_TOKEN: tmdb } : {}),
      SETUP_PASSWORD_HASH: createHash('sha256').update(setupPassword!).digest('hex'),
      UPDATE_CHECK: updateCheck,
    },
    errors,
  };
}

/** What to write: the desired values that differ, and the managed names the deployment has but no longer wants. */
export function diff(
  current: Record<string, string>,
  desired: Record<string, string>,
  managed: readonly string[],
): { set: Record<string, string>; remove: string[] } {
  const set = Object.fromEntries(Object.entries(desired).filter(([name, wanted]) => current[name] !== wanted));
  const remove = managed.filter((name) => name in current && !(name in desired));
  return { set, remove };
}
