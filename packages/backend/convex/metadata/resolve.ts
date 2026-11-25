// The resolver functions search and grab use: the Work a release title
// names, the Units its numbers name, and the keys a search is sent with.
// Each is a plain function for mutations and queries, with an internal query
// wrapper for actions. All of them only read.
import {
  type AliasSource,
  type Confidence,
  MatchedAlias,
  ParsedEpisode,
  type PartSeasonOrdering,
  ResolveOrdering,
  ResolveResult,
  SearchKeys,
  type UnitRef,
} from '@omnarr/contracts';
import { compactTitle, normalizeTitle } from '@omnarr/parser';
import { zid, zodToConvex, zodToConvexFields } from 'convex-helpers/server/zod4';
import { z } from 'zod';

import type { Doc, Id } from '../_generated/dataModel';
import { internalQuery, type QueryCtx } from '../_generated/server';
import { workMetadataOf } from './write';

export type WorkByTitle = { workId: Id<'works'>; aliasId: Id<'workAliases'>; anidbId?: number };

/**
 * Works with an alias whose normalized title is this one, else whose compact
 * form is this title's (a hyphen on either side); per Work, the
 * alias without an AniDB link first.
 */
export async function findWorksByTitle(ctx: QueryCtx, normalizedTitle: string): Promise<WorkByTitle[]> {
  let aliases = await ctx.db
    .query('workAliases')
    .withIndex('by_normalized', (q) => q.eq('normalized', normalizedTitle))
    .collect();
  if (aliases.length === 0)
    aliases = await ctx.db
      .query('workAliases')
      .withIndex('by_compact', (q) => q.eq('compact', compactTitle(normalizedTitle)))
      .collect();
  const linked = (alias: Doc<'workAliases'>) => (alias.anidbId === undefined ? 0 : 1);
  const workOrder = [...new Set(aliases.map((alias) => alias.workId))];
  return aliases
    .sort((a, b) => workOrder.indexOf(a.workId) - workOrder.indexOf(b.workId) || linked(a) - linked(b))
    .map((alias) =>
      alias.anidbId === undefined ? { workId: alias.workId, aliasId: alias._id } : { workId: alias.workId, aliasId: alias._id, anidbId: alias.anidbId },
    );
}

type Via = ResolveResult['via'];

/** Units of the Work that TMDB still lists. */
async function live(ctx: QueryCtx, units: Doc<'units'>[]): Promise<Doc<'units'>[]> {
  const kept: Doc<'units'>[] = [];
  for (const unit of units) {
    const meta = await ctx.db
      .query('unitMetadata')
      .withIndex('by_unit', (q) => q.eq('unitId', unit._id))
      .unique();
    if (meta?.retiredAt === undefined) kept.push(unit);
  }
  return kept;
}

/** TMDB's own numbers: `assumed` without mapping data, `unverified` where mapping data didn't cover the number. */
async function tmdbConfidence(ctx: QueryCtx, workId: Id<'works'>): Promise<Confidence> {
  const metadata = await workMetadataOf(ctx, workId);
  return metadata?.mappingStatus === undefined || metadata.mappingStatus === 'tmdbOnly' ? 'assumed' : 'unverified';
}

async function byTmdbNumbers(ctx: QueryCtx, workId: Id<'works'>, episode: ParsedEpisode): Promise<Doc<'units'>[]> {
  const units = await ctx.db
    .query('units')
    .withIndex('by_work_tmdb', (q) =>
      episode.episode === undefined
        ? q.eq('workId', workId).eq('tmdbSeason', episode.season)
        : q.eq('workId', workId).eq('tmdbSeason', episode.season).eq('tmdbEpisode', episode.episode),
    )
    .collect();
  return live(ctx, units);
}

/** The Units of one ordering's rows for a season and episode; a season with no episode gives the whole season. */
async function byOrdering(ctx: QueryCtx, workId: Id<'works'>, ordering: string, season: number, episode: number | undefined) {
  const rows = await ctx.db
    .query('unitMappings')
    .withIndex('by_ordering', (q) =>
      episode === undefined
        ? q.eq('workId', workId).eq('ordering', ordering).eq('season', season)
        : q.eq('workId', workId).eq('ordering', ordering).eq('season', season).eq('episode', episode),
    )
    .collect();
  return rows;
}

/**
 * What one rule found: the Units per number of the release, and how. Empty
 * when the rule found nothing, so the next rule runs.
 */
type Found = { perNumber: Id<'units'>[][]; via: Via; confidence: Confidence };

/** Readings that disagree: the Units each found, for the user to pick from. */
type Ambiguous = { ambiguous: Id<'units'>[] };
const isAmbiguous = (found: Found | Ambiguous | null): found is Ambiguous => found !== null && 'ambiguous' in found;
/** The Units several readings found, each once. */
const ambiguous = (...readings: (Found | Ambiguous | Id<'units'>[] | null)[]): Ambiguous => ({
  ambiguous: [
    ...new Set(
      readings.flatMap((reading) => (reading === null ? [] : Array.isArray(reading) ? reading : isAmbiguous(reading) ? reading.ambiguous : flat(reading))),
    ),
  ],
});

/** Several numbers must each find a Unit; a rule that finds some but not all is `notFound` (rule 5). */
const complete = (found: Found) => found.perNumber.every((ids) => ids.length > 0);
const anyFound = (found: Found | null): found is Found => found !== null && found.perNumber.some((ids) => ids.length > 0);

/** Live Units behind mapping rows, `manual` rows first. */
async function unitsOfRows(ctx: QueryCtx, rows: Doc<'unitMappings'>[]): Promise<{ unitIds: Id<'units'>[]; source?: Doc<'unitMappings'>['source'] }> {
  const ordered = [...rows].sort((a, b) => Number(b.source === 'manual') - Number(a.source === 'manual'));
  const units = await live(
    ctx,
    (await Promise.all(ordered.map((row) => ctx.db.get(row.unitId)))).filter((unit) => unit !== null),
  );
  return { unitIds: [...new Set(units.map((unit) => unit._id))], source: ordered[0]?.source };
}

/** Rule 1: the Unit whose air date falls on this calendar day. */
async function byAirDate(ctx: QueryCtx, workId: Id<'works'>, airDate: string): Promise<Found | Ambiguous | null> {
  const start = Date.parse(`${airDate}T00:00:00Z`);
  if (Number.isNaN(start)) return null;
  const units = await live(
    ctx,
    await ctx.db
      .query('units')
      .withIndex('by_work_air_date', (q) =>
        q
          .eq('workId', workId)
          .gte('airDateUtc', start)
          .lt('airDateUtc', start + 86_400_000),
      )
      .collect(),
  );
  if (units.length > 1) return ambiguous(units.map((unit) => unit._id));
  if (units.length === 0) return null;
  return { perNumber: [[units[0]!._id]], via: { ordering: 'airDate', source: 'tmdb' }, confidence: 'mapped' };
}

/** Rule 2: the alias names an AniDB entry, so its `anidb:<id>` ordering reads the numbers. */
async function byAnidb(ctx: QueryCtx, workId: Id<'works'>, anidbId: number, episodes: ParsedEpisode[]): Promise<Found | null> {
  const ordering = `anidb:${anidbId}`;
  const numbers = episodes.filter((e) => (e.episode ?? e.absolute) !== undefined);
  if (numbers.length === 0) return null;
  let source: Doc<'unitMappings'>['source'] = 'animeLists';
  const perNumber: Id<'units'>[][] = [];
  for (const episode of numbers) {
    const found = await unitsOfRows(ctx, await byOrdering(ctx, workId, ordering, episode.season ?? 1, episode.episode ?? episode.absolute));
    if (found.source) source = found.source;
    perNumber.push(found.unitIds);
  }
  return { perNumber, via: { ordering, source }, confidence: 'mapped' };
}

/** Which orderings rules 3 and 4 may read (the `orderings` argument; all without it). */
type Allowed = (ordering: string) => boolean;
const allOrderings: Allowed = () => true;

/** Rule 3: season and episode, in `scene` rows, then `tvdb` rows, then TMDB's own numbers. */
async function bySeasonEpisode(ctx: QueryCtx, workId: Id<'works'>, episodes: ParsedEpisode[], allowed: Allowed): Promise<Found | null> {
  const numbers = episodes.filter((e) => e.season !== undefined);
  if (numbers.length === 0) return null;
  let partial: Found | null = null;
  for (const ordering of (['scene', 'tvdb'] as const).filter(allowed)) {
    let source: Doc<'unitMappings'>['source'] = 'xem';
    const perNumber: Id<'units'>[][] = [];
    for (const episode of numbers) {
      const found = await unitsOfRows(ctx, await byOrdering(ctx, workId, ordering, episode.season!, episode.episode));
      if (found.source) source = found.source;
      perNumber.push(found.unitIds);
    }
    const result: Found = { perNumber, via: { ordering, source }, confidence: 'mapped' };
    if (complete(result)) return result;
    if (!partial && anyFound(result)) partial = result;
  }
  if (!allowed('tmdb')) return partial;
  const perNumber: Id<'units'>[][] = [];
  for (const episode of numbers) perNumber.push((await byTmdbNumbers(ctx, workId, episode)).map((unit) => unit._id));
  const tmdb: Found = { perNumber, via: { ordering: 'tmdb', source: 'tmdb' }, confidence: await tmdbConfidence(ctx, workId) };
  if (complete(tmdb)) return tmdb;
  return partial ?? tmdb;
}

/**
 * Rule 4: absolute numbers, from a `manual` row, then a `scene` row, then an
 * `absolute` row; `anidb:` rows aren't read. `scene` rows that put one number
 * on several Units (XEM restarting a scene season at absolute 1) make the
 * number `ambiguous`, whatever the `absolute` row says: the release may be
 * any of those seasons, so it is left for the user to pick. With `keep`, only
 * rows whose Unit it keeps count: the Units of a season the title names, or
 * of the AniDB entry its alias names.
 */
async function byAbsolute(
  ctx: QueryCtx,
  workId: Id<'works'>,
  episodes: ParsedEpisode[],
  allowed: Allowed,
  keep: (unitId: Id<'units'>) => boolean | Promise<boolean> = () => true,
): Promise<Found | Ambiguous | null> {
  const numbers = episodes.filter((e) => e.absolute !== undefined);
  if (numbers.length === 0) return null;
  let via: Via = { ordering: 'absolute', source: 'tmdb' };
  const perNumber: Id<'units'>[][] = [];
  for (const episode of numbers) {
    const rows: Doc<'unitMappings'>[] = [];
    const all = await ctx.db
      .query('unitMappings')
      .withIndex('by_absolute', (q) => q.eq('workId', workId).eq('absolute', episode.absolute))
      .collect();
    for (const row of all) if (allowed(row.ordering) && (await keep(row.unitId))) rows.push(row);
    const scene = rows.filter((row) => row.source !== 'manual' && row.ordering === 'scene');
    const sceneUnits = new Set(scene.map((row) => row.unitId)).size;
    const manual = rows.find((row) => row.source === 'manual');
    if (!manual && sceneUnits > 1) return ambiguous((await unitsOfRows(ctx, scene)).unitIds);
    const best = manual ?? (sceneUnits === 1 ? scene[0] : undefined) ?? rows.find((row) => row.ordering === 'absolute');
    const found = best ? await unitsOfRows(ctx, [best]) : { unitIds: [] };
    if (best && found.unitIds.length > 0) via = { ordering: best.ordering, source: best.source };
    perNumber.push(found.unitIds);
  }
  return { perNumber, via, confidence: 'mapped' };
}

/** Whether TMDB, a `scene` row or a `tvdb` row puts the Unit in this season. */
const inSeason =
  (ctx: QueryCtx, season: number) =>
  async (unitId: Id<'units'>): Promise<boolean> => {
    if ((await ctx.db.get(unitId))?.tmdbSeason === season) return true;
    const rows = await ctx.db
      .query('unitMappings')
      .withIndex('by_unit', (q) => q.eq('unitId', unitId))
      .collect();
    return rows.some((row) => (row.ordering === 'scene' || row.ordering === 'tvdb') && row.season === season);
  };

/**
 * Rule 4 for a title that names a season (`Ember Rite S2 - 02`):
 * the number read within that season by rule 3, or as an absolute number
 * that lands in it. A Unit of another season is never returned; when both
 * readings find different Units, the release is `ambiguous`.
 */
async function byNamedSeason(
  ctx: QueryCtx,
  workId: Id<'works'>,
  season: number,
  episodes: ParsedEpisode[],
  allowed: Allowed,
  keep: (unitId: Id<'units'>) => Promise<boolean>,
): Promise<Found | Ambiguous | null> {
  const numbers = episodes.filter((e) => e.absolute !== undefined);
  const within = await bySeasonEpisode(
    ctx,
    workId,
    numbers.map((e) => ({ season, episode: e.absolute })),
    allowed,
  );
  const absolute = await byAbsolute(ctx, workId, numbers, allowed, keep);
  if (isAmbiguous(absolute)) return ambiguous(absolute, anyFound(within) ? within : null);
  const byNumber = within && complete(within) ? within : null;
  const byAbsoluteNumber = absolute && complete(absolute) ? absolute : null;
  if (byNumber && byAbsoluteNumber && !sameUnits(flat(byNumber), flat(byAbsoluteNumber))) return ambiguous(byNumber, byAbsoluteNumber);
  return byNumber ?? byAbsoluteNumber;
}

/**
 * Rule 4 for a title that matched an alias XEM lists under one scene season
 * (`JoJo's Bizarre Adventure - Stone Ocean`):
 * the number read in that scene season only, as its episode or as its scene
 * absolute number. A Unit outside the scene season is never returned; when
 * the two readings find different Units, the release is `ambiguous`.
 */
async function bySceneSeason(
  ctx: QueryCtx,
  workId: Id<'works'>,
  season: number,
  episodes: ParsedEpisode[],
  allowed: Allowed,
): Promise<Found | Ambiguous | null> {
  if (!allowed('scene')) return null;
  const rows = await byOrdering(ctx, workId, 'scene', season, undefined);
  let source: Doc<'unitMappings'>['source'] = 'xem';
  const perNumber: Id<'units'>[][] = [];
  for (const { absolute } of episodes.filter((e) => e.absolute !== undefined)) {
    const asEpisode = await unitsOfRows(
      ctx,
      rows.filter((row) => row.episode === absolute),
    );
    const asAbsolute = await unitsOfRows(
      ctx,
      rows.filter((row) => row.absolute === absolute),
    );
    if (asEpisode.unitIds.length > 0 && asAbsolute.unitIds.length > 0 && !sameUnits(asEpisode.unitIds, asAbsolute.unitIds))
      return ambiguous(asEpisode.unitIds, asAbsolute.unitIds);
    const found = asEpisode.unitIds.length > 0 ? asEpisode : asAbsolute;
    if (found.source) source = found.source;
    perNumber.push(found.unitIds);
  }
  return { perNumber, via: { ordering: 'scene', source }, confidence: 'mapped' };
}

type PartSeasonReading = {
  orderings: (allowed: Allowed) => Allowed;
  byAbsolute: (ctx: QueryCtx, workId: Id<'works'>, season: number, episodes: ParsedEpisode[], inPart: Allowed) => Promise<Found | Ambiguous | null>;
  unclearAs: Partial<Pick<ResolveResult, 'via' | 'confidence'>>;
};

type PartSeason = { season: number; reading: PartSeasonReading; inPart: Allowed };

const partSeason = (season: number, reading: PartSeasonReading, allowed: Allowed): PartSeason => ({ season, reading, inPart: reading.orderings(allowed) });

const VIA_SCENE = { via: { ordering: 'scene', source: 'xem' }, confidence: 'mapped' } as const;

const inTmdbSeason = (ctx: QueryCtx, season: number) => async (unitId: Id<'units'>) => (await ctx.db.get(unitId))?.tmdbSeason === season;

const PART_SEASON_READINGS: Record<PartSeasonOrdering, PartSeasonReading> = {
  scene: {
    orderings: (allowed) => (ordering) => ordering === 'scene' && allowed(ordering),
    byAbsolute: bySceneSeason,
    unclearAs: VIA_SCENE,
  },
  tmdb: {
    orderings: (allowed) => (ordering) => (ordering === 'tmdb' || ordering === 'absolute') && allowed(ordering),
    byAbsolute: (ctx, workId, season, episodes, inPart) => byNamedSeason(ctx, workId, season, episodes, inPart, inTmdbSeason(ctx, season)),
    unclearAs: {},
  },
};

async function byPartSeason(
  ctx: QueryCtx,
  workId: Id<'works'>,
  part: PartSeason,
  episodes: ParsedEpisode[],
  allowed: Allowed,
): Promise<Found | Ambiguous | null> {
  const { season, reading, inPart } = part;
  const numbers = episodes.filter((e) => e.season !== undefined);
  const ifComplete = (found: Found | null) => (found && complete(found) ? found : null);
  const partReading = () =>
    bySeasonEpisode(
      ctx,
      workId,
      numbers.map((e) => ({ season, episode: e.episode })),
      inPart,
    );
  const nameAndSeasonDisagree = numbers.some((e) => e.season !== season && e.season !== 1);
  if (nameAndSeasonDisagree) return ambiguous(ifComplete(await partReading()), ifComplete(await bySeasonEpisode(ctx, workId, numbers, allowed)));
  const found = await partReading();
  if (found && complete(found) && episodes.some((e) => e.absolute !== undefined)) {
    const absolute = await reading.byAbsolute(ctx, workId, season, episodes, inPart);
    if (isAmbiguous(absolute) || (absolute && complete(absolute) && !sameUnits(flat(absolute), flat(found)))) return ambiguous(found, absolute);
  }
  return found;
}

const flat = (found: Found) => [...new Set(found.perNumber.flat())];
const sameUnits = (a: Id<'units'>[], b: Id<'units'>[]) => a.length === b.length && a.every((id) => b.includes(id));

/**
 * The Units a release's numbers name, by the first rule that finds any:
 * air date, the alias's AniDB ordering, season and episode, absolute numbers.
 * `orderings` limits rules 3 and 4 to those orderings, for the scan, which
 * tries one numbering at a time.
 * Retired Units are never returned.
 */
export async function resolveUnits(
  ctx: QueryCtx,
  workId: Id<'works'>,
  episodes: ParsedEpisode[],
  airDate: string | undefined,
  alias: MatchedAlias,
  options: { orderings?: ResolveOrdering[] } = {},
): Promise<ResolveResult> {
  const allowed: Allowed = options.orderings ? (ordering) => (options.orderings as string[]).includes(ordering) : allOrderings;
  const work = await ctx.db.get(workId);
  const none: ResolveResult = { unitIds: [], via: { ordering: 'tmdb', source: 'tmdb' }, confidence: await tmdbConfidence(ctx, workId), problem: 'notFound' };
  if (!work) return none;
  const answer = (found: Found): ResolveResult =>
    complete(found) ? { unitIds: flat(found), via: found.via, confidence: found.confidence } : { ...none, via: found.via, confidence: found.confidence };
  /** No Unit, and the Units the disagreeing readings found. */
  const unclear = (found: Ambiguous, how: Partial<Pick<ResolveResult, 'via' | 'confidence'>> = {}): ResolveResult => ({
    ...none,
    ...how,
    problem: 'ambiguous',
    ...(found.ambiguous.length > 0 ? { possibleUnitIds: found.ambiguous } : {}),
  });

  // A movie is one Unit; its release names no numbers.
  if (work.kind === 'movie') {
    const units = await live(
      ctx,
      await ctx.db
        .query('units')
        .withIndex('by_work', (q) => q.eq('workId', workId))
        .collect(),
    );
    return units.length === 1 ? { unitIds: [units[0]!._id], via: { ordering: 'tmdb', source: 'tmdb' }, confidence: 'mapped' } : none;
  }

  if (airDate !== undefined) {
    const found = await byAirDate(ctx, workId, airDate);
    if (isAmbiguous(found)) return unclear(found, { via: { ordering: 'airDate', source: 'tmdb' }, confidence: 'mapped' });
    if (found) return answer(found);
  }

  const anidbId = alias.kind === 'anidb' ? alias.anidbId : undefined;
  if (anidbId !== undefined) {
    const found = await byAnidb(ctx, workId, anidbId, episodes);
    if (anyFound(found)) return answer(found);
  }

  const part = alias.kind === 'partSeason' ? partSeason(alias.season, PART_SEASON_READINGS[alias.ordering], allowed) : undefined;
  // A part's name with season numbers: read within the part, never as another season.
  if (part && episodes.some((e) => e.season !== undefined)) {
    const found = await byPartSeason(ctx, workId, part, episodes, allowed);
    if (isAmbiguous(found)) return unclear(found, part.reading.unclearAs);
    return found ? answer(found) : none;
  }

  const hasAbsolute = episodes.some((e) => e.absolute !== undefined);
  const anime = work.numberingScheme === 'anime';
  const seasonEpisode = await bySeasonEpisode(ctx, workId, episodes, allowed);
  if (anyFound(seasonEpisode)) {
    // Rule 5: an absolute number beside SxxEyy must name the same Units.
    if (hasAbsolute && anime && complete(seasonEpisode)) {
      const absolute = await byAbsolute(ctx, workId, episodes, allowed);
      if (isAmbiguous(absolute) || (anyFound(absolute) && !sameUnits(flat(absolute), flat(seasonEpisode))))
        return unclear(ambiguous(seasonEpisode, absolute), { via: seasonEpisode.via, confidence: seasonEpisode.confidence });
    }
    return answer(seasonEpisode);
  }

  if (hasAbsolute) {
    if (!anime) return { ...none, problem: 'schemeMismatch' };
    if (alias.kind === 'namedSeason') {
      const found = await byNamedSeason(ctx, workId, alias.season, episodes, allowed, inSeason(ctx, alias.season));
      if (isAmbiguous(found)) return unclear(found);
      return found ? answer(found) : none;
    }
    if (part) {
      const found = await part.reading.byAbsolute(ctx, workId, part.season, episodes, part.inPart);
      if (isAmbiguous(found)) return unclear(found, part.reading.unclearAs);
      return found ? answer(found) : none;
    }
    // The alias names an AniDB entry, so an absolute number must land on one of its Units: only their rows count.
    let entryUnits: Set<Id<'units'>> | undefined;
    if (anidbId !== undefined)
      entryUnits = new Set(
        (
          await ctx.db
            .query('unitMappings')
            .withIndex('by_ordering', (q) => q.eq('workId', workId).eq('ordering', `anidb:${anidbId}`))
            .collect()
        ).map((row) => row.unitId),
      );
    const absolute = await byAbsolute(ctx, workId, episodes, allowed, entryUnits ? (unitId) => entryUnits.has(unitId) : undefined);
    if (isAmbiguous(absolute)) return unclear(absolute, VIA_SCENE);
    if (absolute && entryUnits) return answer(absolute);
    if (anyFound(absolute)) return answer(absolute);
  }
  return none;
}

/** Scene names first: release groups name a show as XEM and the scene-mapping list do. */
const SEARCH_TITLE_RANK: Record<AliasSource, number> = { xem: 0, sceneMapping: 0, animeLists: 1, manual: 2, tmdb: 3 };

/**
 * SearchKeys' `searchTitles`: the display title, then the aliases by source
 * rank, one per compact form. A name XEM lists under another scene season
 * than the Units' (a part's name) is left out.
 */
function searchTitlesOf(display: string | undefined, aliases: Doc<'workAliases'>[], sceneSeasons: Set<number>): string[] {
  const ranked = aliases
    .filter((alias) => alias.sceneSeason === undefined || sceneSeasons.has(alias.sceneSeason))
    .sort((a, b) => SEARCH_TITLE_RANK[a.source] - SEARCH_TITLE_RANK[b.source])
    .map((alias) => alias.title);
  const seen = new Set<string>();
  return [...(display === undefined ? [] : [display]), ...ranked].filter((title) => {
    const key = compactTitle(normalizeTitle(title));
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/**
 * What the indexer request plan builds its queries from: the Work's IDs, its
 * titles (the display title first) and, per Unit, scene numbers where they
 * exist, else TMDB's. Units without numbers (a movie) are left out.
 */
export async function searchKeys(ctx: QueryCtx, workId: Id<'works'>, unitIds: Id<'units'>[]): Promise<SearchKeys> {
  const work = await ctx.db.get(workId);
  const ids = await ctx.db
    .query('externalIds')
    .withIndex('by_work', (q) => q.eq('workId', workId))
    .collect();
  const id = (provider: 'tmdb' | 'tvdb' | 'imdb') => ids.find((row) => row.provider === provider)?.value;
  const aliases = await ctx.db
    .query('workAliases')
    .withIndex('by_work', (q) => q.eq('workId', workId))
    .collect();
  const titles = [...new Set([...(work ? [work.title] : []), ...aliases.map((alias) => alias.title)])];

  const units: UnitRef[] = [];
  const airDates: (number | undefined)[] = [];
  for (const unitId of unitIds) {
    const unit = await ctx.db.get(unitId);
    airDates.push(unit?.airDateUtc);
    if (!unit || unit.tmdbSeason === undefined || unit.tmdbEpisode === undefined) continue;
    const rows = await ctx.db
      .query('unitMappings')
      .withIndex('by_unit', (q) => q.eq('unitId', unitId))
      .collect();
    const scene = rows.find((row) => row.ordering === 'scene' && row.source === 'manual') ?? rows.find((row) => row.ordering === 'scene');
    const absolute = scene?.absolute ?? rows.find((row) => row.ordering === 'absolute')?.absolute;
    const season = scene?.season ?? unit.tmdbSeason;
    const episode = scene?.episode ?? unit.tmdbEpisode;
    units.push(absolute === undefined ? { unitId, season, episode } : { unitId, season, episode, absolute });
  }
  const tvdbId = id('tvdb');
  const imdbId = id('imdb');
  const lastAirDateUtc = airDates.length > 0 && airDates.every((at) => at !== undefined) ? Math.max(...(airDates as number[])) : undefined;
  return {
    tmdbId: id('tmdb') ?? '',
    ...(tvdbId ? { tvdbId } : {}),
    ...(imdbId ? { imdbId } : {}),
    titles,
    searchTitles: searchTitlesOf(work?.title, aliases, new Set(units.map((unit) => unit.season))),
    units,
    ...(lastAirDateUtc === undefined ? {} : { lastAirDateUtc }),
  };
}

// Internal query wrappers, for actions.

export const findWorks = internalQuery({
  args: zodToConvexFields({ normalizedTitle: z.string() }),
  returns: zodToConvex(z.array(z.object({ workId: zid('works'), aliasId: zid('workAliases'), anidbId: z.number().optional() }))),
  handler: (ctx, { normalizedTitle }) => findWorksByTitle(ctx, normalizedTitle),
});

export const resolve = internalQuery({
  args: zodToConvexFields({
    workId: zid('works'),
    episodes: z.array(ParsedEpisode),
    airDate: z.string().optional(),
    alias: MatchedAlias,
    orderings: z.array(ResolveOrdering).optional(),
  }),
  returns: zodToConvex(ResolveResult),
  handler: (ctx, { workId, episodes, airDate, alias, orderings }) =>
    resolveUnits(ctx, workId, episodes, airDate, alias, orderings === undefined ? {} : { orderings }),
});

export const keys = internalQuery({
  args: zodToConvexFields({ workId: zid('works'), unitIds: z.array(zid('units')) }),
  returns: zodToConvex(SearchKeys),
  handler: (ctx, { workId, unitIds }) => searchKeys(ctx, workId, unitIds),
});
