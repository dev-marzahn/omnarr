// Pure rules for numbers, dates and titles: the numbering
// scheme suggestion, a movie's date, the Absolute group choice and the
// alias list. No Convex imports.
import type { AliasReading, AliasSource, NumberingReason, NumberingScheme, PartSeason, SeasonName, SeasonNameForMatch, WorkKind } from '@omnarr/contracts';
import { compactTitle, normalizeTitle } from '@omnarr/parser';
import { namesEveryRelease, splitSeasonName } from '@omnarr/scoring';

/** TMDB's genre ID for Animation. */
const ANIMATION = 16;

/**
 * The numbering scheme to preselect: `anime` when Anime-Lists has an entry
 * for the series, else when TMDB lists it as Animation from Japan (the
 * fallback). Movies are always `standard`.
 */
export function suggestNumbering(
  work: { kind: WorkKind; genreIds: number[]; originCountry: string[] },
  inAnimeLists: boolean,
): { scheme: NumberingScheme; reason: NumberingReason } {
  if (work.kind === 'movie') return { scheme: 'standard', reason: 'none' };
  if (inAnimeLists) return { scheme: 'anime', reason: 'animeLists' };
  if (work.genreIds.includes(ANIMATION) && work.originCountry.includes('JP')) return { scheme: 'anime', reason: 'genreOrigin' };
  return { scheme: 'standard', reason: 'none' };
}

/** A TMDB date (`YYYY-MM-DD`, or an ISO time whose date part counts) as 00:00 UTC; unknown when absent. */
export const utcDate = (date?: string | null): number | undefined => (date ? Date.parse(`${date.slice(0, 10)}T00:00:00Z`) : undefined);

/** TMDB release types, in the order the air date falls back through: Theatrical, Theatrical (limited), Premiere. */
const MOVIE_DATE_TYPES = [3, 2, 1];

/**
 * When a movie counts as aired: its earliest Theatrical date in any
 * country, else the earliest limited theatrical date, else the earliest
 * premiere, else TMDB's top-level `release_date`.
 */
export function movieAirDate(releaseDates: { type: number; releaseDate: string }[], releaseDate: string | null | undefined): number | undefined {
  for (const type of MOVIE_DATE_TYPES) {
    const dates = releaseDates.filter((r) => r.type === type).map((r) => utcDate(r.releaseDate)!);
    if (dates.length) return Math.min(...dates);
  }
  return utcDate(releaseDate);
}

export type TmdbNumber = { tmdbSeason: number; tmdbEpisode: number };

/** TMDB's Absolute (type 2) groups for a series: how many it lists, and the episodes of the one fetched. */
export type AbsoluteGroups = { count: number; episodes?: TmdbNumber[] };

const numberKey = (n: TmdbNumber) => `${n.tmdbSeason}:${n.tmdbEpisode}`;

/**
 * The order `absolute` rows follow: the Absolute group's when there
 * is exactly one and it covers every regular episode TMDB lists, else TMDB
 * order (no `order`), with a note when a group was passed over.
 */
export function selectAbsoluteOrder(regular: TmdbNumber[], groups: AbsoluteGroups | undefined): { order?: TmdbNumber[]; note?: string } {
  if (!groups || groups.count === 0) return {};
  if (groups.count > 1) return { note: `TMDB lists ${groups.count} Absolute episode groups; absolute numbers follow TMDB order.` };
  const inGroup = new Set((groups.episodes ?? []).map(numberKey));
  const missing = regular.filter((n) => !inGroup.has(numberKey(n))).length;
  if (missing > 0)
    return { note: `TMDB's Absolute episode group leaves out ${missing} of ${regular.length} regular episodes; absolute numbers follow TMDB order.` };
  const listed = new Set(regular.map(numberKey));
  return { order: groups.episodes!.filter((n) => listed.has(numberKey(n))) };
}

export type Alias = AliasReading & { title: string; normalized: string; source: Exclude<AliasSource, 'manual'> };

type AliasIdentity = AliasReading & { source: AliasSource; normalized: string };

const nameKey = ({ source, normalized, anidbId, releaseSeason, filter }: AliasIdentity): unknown[] => [source, normalized, anidbId, releaseSeason, filter];

export const aliasIdentity = (alias: AliasIdentity): string => JSON.stringify([...nameKey(alias), alias.partSeason?.season, alias.partSeason?.ordering]);

export type NamedReading = AliasReading & { title: string };

const samePartSeason = (a: PartSeason | undefined, b: PartSeason | undefined) => a?.season === b?.season && a?.ordering === b?.ordering;

/** A linked Anime-Lists entry, and whether its first episode is the Unit with TMDB absolute 1. */
export type AliasEntry = { anidbId: number; name: string; startsAtAbsoluteOne: boolean };

/**
 * The words of a placeholder name, which names nothing: `Season 2`, `2nd Season`,
 * `Part 2`, `Specials`. `The Final Season` is a name (Attack on Titan's season 4):
 * it only ever matches together with one of the Work's aliases.
 */
const GENERIC_WORDS = new Set(['season', 'seasons', 'part', 'specials', 'special']);
const NUMBER_WORD = /^\d+(st|nd|rd|th)?$/;

/** A cour or part number at the end of a normalized title: `… the final season part 2`. */
const TRAILING_PART = / part \d{1,2}$/;

export function seasonNames(input: {
  seasons: { season: number; name?: string }[];
  xemSceneSeasons: Map<number, Set<number>>;
  titles: string[];
}): SeasonName[] {
  const titles = new Set(input.titles.map((title) => compactTitle(normalizeTitle(title))));
  return input.seasons.flatMap(({ season, name }) => {
    const normalized = normalizeTitle(name ?? '');
    const xemScene = [...(input.xemSceneSeasons.get(season) ?? [])];
    const generic = normalized.split(' ').every((word) => GENERIC_WORDS.has(word) || NUMBER_WORD.test(word));
    const splitByXem = xemScene.length > 1;
    if (season === 0 || !normalized || generic || titles.has(compactTitle(normalized)) || splitByXem) return [];
    const stored: SeasonName = { season, name: name!, normalized };
    return [xemScene.length === 1 ? { ...stored, sceneSeason: xemScene[0]! } : stored];
  });
}

/**
 * The aliases a sync writes: TMDB's titles, each linked Anime-Lists
 * entry's name with its AniDB ID, and XEM's names with the scene season XEM
 * lists them under. A title is listed once per source and AniDB ID; one that
 * normalizes to nothing is left out. XEM names that normalize alike but
 * carry different scene seasons keep none.
 *
 * A TMDB title with the same normalized form as the name of an entry that
 * starts after absolute 1 is left out: only the entry's
 * alias then matches, so its AniDB numbering applies. Beside an entry that
 * starts at absolute 1, both stay.
 */
export function aliasList(input: {
  tmdbTitles: string[];
  animeLists: AliasEntry[];
  xemNames: { title: string; sceneSeason?: number }[];
  sceneMappings?: NamedReading[];
  seasonNames?: SeasonNameForMatch[];
}): Alias[] {
  const aliases: Alias[] = [];
  const seen = new Map<string, Alias>();
  const conflicted = new Set<Alias>();
  const laterEntries = new Set(input.animeLists.filter((entry) => !entry.startsAtAbsoluteOne).map((entry) => normalizeTitle(entry.name)));
  const add = (title: string, source: Alias['source'], reading: AliasReading = {}) => {
    const normalized = normalizeTitle(title);
    const key = JSON.stringify(nameKey({ ...reading, source, normalized }));
    const earlier = seen.get(key);
    if (earlier && !samePartSeason(earlier.partSeason, reading.partSeason)) {
      if (namesEveryRelease(earlier)) earlier.partSeason = undefined;
      else conflicted.add(earlier);
    }
    if (!normalized || earlier) return;
    if (source === 'tmdb' && laterEntries.has(normalized)) return;
    const alias: Alias = { title, normalized, source, ...reading };
    seen.set(key, alias);
    aliases.push(alias);
  };
  for (const title of input.tmdbTitles) add(title, 'tmdb');
  for (const entry of input.animeLists) add(entry.name, 'animeLists', { anidbId: entry.anidbId });
  for (const { title, sceneSeason } of input.xemNames)
    add(title, 'xem', { partSeason: sceneSeason === undefined ? undefined : { season: sceneSeason, ordering: 'scene' } });
  for (const { title, ...reading } of input.sceneMappings ?? []) add(title, 'sceneMapping', reading);
  const general = aliases.filter((alias) => alias.anidbId === undefined && alias.partSeason === undefined && namesEveryRelease(alias));
  for (const alias of general) {
    const split = splitSeasonName(alias.normalized, input.seasonNames ?? [], (rest) =>
      general.find((other) => other !== alias && compactTitle(other.normalized) === compactTitle(rest)),
    );
    if (split?.seasonName.sceneSeason !== undefined) alias.partSeason = { season: split.seasonName.sceneSeason, ordering: 'scene' };
  }
  // `Attack on Titan: The Final Season Part 2` with no scene season of its own: a cour nothing places. Its number would be
  // read across the whole series, a wrong episode, so it isn't written, and its releases are rejected (the part-title fix).
  const unplaced = (alias: Alias) =>
    alias.anidbId === undefined &&
    alias.partSeason === undefined &&
    TRAILING_PART.test(alias.normalized) &&
    general.some((other) => other !== alias && other.partSeason === undefined && alias.normalized.startsWith(`${other.normalized} `));
  return aliases.filter((alias) => !unplaced(alias) && !conflicted.has(alias));
}
