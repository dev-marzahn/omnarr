// Title fixes after the library mapping: the author's year rule for series and
// one-letter words of dotted titles.
import type { ParsedRelease } from '@omnarr/contracts';

import { normalizeTitle } from '../normalize.ts';
import { YEAR } from './tokens.ts';

const COUNTRY = /^[A-Z]{2}$/;

export function withTitle(partial: ParsedRelease, title: string): ParsedRelease {
  return { ...partial, title, normalizedTitle: normalizeTitle(title) };
}

/**
 * A series title that ends in a year splits the year out
 * (`Tracker.2024.S04E06` → `Tracker`, 2024), also before a country code
 * (`Heartland.2007.CA` → `Heartland CA`, 2007). Series only: a movie's year
 * is the library's, and a movie title such as "Blade Runner 2049" keeps its number.
 */
export function seriesTitleYear(cleanTitle: string, partial: ParsedRelease): ParsedRelease {
  void cleanTitle;
  const words = partial.title.split(' ');
  const last = words.length - 1;
  let at = -1;
  if (words.length > 1 && YEAR.test(words[last]!)) at = last;
  else if (words.length > 2 && YEAR.test(words[last - 1]!) && COUNTRY.test(words[last]!)) at = last - 1;
  if (at < 0) return partial;
  const year = Number(words[at]);
  const release = withTitle(partial, words.filter((_word, i) => i !== at).join(' '));
  if (release.year === undefined) release.year = year;
  return release;
}

/**
 * The library keeps the dot of a one-letter word in a dotted title
 * (`I.Know.What…` → `I. Know What…`). In a title written with dots, that dot
 * was a separator.
 */
export function titleInitials(cleanTitle: string, partial: ParsedRelease): ParsedRelease {
  if (/\s/.test(cleanTitle.trim())) return partial;
  const title = partial.title.replace(/(^|\s)(\p{L})\.(?=\s)/gu, '$1$2');
  return title === partial.title ? partial : withTitle(partial, title);
}
