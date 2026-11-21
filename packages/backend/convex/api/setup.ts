// First run's public functions: `state` and `createAdmin` run before
// any account exists (setupQuery, setupAction); `advance` and `saveLanguage`
// need the admin's session.
import {
  AdvanceRequest,
  CreateAdminRequest,
  CreateAdminResult,
  MIN_PASSWORD_LENGTH,
  SaveLanguageRequest,
  SetupState,
  USERNAME_PATTERN,
} from '@omnarr/contracts';
import { hashPassword } from 'better-auth/crypto';
import { z } from 'zod';

import { internal } from '../_generated/api';
import { authComponent } from '../auth';
import { adminMutation, setupAction, setupQuery } from '../lib/functions';
import { ensureSettings } from '../metadata/keys';
import { ensureSettingsRow, isLater, settingsRow } from '../setup/settings';

export const state = setupQuery({
  args: {},
  returns: SetupState,
  handler: async (ctx): Promise<SetupState> => {
    const row = await settingsRow(ctx);
    if (!row?.adminUserId) return { adminExists: false };
    const user = await authComponent.safeGetAuthUser(ctx);
    return user?.role === 'admin' && !user.banned ? { adminExists: true, step: row.firstRun.step } : { adminExists: true };
  },
});

const sha256 = async (text: string) =>
  [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)))].map((byte) => byte.toString(16).padStart(2, '0')).join('');

export const createAdmin = setupAction({
  args: CreateAdminRequest.shape,
  returns: CreateAdminResult,
  handler: async (ctx, { setupPassword, username, email, password, locale }): Promise<CreateAdminResult> => {
    if (!USERNAME_PATTERN.test(username)) return { error: 'invalidUsername' };
    if (password.length < MIN_PASSWORD_LENGTH) return { error: 'weakPassword' };
    return await ctx.runMutation(internal.setup.admin.createAdminRecord, {
      setupPasswordHash: await sha256(setupPassword),
      username,
      ...(email ? { email } : {}),
      passwordHash: await hashPassword(password),
      password,
      locale,
    });
  },
});

export const advance = adminMutation({
  args: AdvanceRequest.shape,
  returns: z.null(),
  handler: async (ctx, { step }) => {
    const row = await ensureSettingsRow(ctx);
    if (isLater(step, row.firstRun.step)) await ctx.db.patch(row._id, { firstRun: step === 'done' ? { step, completedAt: Date.now() } : { step } });
    return null;
  },
});

/** First run's language: the metadata settings have no public writer for it. */
export const saveLanguage = adminMutation({
  args: SaveLanguageRequest.shape,
  returns: z.null(),
  handler: async (ctx, { language }) => {
    const settings = await ensureSettings(ctx);
    await ctx.db.patch(settings._id, { language });
    return null;
  },
});
