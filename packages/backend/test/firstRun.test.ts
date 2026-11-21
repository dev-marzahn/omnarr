// First run's functions: setup.state, createAdmin with its
// refusals and lockout, the admin's transaction, advance and saveLanguage.
import { createHash } from 'node:crypto';

import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';

import { api, components } from '../convex/_generated/api';
import { setup, shippedProfile, type Backend } from './setup';

const SETUP_PASSWORD = 'planted-setup-password';
let t: Backend;

beforeEach(async () => {
  process.env.SETUP_PASSWORD_HASH = createHash('sha256').update(SETUP_PASSWORD).digest('hex');
  t = setup();
  // The post-apply hook's reference seeds have run before any user reaches first run.
  await t.run((ctx) => ctx.db.insert('releaseProfiles', shippedProfile()));
});
afterEach(() => {
  delete process.env.SETUP_PASSWORD_HASH;
  vi.useRealTimers();
});

const request = { setupPassword: SETUP_PASSWORD, username: 'Leon', password: 'a-long-password', locale: 'de-DE' };
const createAdmin = (overrides: Partial<typeof request> & { email?: string } = {}) => t.action(api.api.setup.createAdmin, { ...request, ...overrides });
const users = () =>
  t.run((ctx) => ctx.runQuery(components.betterAuth.adapter.findMany, { model: 'user', paginationOpts: { numItems: 10, cursor: null } } as never)) as Promise<{
    page: { _id: string; username: string; role: string; email: string }[];
  }>;
const settings = () => t.run((ctx) => ctx.db.query('settings').first());
/** The admin's own session, as signIn.username leaves it. */
const signedIn = async () => {
  const [user] = (await users()).page;
  const sessionId = await t.run(
    async (ctx) =>
      (
        (await ctx.runMutation(components.betterAuth.adapter.create, {
          input: {
            model: 'session',
            data: { userId: user!._id, token: 'tok', expiresAt: Date.now() + 3_600_000, createdAt: Date.now(), updatedAt: Date.now() },
          },
        } as never)) as { _id: string }
      )._id,
  );
  return t.withIdentity({ subject: user!._id, sessionId });
};

describe('setup.state', () => {
  test('before an admin exists, and after: the step only for an admin session', async () => {
    expect(await t.query(api.api.setup.state, {})).toEqual({ adminExists: false });
    expect(await createAdmin()).toEqual({ ok: true });
    expect(await t.query(api.api.setup.state, {})).toEqual({ adminExists: true });
    expect(await (await signedIn()).query(api.api.setup.state, {})).toEqual({ adminExists: true, step: 'address' });
  });
});

describe('setup.createAdmin', () => {
  test("creates the admin, the libraries with web-1080p, the language and Jellyfin's setup in one go", async () => {
    expect(await createAdmin({ email: 'leon@example.net' })).toEqual({ ok: true });
    const [user] = (await users()).page;
    expect(user).toMatchObject({ username: 'leon', role: 'admin', email: 'leon@example.net' });
    const accounts = (await t.run((ctx) =>
      ctx.runQuery(components.betterAuth.adapter.findMany, { model: 'account', paginationOpts: { numItems: 10, cursor: null } } as never),
    )) as { page: { accountId: string; providerId: string; password: string }[] };
    expect(accounts.page).toEqual([expect.objectContaining({ accountId: user!._id, providerId: 'credential' })]);
    expect(accounts.page[0]!.password).not.toContain(request.password);

    expect(await settings()).toMatchObject({ adminUserId: user!._id, firstRun: { step: 'address' } });
    const { libraries, profile, language, jobs, server } = await t.run(async (ctx) => ({
      libraries: await ctx.db.query('libraries').collect(),
      profile: (await ctx.db.query('releaseProfiles').collect()).find((row) => row.shippedKey === 'web-1080p')!,
      language: (await ctx.db.query('metadataSettings').first())?.language,
      jobs: await ctx.db.query('jobs').collect(),
      server: await ctx.db.query('jellyfinServer').first(),
    }));
    expect(libraries.map(({ kind, name, rootPath, defaultReleaseProfileId }) => ({ kind, name, rootPath, defaultReleaseProfileId }))).toEqual([
      { kind: 'series', name: 'Series', rootPath: '/data/library/series', defaultReleaseProfileId: profile._id },
      { kind: 'movies', name: 'Movies', rootPath: '/data/library/movies', defaultReleaseProfileId: profile._id },
    ]);
    expect(libraries[0]!.playbackProfileId).toBe(libraries[1]!.playbackProfileId);
    expect(language).toBe('de-DE');
    expect(server).toMatchObject({ state: 'settingUp', ownerUserId: user!._id, locale: { uiCulture: 'de-DE' } });
    expect(jobs).toHaveLength(1);
    expect(jobs[0]!.payload).toMatchObject({
      action: 'setupJellyfin',
      mode: 'firstRun',
      admin: { username: 'leon', password: request.password },
      libraries: expect.any(Array),
    });
  });

  test('without an email, the synthetic one', async () => {
    await createAdmin();
    expect((await users()).page[0]!.email).toBe('leon@users.invalid');
  });

  test.each([
    [{ username: 'ab' }, 'invalidUsername'],
    [{ username: 'has space' }, 'invalidUsername'],
    [{ username: 'x'.repeat(31) }, 'invalidUsername'],
    [{ password: 'short' }, 'weakPassword'],
    [{ setupPassword: 'wrong' }, 'wrongSetupPassword'],
  ] as const)('%o is refused with %s, and no account is created', async (overrides, error) => {
    expect(await createAdmin(overrides)).toEqual({ error });
    expect((await users()).page).toEqual([]);
    expect((await settings())?.adminUserId).toBeUndefined();
  });

  test('once an admin exists: adminExists, even with the right setup password', async () => {
    await createAdmin();
    expect(await createAdmin({ username: 'other' })).toEqual({ error: 'adminExists' });
    expect((await users()).page).toHaveLength(1);
  });

  test('two concurrent calls create one admin', async () => {
    const results = await Promise.all([createAdmin(), createAdmin({ username: 'other' })]);
    expect(results).toContainEqual({ ok: true });
    expect(results).toContainEqual({ error: 'adminExists' });
    expect((await users()).page).toHaveLength(1);
  });

  test('five wrong passwords lock it for 15 minutes, then the right one works', async () => {
    vi.useFakeTimers();
    for (let i = 0; i < 5; i++) expect(await createAdmin({ setupPassword: 'wrong' })).toEqual({ error: 'wrongSetupPassword' });
    const locked = await createAdmin();
    expect(locked).toEqual({ error: 'locked', until: expect.any(Number) });
    expect((locked as { until: number }).until - Date.now()).toBeGreaterThan(14 * 60_000);
    expect((locked as { until: number }).until - Date.now()).toBeLessThanOrEqual(15 * 60_000 + 1_000);
    vi.advanceTimersByTime(15 * 60_000 + 1_000);
    expect(await createAdmin()).toEqual({ ok: true });
  });
});

describe('setup.advance and setup.saveLanguage', () => {
  test('advance moves forward only; done sets completedAt', async () => {
    await createAdmin();
    const admin = await signedIn();
    await admin.mutation(api.api.setup.advance, { step: 'usenet' });
    await admin.mutation(api.api.setup.advance, { step: 'indexer' });
    expect((await settings())?.firstRun).toEqual({ step: 'usenet' });
    await admin.mutation(api.api.setup.advance, { step: 'done' });
    expect((await settings())?.firstRun).toEqual({ step: 'done', completedAt: expect.any(Number) });
  });

  test('saveLanguage writes metadataSettings.language', async () => {
    await createAdmin();
    await (await signedIn()).mutation(api.api.setup.saveLanguage, { language: 'fr-FR' });
    expect(await t.run(async (ctx) => (await ctx.db.query('metadataSettings').first())?.language)).toBe('fr-FR');
  });

  test('both need an admin session', async () => {
    await expect(t.mutation(api.api.setup.advance, { step: 'done' })).rejects.toThrow(/unauthorized/);
    await expect(t.mutation(api.api.setup.saveLanguage, { language: 'fr-FR' })).rejects.toThrow(/unauthorized/);
  });
});
