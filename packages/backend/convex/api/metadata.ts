// Metadata for adding a title, and the metadata settings and Work
// numbering functions. Search and preview
// are actions, because the MetadataProvider answers over HTTP.
import {
  AddAliasRequest,
  KeyTestRequest,
  KeyTestResult,
  MetadataSearchRequest,
  MetadataSearchResult,
  MetadataSettingsRow,
  MetadataSourceName,
  RemoveAliasRequest,
  RemoveManualMappingRequest,
  SetManualMappingRequest,
  SetNumberingSchemeRequest,
  UnitMappingRow,
  UnitRequest,
  WorkMetadataRow,
  WorkPreview,
  WorkPreviewRequest,
  WorkRequest,
  type SeasonPreview,
} from '@omnarr/contracts';
import { compactTitle, normalizeTitle } from '@omnarr/parser';
import { zid } from 'convex-helpers/server/zod4';
import { ConvexError } from 'convex/values';
import { z } from 'zod';

import { internal } from '../_generated/api';
import { adminAction, adminMutation, adminQuery } from '../lib/functions';
import { posterDataUri } from '../metadata/images';
import { DEFAULT_LANGUAGE, settingsRow, withProvider } from '../metadata/keys';
import { suggestNumbering } from '../metadata/numbering';
import { enqueueSync } from '../metadata/pool';
import { metadataProvider, requireWork } from '../metadata/provider';
import { workMetadataOf } from '../metadata/write';

/** Titles matching the query, each with its numbering suggestion and its Work when it's already in the library. */
export const search = adminAction({
  args: MetadataSearchRequest.shape,
  returns: MetadataSearchResult,
  handler: async (ctx, { query, kind }): Promise<MetadataSearchResult> => {
    const kinds = kind ? [kind] : (['series', 'movie'] as const);
    const hits = await withProvider(ctx, async (provider) => (await Promise.all(kinds.map((k) => provider.search(query, k)))).flat());
    const refs = hits.map(({ tmdbId, kind }) => ({ tmdbId, kind }));
    const workIds = await ctx.runQuery(internal.library.works.findWorks, { refs });
    const inAnimeLists = await ctx.runQuery(internal.metadata.write.animeListsMembership, { tmdbIds: hits.map((hit) => hit.tmdbId) });
    // Each result's w92 poster, fetched here, so the browser never asks TMDB.
    const posters = await Promise.all(hits.map((hit) => posterDataUri(hit.posterPath)));
    return hits.map(({ genreIds, originCountry, posterPath: _path, ...hit }, i) => {
      // Only series have Anime-Lists entries by TMDB ID; suggestNumbering ignores the flag for movies.
      const { scheme, reason } = suggestNumbering({ kind: hit.kind, genreIds, originCountry }, inAnimeLists[i]!);
      return {
        ...hit,
        numberingScheme: scheme,
        numberingReason: reason,
        workId: workIds[i] ?? undefined,
        ...(posters[i] ? { posterDataUri: posters[i] } : {}),
      };
    });
  },
});

/** Tests a TMDB token and stores it only if TMDB accepts it; a rejected one leaves the previous token in use. */
export const testKey = adminAction({
  args: KeyTestRequest.shape,
  returns: KeyTestResult,
  handler: async (ctx, { token }): Promise<KeyTestResult> => {
    const { language } = await ctx.runQuery(internal.metadata.keys.currentToken, {});
    const outcome = await metadataProvider(token, language).checkKey(token);
    if (outcome === 'valid') await ctx.runMutation(internal.metadata.keys.saveUserToken, { token });
    return { outcome };
  },
});

/** Removes the user's token; calls use the deployment's again. */
export const clearUserToken = adminMutation({
  args: {},
  returns: z.null(),
  handler: async (ctx) => {
    await ctx.runMutation(internal.metadata.keys.clearUserToken, {});
    return null;
  },
});

/** The Work page's scheme choice; it changes only future matching. */
export const setNumberingScheme = adminMutation({
  args: SetNumberingSchemeRequest.shape,
  returns: z.null(),
  handler: async (ctx, { workId, scheme }) => {
    const work = await ctx.db.get(workId);
    if (!work) throw new ConvexError({ code: 'notFound', message: 'The Work does not exist.' });
    await ctx.db.patch(workId, { numberingScheme: scheme });
    return null;
  },
});

/** A title the user adds for searching and matching; syncs never remove it. */
export const addAlias = adminMutation({
  args: AddAliasRequest.shape,
  returns: zid('workAliases'),
  handler: async (ctx, { workId, title }) => {
    if (!(await ctx.db.get(workId))) throw new ConvexError({ code: 'notFound', message: 'The Work does not exist.' });
    const normalized = normalizeTitle(title);
    if (!normalized) throw new ConvexError({ code: 'invalid', message: 'The title has no letters or digits.' });
    return await ctx.db.insert('workAliases', { workId, title, normalized, compact: compactTitle(normalized), source: 'manual' });
  },
});

const notManual = (what: string) => new ConvexError({ code: 'notManual', message: `Only ${what} the user added can be removed.` });

export const removeAlias = adminMutation({
  args: RemoveAliasRequest.shape,
  returns: z.null(),
  handler: async (ctx, { aliasId }) => {
    const alias = await ctx.db.get(aliasId);
    if (!alias) return null;
    if (alias.source !== 'manual') throw notManual('aliases');
    await ctx.db.delete(aliasId);
    return null;
  },
});

/** The user's own number for a Unit in an ordering. It wins over every source, and starts a sync. */
export const setManualMapping = adminMutation({
  args: SetManualMappingRequest.shape,
  returns: zid('unitMappings'),
  handler: async (ctx, args) => {
    const { unitId, ordering, season, episode, absolute } = SetManualMappingRequest.parse(args);
    const unit = await ctx.db.get(unitId);
    if (!unit) throw new ConvexError({ code: 'notFound', message: 'The Unit does not exist.' });
    const mappingId = await ctx.db.insert('unitMappings', { unitId, workId: unit.workId, ordering, season, episode, absolute, source: 'manual' });
    await enqueueSync(ctx, unit.workId);
    return mappingId;
  },
});

export const removeManualMapping = adminMutation({
  args: RemoveManualMappingRequest.shape,
  returns: z.null(),
  handler: async (ctx, { mappingId }) => {
    const row = await ctx.db.get(mappingId);
    if (!row) return null;
    if (row.source !== 'manual') throw notManual('mappings');
    await ctx.db.delete(mappingId);
    await enqueueSync(ctx, row.workId);
    return null;
  },
});

/** "Refresh now" and "Try again": enqueues the Work's sync; false when one is already enqueued or running. */
export const syncNow = adminMutation({
  args: WorkRequest.shape,
  returns: z.boolean(),
  handler: (ctx, { workId }) => enqueueSync(ctx, workId),
});

/** The metadata settings page: the token in use (never the token itself), the language, and each source's health. */
export const settings = adminQuery({
  args: {},
  returns: MetadataSettingsRow,
  handler: async (ctx): Promise<MetadataSettingsRow> => {
    const row = await settingsRow(ctx);
    const states = await ctx.db.query('mappingSourceState').collect();
    return {
      tokenSource: row?.userApiToken ? 'user' : 'deployment',
      userTokenCheckedAt: row?.userApiToken ? row.userTokenCheckedAt : undefined,
      language: row?.language ?? DEFAULT_LANGUAGE,
      sources: MetadataSourceName.options.map((name) => ({
        name,
        version: states.find((state) => state.source === name)?.version,
        ...row?.sourceHealth[name],
      })),
    };
  },
});

/** The Work page's metadata and numbering panel; null once the Work is gone. */
export const workInfo = adminQuery({
  args: WorkRequest.shape,
  returns: WorkMetadataRow.nullable(),
  handler: async (ctx, { workId }): Promise<WorkMetadataRow | null> => {
    const metadata = await workMetadataOf(ctx, workId);
    if (!metadata) return null;
    const aliases = await ctx.db
      .query('workAliases')
      .withIndex('by_work', (q) => q.eq('workId', workId))
      .collect();
    return {
      workId,
      overview: metadata.overview,
      posterPath: metadata.posterPath,
      backdropPath: metadata.backdropPath,
      genreIds: metadata.genreIds ?? [],
      originCountry: metadata.originCountry ?? [],
      originalLanguage: metadata.originalLanguage,
      tmdbStatus: metadata.tmdbStatus,
      buildState: metadata.buildState,
      numberingSuggestion: metadata.numberingSuggestion,
      mappingStatus: metadata.mappingStatus,
      mappingNotes: metadata.mappingNotes,
      aliases: aliases.map((alias) => ({ aliasId: alias._id, title: alias.title, source: alias.source, anidbId: alias.anidbId })),
      tmdbMissing: metadata.tmdbMissingSince !== undefined,
      syncing: metadata.syncWorkId !== undefined,
    };
  },
});

/** A Unit's numbers in every other ordering, with their sources. */
export const unitMappings = adminQuery({
  args: UnitRequest.shape,
  returns: z.array(UnitMappingRow),
  handler: async (ctx, { unitId }): Promise<UnitMappingRow[]> => {
    const rows = await ctx.db
      .query('unitMappings')
      .withIndex('by_unit', (q) => q.eq('unitId', unitId))
      .collect();
    return rows.map((row) => ({
      mappingId: row._id,
      ordering: row.ordering,
      season: row.season,
      episode: row.episode,
      absolute: row.absolute,
      source: row.source,
      sourceVersion: row.sourceVersion,
    }));
  },
});

/** A title's seasons before subscribing: episodes, how many aired, and when the next one airs. */
export const preview = adminAction({
  args: WorkPreviewRequest.shape,
  returns: WorkPreview,
  handler: async (ctx, { tmdbId, kind }): Promise<WorkPreview> => {
    const work = await withProvider(ctx, (provider) => requireWork(provider, tmdbId, kind));
    const [workId] = await ctx.runQuery(internal.library.works.findWorks, { refs: [{ tmdbId, kind }] });
    const [inAnimeLists] = await ctx.runQuery(internal.metadata.write.animeListsMembership, { tmdbIds: kind === 'series' ? [tmdbId] : [] });
    const { scheme, reason } = suggestNumbering(work, inAnimeLists ?? false);

    const now = Date.now();
    const seasons = new Map<number, SeasonPreview>();
    for (const unit of work.kind === 'series' ? work.units : []) {
      if (unit.tmdbSeason === undefined) continue;
      const season = seasons.get(unit.tmdbSeason) ?? { season: unit.tmdbSeason, episodes: 0, aired: 0 };
      season.episodes++;
      if (unit.airDateUtc !== undefined && unit.airDateUtc <= now) season.aired++;
      else if (unit.airDateUtc !== undefined && (season.nextAirDateUtc === undefined || unit.airDateUtc < season.nextAirDateUtc))
        season.nextAirDateUtc = unit.airDateUtc;
      seasons.set(unit.tmdbSeason, season);
    }

    return {
      tmdbId,
      kind,
      title: work.title,
      year: work.year,
      numberingScheme: scheme,
      numberingReason: reason,
      workId: workId ?? undefined,
      seasons: [...seasons.values()].sort((a, b) => a.season - b.season),
    };
  },
});
