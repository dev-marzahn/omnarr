// One write path for Units and mappings: `applySnapshot` serves
// subscribe's first write, scheduled syncs, "Refresh now" and mapping-data
// changes alike.
import { zid, zodToConvex, zodToConvexFields } from 'convex-helpers/server/zod4';
import { z } from 'zod';

import { internal } from '../_generated/api';
import type { Id } from '../_generated/dataModel';
import { internalAction, type ActionCtx } from '../_generated/server';
import { chooseTvdbId, entriesStartingAtAbsoluteOne, projectMappings, type MappingRow, type Projection } from '../mapping/project';
import { fetchShow, type XemEntry } from '../mapping/xem';
import { withProvider } from './keys';
import { aliasList, seasonNames, selectAbsoluteOrder, suggestNumbering } from './numbering';
import type { WorkMetadata } from './provider';
import { reconcileUnits, type UnitPlan } from './reconcile';
import { nextSyncAt } from './schedule';
import type { UnitBatch, WorkFields } from './write';

/**
 * A Work's sync, run in `metadataPool`: fetch TMDB, then `applySnapshot`.
 * A failed fetch changes nothing and fails, so the pool retries it. A title
 * TMDB no longer lists is marked, and its Units and files stay.
 */
export const syncWork = internalAction({
  args: zodToConvexFields({ workId: zid('works') }),
  returns: zodToConvex(z.null()),
  handler: async (ctx, { workId }): Promise<null> => {
    const ref = await ctx.runQuery(internal.metadata.write.workRef, { workId });
    if (!ref) return null;
    const snapshot = await withProvider(ctx, (provider) => provider.lookupWork(ref.tmdbId, ref.kind));
    if (!snapshot) {
      await ctx.runMutation(internal.metadata.write.markTmdbMissing, { workId });
      return null;
    }
    await applySnapshot(ctx, workId, snapshot);
    return null;
  },
});

/** At most this many Units, with their rows, per write mutation, to bound the Convex load. */
export const UNITS_PER_BATCH = 200;

/** Splits a plan into batches of at most `size` Units, in order. */
export function unitBatches(plan: UnitPlan<Id<'units'>>, size: number): UnitBatch[] {
  const items = [
    ...plan.creates.map((item) => ['creates', item] as const),
    ...plan.updates.map((item) => ['updates', item] as const),
    ...plan.unretires.map((item) => ['unretires', item] as const),
    ...plan.retires.map((item) => ['retires', item] as const),
  ];
  const out: UnitBatch[] = [];
  for (let i = 0; i < items.length; i += size) {
    const batch: UnitBatch = { creates: [], updates: [], unretires: [], retires: [] };
    for (const [kind, item] of items.slice(i, i + size)) (batch[kind] as unknown[]).push(item);
    out.push(batch);
  }
  return out;
}

/** The scene seasons XEM's `scene` rows give each TMDB season's Units. */
function sceneSeasonsByTmdbSeason(units: WorkMetadata['units'], rows: MappingRow[]): Map<number, Set<number>> {
  const seasonOf = new Map(units.flatMap((unit) => (unit.tmdbId && unit.tmdbSeason !== undefined ? [[unit.tmdbId, unit.tmdbSeason] as const] : [])));
  const out = new Map<number, Set<number>>();
  for (const row of rows) {
    const season = seasonOf.get(row.key);
    if (row.ordering !== 'scene' || row.season === undefined || season === undefined) continue;
    out.set(season, (out.get(season) ?? new Set()).add(row.season));
  }
  return out;
}

/** Groups rows by Unit, at most `size` Units' rows per group. */
function rowBatches(rows: MappingRow[], size: number): MappingRow[][] {
  const byKey = new Map<string, MappingRow[]>();
  for (const row of rows) byKey.set(row.key, [...(byKey.get(row.key) ?? []), row]);
  const groups = [...byKey.values()];
  const out: MappingRow[][] = [];
  for (let i = 0; i < groups.length; i += size) out.push(groups.slice(i, i + size).flat());
  return out;
}

/**
 * Syncs one Work: fetch XEM, read the Work, reconcile its Units, project its
 * mappings and write them all, in batches. Until the first write succeeds,
 * new Units are monitored by the seasons ticked at subscribe
 * (`workMetadata.initialSeasons`), on a retry too. Does nothing
 * once the Work is gone.
 */
export async function applySnapshot(ctx: ActionCtx, workId: Id<'works'>, snapshot: WorkMetadata): Promise<void> {
  const input = await ctx.runQuery(internal.metadata.write.snapshotInput, { workId, tmdbTvdbId: snapshot.tvdbId });
  if (!input) return;
  const now = Date.now();
  const notes: string[] = [];

  let xemEntries: XemEntry[] | undefined = [];
  if (input.inXem) {
    try {
      xemEntries = await fetchShow(input.tvdbId!);
      await ctx.runMutation(internal.metadata.keys.recordHealth, { source: 'xem', outcome: 'success', at: now });
    } catch {
      xemEntries = undefined;
      notes.push('XEM could not be reached; its numbers are from the last successful fetch.');
      await ctx.runMutation(internal.metadata.keys.recordHealth, { source: 'xem', outcome: 'failure', at: now });
    }
  }
  const xemVersion = new Date(now).toISOString();

  const plan = reconcileUnits(input.units, snapshot.units, {
    monitorNewUnits: input.monitorNewUnits,
    seasons: input.firstWrite ? input.initialSeasons : undefined,
    fromFolder: input.fromFolder,
  });
  for (const batch of unitBatches(plan, UNITS_PER_BATCH)) await ctx.runMutation(internal.metadata.write.applyUnitPlan, { workId, batch });

  let projection: Projection = { rows: [], status: 'tmdbOnly', notes: [] };
  if (snapshot.kind === 'series') {
    const units = snapshot.units.flatMap((u) =>
      u.tmdbId && u.tmdbSeason !== undefined && u.tmdbEpisode !== undefined && u.kind !== 'movie'
        ? [{ key: u.tmdbId, kind: u.kind, tmdbSeason: u.tmdbSeason, tmdbEpisode: u.tmdbEpisode }]
        : [],
    );
    const absolute = selectAbsoluteOrder(
      units.filter((u) => u.kind === 'episode'),
      snapshot.absoluteGroups,
    );
    if (absolute.note) notes.push(absolute.note);
    projection = projectMappings({
      units,
      absoluteOrder: absolute.order,
      tmdbTvdbId: snapshot.tvdbId,
      animeListEntries: input.animeListEntries,
      xemEntries,
      manualRows: input.manualRows,
      versions: { animeLists: input.animeListsVersion, xem: xemVersion },
    });
  }
  const version = input.projectionVersion + 1;
  for (const rows of rowBatches(projection.rows, UNITS_PER_BATCH)) await ctx.runMutation(internal.metadata.write.applyMappings, { workId, version, rows });

  const { tvdbId } = snapshot.kind === 'series' ? chooseTvdbId(snapshot.tvdbId, input.animeListEntries) : {};
  const tmdbTitles = [snapshot.title, ...snapshot.aliases];
  // While XEM is down, its rows are kept, and so are the stored season names, whose scene seasons come from them.
  const named =
    snapshot.kind !== 'series'
      ? undefined
      : xemEntries === undefined
        ? input.seasonNames
        : seasonNames({ seasons: snapshot.seasons ?? [], xemSceneSeasons: sceneSeasonsByTmdbSeason(snapshot.units, projection.rows), titles: tmdbTitles });
  const fields: WorkFields = {
    seasonNames: named,
    title: snapshot.title,
    year: snapshot.year,
    overview: snapshot.overview,
    posterPath: snapshot.posterPath,
    backdropPath: snapshot.backdropPath,
    genreIds: snapshot.genreIds,
    originCountry: snapshot.originCountry,
    originalLanguage: snapshot.originalLanguage,
    tmdbStatus: snapshot.tmdbStatus,
    numberingSuggestion: suggestNumbering(snapshot, input.animeListEntries.length > 0),
    // While XEM is down, the last status stands: its rows are kept.
    mappingStatus: xemEntries === undefined && input.mappingStatus ? input.mappingStatus : projection.status,
    mappingNotes: [...projection.notes, ...notes],
    nextSyncAt: nextSyncAt(snapshot, snapshot.units, now),
    externalIds: [
      ...(tvdbId !== undefined ? [{ provider: 'tvdb' as const, value: String(tvdbId) }] : []),
      ...(snapshot.imdbId ? [{ provider: 'imdb' as const, value: snapshot.imdbId }] : []),
      ...input.animeListEntries.map((entry) => ({ provider: 'anidb' as const, value: String(entry.anidbId) })),
    ],
  };
  const starting = entriesStartingAtAbsoluteOne(projection.rows);
  const aliases = aliasList({
    tmdbTitles,
    animeLists: input.animeListEntries.map(({ anidbId, name }) => ({ anidbId, name, startsAtAbsoluteOne: starting.has(anidbId) })),
    xemNames: input.xemNames ?? [],
    sceneMappings: input.sceneMappings,
    seasonNames: fields.seasonNames,
  });
  let cursor: string | null = null;
  for (;;) {
    const page: { done: boolean; cursor: string | null } = await ctx.runMutation(internal.metadata.write.finishWrite, {
      workId,
      version,
      cursor,
      keepXem: { rows: xemEntries === undefined, aliases: input.xemNames === undefined },
      aliases,
      fields,
    });
    if (page.done) break;
    cursor = page.cursor;
  }
  // The images come after the write, on their own, so a slow or unreachable CDN never fails the sync.
  await ctx.scheduler.runAfter(0, internal.metadata.images.fetchForWork, { workId });
}
