// The indexer functions. `test`, `create` and `update` are
// admin actions because they call the indexer; a new or changed URL or key
// must pass the test before it is saved. No DTO carries `apiKey`.
import {
  Ack,
  IndexerCreateInput,
  IndexerCreateSiteInput,
  IndexerDetail,
  IndexerPatch,
  IndexerRow,
  IndexerTestInput,
  IndexerTestResult,
  IndexerTestSiteInput,
  capsFromMeta,
  indexerFailureCode,
  type DefinitionMeta,
  type IndexerCall,
  type IndexerCaps,
  type IndexerKind,
  type SiteSettings,
} from '@omnarr/contracts';
import { zid } from 'convex-helpers/server/zod4';
import { ConvexError } from 'convex/values';
import { z } from 'zod';

import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import type { ActionCtx } from '../_generated/server';
import { defaultCategories, normalizeApiUrl } from '../indexers/caps';
import { type ConnectionTest, testConnection, testSiteConnection } from '../indexers/connection';
import { toRow } from '../indexers/dto';
import { TEST_TIMEOUT_MS } from '../indexers/http';
import { createNyaaAdapter, NYAA_CATEGORIES, nyaaBaseUrl, nyaaCaps } from '../indexers/nyaa';
import { deletePacing, MAX_PACING_WAIT_MS, paced, pacedSite, pacingIntervalOf } from '../indexers/pacing';
import { relayTest } from '../indexers/relay';
import { detailOf } from '../indexers/store';
import { adminAction, adminMutation, adminQuery } from '../lib/functions';
import { siteValues } from '../sites/siteInput';

/** The test's answer for a URL that isn't http or https: no indexer API there. */
function notAnApi(url: string): ConnectionTest {
  let at = { host: url, path: '' };
  try {
    const parsed = new URL(url);
    at = { host: parsed.host, path: parsed.pathname };
  } catch {
    // Not a URL at all: the host is what was typed.
  }
  return { result: { ok: false, searchModes: [], categories: [], latencyMs: 0, failure: { kind: 'notAnIndexerApi', ...at } }, calls: [] };
}

async function runTest(url: string, apiKey: string): Promise<ConnectionTest & { apiUrl?: string }> {
  const apiUrl = normalizeApiUrl(url);
  if (!apiUrl) return notAnApi(url);
  return { ...(await testConnection({ apiUrl, apiKey })), apiUrl };
}

/** A failed test, as the error the form shows: the kind, host and path, never the URL or key. */
const testFailed = (test: ConnectionTest) =>
  new ConvexError({ code: 'testFailed', ...test.result.failure, ...(test.result.skipped ? { skipped: test.result.skipped } : {}) });

/** The stored indexer's URL and key, for a test of a stored indexer. */
async function stored(ctx: ActionCtx, indexerId: Doc<'indexers'>['_id']) {
  const indexer = await ctx.runQuery(internal.indexers.store.getForAction, { indexerId });
  if (!indexer) throw new ConvexError({ code: 'notFound' });
  return indexer;
}

/** Nyaa's test: one feed request at `apiUrl`, paced by `pace`, with the test's timeout. */
const nyaaTest = (apiUrl: string, pace: () => Promise<'go' | 'skip'>) =>
  testSiteConnection(createNyaaAdapter({ apiUrl }, { pace, timeoutMs: TEST_TIMEOUT_MS }), nyaaCaps(Date.now()), 'nyaa');

/** A site indexer's URL and key are fixed: only name, categories, priority, interval and limit change. */
const notEditable = () => new ConvexError({ code: 'notEditable' });

/** A definition site's id, which the flat input leaves optional. */
function definitionIdOf(input: { definitionId?: string }): string {
  if (!input.definitionId) throw new ConvexError({ code: 'definitionRequired' });
  return input.definitionId;
}

/** Nyaa takes no definition fields: it has no link or settings to choose. */
function nyaaOnly(input: { definitionId?: string; baseUrl?: string; settings?: SiteSettings }): void {
  if (input.definitionId !== undefined || input.baseUrl !== undefined || input.settings !== undefined) throw notEditable();
}

/** A supported definition's metadata, or the refusal. */
async function supportedDefinition(ctx: ActionCtx, definitionId: string): Promise<DefinitionMeta> {
  const definition = await ctx.runQuery(internal.sites.definitions.forAction, { definitionId });
  if (!definition?.meta) throw new ConvexError({ code: 'notFound' });
  if (!definition.support.ok) throw new ConvexError({ code: 'definitionUnsupported', reason: definition.support.reason });
  return definition.meta;
}

/** A definition's series and movie categories: the ones it maps, so one that maps only TV/Anime is anime-only. */
const definitionCategories = (meta: DefinitionMeta) => ({
  series: meta.categories.filter((id) => id >= 5000 && id < 6000),
  movies: meta.categories.filter((id) => id >= 2000 && id < 3000),
});

/** The test's request as the call `usage` counts; a paced test sent nothing. */
const testCalls = (result: IndexerTestResult): IndexerCall[] =>
  result.skipped
    ? []
    : [
        {
          at: Date.now(),
          ok: result.ok,
          latencyMs: result.latencyMs,
          kind: 'test',
          ...(result.failure ? { failure: { ...result.failure, code: indexerFailureCode(result.failure.kind) } } : {}),
        },
      ];

/** A definition's test of the form's values, in the worker. */
async function draftTest(ctx: ActionCtx, definitionId: string, values: { baseUrl: string; settings: SiteSettings }, meta: DefinitionMeta) {
  return await relayTest(ctx, { class: 'indexer', action: 'testDraft', draft: { definitionId, ...values } }, values.baseUrl, capsFromMeta(meta, Date.now()));
}

export const test = adminAction({
  args: { input: IndexerTestInput },
  returns: IndexerTestResult,
  handler: async (ctx, { input }) => {
    if ('indexerId' in input) {
      const indexer = await stored(ctx, input.indexerId);
      if (indexer.kind === 'definition') {
        if (input.url !== undefined || input.apiKey !== undefined) throw notEditable();
        const result = await relayTest(ctx, { class: 'indexer', action: 'test', indexerId: input.indexerId }, indexer.apiUrl, indexer.caps);
        await ctx.runMutation(internal.indexers.store.recordCalls, { indexerId: input.indexerId, calls: testCalls(result) });
        return result;
      }
      if (indexer.kind === 'nyaa') {
        if (input.url !== undefined || input.apiKey !== undefined) throw notEditable();
        const test = await nyaaTest(indexer.apiUrl, () => paced(ctx, input.indexerId, pacingIntervalOf({ kind: 'nyaa' })!, MAX_PACING_WAIT_MS));
        await ctx.runMutation(internal.indexers.store.recordCalls, { indexerId: input.indexerId, calls: test.calls });
        if (test.result.ok && test.caps) await ctx.runMutation(internal.indexers.store.saveCaps, { indexerId: input.indexerId, caps: test.caps });
        return test.result;
      }
      const test = await runTest(input.url ?? indexer.apiUrl, input.apiKey ?? indexer.apiKey);
      // Unsaved values aren't the stored indexer: their test touches none of its state.
      const unsaved = (input.url !== undefined && test.apiUrl !== indexer.apiUrl) || (input.apiKey !== undefined && input.apiKey !== indexer.apiKey);
      if (unsaved) return test.result;
      // A stored indexer counts the test's requests; a passing test clears its rate limit.
      await ctx.runMutation(internal.indexers.store.recordCalls, { indexerId: input.indexerId, calls: test.calls });
      if (test.result.ok && test.caps) await ctx.runMutation(internal.indexers.store.saveCaps, { indexerId: input.indexerId, caps: test.caps });
      return test.result;
    }
    return (await runTest(input.url, input.apiKey)).result;
  },
});

/** The kind detection gave, else the one the form chose; refused when neither decides it. */
function kindOf(test: ConnectionTest, chosen: IndexerKind | undefined): IndexerKind {
  const kind = test.result.kind ?? chosen;
  if (!kind) throw new ConvexError({ code: 'kindRequired' });
  return kind;
}

export const create = adminAction({
  args: IndexerCreateInput.shape,
  returns: IndexerDetail,
  handler: async (ctx, input): Promise<IndexerDetail> => {
    const test = await runTest(input.url, input.apiKey);
    if (!test.result.ok || !test.caps || !test.apiUrl) throw testFailed(test);
    const caps: IndexerCaps = test.caps;
    const id = await ctx.runMutation(internal.indexers.store.insertIndexer, {
      name: input.name,
      kind: kindOf(test, input.kind),
      apiUrl: test.apiUrl,
      apiKey: input.apiKey,
      priority: input.priority ?? 25,
      categories: input.categories ?? defaultCategories(caps),
      caps,
      rssIntervalMinutes: input.rssIntervalMinutes ?? 15,
      apiLimit: input.apiLimitMax !== undefined ? { max: input.apiLimitMax, source: 'user' } : test.result.apiLimit,
    });
    await ctx.runMutation(internal.indexers.store.recordCalls, { indexerId: id, calls: test.calls });
    return (await ctx.runQuery(internal.indexers.store.detail, { indexerId: id }))!;
  },
});

/**
 * "Test connection" for a site not yet added. With a stored Nyaa,
 * its pacing slot is taken; without one, the site's own slot, which
 * `createSite` hands to the new indexer.
 */
export const testSite = adminAction({
  args: IndexerTestSiteInput.shape,
  returns: IndexerTestResult,
  handler: async (ctx, input): Promise<IndexerTestResult> => {
    if (input.kind === 'definition') {
      const definitionId = definitionIdOf(input);
      const meta = await supportedDefinition(ctx, definitionId);
      return await draftTest(ctx, definitionId, siteValues(meta, input), meta);
    }
    nyaaOnly(input);
    const existing: Id<'indexers'> | null = await ctx.runQuery(internal.indexers.store.siteIndexerId, { kind: input.kind });
    const intervalMs = pacingIntervalOf({ kind: 'nyaa' })!;
    return (await nyaaTest(nyaaBaseUrl(), () => (existing ? paced(ctx, existing, intervalMs, MAX_PACING_WAIT_MS) : pacedSite(ctx, 'nyaa', intervalMs)))).result;
  },
});

/**
 * Adds a definition indexer: a supported definition, one
 * of its links, valid settings and a passing test in the worker. Several
 * indexers may use one definition.
 */
async function createDefinitionIndexer(ctx: ActionCtx, input: IndexerCreateSiteInput): Promise<IndexerDetail> {
  const definitionId = definitionIdOf(input);
  const meta = await supportedDefinition(ctx, definitionId);
  const values = siteValues(meta, input);
  const result = await draftTest(ctx, definitionId, values, meta);
  if (!result.ok) throw new ConvexError({ code: 'testFailed', ...result.failure, ...(result.skipped ? { skipped: result.skipped } : {}) });
  const caps = capsFromMeta(meta, Date.now());
  const id = await ctx.runMutation(internal.indexers.store.insertIndexer, {
    name: input.name ?? meta.name,
    kind: 'definition',
    apiUrl: values.baseUrl,
    apiKey: '',
    priority: 25,
    categories: definitionCategories(meta),
    caps,
    rssIntervalMinutes: 15,
    site: {
      definitionId,
      ...values,
      definitionName: meta.name,
      ...(meta.requestDelay ? { requestDelayMs: Math.round(meta.requestDelay * 1000) } : {}),
    },
  });
  // The test's request was the site's last one: the next waits its interval.
  const indexer = await stored(ctx, id);
  await ctx.runMutation(internal.indexers.pacing.reserve, { indexerId: id, intervalMs: pacingIntervalOf(indexer)!, longestWaitMs: MAX_PACING_WAIT_MS });
  await ctx.runMutation(internal.indexers.store.recordCalls, { indexerId: id, calls: testCalls(result) });
  return (await ctx.runQuery(internal.indexers.store.detail, { indexerId: id }))!;
}

/** Adds Nyaa: no URL or key, the built caps and the anime defaults, after a passing test. One Nyaa at most. */
export const createSite = adminAction({
  args: IndexerCreateSiteInput.shape,
  returns: IndexerDetail,
  handler: async (ctx, input): Promise<IndexerDetail> => {
    if (input.kind === 'definition') return await createDefinitionIndexer(ctx, input);
    nyaaOnly(input);
    if (await ctx.runQuery(internal.indexers.store.siteIndexerId, { kind: input.kind })) throw new ConvexError({ code: 'alreadyExists' });
    const apiUrl = nyaaBaseUrl();
    // The save's test waits for the slot after a pre-save test's.
    const intervalMs = pacingIntervalOf({ kind: 'nyaa' })!;
    const test = await nyaaTest(apiUrl, () => pacedSite(ctx, 'nyaa', intervalMs));
    if (!test.result.ok || !test.caps) throw testFailed(test);
    const id = await ctx.runMutation(internal.indexers.store.insertIndexer, {
      name: input.name ?? 'Nyaa',
      kind: input.kind,
      apiUrl,
      apiKey: '',
      priority: 25,
      categories: NYAA_CATEGORIES,
      caps: test.caps,
      rssIntervalMinutes: 15,
    });
    // The test's request was the site's last one: the site's slot becomes the indexer's, so the next waits its interval.
    await ctx.runMutation(internal.indexers.pacing.adoptSite, { site: 'nyaa', indexerId: id, intervalMs });
    await ctx.runMutation(internal.indexers.store.recordCalls, { indexerId: id, calls: test.calls });
    return (await ctx.runQuery(internal.indexers.store.detail, { indexerId: id }))!;
  },
});

export const update = adminAction({
  args: { id: zid('indexers'), patch: IndexerPatch },
  returns: IndexerDetail,
  handler: async (ctx, { id, patch }): Promise<IndexerDetail> => {
    const current = await stored(ctx, id);
    if ((current.kind === 'nyaa' || current.kind === 'definition') && (patch.url !== undefined || patch.apiKey !== undefined)) throw notEditable();
    if (current.kind !== 'definition' && (patch.baseUrl !== undefined || patch.settings !== undefined)) throw notEditable();
    const url = patch.url === undefined ? undefined : normalizeApiUrl(patch.url);
    const changed = (patch.url !== undefined && url !== current.apiUrl) || (patch.apiKey !== undefined && patch.apiKey !== current.apiKey);
    const fields: Record<string, unknown> = {};
    if (current.site && (patch.baseUrl !== undefined || patch.settings !== undefined)) {
      // A new link or new settings must pass the test before they are saved, like a new URL or key.
      const meta = await supportedDefinition(ctx, current.site.definitionId);
      const values = siteValues(meta, patch, current.site);
      const result = await draftTest(ctx, current.site.definitionId, values, meta);
      await ctx.runMutation(internal.indexers.store.recordCalls, { indexerId: id, calls: testCalls(result) });
      if (!result.ok) throw new ConvexError({ code: 'testFailed', ...result.failure });
      Object.assign(fields, { apiUrl: values.baseUrl, site: { ...current.site, ...values } });
    }
    if (changed) {
      const test = await runTest(patch.url ?? current.apiUrl, patch.apiKey ?? current.apiKey);
      if (!test.result.ok || !test.caps || !test.apiUrl) throw testFailed(test);
      Object.assign(fields, { apiUrl: test.apiUrl, caps: test.caps, kind: kindOf(test, patch.kind ?? current.kind) });
      if (patch.apiKey !== undefined) fields.apiKey = patch.apiKey;
      await ctx.runMutation(internal.indexers.store.recordCalls, { indexerId: id, calls: test.calls });
    }
    if (patch.name !== undefined) fields.name = patch.name;
    if (patch.priority !== undefined) fields.priority = patch.priority;
    if (patch.categories !== undefined) fields.categories = patch.categories;
    if (patch.rssIntervalMinutes !== undefined) fields.rssIntervalMinutes = patch.rssIntervalMinutes;
    if (patch.apiLimitMax !== undefined) fields.apiLimit = { max: patch.apiLimitMax, source: 'user' };
    await ctx.runMutation(internal.indexers.store.patchIndexer, { indexerId: id, patch: fields as never });
    return (await ctx.runQuery(internal.indexers.store.detail, { indexerId: id }))!;
  },
});

export const list = adminQuery({
  args: {},
  returns: z.array(IndexerRow),
  handler: async (ctx) => {
    const now = Date.now();
    return (await ctx.db.query('indexers').collect()).map((indexer) => toRow(indexer, now));
  },
});

export const get = adminQuery({
  args: { id: zid('indexers') },
  returns: IndexerDetail.nullable(),
  handler: async (ctx, { id }) => {
    const indexer = await ctx.db.get(id);
    return indexer && (await detailOf(ctx, indexer));
  },
});

/** "Disable indexer". */
export const setEnabled = adminMutation({
  args: { id: zid('indexers'), enabled: z.boolean() },
  returns: Ack,
  handler: async (ctx, { id, enabled }) => {
    if (await ctx.db.get(id)) await ctx.db.patch(id, { enabled });
    return null;
  },
});

/** Deletes the indexer; its candidates stay, shown as from a removed indexer. A running action skips it once it no longer loads. */
export const remove = adminMutation({
  args: { id: zid('indexers') },
  returns: Ack,
  handler: async (ctx, { id }) => {
    if (await ctx.db.get(id)) await ctx.db.delete(id);
    await deletePacing(ctx, id);
    return null;
  },
});
