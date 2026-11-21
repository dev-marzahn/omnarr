// The admin account: first run's `createAdminRecord`, which does
// all of admin creation in one transaction, and the reset command's action.
import { CreateAdminResult } from '@omnarr/contracts';
import { hashPassword } from 'better-auth/crypto';
import { zodToConvex } from 'convex-helpers/server/zod4';
import { v } from 'convex/values';

import { components, internal } from '../_generated/api';
import { internalAction, internalMutation } from '../_generated/server';
import { syntheticEmail } from '../auth';
import { startJellyfinSetup } from '../jellyfin/setup';
import { enqueuePasswordPushJob } from '../jobs/queue';
import { constantTimeEqual } from '../lib/functions';
import { limits } from '../lib/limits';
import { ensureSettings } from '../metadata/keys';
import { ensureSettingsRow, settingsRow } from './settings';

type Created = { _id: string };

/**
 * The rest of `setup.createAdmin` after its checks: the
 * lockout and the setup-password check, the user and its credential (the rows
 * Better Auth's own admin `createUser` writes), the settings, the two
 * libraries, the language and the Jellyfin setup. Refusals are values, so a wrong
 * password's count commits.
 */
export const createAdminRecord = internalMutation({
  args: {
    setupPasswordHash: v.string(),
    username: v.string(),
    email: v.optional(v.string()),
    passwordHash: v.string(),
    password: v.string(),
    locale: v.string(),
  },
  returns: zodToConvex(CreateAdminResult),
  handler: async (ctx, { setupPasswordHash, username, email, passwordHash, password, locale }) => {
    const row = await ensureSettingsRow(ctx);
    if (row.adminUserId) return { error: 'adminExists' as const };
    const now = Date.now();
    const failures = row.setupPasswordFailures;
    if (failures?.lockedUntil && failures.lockedUntil > now) return { error: 'locked' as const, until: failures.lockedUntil };
    if (!constantTimeEqual(setupPasswordHash, process.env.SETUP_PASSWORD_HASH ?? '')) {
      const count = (failures?.lockedUntil ? 0 : (failures?.count ?? 0)) + 1;
      const locked = count >= limits().setupPasswordAttempts;
      await ctx.db.patch(row._id, { setupPasswordFailures: locked ? { count: 0, lockedUntil: now + limits().setupLockMs } : { count } });
      return { error: 'wrongSetupPassword' as const };
    }

    const name = username.toLowerCase();
    const user = (await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: 'user',
        data: {
          name,
          username: name,
          displayUsername: username,
          email: email || syntheticEmail(name),
          emailVerified: false,
          role: 'admin',
          createdAt: now,
          updatedAt: now,
        },
      },
    } as never)) as Created;
    await ctx.runMutation(components.betterAuth.adapter.create, {
      input: {
        model: 'account',
        data: { accountId: user._id, providerId: 'credential', userId: user._id, password: passwordHash, createdAt: now, updatedAt: now },
      },
    } as never);
    await ctx.db.patch(row._id, { adminUserId: user._id, firstRun: { step: 'address' }, setupPasswordFailures: undefined });

    // One playback profile row for both, which setupDefaults splits later in the first run.
    const profile = (await ctx.db.query('releaseProfiles').collect()).find((candidate) => candidate.shippedKey === 'web-1080p');
    if (!profile) throw new Error("createAdmin: the web-1080p profile is missing; the backend's reference seeds haven't run");
    const playbackProfileId = await ctx.db.insert('playbackProfiles', { name: 'Series' });
    for (const [kind, label] of [
      ['series', 'Series'],
      ['movies', 'Movies'],
    ] as const)
      await ctx.db.insert('libraries', { kind, name: label, rootPath: `/data/library/${kind}`, playbackProfileId, defaultReleaseProfileId: profile._id });

    const metadata = await ensureSettings(ctx);
    await ctx.db.patch(metadata._id, { language: locale });
    // After the libraries, which its payload lists.
    await startJellyfinSetup(ctx, { username: name, password, locale, userId: user._id });
    return { ok: true as const };
  },
});

/** The reset's writes: the credential, every session, and the Jellyfin push, as the change hook does. */
export const applyPasswordReset = internalMutation({
  args: { passwordHash: v.string(), password: v.string() },
  returns: v.null(),
  handler: async (ctx, { passwordHash, password }) => {
    const adminUserId = (await settingsRow(ctx))?.adminUserId;
    if (!adminUserId) throw new Error('No admin exists yet: create it in the web app first.');
    const updated = await ctx.runMutation(components.betterAuth.adapter.updateOne, {
      input: {
        model: 'account',
        where: [
          { field: 'userId', value: adminUserId },
          { field: 'providerId', value: 'credential' },
        ],
        update: { password: passwordHash, updatedAt: Date.now() },
      },
    } as never);
    if (!updated) throw new Error('The admin has no password credential.');
    await ctx.runMutation(components.betterAuth.adapter.deleteMany, {
      input: { model: 'session', where: [{ field: 'userId', value: adminUserId }] },
      paginationOpts: { numItems: 1000, cursor: null },
    } as never);
    const user = (await ctx.runQuery(components.betterAuth.adapter.findOne, { model: 'user', where: [{ field: '_id', value: adminUserId }] } as never)) as {
      username?: string;
    } | null;
    if (user?.username) await enqueuePasswordPushJob(ctx, { userId: adminUserId, username: user.username, newPassword: password });
    return null;
  },
});

/** `reset-admin-password`'s call, with the admin key only. */
export const resetAdminPassword = internalAction({
  args: { password: v.string() },
  returns: v.null(),
  handler: async (ctx, { password }) => {
    await ctx.runMutation(internal.setup.admin.applyPasswordReset, { passwordHash: await hashPassword(password), password });
    return null;
  },
});
