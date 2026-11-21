// The definition catalogue: the worker's sync writes it in
// batches (`upsertBatch`) and ends with `finishSync`; the picker lists it;
// "Check for definition updates" and the daily cron enqueue the sync.
import {
  Ack,
  capsFromMeta,
  DefinitionMeta,
  DefinitionSupport,
  DefinitionSyncStatus,
  DefinitionType,
  FinishDefinitionSyncRequest,
  FinishDefinitionSyncResponse,
  SiteDefinitionDetail,
  SiteDefinitionRow,
  UpsertDefinitionsRequest,
} from '@omnarr/contracts';
import { zodToConvex } from 'convex-helpers/server/zod4';
import { v } from 'convex/values';
import { z } from 'zod';

import type { Doc } from '../_generated/dataModel';
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from '../_generated/server';
import { enqueueJob } from '../jobs/queue';
import { adminMutation, adminQuery, workerMutation } from '../lib/functions';
import { leaseForSync } from './lease';

const DAY_MS = 86_400_000;

export const definitionRow = (ctx: QueryCtx, definitionId: string) =>
  ctx.db
    .query('siteDefinitions')
    .withIndex('by_definition_id', (q) => q.eq('definitionId', definitionId))
    .unique();

const fileRow = (ctx: QueryCtx, definitionId: string) =>
  ctx.db
    .query('siteDefinitionFiles')
    .withIndex('by_definition_id', (q) => q.eq('definitionId', definitionId))
    .unique();

/** A definition's file text, for the worker's engine. A row from before migration 0005 still holds it itself. */
export async function definitionYaml(ctx: QueryCtx, row: Doc<'siteDefinitions'>): Promise<string> {
  const yaml = (await fileRow(ctx, row.definitionId))?.yaml ?? row.yaml;
  if (yaml === undefined) throw new Error(`definition file missing: ${row.definitionId}`);
  return yaml;
}

/** Stores a definition's file text beside its catalogue row (the catalogue doesn't read it). */
export async function writeDefinitionYaml(ctx: MutationCtx, definitionId: string, yaml: string): Promise<void> {
  const existing = await fileRow(ctx, definitionId);
  if (!existing) await ctx.db.insert('siteDefinitionFiles', { definitionId, yaml });
  else if (existing.yaml !== yaml) await ctx.db.patch(existing._id, { yaml });
}

async function deleteDefinition(ctx: MutationCtx, row: Doc<'siteDefinitions'>): Promise<void> {
  const file = await fileRow(ctx, row.definitionId);
  if (file) await ctx.db.delete(file._id);
  await ctx.db.delete(row._id);
}

/** A new file's caps, name and request delay reach the indexers that use it: caps are built at create and at each sync. */
async function refreshIndexers(ctx: MutationCtx, definitionId: string, meta: DefinitionMeta): Promise<void> {
  for (const indexer of await ctx.db.query('indexers').collect()) {
    if (indexer.site?.definitionId !== definitionId) continue;
    const { requestDelayMs: _old, ...site } = indexer.site;
    await ctx.db.patch(indexer._id, {
      caps: capsFromMeta(meta, Date.now()),
      site: { ...site, definitionName: meta.name, ...(meta.requestDelay ? { requestDelayMs: Math.round(meta.requestDelay * 1000) } : {}) },
    });
  }
}

export const upsertBatch = workerMutation({
  args: UpsertDefinitionsRequest.shape,
  returns: Ack,
  handler: async (ctx, { jobId, leaseEpoch, syncedAt, rows }) => {
    await leaseForSync(ctx, { jobId, leaseEpoch });
    for (const { yaml, ...row } of rows) {
      const existing = await definitionRow(ctx, row.definitionId);
      const fields = { ...row, supported: row.support.ok, syncedAt };
      if (!existing) {
        await ctx.db.insert('siteDefinitions', fields);
        await writeDefinitionYaml(ctx, row.definitionId, yaml);
        continue;
      }
      if (existing.sha256 === row.sha256) continue;
      // A newer file that fails the check doesn't replace one that passes.
      if (existing.supported && !row.support.ok) {
        if (existing.pendingUpdate?.sha256 !== row.sha256)
          await ctx.db.patch(existing._id, {
            pendingUpdate: { sha256: row.sha256, reason: row.support.reason, ...(row.support.detail ? { detail: row.support.detail } : {}) },
            syncedAt,
          });
        continue;
      }
      await ctx.db.replace(existing._id, { ...fields, ...(existing.removedUpstream ? { removedUpstream: true } : {}) });
      await writeDefinitionYaml(ctx, row.definitionId, yaml);
      if (row.meta && row.support.ok) await refreshIndexers(ctx, row.definitionId, row.meta);
    }
    return null;
  },
});

async function counts(ctx: QueryCtx) {
  const rows = await ctx.db.query('siteDefinitions').collect();
  return {
    supported: rows.filter((row) => row.supported).length,
    unsupported: rows.filter((row) => !row.supported).length,
    pending: rows.filter((row) => row.pendingUpdate).length,
  };
}

async function inUse(ctx: QueryCtx): Promise<Set<string>> {
  const indexers = await ctx.db.query('indexers').collect();
  return new Set(indexers.flatMap((indexer) => (indexer.site ? [indexer.site.definitionId] : [])));
}

export const finishSync = workerMutation({
  args: FinishDefinitionSyncRequest.shape,
  returns: FinishDefinitionSyncResponse,
  handler: async (ctx, { jobId, leaseEpoch, status, seenIds }) => {
    await leaseForSync(ctx, { jobId, leaseEpoch });
    if (status.ok && seenIds) {
      const seen = new Set(seenIds);
      const used = await inUse(ctx);
      for (const row of await ctx.db.query('siteDefinitions').collect()) {
        if (seen.has(row.definitionId)) {
          if (row.removedUpstream) await ctx.db.patch(row._id, { removedUpstream: undefined });
        } else if (used.has(row.definitionId)) {
          if (!row.removedUpstream) await ctx.db.patch(row._id, { removedUpstream: true });
        } else await deleteDefinition(ctx, row);
      }
    }
    const total = await counts(ctx);
    const current = await ctx.db.query('definitionSync').first();
    const record = { ...status, ...total };
    if (current) await ctx.db.replace(current._id, record);
    else await ctx.db.insert('definitionSync', record);
    return total;
  },
});

/** The System page's definitions card: the last sync, or null before the first. */
export const status = adminQuery({
  args: {},
  returns: DefinitionSyncStatus.nullable(),
  handler: async (ctx) => {
    const row = await ctx.db.query('definitionSync').first();
    if (!row) return null;
    const { _id, _creationTime, ...rest } = row;
    return rest;
  },
});

const toRow = (row: Doc<'siteDefinitions'>): SiteDefinitionRow => ({
  definitionId: row.definitionId,
  source: row.source,
  name: row.meta?.name ?? row.definitionId,
  ...(row.meta?.description ? { description: row.meta.description } : {}),
  type: row.meta?.type ?? 'private',
  ...(row.meta?.language ? { language: row.meta.language } : {}),
  support: row.support,
  ...(row.pendingUpdate ? { pendingUpdate: row.pendingUpdate } : {}),
  ...(row.removedUpstream ? { removedUpstream: true } : {}),
});

/** Every definition for the picker, by name; unsupported ones with their reason. It reads no file. */
export async function catalogue(ctx: QueryCtx, { search, type }: { search?: string; type?: DefinitionType }): Promise<SiteDefinitionRow[]> {
  const needle = search?.trim().toLowerCase();
  return (await ctx.db.query('siteDefinitions').collect())
    .map(toRow)
    .filter((row) => (!type || row.type === type) && (!needle || row.name.toLowerCase().includes(needle) || row.definitionId.includes(needle)))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** One definition with its links and settings, for the form. */
export async function definitionDetail(ctx: QueryCtx, definitionId: string): Promise<SiteDefinitionDetail | null> {
  const row = await definitionRow(ctx, definitionId);
  if (!row?.meta) return null;
  return { ...toRow(row), meta: row.meta };
}

export const list = adminQuery({
  args: { search: z.string().optional(), type: DefinitionType.optional() },
  returns: z.array(SiteDefinitionRow),
  handler: (ctx, args) => catalogue(ctx, args),
});

export const get = adminQuery({
  args: { definitionId: z.string() },
  returns: SiteDefinitionDetail.nullable(),
  handler: (ctx, { definitionId }) => definitionDetail(ctx, definitionId),
});

/** A definition's support and metadata, for the indexer API's actions. */
export const forAction = internalQuery({
  args: { definitionId: v.string() },
  returns: v.union(v.null(), v.object({ support: zodToConvex(DefinitionSupport), meta: v.optional(zodToConvex(DefinitionMeta)) })),
  handler: async (ctx, { definitionId }) => {
    const row = await definitionRow(ctx, definitionId);
    return row ? { support: row.support, ...(row.meta ? { meta: row.meta } : {}) } : null;
  },
});

const enqueueSync = (ctx: MutationCtx, idempotencyKey: string) =>
  enqueueJob(ctx, { payload: { class: 'maintenance', action: 'syncDefinitions' }, idempotencyKey });

/** "Check for definition updates": a sync with its own key, numbered. */
export const syncNow = adminMutation({
  args: {},
  returns: Ack,
  handler: async (ctx) => {
    const manual = await ctx.db
      .query('jobs')
      .withIndex('by_idempotency_key', (q) => q.gte('idempotencyKey', 'syncDefinitions:manual:').lt('idempotencyKey', 'syncDefinitions:manual;'))
      .collect();
    await enqueueSync(ctx, `syncDefinitions:manual:${manual.length}`);
    return null;
  },
});

const dated = (now: number) => `syncDefinitions:${new Date(now).toISOString().slice(0, 10)}`;

/** The daily cron's sync, one per UTC date. */
export const dailySync = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    await enqueueSync(ctx, dated(Date.now()));
    return null;
  },
});

/**
 * At each worker connect: the dated sync when the last one failed, is older
 * than 24 h, or there was none. The dated key keeps it to one a day.
 */
export const syncIfStale = internalMutation({
  args: {},
  returns: v.null(),
  handler: async (ctx) => {
    const last = await ctx.db.query('definitionSync').first();
    const now = Date.now();
    if (!(last?.ok && now - last.at <= DAY_MS)) await enqueueSync(ctx, dated(now));
    return null;
  },
});
