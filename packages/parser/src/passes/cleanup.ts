// Pass 1, clean-up. Runs before the library on the raw title.
import type { Container } from '@omnarr/contracts';

import { REPOST_SUFFIXES } from '../tables/repostSuffixes.ts';

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
const BRACKETED_TITLE = /^[[【]([^\]】]+)[\]】]\s*\[([^\]]*\p{L}[^\]]*)\]\s*\[(\d{1,4})(?:v\d)?\]/u;

/** The library finds no title or number there; `[Group] Title - 03` it reads. */
function unbracketTitle(title: string): string {
  const match = BRACKETED_TITLE.exec(title);
  if (!match) return title;
  return `[${match[1]}] ${match[2]!.trim()} - ${match[3]}${title.slice(match[0].length)}`;
}

/** `[01-08]`: a bracketed episode range, which the library reads only in parentheses. Years (`[2019-2020]`) aren't ranges. */
const BRACKETED_RANGE = /\[(\d{2,4})\s*[-~]\s*(\d{2,4})\]/;
const YEAR = /^(19|20)\d\d$/;

function bracketedRange(title: string): string {
  const match = BRACKETED_RANGE.exec(title);
  if (!match || YEAR.test(match[1]!) || YEAR.test(match[2]!)) return title;
  return `${title.slice(0, match.index)}(${match[1]}-${match[2]})${title.slice(match.index + match[0].length)}`;
}

export const EPISODE_MARK = /\bS\d{1,4}E\d{1,4}|\b\d{1,2}x\d{1,4}\b/i;
const SEASON_DASH_EPISODE = /\bS([1-9]\d?)-(\d{2,4})(v\d)?(?![\dp-])/i;
const LEADING_GROUP = /^\[[^\]]+\]/;

function readsAsEpisode(title: string, season: number, episode: number): boolean {
  return LEADING_GROUP.test(title) || episode <= season;
}

function seasonDashEpisode(title: string): string {
  const match = SEASON_DASH_EPISODE.exec(title);
  if (!match || EPISODE_MARK.test(title)) return title;
  const season = Number(match[1]);
  if (!readsAsEpisode(title, season, Number(match[2]))) return title;
  const revision = match[3] === undefined ? '' : `.${match[3]}`;
  const mark = `S${String(season).padStart(2, '0')}E${match[2]}${revision}`;
  return `${title.slice(0, match.index)}${mark}${title.slice(match.index + match[0].length)}`;
}

/** `S06E03 … Episode 03`: the library would read only `Episode 03`, as an absolute number, so the SxxEyy is kept. */
const EPISODE_WORD_AFTER_SXXEYY = /(\bS\d{1,4}E\d{1,4}\b.*?)\s*\bEpisode\s+\d{1,4}\b/i;

/**
 * Pass 1: strips the file extension (recorded as `container`), re-poster
 * suffixes, a website prefix and a leading `[req]`, before the library runs.
 */
export function cleanup(raw: string): { cleanTitle: string; container?: Container } {
  const withoutPrefix = raw.trim().replace(WEBSITE_PREFIX, '').replace(REQ_PREFIX, '');
  const { title, container } = stripExtension(withoutPrefix);
  const rewritten = seasonDashEpisode(bracketedRange(unbracketTitle(stripRepostSuffixes(title).trim()))).replace(EPISODE_WORD_AFTER_SXXEYY, '$1');
  const cleanTitle = moveLeadingTags(rewritten);
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
