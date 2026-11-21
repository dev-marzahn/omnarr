// Language tags, matched ignoring case. The aliases start from the
// prototype's LANGUAGE_ALIASES (the author's own code) and add scene tags.
// Two-letter tokens are limited to a fixed list.
import type { LanguageCode } from '@omnarr/contracts';

const ALIASES: Readonly<Partial<Record<LanguageCode, readonly string[]>>> = {
  en: ['ENGLISH', 'ENG'],
  de: ['GERMAN', 'GER', 'DEU', 'DE'],
  // VOF: the author's rule.
  fr: ['FRENCH', 'FRE', 'FRA', 'TRUEFRENCH', 'VFF', 'VOF', 'FR'],
  es: ['SPANISH', 'SPA', 'ESP', 'CASTELLANO', 'LATINO', 'ES'],
  it: ['ITALIAN', 'ITA', 'IT'],
  pt: ['PORTUGUESE', 'POR', 'BRAZILIAN', 'PT'],
  nl: ['DUTCH', 'FLEMISH', 'NL'],
  pl: ['POLISH', 'PL'],
  ru: ['RUSSIAN', 'RUS', 'RU'],
  ja: ['JAPANESE', 'JPN', 'JA'],
  ko: ['KOREAN', 'KOR', 'KO'],
  zh: ['CHINESE', 'CHI', 'MANDARIN', 'CANTONESE', 'ZH'],
  sv: ['SWEDISH', 'SWE'],
  no: ['NORWEGIAN', 'NOR'],
  da: ['DANISH', 'DAN'],
  fi: ['FINNISH', 'FIN'],
  tr: ['TURKISH'],
  el: ['GREEK'],
  hu: ['HUNGARIAN'],
  cs: ['CZECH'],
  uk: ['UKRAINIAN'],
  he: ['HEBREW'],
  ar: ['ARABIC'],
  hi: ['HINDI'],
  th: ['THAI'],
  vi: ['VIETNAMESE'],
  // A standalone `DL` also means multi; the languages pass checks that it stands alone.
  // DUAL, also as `DUAL-<group>`: the author's rule.
  multi: ['MULTI', 'DUAL'],
};

/** Upper-case token → the languages it names. */
export const LANGUAGE_TOKENS: ReadonlyMap<string, readonly LanguageCode[]> = new Map<string, readonly LanguageCode[]>([
  ...Object.entries(ALIASES).flatMap(([code, tokens]) => tokens!.map((token): [string, LanguageCode[]] => [token, [code as LanguageCode]])),
  ['NORDIC', ['sv', 'no', 'da', 'fi']],
]);

/** Subtitle-only tags: `VOSTFR` is French subtitles. `<LANG>.SUBS` is handled by the pass. */
export const SUBTITLE_TOKENS: ReadonlyMap<string, readonly LanguageCode[]> = new Map([['VOSTFR', ['fr']]]);

/** The token after a language that makes it a subtitle language. */
export const SUBS_MARKERS: ReadonlySet<string> = new Set(['SUBS', 'SUB']);

/** Single tokens for subtitles in several languages, which are soft subtitles (the author's rule). `Multi-Subs` is MULTI plus a marker. */
export const MULTI_SUBTITLE_TOKENS: ReadonlySet<string> = new Set(['MSUBS', 'MULTISUB', 'MULTISUBS']);

/** Tags for subtitles burned into the picture. */
export const HARDCODED_TOKENS: ReadonlySet<string> = new Set(['HC', 'KORSUB']);
