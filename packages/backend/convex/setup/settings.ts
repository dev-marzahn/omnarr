// The one `settings` row: first run's step, the admin, and the
// setup-password failures.
import { FirstRunStep } from '@omnarr/contracts';
import { v } from 'convex/values';

import type { Doc } from '../_generated/dataModel';
import { internalQuery, type MutationCtx, type QueryCtx } from '../_generated/server';

export const settingsRow = (ctx: QueryCtx): Promise<Doc<'settings'> | null> => ctx.db.query('settings').first();

/** The row, inserted at the first step when missing. */
export async function ensureSettingsRow(ctx: MutationCtx): Promise<Doc<'settings'>> {
  const row = await settingsRow(ctx);
  if (row) return row;
  return (await ctx.db.get(await ctx.db.insert('settings', { firstRun: { step: 'account' } })))!;
}

/** Whether a step comes after another in first run's order. */
export const isLater = (step: FirstRunStep, than: FirstRunStep) => FirstRunStep.options.indexOf(step) > FirstRunStep.options.indexOf(than);

/** For `setupAction`, which runs before any session exists. */
export const adminExists = internalQuery({
  args: {},
  returns: v.boolean(),
  handler: async (ctx) => Boolean((await settingsRow(ctx))?.adminUserId),
});
