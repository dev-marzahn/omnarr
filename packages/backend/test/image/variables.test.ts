// The pre-push hook's validation and values.
import { createHash } from 'node:crypto';

import { describe, expect, test } from 'vite-plus/test';

import { desiredVariables, diff, MANAGED } from '../../image/variables.ts';

const files = { workerToken: 'wt-file', betterAuthSecret: 'bas-file', setupPassword: 'generated-setup-pw' };
const sha = (text: string) => createHash('sha256').update(text).digest('hex');

describe('desiredVariables', () => {
  test('with no .env: the secrets, the web port, the generated setup password and the update check on', () => {
    expect(desiredVariables({}, files)).toEqual({
      set: {
        WORKER_TOKEN: 'wt-file',
        BETTER_AUTH_SECRET: 'bas-file',
        WEB_PORT: '3000',
        SETUP_PASSWORD_HASH: sha('generated-setup-pw'),
        UPDATE_CHECK: 'on',
      },
      errors: [],
    });
  });

  test('the three platform URLs set: SITE_URL is the web URL', () => {
    const { set, errors } = desiredVariables(
      {
        OMNARR_WEB_URL: 'https://omnarr.example.net',
        OMNARR_CONVEX_URL: 'https://api.omnarr.example.net',
        OMNARR_CONVEX_SITE_URL: 'https://auth.omnarr.example.net/',
      },
      files,
    );
    expect(errors).toEqual([]);
    expect(set.SITE_URL).toBe('https://omnarr.example.net');
  });

  test('a set setup password wins over the generated file', () => {
    expect(desiredVariables({ OMNARR_SETUP_PASSWORD: 'chosen' }, files).set.SETUP_PASSWORD_HASH).toBe(sha('chosen'));
    expect(desiredVariables({ OMNARR_SETUP_PASSWORD: 'chosen' }, { ...files, setupPassword: undefined }).errors).toEqual([]);
  });

  test('TMDB: the environment, else the image file, else unset', () => {
    expect(desiredVariables({ TMDB_API_TOKEN: 'from-env' }, { ...files, tmdbToken: 'built-in' }).set.TMDB_API_TOKEN).toBe('from-env');
    expect(desiredVariables({}, { ...files, tmdbToken: 'built-in' }).set.TMDB_API_TOKEN).toBe('built-in');
    expect(desiredVariables({}, files).set).not.toHaveProperty('TMDB_API_TOKEN');
  });

  test('an empty value counts as unset', () => {
    const { set, errors } = desiredVariables(
      {
        OMNARR_WEB_URL: '',
        OMNARR_CONVEX_URL: '',
        OMNARR_CONVEX_SITE_URL: '',
        OMNARR_WEB_PORT: '',
        OMNARR_SETUP_PASSWORD: '',
        TMDB_API_TOKEN: '',
        OMNARR_UPDATE_CHECK: '',
      },
      files,
    );
    expect(errors).toEqual([]);
    expect(set).toEqual(desiredVariables({}, files).set);
  });

  test.each([
    [
      { OMNARR_WEB_URL: 'https://a.example.net', OMNARR_CONVEX_URL: 'ftp://b.example.net', OMNARR_CONVEX_SITE_URL: 'https://c.example.net' },
      'OMNARR_CONVEX_URL is not an http(s) URL without a path',
    ],
    [{ OMNARR_JELLYFIN_URL: 'https://jf.example.net/jellyfin' }, 'OMNARR_JELLYFIN_URL is not an http(s) URL without a path'],
    [{ OMNARR_JELLYFIN_URL: 'not a url' }, 'OMNARR_JELLYFIN_URL is not an http(s) URL without a path'],
    [{ OMNARR_WEB_URL: 'https://a.example.net' }, 'OMNARR_WEB_URL, OMNARR_CONVEX_URL and OMNARR_CONVEX_SITE_URL must be set together'],
    [
      { OMNARR_WEB_URL: 'https://a.example.net', OMNARR_CONVEX_URL: 'http://b.example.net', OMNARR_CONVEX_SITE_URL: 'https://c.example.net' },
      'OMNARR_WEB_URL, OMNARR_CONVEX_URL and OMNARR_CONVEX_SITE_URL must use the same scheme',
    ],
    [{ OMNARR_WEB_PORT: '0' }, 'OMNARR_WEB_PORT is not a port from 1 to 65535'],
    [{ OMNARR_CONVEX_PORT: '70000' }, 'OMNARR_CONVEX_PORT is not a port from 1 to 65535'],
    [{ OMNARR_JELLYFIN_PORT: '80a' }, 'OMNARR_JELLYFIN_PORT is not a port from 1 to 65535'],
    [{ OMNARR_UPDATE_CHECK: 'yes' }, 'OMNARR_UPDATE_CHECK is neither on nor off'],
  ])('%o is refused: %s', (env, error) => {
    const result = desiredVariables(env, files);
    expect(result.errors).toEqual([error]);
    expect(result.set).toEqual({});
  });

  test('a missing secrets file is named, and nothing is set', () => {
    expect(desiredVariables({}, { betterAuthSecret: 'x' })).toEqual({
      set: {},
      errors: ['backend-secrets/worker_token is missing', 'backend-secrets/setup_password is missing and OMNARR_SETUP_PASSWORD is unset'],
    });
  });
});

describe('diff', () => {
  test('sets what differs, removes managed names no longer wanted, and leaves every other variable alone', () => {
    const current = { WORKER_TOKEN: 'same', SITE_URL: 'https://old', TMDB_API_URL: 'http://tmdb:8000', CONVEX_RELEASE_VERSION: '1.2.0', UPDATE_CHECK: 'on' };
    const desired = { WORKER_TOKEN: 'same', UPDATE_CHECK: 'off' };
    expect(diff(current, desired, MANAGED)).toEqual({ set: { UPDATE_CHECK: 'off' }, remove: ['SITE_URL'] });
  });

  test("convex-release's own variables are never managed", () => {
    expect(MANAGED.some((name) => name.startsWith('CONVEX_RELEASE_'))).toBe(false);
  });
});
