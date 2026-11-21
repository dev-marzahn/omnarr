// The Jellyfin setup on the real stack with Jellyfin 12.4:
//
//   setup            first run sets Jellyfin up through startSetup: every
//                    step done, and the admin signs in to Jellyfin with the
//                    platform password;
//   password push    a platform password change reaches Jellyfin: the new
//                    password signs in, the old one doesn't;
//   setup outage     in its own stack: setup fails while Jellyfin is
//                    stopped, an imported episode's publish waits, and a
//                    re-run with the password completes setup and the
//                    publish.
import { makeFunctionReference } from 'convex/server';
import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test';

import {
  ADMIN,
  authFetch,
  down,
  jellyfinSignIn,
  jellyfinStatus,
  NEWZNAB_KEY,
  rows,
  setUpJellyfinThroughProduct,
  startJellyfin,
  startWorker,
  stopJellyfin,
  up,
  waitFor,
  type Deployment,
} from './stack.ts';

// The backend's generated API isn't a dependency of this package, so calls go by name.
// oxlint-disable-next-line typescript/no-explicit-any
type Any = any;
let d: Deployment;
const query = (name: string, args: object = {}): Promise<Any> => d.admin.query(makeFunctionReference<'query'>(name), args);
const action = (name: string, args: object): Promise<Any> => d.admin.action(makeFunctionReference<'action'>(name), args);

/** Better Auth's routes on 3211, as the web app calls them: from the web origin, with the session header. */
const auth = (path: string, body: object, cookie?: string) => authFetch(d.siteUrl, d.webUrl, path, { body, ...(cookie ? { cookie } : {}) });

describe('Jellyfin setup and password push', () => {
  beforeAll(async () => {
    d = await up();
  }, 600_000);
  afterAll(() => {
    if (process.env.E2E_KEEP !== '1') return down();
  });

  test('setup: every step is done, and the admin signs in to Jellyfin with the platform password', async () => {
    const status = await setUpJellyfinThroughProduct(d);
    expect(status.steps.map((s) => [s.step, s.state])).toEqual([
      ['reachable', 'done'],
      ['wizard', 'done'],
      ['apiKey', 'done'],
      ['libraries', 'done'],
      ['testRefresh', 'done'],
    ]);
    expect(status).toMatchObject({ state: 'ready', version: '12.4.0' });
    expect(await jellyfinSignIn(d, ADMIN.password)).toBe(200);
    // The setup's password left with its payload.
    const job = rows<{ idempotencyKey: string; status: string; payload?: unknown }>(d.env, 'jobs').find((j) => j.idempotencyKey === 'setupJellyfin:firstRun');
    expect(job).toMatchObject({ status: 'done' });
    expect(job!.payload).toBeUndefined();
  });

  test('password push: after /change-password, Jellyfin accepts the new password and refuses the old one', async () => {
    const signIn = await auth('/sign-in/username', { username: ADMIN.username, password: ADMIN.password });
    expect(signIn.status).toBe(200);
    const newPassword = `${ADMIN.password}-changed`;
    const change = await auth('/change-password', { currentPassword: ADMIN.password, newPassword, revokeOtherSessions: false }, signIn.cookie);
    expect(change.status).toBe(200);

    await waitFor('the push to land', async () => ((await jellyfinSignIn(d, newPassword)) === 200 ? true : undefined), 120_000, 500);
    expect(await jellyfinSignIn(d, ADMIN.password)).toBe(401);
    // The change signed out every other omnarr session, the admin client's too, whatever it asked for:
    // only the session it opened in their place is left.
    expect(rows(d.env, 'session', 'betterAuth')).toHaveLength(1);
    await d.admin.signIn(newPassword);
    const push = rows<{ idempotencyKey: string; status: string; payload?: unknown }>(d.env, 'jobs').find((j) =>
      j.idempotencyKey.startsWith('pushJellyfinPassword:'),
    );
    expect(push).toMatchObject({ status: 'done' });
    expect(push!.payload).toBeUndefined();
    expect((await query('api/system:status')).jellyfin.state).toBe('ready');
  });
});

/**
 * The outage stack's reachable step (3 minutes in production): Jellyfin is stopped, so each of the
 * setup's 3 attempts gives up after this, and up() and startJellyfin() wait until a started Jellyfin
 * answers, so no attempt meets a Jellyfin that is still starting.
 */
const OUTAGE_REACHABLE_MS = 5_000;

describe('Jellyfin setup outage', () => {
  beforeAll(async () => {
    // Jellyfin stops before the admin is created, so the setup job createAdmin enqueues meets the outage.
    d = await up({ limits: { jellyfinReachableMs: OUTAGE_REACHABLE_MS }, beforeAdmin: stopJellyfin });
  }, 600_000);
  afterAll(() => {
    if (process.env.E2E_KEEP !== '1') return down();
  });

  test('setup fails while Jellyfin is stopped, publishing waits, and a re-run with the password completes both', async () => {
    startWorker('worker');
    // 3 attempts of `reachable` (3 minutes each in production, OUTAGE_REACHABLE_MS here), plus their backoff.
    const blocked = await waitFor(
      'Jellyfin to be blocked',
      async () => {
        const status = await jellyfinStatus(d);
        return status.state === 'blocked' ? status : undefined;
      },
      120_000,
      500,
    );
    expect(blocked.steps.find((s) => s.step === 'reachable')).toMatchObject({ state: 'failed', reason: 'setupFailed' });
    const issues = (await query('api/system:status')).jellyfin;
    expect(issues.state).toBe('blocked');

    // One episode is imported while Jellyfin is blocked: its publish waits, without counting an attempt.
    await action('api/indexers:create', { name: 'Newznab Main', url: 'http://newznab:4120/api', apiKey: NEWZNAB_KEY, priority: 10 });
    const { library } = await query('api/library:list', { kind: 'series' });
    const { workId } = await action('api/library:subscribe', {
      tmdbId: '900001',
      kind: 'series',
      libraryId: library.libraryId,
      releaseProfileId: library.defaultReleaseProfileId,
      seasons: [1],
    });
    const waiting = await waitFor(
      'the publish to wait for setup',
      async () =>
        rows<{ class: string; status: string; failureCode?: string; attempt: number }>(d.env, 'jobs').find(
          (j) => j.class === 'publish' && j.status === 'waiting' && j.failureCode === 'jellyfinSetupNeeded',
        ),
      300_000,
      1_000,
    );
    expect(waiting.attempt).toBe(0);

    // Started again, and answering before the re-run, whose reachable step allows only OUTAGE_REACHABLE_MS.
    await startJellyfin(d);
    expect(await action('api/jellyfin:rerunSetup', { password: ADMIN.password })).toEqual({ ok: true });
    await waitFor('Jellyfin to be set up again', async () => ((await jellyfinStatus(d)).state === 'ready' ? true : undefined), 300_000, 500);

    await waitFor(
      'the waiting publish to complete',
      async () => {
        const units: { tmdbSeason?: number; tmdbEpisode?: number; state: string }[] = (await query('api/library:detail', { workId })).units;
        const playable = units.filter((u) => u.state === 'notInTargetFormat' || u.state === 'ready');
        return playable.length > 0 ? true : undefined;
      },
      300_000,
      1_000,
    );
    expect(await jellyfinSignIn(d, ADMIN.password)).toBe(200);
    // Production: up to 15 minutes until blocked. Here the outage is a stopped container, seen in seconds.
  }, 600_000);
});
