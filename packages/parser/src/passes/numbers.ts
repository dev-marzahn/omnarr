// Pass 2, numbers. The library mapping (wrap.ts) already relabels
// season-less episode numbers as absolute numbers and turns its local-midnight
// air date into a calendar date; this pass reads what the library leaves out.
import type { ParsedRelease } from '@omnarr/contracts';

import { EPISODE_MARK } from './cleanup.ts';
import { withTitle } from './title.ts';
import { QUALITY_TOKEN, tokensOf } from './tokens.ts';

const YEAR = /^(19|20)\d\d$/;

/** `S02E05 (1071)` or `S02E05 - 1071`: an absolute number right after a single SxxEyy. */
const DUAL = /\bS\d{1,4}E\d{1,4}\s*(?:\(\s*(\d{2,4})\s*\)|-\s*(\d{2,4})(?![\dp]))/i;

function dualNumbering(cleanTitle: string, partial: ParsedRelease): ParsedRelease['episodes'] {
  const [only, ...more] = partial.episodes;
  if (!only || more.length > 0 || only.season === undefined || only.episode === undefined || only.absolute !== undefined) return partial.episodes;
  const match = DUAL.exec(cleanTitle);
  const absolute = match?.[1] ?? match?.[2];
  if (absolute === undefined || YEAR.test(absolute)) return partial.episodes;
  return [{ ...only, absolute: Number(absolute) }];
}

/**
 * In a series search the library reads a movie's year as SxxEyy
 * (`The.Net.1995` → S19E95). When the title writes no episode and has that
 * year as a token, it is the year.
 */
function yearReadAsEpisode(cleanTitle: string, partial: ParsedRelease): number | undefined {
  const [only, ...more] = partial.episodes;
  if (!only || more.length > 0 || only.season === undefined || only.episode === undefined || EPISODE_MARK.test(cleanTitle)) return undefined;
  const year = `${only.season}${String(only.episode).padStart(2, '0')}`;
  return YEAR.test(year) && tokensOf(cleanTitle).includes(year) ? Number(year) : undefined;
}

const DAY_OR_MONTH = /^\d{1,2}$/;

/** A year that is part of a date: `16.11.2026` or `2026.11.17`. */
function inDate(tokens: string[], i: number): boolean {
  const before = DAY_OR_MONTH.test(tokens[i - 1] ?? '') && DAY_OR_MONTH.test(tokens[i - 2] ?? '');
  const after = DAY_OR_MONTH.test(tokens[i + 1] ?? '') && DAY_OR_MONTH.test(tokens[i + 2] ?? '');
  return before || after;
}

/** A year token before the first quality token, not the title's first word and not part of a date. */
function yearOf(cleanTitle: string, partial: ParsedRelease): number | undefined {
  if (partial.year !== undefined) return partial.year;
  if (partial.airDate !== undefined) return undefined;
  const tokens = tokensOf(cleanTitle);
  for (let i = 1; i < tokens.length; i += 1) {
    const token = tokens[i]!;
    if (QUALITY_TOKEN.test(token)) return undefined;
    if (YEAR.test(token) && !inDate(tokens, i)) return Number(token);
  }
  return undefined;
}

/**
 * `[Group] Title Part 2 - 05`: a cour (`Part N`) in the title, then the
 * episode. The library reads `Part 2` as the episode or `Season 3 Part 2` as
 * a season pack, which drops the part; the part stays in the title, and the
 * number after the dash is the absolute number.
 */
const PART_DASH_EPISODE = /^(?:\[[^\]]+\]\s*)?(.+?\bPart\s?(\d{1,2}))\s+-\s+(\d{2,4})(?:v\d)?(?![\d-])/i;

function partDashEpisode(cleanTitle: string, partial: ParsedRelease): ParsedRelease {
  const match = PART_DASH_EPISODE.exec(cleanTitle);
  // A title that kept its part (`Title (Final Season Part 2) - 05`) was read right.
  if (!match || new RegExp(`\\bpart ${match[2]}\\b`).test(partial.normalizedTitle)) return partial;
  const { pack: _pack, ...release } = partial;
  return { ...withTitle(release, match[1]!.trim()), episodes: [{ absolute: Number(match[3]) }] };
}

export function numbers(cleanTitle: string, input: ParsedRelease): ParsedRelease {
  const partial = partDashEpisode(cleanTitle, input);
  const release = { ...partial, episodes: dualNumbering(cleanTitle, partial) };
  const misread = yearReadAsEpisode(cleanTitle, release);
  if (misread !== undefined) {
    release.episodes = [];
    release.year ??= misread;
  }
  const year = yearOf(cleanTitle, release);
  if (year !== undefined) release.year = year;
  if (release.episodes.some((episode) => episode.season === 0)) release.special = true;
  return release;
}
