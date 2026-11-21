// `reset-admin-password`'s action: the credential
// changes, every session ends, and the Jellyfin push is enqueued.
import { createHash } from 'node:crypto';

import { verifyPassword } from 'better-auth/crypto';
import { beforeEach, expect, test } from 'vite-plus/test';

import { api, components, internal } from '../convex/_generated/api';
import { setup, shippedProfile, type Backend } from './setup';

let t: Backend;
beforeEach(async () => {
  process.env.SETUP_PASSWORD_HASH = createHash('sha256').update('setup-pw').digest('hex');
  t = setup();
  await t.run((ctx) => ctx.db.insert('releaseProfiles', shippedProfile()));
  await t.action(api.api.setup.createAdmin, { setupPassword: 'setup-pw', username: 'leon', password: 'the-old-password', locale: 'en-US' });
});

const all = (model: string) =>
  t.run(
    async (ctx) =>
      (
        (await ctx.runQuery(components.betterAuth.adapter.findMany, { model, paginationOpts: { numItems: 100, cursor: null } } as never)) as {
          page: Record<string, unknown>[];
        }
      ).page,
  );

test('the credential gets the new password, every session is deleted, and a push is enqueued', async () => {
  const [user] = await all('user');
  for (const token of ['a', 'b'])
    await t.run((ctx) =>
      ctx.runMutation(components.betterAuth.adapter.create, {
        input: { model: 'session', data: { userId: user!._id, token, expiresAt: Date.now() + 3_600_000, createdAt: Date.now(), updatedAt: Date.now() } },
      } as never),
    );

  await t.action(internal.setup.admin.resetAdminPassword, { password: 'the-new-password' });

  const [account] = await all('account');
  expect(await verifyPassword({ hash: account!.password as string, password: 'the-new-password' })).toBe(true);
  expect(await all('session')).toEqual([]);
  const pushes = await t.run(async (ctx) =>
    (await ctx.db.query('jobs').collect()).filter((job) => job.payload?.class === 'maintenance' && job.payload.action === 'pushJellyfinPassword'),
  );
  expect(pushes.map((job) => job.payload)).toEqual([
    { class: 'maintenance', action: 'pushJellyfinPassword', username: 'leon', newPassword: 'the-new-password' },
  ]);
});
