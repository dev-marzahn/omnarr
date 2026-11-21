// Better Auth through the locally installed component.
import { createClient, type GenericCtx } from '@convex-dev/better-auth';
import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { createAuthMiddleware } from 'better-auth/api';

import { components, internal } from './_generated/api';
import type { DataModel } from './_generated/dataModel';
import { baseAuthOptions } from './authOptions';
import authSchema from './betterAuth/schema';

export const authComponent = createClient<DataModel, typeof authSchema>(components.betterAuth, {
  local: { schema: authSchema },
});

/**
 * The address an account gets when it has no email: Better Auth requires one,
 * sign-in is by username, and the `.invalid` TLD can't receive mail. Never
 * shown in the UI. For the first-run admin creation.
 */
export const syntheticEmail = (username: string): string => `${username.toLowerCase()}@users.invalid`;

export const createAuthOptions = (ctx: GenericCtx<DataModel>) =>
  ({
    ...baseAuthOptions(),
    database: authComponent.adapter(ctx),
    hooks: {
      // A password change signs out every other omnarr session, whatever the client sends.
      before: createAuthMiddleware(async (hook) => {
        if (hook.path !== '/change-password' || !hook.body || typeof hook.body !== 'object') return;
        // Set on the parsed body itself: a returned context's body doesn't reach the endpoint here.
        (hook.body as { revokeOtherSessions?: boolean }).revokeOtherSessions = true;
      }),
      // The Jellyfin admin shares the platform admin's password, so a change
      // is pushed to Jellyfin by a maintenance job. The plaintext
      // lives only in that job's payload, which is cleared when the job ends.
      after: createAuthMiddleware(async (hook) => {
        if (hook.path !== '/change-password') return;
        const session = hook.context.newSession ?? hook.context.session;
        const newPassword: unknown = hook.body?.newPassword;
        const user = session?.user as { id: string; username?: string | null } | undefined;
        if (!user?.username || typeof newPassword !== 'string' || !('runMutation' in ctx)) return;
        await ctx.runMutation(internal.jobs.queue.enqueuePasswordPush, { userId: user.id, username: user.username, newPassword });
      }),
    },
  }) satisfies BetterAuthOptions;

export const createAuth = (ctx: GenericCtx<DataModel>) => betterAuth(createAuthOptions(ctx));
