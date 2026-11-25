// Pass 1, clean-up. Runs before the library on the raw title.
import { type Container, Resolution } from '@omnarr/contracts';

import { REPOST_SUFFIXES } from '../tables/repostSuffixes.ts';
import { EPISODE_MARK, QUALITY_TOKEN, tokensOf, versionCapture, YEAR, YEAR_DIGITS } from './tokens.ts';

const EXTENSION = /\.(mkv|mp4|avi|m2ts|ts)$/i;

/** Removes a video file extension and says which container it named. */
export function stripExtension(title: string): { title: string; container?: Container } {
  const match = EXTENSION.exec(title.trimEnd());
  if (!match) return { title };
  return { title: title.trimEnd().slice(0, match.index), container: match[1]!.toLowerCase() as Container };
}

/** `www.site.org -`, `[ www.site.org ] -` and the like before the name. */
const WEBSITE_PREFIX = /^\[?\s*www\.[\w-]+(\.[\w-]+)*\.[a-z]{2,}\s*\]?\s*-?\s*/i;
const REQ_PREFIX = /^\[req\]\s*/i;

/** `[Group].[WEB][1080p].Title…`: bracketed tags between a leading group and the title. */
const LEADING_TAGS = /^(\[[^\]]+\])[.\s_]*((?:\[[^\]]+\][.\s_]*)+)(?=[^\s[.])/;

/**
 * The library reads `[Group].[WEB][1080p].Title-07` as the title `[] Title`
 * and no group; with the tags moved behind the title it reads both.
 */
function moveLeadingTags(title: string): string {
  const match = LEADING_TAGS.exec(title);
  if (!match) return title;
  const tags = match[2]!.replace(/[.\s_]+$/, '').replace(/\][.\s_]+\[/g, '][');
  return `${match[1]} ${title.slice(match[0].length)} ${tags}`;
}

/** `【Group】[Title][03]` or `[Group][Title][03]`: a bracketed title, then a bracketed episode number. */
const BRACKETED_TITLE = new RegExp(`^[[【]([^\\]】]+)[\\]】]\\s*\\[([^\\]]*\\p{L}[^\\]]*)\\]\\s*\\[(\\d{1,4})(?:${versionCapture('version')})?\\]`, 'u');

/** The library finds no title or number there; `[Group] Title - 03` it reads. */
function unbracketTitle(title: string): string {
  const match = BRACKETED_TITLE.exec(title);
  if (!match) return title;
  return `[${match[1]}] ${match[2]!.trim()} - ${match[3]}${title.slice(match[0].length)}`;
}

/** `[01-08]`: a bracketed episode range, which the library reads only in parentheses. Years (`[2019-2020]`) aren't ranges. */
const BRACKETED_RANGE = /\[(\d{2,4})\s*[-~]\s*(\d{2,4})\]/;

function replaceMatch(title: string, match: RegExpExecArray, replacement: string): string {
  return `${title.slice(0, match.index)}${replacement}${title.slice(match.index + match[0].length)}`;
}

function bracketedRange(title: string): string {
  const match = BRACKETED_RANGE.exec(title);
  if (!match || YEAR.test(match[1]!) || YEAR.test(match[2]!)) return title;
  return replaceMatch(title, match, `(${match[1]}-${match[2]})`);
}

const RESOLUTION_DIGITS = `(?:${Resolution.options.map((option) => option.value).join('|')})`;
const YEAR_OR_RESOLUTION = `(?:${YEAR_DIGITS}|${RESOLUTION_DIGITS})(?!\\d)`;
const NOT_YEAR_OR_RESOLUTION = `(?!${YEAR_OR_RESOLUTION})`;
const FURTHER_EPISODE_MARK = `(?:-E?|E)${NOT_YEAR_OR_RESOLUTION}`;
const optionalVersion = (name: string): string => `(?:${versionCapture(name)})?`;
const SEASON_DASH = '\\bS(?<season>[1-9]\\d?)-';
const TAIL_END = '(?![a-z\\d])';
const EPISODES_END = `(?![\\dp]|e\\d|-e\\d|-${NOT_YEAR_OR_RESOLUTION}\\d)(?<dashBeforeResolution>-(?=${RESOLUTION_DIGITS}${TAIL_END}))?`;
const SEASON_DASH_NUMBER_EPISODES = new RegExp(
  `${SEASON_DASH}\\d{1,4}E(?<first>\\d{1,4})(?:(?:${FURTHER_EPISODE_MARK}\\d{1,4})*${FURTHER_EPISODE_MARK}(?<last>\\d{1,4}))?${optionalVersion('lastVersion')}${EPISODES_END}`,
  'i',
);
const SEASON_DASH_EPISODES = new RegExp(
  `${SEASON_DASH}(?<first>\\d{2,4})${optionalVersion('firstVersion')}(?:-${NOT_YEAR_OR_RESOLUTION}(?<last>\\d{2,4})${optionalVersion('lastVersion')})?${EPISODES_END}`,
  'i',
);
const LEADING_BRACKET = /^\[([^\]]+)\]/;

const twoDigits = (n: number): string => String(n).padStart(2, '0');

function startsWithGroup(title: string): boolean {
  const bracket = LEADING_BRACKET.exec(title)?.[1];
  return bracket !== undefined && !tokensOf(bracket).every((token) => QUALITY_TOKEN.test(token));
}

interface SeasonEpisodes {
  season: number;
  first: number;
  last?: number;
  version?: number;
}

function seasonEpisodes(season: string, first: string, last: string | undefined, version: string | undefined): SeasonEpisodes {
  return {
    season: Number(season),
    first: Number(first),
    ...(last === undefined ? {} : { last: Number(last) }),
    ...(version === undefined ? {} : { version: Number(version) }),
  };
}

const isAscending = ({ first, last }: SeasonEpisodes): boolean => last === undefined || first <= last;

function cannotBeSeasonRange(title: string, { season, first, last }: SeasonEpisodes): boolean {
  return last !== undefined || startsWithGroup(title) || first <= season;
}

const isSingleEpisode = ({ first, last }: SeasonEpisodes): boolean => last === undefined || last === first;

function episodeMark(episodes: SeasonEpisodes): string {
  const { season, first, last, version } = episodes;
  const rangeEnd = last === undefined || isSingleEpisode(episodes) ? '' : `E${twoDigits(last)}`;
  const revision = version === undefined ? '' : `.v${version}`;
  return `S${twoDigits(season)}E${twoDigits(first)}${rangeEnd}${revision}`;
}

interface SeasonDashForm {
  pattern: RegExp;
  accepts: (title: string, episodes: SeasonEpisodes) => boolean;
}

const SEASON_DASH_FORMS: readonly SeasonDashForm[] = [
  { pattern: SEASON_DASH_NUMBER_EPISODES, accepts: (_title, episodes) => isAscending(episodes) },
  { pattern: SEASON_DASH_EPISODES, accepts: (title, episodes) => isAscending(episodes) && cannotBeSeasonRange(title, episodes) },
];

function singleSeasonDashEpisodeKeptApartFromDashedResolution(episodes: SeasonEpisodes, dashBeforeResolution: string | undefined): string {
  if (dashBeforeResolution === undefined) return '';
  return isSingleEpisode(episodes) ? ' ' : dashBeforeResolution;
}

function seasonDashRewrite({ pattern, accepts }: SeasonDashForm): (title: string) => string {
  return (title) => {
    const match = pattern.exec(title);
    const groups: Record<string, string | undefined> = match?.groups ?? {};
    const { season, first, last, firstVersion, lastVersion, dashBeforeResolution } = groups;
    if (!match || season === undefined || first === undefined || EPISODE_MARK.test(title)) return title;
    const episodes = seasonEpisodes(season, first, last, lastVersion ?? firstVersion);
    if (!accepts(title, episodes)) return title;
    const separator = singleSeasonDashEpisodeKeptApartFromDashedResolution(episodes, dashBeforeResolution);
    return replaceMatch(title, match, `${episodeMark(episodes)}${separator}`);
  };
}

const SINGLE_EPISODE = `\\bS\\d{1,4}E\\d{1,4}`;
const FURTHER_EPISODES = `(?:${FURTHER_EPISODE_MARK}\\d{1,4})`;
const NOT_A_FOUR_DIGIT_RANGE_END = '(?<!\\d{4})';
const OPTIONAL_MARK_VERSION = `(?:\\.?${versionCapture('version')})?`;

interface DashedTailForm {
  pattern: RegExp;
  written: (tail: string) => string;
}

const dashedTail = (episodes: string, tail: string): RegExp => new RegExp(`(?<episodes>${episodes}${OPTIONAL_MARK_VERSION})-(?<tail>${tail})${TAIL_END}`, 'i');

const DASHED_TAIL_FORMS: readonly DashedTailForm[] = [
  { pattern: dashedTail(`${SINGLE_EPISODE}${FURTHER_EPISODES}*${NOT_A_FOUR_DIGIT_RANGE_END}`, YEAR_DIGITS), written: (year) => year },
  { pattern: dashedTail(`${SINGLE_EPISODE}${FURTHER_EPISODES}+`, RESOLUTION_DIGITS), written: (resolution) => `${resolution}p` },
];

function dashedTailRewrite({ pattern, written }: DashedTailForm): (title: string) => string {
  return (title) => {
    const match = pattern.exec(title);
    const { episodes, tail } = match?.groups ?? {};
    if (!match || episodes === undefined || tail === undefined) return title;
    return replaceMatch(title, match, `${episodes} ${written(tail)}`);
  };
}

/** `S06E03 … Episode 03`: the library would read only `Episode 03`, as an absolute number, so the SxxEyy is kept. */
const EPISODE_WORD_AFTER_SXXEYY = /(\bS\d{1,4}E\d{1,4}\b.*?)\s*\bEpisode\s+\d{1,4}\b/i;

const withoutEpisodeWordAfterSxxEyy = (title: string): string => title.replace(EPISODE_WORD_AFTER_SXXEYY, '$1');

const withoutWebsitePrefix = (title: string): string => title.replace(WEBSITE_PREFIX, '');
const withoutReqPrefix = (title: string): string => title.replace(REQ_PREFIX, '');

const TITLE_REWRITES: readonly ((title: string) => string)[] = [
  withoutWebsitePrefix,
  withoutReqPrefix,
  stripRepostSuffixes,
  unbracketTitle,
  bracketedRange,
  ...SEASON_DASH_FORMS.map(seasonDashRewrite),
  ...DASHED_TAIL_FORMS.map(dashedTailRewrite),
  withoutEpisodeWordAfterSxxEyy,
  moveLeadingTags,
];

/**
 * Pass 1: strips the file extension (recorded as `container`), re-poster
 * suffixes, a website prefix and a leading `[req]`, before the library runs.
 */
export function cleanup(raw: string): { cleanTitle: string; container?: Container } {
  const { title, container } = stripExtension(raw.trim());
  const cleanTitle = TITLE_REWRITES.reduce((rewritten, rewrite) => rewrite(rewritten), title);
  return container ? { cleanTitle, container } : { cleanTitle };
}

/** Removes re-poster suffixes from the end, however many are stacked. */
export function stripRepostSuffixes(title: string): string {
  let rest = title.trimEnd();
  for (;;) {
    const lower = rest.toLowerCase();
    const suffix = REPOST_SUFFIXES.find((candidate) => lower.endsWith(candidate.toLowerCase()));
    if (!suffix) return rest;
    rest = rest.slice(0, rest.length - suffix.length).trimEnd();
  }
}
