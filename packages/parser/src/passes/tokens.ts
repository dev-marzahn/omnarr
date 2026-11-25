// Tokenizing a clean title for the platform's passes. Tokens are split
// on `.`, `_`, spaces and brackets; hyphenated compounds (`WEB-DL`, `DTS-HD`,
// `Multi-Subs`) stay one token, and `parts` splits them.
import type { ParsedRelease } from '@omnarr/contracts';

const SEPARATORS = /[.\s_[\](){}]+/;

/** Every token, without separator-only ones such as a lone `-`. */
export function tokensOf(cleanTitle: string): string[] {
  return cleanTitle.split(SEPARATORS).filter((token) => /[\p{L}\p{N}]/u.test(token));
}

/** The hyphen-separated parts of a compound token. */
export const partsOf = (token: string): string[] => token.split('-').filter(Boolean);

export const EPISODE_MARK = /\bS\d{1,4}E\d{1,4}|\b\d{1,2}x\d{1,4}\b/i;
export const versionCapture = (name: string): string => `v(?<${name}>\\d+)(?![a-z\\d])`;
export const YEAR_DIGITS = '(?:19|20)\\d\\d';
export const YEAR = new RegExp(`^${YEAR_DIGITS}$`);

const loose = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]/gu, '');

/** Season, episode, absolute, date and year tokens that follow the title. */
const NUMBERING = new RegExp(
  `^(s\\d{1,4}(e\\d{1,4})*(-?(s|e)?\\d{1,4})*|e\\d{1,4}(-?e?\\d{1,4})*|\\d{1,2}x\\d{1,4}(-?(\\d{1,2}x)?\\d{1,4})*|\\d{1,4}(?:${versionCapture('version')})?|season|seasons|complete|part|episode|ep|vol|volume)$`,
  'i',
);

/** The first token that names the quality: a resolution, a source or a codec. */
export const QUALITY_TOKEN =
  /^(\d{3,4}[pi]|4k|uhd|web|web-?dl|web-?rip|webrip|blu-?ray|bdrip|brrip|bdremux|remux|hdtv|pdtv|sdtv|dvdrip|dvd|dvdr|hdrip|hdcam|cam|ts|tc|x26[45]|h26[45]|hevc|avc|xvid)$/i;

/** Where the title's own tokens end: a leading `[Group]`, then the words of the library's title. */
function titleEnd(tokens: string[], cleanTitle: string, partial: ParsedRelease): number {
  let i = 0;
  if (cleanTitle.trimStart().startsWith('[') && partial.group !== undefined && tokens[0] === partial.group) i = 1;
  for (const word of tokensOf(partial.title)) {
    if (i < tokens.length && loose(tokens[i]!) === loose(word)) i += 1;
    else break;
  }
  return i;
}

/** The index of the first token after the title and its numbers. */
export function numbersEnd(tokens: string[], cleanTitle: string, partial: ParsedRelease): number {
  let i = titleEnd(tokens, cleanTitle, partial);
  while (i < tokens.length && NUMBERING.test(tokens[i]!)) i += 1;
  return i;
}

/**
 * The tokens after the title and numbers, where quality, language and service
 * tags are read, without a trailing `-Group` unless `keepGroup` is set.
 */
export function tailTokens(cleanTitle: string, partial: ParsedRelease, options: { keepGroup?: boolean } = {}): string[] {
  const tokens = tokensOf(cleanTitle);
  const tail = tokens.slice(numbersEnd(tokens, cleanTitle, partial));
  const last = tail.at(-1);
  if (last !== undefined && partial.group !== undefined && !options.keepGroup) {
    if (last === partial.group) tail.pop();
    else if (last.endsWith(`-${partial.group}`)) tail[tail.length - 1] = last.slice(0, -partial.group.length - 1);
  }
  return tail.filter(Boolean);
}
