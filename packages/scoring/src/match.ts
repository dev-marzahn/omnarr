// Matching a release to a Work and its Units. The backend's resolveUnits runs
// between matchTitle and matchUnits.
import type { IndexerItem, ParsedRelease, ResolveResult } from '@omnarr/contracts';
import { compactTitle, normalizeTitle, titleSides } from '@omnarr/parser';

import type { Id } from './ids.ts';

export type WorkForMatch = {
  kind: 'series' | 'movie';
  year?: number;
  /** `sceneSeason`: the scene season XEM lists the alias under (a part's name). */
  aliases: { aliasId: Id<'workAliases'>; normalized: string; anidbId?: number; sceneSeason?: number }[];
  /** The Work's named TMDB seasons, each with its scene season. */
  seasonNames?: SeasonName[];
  /** IMDb with its "tt" prefix, as externalIds stores it. */
  ids: { tmdb: string; tvdb?: string; imdb?: string };
};

/** A TMDB season's own name (`Steel Ball Run`), normalized, and the one scene season XEM gives its episodes. */
export type SeasonName = { normalized: string; sceneSeason: number };

/** `part 7` between the show's name and the season's: the part's number, which says nothing the season name doesn't. */
const PART_NUMBER = / part \d{1,2}$/;

/**
 * A normalized title that is an alias and a season's name, in either order:
 * `<alias> <season>`, `<alias> part N <season>` or `<season> <alias>`
 * (normalizing drops `:` and `-`). `aliasOf` says whether the rest is an
 * alias; the result is that alias and the season's scene season.
 */
export function splitSeasonName<A>(
  normalized: string,
  seasons: SeasonName[],
  aliasOf: (rest: string) => A | undefined,
): { alias: A; sceneSeason: number } | undefined {
  for (const { normalized: name, sceneSeason } of seasons) {
    const before = normalized.endsWith(` ${name}`) ? aliasOf(normalized.slice(0, -name.length - 1).replace(PART_NUMBER, '')) : undefined;
    const after = before ?? (normalized.startsWith(`${name} `) ? aliasOf(normalized.slice(name.length + 1)) : undefined);
    if (after !== undefined) return { alias: after, sceneSeason };
  }
  return undefined;
}

/** The resolveUnits result. */
export type { ResolveResult };

/**
 * `season` is a season the title names after an alias without an AniDB link
 * (`Ember Rite S2`, `Ember Rite 2nd Season`); resolveUnits reads an anime
 * release's number within it. `sceneSeason` is the scene season of the alias
 * that matched, when XEM lists it under one; resolveUnits reads an absolute
 * number in that scene season.
 */
export type TitleMatch =
  | { ok: true; aliasId?: Id<'workAliases'>; anidbId?: number; season?: number; sceneSeason?: number }
  | { ok: false; detail: 'title' | 'kind' | 'extras' };

/**
 * A wrong episode keeps resolveUnits' `problem`, and for `ambiguous` the
 * Units the readings found, so the item page can show what it could be and a
 * manual grab can pick one.
 */
export type MatchResult =
  | { ok: true; coveredUnitIds: Id<'units'>[]; alsoContainsUnitIds: Id<'units'>[]; matchDetail: string }
  | { ok: false; detail: 'episode' | 'otherEpisode'; problem?: NonNullable<ResolveResult['problem']>; possibleUnitIds?: Id<'units'>[] };

const words = (normalized: string) => normalized.split(' ').filter(Boolean);
const stripTt = (imdb: string) => imdb.replace(/^tt/i, '');

/** Whether the item carries one of the Work's IDs (IMDb compared without "tt"). */
function sharesId(item: IndexerItem, work: WorkForMatch): boolean {
  const { tvdbid, tmdbid, imdbid } = item.ids;
  return (
    (tvdbid !== undefined && tvdbid === work.ids.tvdb) ||
    (tmdbid !== undefined && tmdbid === work.ids.tmdb) ||
    (imdbid !== undefined && work.ids.imdb !== undefined && stripTt(imdbid) === stripTt(work.ids.imdb))
  );
}

const yearsAgree = (a: number | undefined, b: number | undefined) => a === undefined || b === undefined || Math.abs(a - b) <= 1;

/**
 * The alias a renamed title matches through an ID: the one sharing the most of
 * the title's words (at least half), then the shortest. Only an alias without
 * a scene season, and one that names every `part N` the title names.
 */
function aliasByWords(parsed: ParsedRelease, work: WorkForMatch): WorkForMatch['aliases'][number] | undefined {
  const title = words(parsed.normalizedTitle);
  if (title.length === 0) return undefined;
  // A part's alias, or a title naming a cour the alias doesn't, would read the number in the wrong part (the part-title fix).
  const parts = parsed.normalizedTitle.match(/\bpart \d{1,2}\b/g) ?? [];
  let best: { alias: WorkForMatch['aliases'][number]; shared: number; size: number } | undefined;
  for (const alias of work.aliases) {
    if (alias.sceneSeason !== undefined || parts.some((part) => !` ${alias.normalized} `.includes(` ${part} `))) continue;
    const aliasWords = new Set(words(alias.normalized));
    const shared = title.filter((word) => aliasWords.has(word)).length;
    if (shared * 2 < title.length) continue;
    if (!best || shared > best.shared || (shared === best.shared && aliasWords.size < best.size)) best = { alias, shared, size: aliasWords.size };
  }
  return best?.alias;
}

/**
 * The alias with this normalized title, else the one equal to it in compact
 * form: normalizeTitle deletes hyphens, so `Spider-Man` is `spiderman` but
 * `Spider.Man` is `spider man`.
 */
const aliasFor = (normalized: string, work: WorkForMatch) =>
  work.aliases.find((entry) => entry.normalized === normalized) ?? work.aliases.find((entry) => compactTitle(entry.normalized) === compactTitle(normalized));

/** A season written after a name, normalized: `s2`, `s02`, `season 2`, `2nd season`. */
const SEASON_MARK = /^(.+) (?:s0*(\d{1,2})|season 0*(\d{1,2})|(\d{1,2})(?:st|nd|rd|th) season)$/;

/**
 * A normalized title split into the name before a trailing season mark and
 * the season it names (`ember rite s02` → `ember rite`, 2). RSS looks the
 * name up when the whole title finds no Work.
 */
export function splitSeasonMark(normalized: string): { base: string; season: number } | undefined {
  const mark = normalized.match(SEASON_MARK);
  const season = Number(mark?.[2] ?? mark?.[3] ?? mark?.[4]);
  return mark && season > 0 ? { base: mark[1]!, season } : undefined;
}

/**
 * The season a title names after another of the Work's aliases. The title
 * without it must be an alias too, so a Work whose own name ends in
 * "2nd Season" isn't read as its season 2.
 */
function namedSeason(normalized: string, work: WorkForMatch): { season: number; base: WorkForMatch['aliases'][number] } | undefined {
  const mark = splitSeasonMark(normalized);
  const base = mark ? aliasFor(mark.base, work) : undefined;
  return base && mark ? { season: mark.season, base } : undefined;
}

/**
 * Decides whether a parsed release names the Work, and returns the alias that
 * matched. A dual title (`中文名 / English Title`) that is no alias as a whole
 * matches through its first side that is.
 */
export function matchTitle(parsed: ParsedRelease, item: IndexerItem, work: WorkForMatch): TitleMatch {
  const whole = matchName(parsed, item, work);
  if (whole.ok || whole.detail !== 'title') return whole;
  for (const side of titleSides(parsed.title)) {
    const match = matchName({ ...parsed, title: side, normalizedTitle: normalizeTitle(side) }, item, work);
    if (match.ok || match.detail !== 'title') return match;
  }
  return whole;
}

function matchName(parsed: ParsedRelease, item: IndexerItem, work: WorkForMatch): TitleMatch {
  const named = namedSeason(parsed.normalizedTitle, work);
  // `JoJo's Bizarre Adventure Steel Ball Run`: an alias with no season of its own, and a season's name.
  const bySeasonName = splitSeasonName(parsed.normalizedTitle, work.seasonNames ?? [], (rest) => {
    const base = aliasFor(rest, work);
    return base?.sceneSeason === undefined ? base : undefined;
  });
  // `Ember Rite S2` matches through `Ember Rite`, without that alias's AniDB entry: the entry is the first season's. So does a season's name.
  const alias =
    aliasFor(parsed.normalizedTitle, work) ??
    (named ? { ...named.base, anidbId: undefined } : undefined) ??
    (bySeasonName ? { ...bySeasonName.alias, anidbId: undefined, sceneSeason: bySeasonName.sceneSeason } : undefined) ??
    (sharesId(item, work) ? aliasByWords(parsed, work) : undefined);
  if (!alias || (work.kind === 'movie' && !yearsAgree(parsed.year, work.year))) return { ok: false, detail: 'title' };
  const numbered = parsed.episodes.length > 0 || parsed.pack !== undefined;
  if (work.kind === 'series' ? !numbered && parsed.airDate === undefined : numbered) return { ok: false, detail: 'kind' };
  if (parsed.extras) return { ok: false, detail: 'extras' };
  if (alias.anidbId !== undefined) return { ok: true, aliasId: alias.aliasId, anidbId: alias.anidbId };
  if (named) return { ok: true, aliasId: alias.aliasId, season: named.season };
  return alias.sceneSeason === undefined ? { ok: true, aliasId: alias.aliasId } : { ok: true, aliasId: alias.aliasId, sceneSeason: alias.sceneSeason };
}

/** Decides the Units a release covers in the search group, from the resolveUnits result. */
export function matchUnits(resolved: ResolveResult, group: { unitIds: Id<'units'>[]; wantedUnitIds: Id<'units'>[] }, parsed: ParsedRelease): MatchResult {
  void parsed;
  if (resolved.problem !== undefined || resolved.unitIds.length === 0)
    return {
      ok: false,
      detail: 'episode',
      ...(resolved.problem ? { problem: resolved.problem } : {}),
      ...(resolved.possibleUnitIds?.length ? { possibleUnitIds: resolved.possibleUnitIds } : {}),
    };
  const wanted = new Set(group.wantedUnitIds);
  const coveredUnitIds = resolved.unitIds.filter((id) => wanted.has(id));
  // Units of the Work outside this search: kept for the candidate table's "All" view only.
  if (coveredUnitIds.length === 0) return { ok: false, detail: 'otherEpisode' };
  return {
    ok: true,
    coveredUnitIds,
    alsoContainsUnitIds: resolved.unitIds.filter((id) => !wanted.has(id)),
    matchDetail: `${resolved.via.ordering}/${resolved.via.source}, ${resolved.confidence}`,
  };
}

/**
 * When one title matches aliases of several Works (RSS), keeps only the Works
 * whose IDs or year match the release; if more than one is left, none.
 */
export function filterWorks(works: WorkForMatch[], item: IndexerItem, parsed: ParsedRelease): WorkForMatch[] {
  if (works.length <= 1) return works;
  const kept = works.filter((work) => sharesId(item, work) || (parsed.year !== undefined && work.year !== undefined && Math.abs(parsed.year - work.year) <= 1));
  return kept.length === 1 ? kept : [];
}
