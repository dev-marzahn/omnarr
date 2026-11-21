// TMDB tokens and the health of the metadata sources. The user
// token lives only in `metadataSettings.userApiToken`, which no DTO returns.
import { MetadataSourceName } from '@omnarr/contracts';
import { zodToConvex, zodToConvexFields } from 'convex-helpers/server/zod4';
import { ConvexError } from 'convex/values';
import { z } from 'zod';

import { internal } from '../_generated/api';
import type { Doc } from '../_generated/dataModel';
import { internalMutation, internalQuery, type ActionCtx, type MutationCtx, type QueryCtx } from '../_generated/server';
import { raiseIssue, resolveSystemIssue } from '../lib/issues';
import { metadataProvider, type MetadataProvider } from './provider';

/** `metadataSettings.language` until the first-run setup writes the locale. */
export const DEFAULT_LANGUAGE = 'en-US';

const HOUR = 60 * 60 * 1000;
/** How long a source may fail with no success before `metadataSourceUnavailable` opens. */
export const UNAVAILABLE_AFTER: Record<MetadataSourceName, number> = {
  tmdb: 24 * HOUR,
  xem: 7 * 24 * HOUR,
  animeLists: 7 * 24 * HOUR,
  sceneMapping: 7 * 24 * HOUR,
};

export const settingsRow = (ctx: QueryCtx) => ctx.db.query('metadataSettings').first();

/** The one `metadataSettings` row, created with the defaults when missing. */
export async function ensureSettings(ctx: MutationCtx): Promise<Doc<'metadataSettings'>> {
  const row = await settingsRow(ctx);
  if (row) return row;
  const id = await ctx.db.insert('metadataSettings', { language: DEFAULT_LANGUAGE, sourceHealth: { tmdb: {}, xem: {}, animeLists: {}, sceneMapping: {} } });
  return (await ctx.db.get(id))!;
}

export const TokenChoice = z.object({ source: z.enum(['user', 'deployment']), token: z.string().optional(), language: z.string() });
export type TokenChoice = z.infer<typeof TokenChoice>;

/** The token every TMDB call uses: the user's when saved, else the deployment's `TMDB_API_TOKEN`. */
export const currentToken = internalQuery({
  args: {},
  returns: zodToConvex(TokenChoice),
  handler: async (ctx): Promise<TokenChoice> => {
    const settings = await settingsRow(ctx);
    const language = settings?.language ?? DEFAULT_LANGUAGE;
    if (settings?.userApiToken) return { source: 'user', token: settings.userApiToken, language };
    return { source: 'deployment', token: process.env.TMDB_API_TOKEN, language };
  },
});

/** Stores a token `checkKey` found valid; TMDB accepting it resolves `metadataKeyRejected`. */
export const saveUserToken = internalMutation({
  args: zodToConvexFields({ token: z.string() }),
  returns: zodToConvex(z.null()),
  handler: async (ctx, { token }) => {
    const settings = await ensureSettings(ctx);
    await ctx.db.patch(settings._id, { userApiToken: token, userTokenCheckedAt: Date.now() });
    await resolveSystemIssue(ctx, 'metadataKeyRejected');
    return null;
  },
});

/** Back to the deployment's token. */
export const clearUserToken = internalMutation({
  args: {},
  returns: zodToConvex(z.null()),
  handler: async (ctx) => {
    const settings = await settingsRow(ctx);
    if (settings?.userApiToken !== undefined) await ctx.db.patch(settings._id, { userApiToken: undefined, userTokenCheckedAt: undefined });
    return null;
  },
});

export const SOURCE_LABEL: Record<MetadataSourceName, string> = {
  tmdb: 'TMDB',
  xem: 'TheXEM',
  animeLists: 'Anime-Lists',
  sceneMapping: 'Sonarr scene mappings',
};

const REJECTED_DETAIL = {
  user: 'TMDB rejected your token. Enter a new one.',
  deployment: 'TMDB rejected the built-in token. Enter your own TMDB token.',
};

const HealthOutcome = z.object({
  source: MetadataSourceName,
  outcome: z.enum(['success', 'failure', 'rejected']),
  at: z.number(),
  tokenSource: z.enum(['user', 'deployment']).optional(),
});
export type HealthOutcome = z.infer<typeof HealthOutcome>;

/**
 * Records one outcome of a call to a source (`sourceHealth`), writing
 * only what changed. A source failing with no success for longer than
 * `UNAVAILABLE_AFTER` keeps `metadataSourceUnavailable` open; it resolves
 * once no source is. `rejected` (TMDB's 401) opens `metadataKeyRejected`,
 * worded for the token in use; a TMDB success resolves it.
 */
export async function recordHealthIn(ctx: MutationCtx, { source, outcome, at, tokenSource }: HealthOutcome): Promise<void> {
  const settings = await ensureSettings(ctx);
  const health = settings.sourceHealth[source] ?? {};
  const next = outcome === 'success' ? { lastSuccessAt: at } : outcome === 'failure' ? { ...health, firstFailureAt: health.firstFailureAt ?? at } : health;
  if (next.firstFailureAt !== health.firstFailureAt || next.lastSuccessAt !== health.lastSuccessAt)
    await ctx.db.patch(settings._id, { sourceHealth: { ...settings.sourceHealth, [source]: next } });

  if (source === 'tmdb' && outcome === 'success') await resolveSystemIssue(ctx, 'metadataKeyRejected');
  if (outcome === 'rejected') await raiseIssue(ctx, { code: 'metadataKeyRejected', detail: REJECTED_DETAIL[tokenSource ?? 'deployment'] });

  // One Issue for every source past its limit; it resolves once none is.
  const all = { ...settings.sourceHealth, [source]: next };
  const overdue = MetadataSourceName.options.filter((name) => {
    const since = all[name]?.firstFailureAt;
    return since !== undefined && at - since >= UNAVAILABLE_AFTER[name];
  });
  if (overdue.length)
    await raiseIssue(ctx, { code: 'metadataSourceUnavailable', detail: `Not reachable: ${overdue.map((name) => SOURCE_LABEL[name]).join(', ')}.` });
  else await resolveSystemIssue(ctx, 'metadataSourceUnavailable');
}

export const recordHealth = internalMutation({
  args: zodToConvexFields(HealthOutcome.shape),
  returns: zodToConvex(z.null()),
  handler: async (ctx, outcome) => {
    await recordHealthIn(ctx, outcome);
    return null;
  },
});

const codeOf = (error: unknown) => (error instanceof ConvexError ? (error.data as { code?: string }).code : undefined);

/**
 * Runs TMDB calls with the current token and language, and records
 * TMDB's health from the outcome. A 401 says which token TMDB rejected.
 */
export async function withProvider<T>(ctx: ActionCtx, run: (provider: MetadataProvider) => Promise<T>): Promise<T> {
  const { source, token, language } = await ctx.runQuery(internal.metadata.keys.currentToken, {});
  const record = (outcome: 'success' | 'failure' | 'rejected') =>
    ctx.runMutation(internal.metadata.keys.recordHealth, { source: 'tmdb', outcome, at: Date.now(), tokenSource: source });
  try {
    const result = await run(metadataProvider(token, language));
    await record('success');
    return result;
  } catch (error) {
    const code = codeOf(error);
    if (code === 'metadataKeyRejected') {
      await record('rejected');
      throw new ConvexError({ code, message: source === 'user' ? 'TMDB rejected your token.' : 'TMDB rejected the built-in token.' });
    }
    if (code === 'metadataUnavailable' || code === 'metadataBadResponse') await record('failure');
    throw error;
  }
}
