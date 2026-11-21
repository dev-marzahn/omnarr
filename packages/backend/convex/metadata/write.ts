// The write half of a sync: the one read the action makes,
// then batched writes of Units, mapping rows and the Work's own rows. Every
// write first checks that the Work still exists, so a sync racing a Work's
// deletion writes nothing.
import { AliasSource, MappingStatus, NumberingReason, NumberingScheme, Ordering, UnitKind } from '@omnarr/contracts';
import { compactTitle } from '@omnarr/parser';
import { zid, zodToConvex, zodToConvexFields } from 'convex-helpers/server/zod4';
import { z } from 'zod';

import type { Doc, Id } from '../_generated/dataModel';
import { internalMutation, internalQuery, type MutationCtx, type QueryCtx } from '../_generated/server';
import { recomputeUnits, stateOfNewUnit } from '../lib/derivedState';
import { appendEvent } from '../lib/events';
import { unitsRetitled } from '../library/naming';
import { AnimeListEntry } from '../mapping/animeListsParse';
import { chooseTvdbId } from '../mapping/project';
import { startSearch } from '../pipeline/search';
import { UnitMetadata } from './provider';

const UnitChange = z.object({ from: z.string(), to: z.string() });

/** A named TMDB season (`workMetadata.seasonNames`): its number, TMDB's name, the normalized name and its one scene season. */
const SeasonName = z.object({ season: z.number(), name: z.string(), normalized: z.string(), sceneSeason: z.number() });

/** What `snapshotInput` gives a sync: the Work, its Units with their TMDB episode IDs, manual rows and Anime-Lists entries. */
export const SnapshotInput = z.object({
  kind: z.enum(['series', 'movie']),
  tmdbId: z.string(),
  monitorNewUnits: z.boolean(),
  firstWrite: z.boolean(),
  /** The seasons ticked at subscribe, until the first write succeeds. */
  initialSeasons: z.array(z.number()).optional(),
  /** A Work the scan created from an existing folder, until its first write succeeds: nothing starts monitored. */
  fromFolder: z.boolean(),
  projectionVersion: z.number(),
  mappingStatus: MappingStatus.optional(),
  /** The named seasons the last sync stored; kept while XEM is down, as its rows are. */
  seasonNames: z.array(SeasonName).optional(),
  units: z.array(
    z.object({
      unitId: zid('units'),
      tmdbId: z.string().optional(),
      kind: UnitKind,
      tmdbSeason: z.number().optional(),
      tmdbEpisode: z.number().optional(),
      airDateUtc: z.number().optional(),
      monitored: z.boolean(),
      retired: z.boolean(),
    }),
  ),
  manualRows: z.array(
    z.object({ key: z.string(), ordering: Ordering, season: z.number().optional(), episode: z.number().optional(), absolute: z.number().optional() }),
  ),
  animeListEntries: z.array(AnimeListEntry),
  /** The Anime-Lists file hash the entries come from: their rows' `sourceVersion`. */
  animeListsVersion: z.string().optional(),
  /** The Work's one TVDB ID, and whether XEM's `havemap` lists it. */
  tvdbId: z.number().optional(),
  inXem: z.boolean(),
  /** Sonarr's scene-mapping names for that TVDB ID, as stored by the last good fetch. */
  sceneMappings: z.array(z.string()),
});
export type SnapshotInput = z.infer<typeof SnapshotInput>;

export const workMetadataOf = (ctx: QueryCtx, workId: Id<'works'>) =>
  ctx.db
    .query('workMetadata')
    .withIndex('by_work', (q) => q.eq('workId', workId))
    .unique();

const unitMetadataOf = (ctx: MutationCtx, unitId: Id<'units'>) =>
  ctx.db
    .query('unitMetadata')
    .withIndex('by_unit', (q) => q.eq('unitId', unitId))
    .unique();

/** The one read of a sync; null once the Work is gone. */
export const snapshotInput = internalQuery({
  args: { workId: zodToConvex(zid('works')), tmdbTvdbId: zodToConvex(z.number().optional()) },
  returns: zodToConvex(SnapshotInput.nullable()),
  handler: async (ctx, { workId, tmdbTvdbId }): Promise<SnapshotInput | null> => {
    const work = await ctx.db.get(workId);
    const metadata = await workMetadataOf(ctx, workId);
    if (!work || !metadata) return null;
    const workIds = await ctx.db
      .query('externalIds')
      .withIndex('by_work', (q) => q.eq('workId', workId))
      .collect();
    const tmdbId = workIds.find((row) => row.provider === 'tmdb')!.value;

    const units = await ctx.db
      .query('units')
      .withIndex('by_work', (q) => q.eq('workId', workId))
      .collect();
    const keys = new Map<Id<'units'>, string>();
    const existing: SnapshotInput['units'] = [];
    for (const unit of units) {
      const tmdb = await ctx.db
        .query('externalIds')
        .withIndex('by_unit', (q) => q.eq('unitId', unit._id))
        .filter((q) => q.eq(q.field('provider'), 'tmdb'))
        .first();
      const meta = await ctx.db
        .query('unitMetadata')
        .withIndex('by_unit', (q) => q.eq('unitId', unit._id))
        .unique();
      if (tmdb) keys.set(unit._id, tmdb.value);
      existing.push({
        unitId: unit._id,
        tmdbId: tmdb?.value,
        kind: unit.kind,
        tmdbSeason: unit.tmdbSeason,
        tmdbEpisode: unit.tmdbEpisode,
        airDateUtc: unit.airDateUtc,
        monitored: unit.monitored,
        retired: meta?.retiredAt !== undefined,
      });
    }

    const manual = await ctx.db
      .query('unitMappings')
      .withIndex('by_ordering', (q) => q.eq('workId', workId))
      .filter((q) => q.eq(q.field('source'), 'manual'))
      .collect();
    const manualRows = manual.flatMap((row) => {
      const key = keys.get(row.unitId);
      return key ? [{ key, ordering: row.ordering, season: row.season, episode: row.episode, absolute: row.absolute }] : [];
    });

    const entries =
      work.kind === 'series'
        ? await ctx.db
            .query('animeListEntries')
            .withIndex('by_tmdb_tv', (q) => q.eq('tmdbTvId', Number(tmdbId)))
            .collect()
        : [];
    const animeListEntries = entries.map(({ _id, _creationTime, seenVersion: _seen, ...entry }) => entry);
    const { tvdbId } = work.kind === 'series' ? chooseTvdbId(tmdbTvdbId, animeListEntries) : {};
    const source = (name: 'xem' | 'animeLists') =>
      ctx.db
        .query('mappingSourceState')
        .withIndex('by_source', (q) => q.eq('source', name))
        .unique();
    const xem = await source('xem');
    const animeLists = await source('animeLists');
    const sceneMappings =
      tvdbId === undefined
        ? []
        : await ctx.db
            .query('sceneMappings')
            .withIndex('by_tvdb', (q) => q.eq('tvdbId', tvdbId))
            .collect();

    return {
      kind: work.kind,
      tmdbId,
      monitorNewUnits: work.monitorNewUnits,
      firstWrite: metadata.buildState !== 'ready',
      initialSeasons: metadata.initialSeasons,
      // Only the scan's subscribe sets a folder before the first write; an import needs Units first.
      fromFolder: metadata.buildState !== 'ready' && work.folder !== undefined,
      projectionVersion: metadata.projectionVersion,
      mappingStatus: metadata.mappingStatus,
      seasonNames: metadata.seasonNames,
      units: existing,
      manualRows,
      animeListEntries,
      animeListsVersion: animeLists?.version,
      tvdbId,
      inXem: tvdbId !== undefined && (xem?.xemTvdbIds ?? []).includes(tvdbId),
      sceneMappings: sceneMappings.map((row) => row.title),
    };
  },
});

/** The TMDB ID and kind a sync looks a Work up by; null once the Work is gone. */
export const workRef = internalQuery({
  args: zodToConvexFields({ workId: zid('works') }),
  returns: zodToConvex(z.object({ tmdbId: z.string(), kind: z.enum(['series', 'movie']) }).nullable()),
  handler: async (ctx, { workId }) => {
    const work = await ctx.db.get(workId);
    const tmdb = await ctx.db
      .query('externalIds')
      .withIndex('by_work', (q) => q.eq('workId', workId))
      .filter((q) => q.eq(q.field('provider'), 'tmdb'))
      .first();
    return work && tmdb ? { tmdbId: tmdb.value, kind: work.kind } : null;
  },
});

/** TMDB no longer lists the Work: the Work page says so; its Units and files stay, and no Issue opens. */
export const markTmdbMissing = internalMutation({
  args: zodToConvexFields({ workId: zid('works') }),
  returns: zodToConvex(z.null()),
  handler: async (ctx, { workId }) => {
    const metadata = await workMetadataOf(ctx, workId);
    if (metadata && metadata.tmdbMissingSince === undefined) await ctx.db.patch(metadata._id, { tmdbMissingSince: Date.now() });
    return null;
  },
});

/** Whether Anime-Lists has an entry for each of these TMDB series IDs, in order (the `animeLists` suggestion). */
export const animeListsMembership = internalQuery({
  args: zodToConvexFields({ tmdbIds: z.array(z.string()) }),
  returns: zodToConvex(z.array(z.boolean())),
  handler: (ctx, { tmdbIds }) =>
    Promise.all(
      tmdbIds.map(
        async (tmdbId) =>
          (await ctx.db
            .query('animeListEntries')
            .withIndex('by_tmdb_tv', (q) => q.eq('tmdbTvId', Number(tmdbId)))
            .first()) !== null,
      ),
    ),
});

/** One batch of `reconcileUnits`' plan: at most 200 Units. */
export const UnitBatch = z.object({
  updates: z.array(z.object({ unitId: zid('units'), unit: UnitMetadata, change: UnitChange.optional() })),
  unretires: z.array(z.object({ unitId: zid('units'), unit: UnitMetadata, change: UnitChange })),
  creates: z.array(z.object({ unit: UnitMetadata, monitored: z.boolean() })),
  retires: z.array(z.object({ unitId: zid('units'), change: UnitChange })),
});
export type UnitBatch = z.infer<typeof UnitBatch>;

/** `metadataChanged` on the Unit's timeline, with `S01E10`-style numbers. */
function metadataChanged(ctx: MutationCtx, unitId: Id<'units'>, change: z.infer<typeof UnitChange>) {
  const message =
    change.to === 'retired'
      ? `TMDB no longer lists ${change.from}.`
      : change.from === 'retired'
        ? `TMDB lists ${change.to} again.`
        : `TMDB renumbered ${change.from} as ${change.to}.`;
  return appendEvent(ctx, { unitId, stage: 'system', kind: 'metadataChanged', message, data: { from: change.from, to: change.to } });
}

/** Makes the Unit's `tmdb` external ID the given episode ID (number adoption). */
async function setTmdbId(ctx: MutationCtx, unitId: Id<'units'>, tmdbId: string | undefined) {
  if (!tmdbId) return;
  const row = await ctx.db
    .query('externalIds')
    .withIndex('by_unit', (q) => q.eq('unitId', unitId))
    .filter((q) => q.eq(q.field('provider'), 'tmdb'))
    .first();
  if (!row) await ctx.db.insert('externalIds', { unitId, provider: 'tmdb', value: tmdbId });
  else if (row.value !== tmdbId) await ctx.db.patch(row._id, { value: tmdbId });
}

/** Writes a Unit's display data; `retiredAt` stays as it is unless given. */
async function setUnitMetadata(ctx: MutationCtx, workId: Id<'works'>, unitId: Id<'units'>, unit: UnitMetadata, retiredAt?: number | null) {
  const row = await unitMetadataOf(ctx, unitId);
  const fields = {
    overview: unit.overview,
    stillPath: unit.stillPath,
    runtimeMin: unit.runtimeMin,
    retiredAt: retiredAt === null ? undefined : (retiredAt ?? row?.retiredAt),
  };
  if (!row) {
    if (Object.values(fields).some((value) => value !== undefined)) await ctx.db.insert('unitMetadata', { unitId, workId, ...fields });
  } else if ((Object.keys(fields) as (keyof typeof fields)[]).some((key) => row[key] !== fields[key])) {
    await ctx.db.patch(row._id, fields);
  }
}

/** Moves a Unit to the snapshot's numbers, title and date; says whether its air date and its title changed. */
async function updateUnit(ctx: MutationCtx, unit: Doc<'units'>, data: UnitMetadata): Promise<{ airDate: boolean; title: boolean }> {
  const fields = { tmdbSeason: data.tmdbSeason, tmdbEpisode: data.tmdbEpisode, title: data.title, airDateUtc: data.airDateUtc };
  if ((Object.keys(fields) as (keyof typeof fields)[]).some((key) => unit[key] !== fields[key])) await ctx.db.patch(unit._id, fields);
  return { airDate: unit.airDateUtc !== data.airDateUtc, title: unit.title !== data.title };
}

/** Inserts, updates, retires and un-retires one batch of Units with their external IDs, display data and events. */
export const applyUnitPlan = internalMutation({
  args: zodToConvexFields({ workId: zid('works'), batch: UnitBatch }),
  returns: zodToConvex(z.null()),
  handler: async (ctx, { workId, batch }) => {
    if (!(await ctx.db.get(workId))) return null;
    const now = Date.now();
    const recompute: Id<'units'>[] = [];
    const retitled: Id<'units'>[] = [];

    for (const { unit, monitored } of batch.creates) {
      const unitId = await ctx.db.insert('units', {
        workId,
        kind: unit.kind,
        tmdbSeason: unit.tmdbSeason,
        tmdbEpisode: unit.tmdbEpisode,
        title: unit.title,
        airDateUtc: unit.airDateUtc,
        monitored,
        derivedState: stateOfNewUnit({ monitored, airDateUtc: unit.airDateUtc }, now),
      });
      await setTmdbId(ctx, unitId, unit.tmdbId);
      await setUnitMetadata(ctx, workId, unitId, unit);
    }

    for (const { unitId, unit, change } of batch.updates) {
      const doc = await ctx.db.get(unitId);
      if (!doc) continue;
      const changed = await updateUnit(ctx, doc, unit);
      if (changed.airDate) recompute.push(unitId);
      if (changed.title) retitled.push(unitId);
      await setTmdbId(ctx, unitId, unit.tmdbId);
      await setUnitMetadata(ctx, workId, unitId, unit);
      if (change) await metadataChanged(ctx, unitId, change);
    }

    // Listed again: back in mappings and matching, but it stays unmonitored.
    for (const { unitId, unit, change } of batch.unretires) {
      const doc = await ctx.db.get(unitId);
      if (!doc) continue;
      if ((await updateUnit(ctx, doc, unit)).title) retitled.push(unitId);
      await setTmdbId(ctx, unitId, unit.tmdbId);
      await setUnitMetadata(ctx, workId, unitId, unit, null);
      await metadataChanged(ctx, unitId, change);
      recompute.push(unitId);
    }

    // Retired: unmonitored, display data removed. An active Grab is left alone.
    for (const { unitId, change } of batch.retires) {
      const doc = await ctx.db.get(unitId);
      if (!doc) continue;
      if (doc.monitored) await ctx.db.patch(unitId, { monitored: false });
      await setUnitMetadata(ctx, workId, unitId, { kind: doc.kind }, now);
      await metadataChanged(ctx, unitId, change);
      recompute.push(unitId);
    }

    await recomputeUnits(ctx, recompute);
    // File names carry the episode title.
    if (retitled.length > 0) await unitsRetitled(ctx, retitled);
    return null;
  },
});

/** A projected mapping row, keyed by its Unit's TMDB episode ID (`projectMappings`). */
export const MappingRowInput = z.object({
  key: z.string(),
  ordering: Ordering,
  season: z.number().optional(),
  episode: z.number().optional(),
  absolute: z.number().optional(),
  source: z.enum(['tmdb', 'xem', 'animeLists']),
  sourceVersion: z.string().optional(),
});

/**
 * The Unit of this Work with this TMDB episode ID. Episode IDs share the
 * `tmdb` provider with series and movie IDs, so rows are kept only when
 * they belong to a Unit of the Work.
 */
async function unitByTmdbId(ctx: MutationCtx, workId: Id<'works'>, tmdbId: string): Promise<Id<'units'> | null> {
  const rows = await ctx.db
    .query('externalIds')
    .withIndex('by_provider_value', (q) => q.eq('provider', 'tmdb').eq('value', tmdbId))
    .collect();
  for (const row of rows) {
    if (!row.unitId) continue;
    const unit = await ctx.db.get(row.unitId);
    if (unit?.workId === workId) return unit._id;
  }
  return null;
}

/** Inserts or refreshes one batch of the Work's projected rows, stamped with this sync's version. */
export const applyMappings = internalMutation({
  args: zodToConvexFields({ workId: zid('works'), version: z.number(), rows: z.array(MappingRowInput) }),
  returns: zodToConvex(z.null()),
  handler: async (ctx, { workId, version, rows }) => {
    if (!(await ctx.db.get(workId))) return null;
    const units = new Map<string, Id<'units'> | null>();
    const stored = new Map<Id<'units'>, Doc<'unitMappings'>[]>();
    for (const { key, ...row } of rows) {
      if (!units.has(key)) units.set(key, await unitByTmdbId(ctx, workId, key));
      const unitId = units.get(key);
      if (!unitId) continue;
      if (!stored.has(unitId))
        stored.set(
          unitId,
          await ctx.db
            .query('unitMappings')
            .withIndex('by_unit', (q) => q.eq('unitId', unitId))
            .collect(),
        );
      const same = stored
        .get(unitId)!
        .find(
          (m) => m.ordering === row.ordering && m.source === row.source && m.season === row.season && m.episode === row.episode && m.absolute === row.absolute,
        );
      if (same) {
        if (same.projectionVersion !== version || same.sourceVersion !== row.sourceVersion)
          await ctx.db.patch(same._id, { projectionVersion: version, sourceVersion: row.sourceVersion });
      } else {
        await ctx.db.insert('unitMappings', { unitId, workId, ...row, projectionVersion: version });
      }
    }
    return null;
  },
});

const Alias = z.object({ title: z.string(), normalized: z.string(), source: AliasSource, anidbId: z.number().optional(), sceneSeason: z.number().optional() });

/** What the last page of `finishWrite` writes on the Work. */
export const WorkFields = z.object({
  title: z.string(),
  year: z.number().optional(),
  overview: z.string().optional(),
  posterPath: z.string().optional(),
  backdropPath: z.string().optional(),
  genreIds: z.array(z.number()),
  originCountry: z.array(z.string()),
  originalLanguage: z.string().optional(),
  tmdbStatus: z.string().optional(),
  numberingSuggestion: z.object({ scheme: NumberingScheme, reason: NumberingReason }),
  mappingStatus: MappingStatus,
  mappingNotes: z.array(z.string()),
  /** A series' named TMDB seasons with their scene seasons (`numbering.seasonNames`). */
  seasonNames: z.array(SeasonName).optional(),
  nextSyncAt: z.number(),
  /** The Work's `tvdb`, `imdb` and `anidb` IDs; its `tmdb` ID never changes. */
  externalIds: z.array(z.object({ provider: z.enum(['tvdb', 'imdb', 'anidb']), value: z.string() })),
});
export type WorkFields = z.infer<typeof WorkFields>;

const PAGE = 500;

/**
 * The end of a sync, one page per call: deletes the Work's non-manual
 * mapping rows from older versions; on the last page, writes the alias diff,
 * the Work's IDs and metadata, and marks the first write `ready`.
 * `keepXem` keeps the stored `xem` rows and XEM aliases (a failed XEM fetch).
 */
export const finishWrite = internalMutation({
  args: zodToConvexFields({
    workId: zid('works'),
    version: z.number(),
    cursor: z.string().nullable(),
    keepXem: z.object({ rows: z.boolean(), aliases: z.boolean() }),
    aliases: z.array(Alias),
    fields: WorkFields,
  }),
  returns: zodToConvex(z.object({ done: z.boolean(), cursor: z.string().nullable() })),
  handler: async (ctx, { workId, version, cursor, keepXem, aliases, fields }) => {
    const work = await ctx.db.get(workId);
    const metadata = await workMetadataOf(ctx, workId);
    if (!work || !metadata) return { done: true, cursor: null };

    const page = await ctx.db
      .query('unitMappings')
      .withIndex('by_ordering', (q) => q.eq('workId', workId))
      .paginate({ cursor, numItems: PAGE });
    for (const row of page.page) {
      const stale = row.source !== 'manual' && (row.projectionVersion ?? 0) < version && !(keepXem.rows && row.source === 'xem');
      if (stale) await ctx.db.delete(row._id);
    }
    if (!page.isDone) return { done: false, cursor: page.continueCursor };

    // Aliases: the non-manual ones the sync no longer produces go; new ones come in. A changed scene season replaces the row.
    const key = (a: { source: string; normalized: string; anidbId?: number; sceneSeason?: number }) =>
      `${a.source}:${a.anidbId ?? ''}:${a.sceneSeason ?? ''}:${a.normalized}`;
    const wanted = new Map(aliases.map((a) => [key(a), a]));
    const current = await ctx.db
      .query('workAliases')
      .withIndex('by_work', (q) => q.eq('workId', workId))
      .collect();
    for (const alias of current) {
      if (alias.source === 'manual' || (keepXem.aliases && alias.source === 'xem')) continue;
      if (!wanted.delete(key(alias))) await ctx.db.delete(alias._id);
    }
    for (const alias of wanted.values()) await ctx.db.insert('workAliases', { workId, ...alias, compact: compactTitle(alias.normalized) });

    // The Work's own IDs, besides its tmdb ID.
    const ids = await ctx.db
      .query('externalIds')
      .withIndex('by_work', (q) => q.eq('workId', workId))
      .collect();
    const wantedIds = new Set(fields.externalIds.map((ref) => `${ref.provider}:${ref.value}`));
    for (const row of ids) if (row.provider !== 'tmdb' && !wantedIds.delete(`${row.provider}:${row.value}`)) await ctx.db.delete(row._id);
    for (const ref of fields.externalIds) if (wantedIds.has(`${ref.provider}:${ref.value}`)) await ctx.db.insert('externalIds', { workId, ...ref });

    const now = Date.now();
    const { externalIds: _ids, title, year, ...display } = fields;
    await ctx.db.patch(workId, { title, year, metadataUpdatedAt: now });
    const firstWrite = metadata.buildState !== 'ready';
    await ctx.db.patch(metadata._id, { ...display, projectionVersion: version, buildState: 'ready', initialSeasons: undefined, tmdbMissingSince: undefined });
    // The subscribe search: once, when the first write makes the Work ready.
    if (firstWrite) {
      const units = await ctx.db
        .query('units')
        .withIndex('by_work', (q) => q.eq('workId', workId))
        .collect();
      const aired = units.filter((unit) => unit.monitored && unit.airDateUtc !== undefined && unit.airDateUtc <= now).map((unit) => unit._id);
      if (aired.length > 0) await startSearch(ctx, aired, 'subscribe');
    }
    return { done: true, cursor: null };
  },
});

/** A first write that never succeeded ends `failed`; a Work already `ready` stays so. */
export const failFirstWrite = internalMutation({
  args: zodToConvexFields({ workId: zid('works') }),
  returns: zodToConvex(z.null()),
  handler: async (ctx, { workId }) => {
    const metadata = await workMetadataOf(ctx, workId);
    if (metadata && metadata.buildState !== 'ready') await ctx.db.patch(metadata._id, { buildState: 'failed' });
    return null;
  },
});
