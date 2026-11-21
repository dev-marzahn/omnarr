// Title normalization. `normalizeTitle` is the rule for `workAliases.normalized`;
// changing it needs a convex-release migration that recomputes the stored
// values.
import { stripExtension, stripRepostSuffixes } from './passes/cleanup.ts';

/**
 * The form titles are matched in: lowercase, accents folded (NFKD without
 * combining marks), `&` as `and`, punctuation removed, runs of spaces
 * collapsed. Years and articles are kept; the Work's year is compared
 * separately.
 */
export function normalizeTitle(title: string): string {
  return title.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/&/g, ' and ').replace(/\p{P}/gu, '').replace(/\s+/g, ' ').trim();
}

/**
 * A normalized title without its spaces, stored as `workAliases.compact`.
 * `normalizeTitle` deletes hyphens, so `Spider-Man` is `spiderman` but
 * `Spider.Man` is `spider man`; their compact forms are equal.
 * Changing it needs a migration of `workAliases.compact`.
 */
export function compactTitle(normalized: string): string {
  return normalized.replaceAll(' ', '');
}

const CJK = '\\p{Script=Han}\\p{Script=Hiragana}\\p{Script=Katakana}\\p{Script=Hangul}';
/** ` / ` between two names, or a bare `/` next to a CJK name; never the slash in `Fate/Zero`. */
const SIDE_SEPARATOR = new RegExp(`\\s+/\\s+|(?<=[${CJK}])\\s*/\\s*|\\s*/\\s*(?=[${CJK}])`, 'u');

/**
 * The names of a dual title, as fansub groups write a show in two or more
 * languages: `中文名 / English Title`, `飙马野郎/JoJo's Bizarre Adventure`.
 * Empty when the title is a single name. The matcher tries each side when
 * the whole title is no alias.
 */
export function titleSides(title: string): string[] {
  const sides = title
    .split(SIDE_SEPARATOR)
    .map((side) => side.trim())
    .filter(Boolean);
  return sides.length > 1 ? sides : [];
}

/** A CRC32 tag at the end, as anime groups add it: `[5A6B7C8D]`. */
const TRAILING_CRC32 = /\s*\[[0-9a-f]{8}\]$/i;

/**
 * The blocklist's second key: a re-post of the
 * same release under a new GUID gets the same key, a different encode
 * doesn't. Keeps the group and every quality token. Brackets and parentheses
 * are separators and a trailing CRC32 tag goes, so `[Grp].Title-30.1080p` and
 * `[Grp] Title - 30 (1080p) [5A6B7C8D]` share a key.
 * Changing it needs a migration of `blocklist.normalizedTitle`.
 */
export function normalizeReleaseTitle(title: string): string {
  return stripRepostSuffixes(stripExtension(title).title)
    .replace(TRAILING_CRC32, '')
    .toLowerCase()
    .replace(/[._\-\s[\]()]+/g, ' ')
    .trim();
}
