// Pass 5, languages, with the author's rules. The library answers `English`
// when it finds no language token, so its languages are ignored and read here
// instead.
import { LanguageCode, type ParsedRelease } from '@omnarr/contracts';

import { HARDCODED_TOKENS, LANGUAGE_TOKENS, MULTI_SUBTITLE_TOKENS, SUBS_MARKERS, SUBTITLE_TOKENS } from '../tables/languages.ts';
import { streamingTokenIndex } from './streaming.ts';
import { partsOf, tailTokens } from './tokens.ts';

/** `text` is upper case; `raw` as written. `standalone` is true for a part that is a whole token, which is what `DL` needs to count. */
type Part = { text: string; raw: string; standalone: boolean };

const toPart = (raw: string, standalone: boolean): Part => ({ text: raw.toUpperCase(), raw, standalone });

/** `[EN-TR]`: a bracketed list of two-letter codes, each a language of the release. */
function bracketedCodes(token: string, cleanTitle: string): LanguageCode[] | undefined {
  const parts = partsOf(token);
  if (parts.length < 2 || !cleanTitle.includes(`[${token}]`)) return undefined;
  const codes = parts.map((part) => part.toLowerCase());
  return codes.every((code) => code.length === 2 && (LanguageCode.options as readonly string[]).includes(code)) ? (codes as LanguageCode[]) : undefined;
}

/**
 * The parts of the tokens after the title and numbers, with the streaming
 * service's token and the group dropped. A bracketed code list is one part
 * per language.
 */
function partsAfterNumbers(cleanTitle: string, partial: ParsedRelease): (Part | LanguageCode[])[] {
  const tail = tailTokens(cleanTitle, partial, { keepGroup: true });
  const service = streamingTokenIndex(tail);
  const group = partial.group;
  return tail.flatMap((token, i): (Part | LanguageCode[])[] => {
    if (i === service) return [];
    if (i === tail.length - 1 && group !== undefined) {
      if (token === group) return [];
      // `DL-GRP`: the group's hyphen makes DL part of a compound.
      if (token.endsWith(`-${group}`)) return partsOf(token.slice(0, -group.length - 1)).map((text) => toPart(text, false));
    }
    const listed = bracketedCodes(token, cleanTitle);
    if (listed) return [listed];
    const parts = partsOf(token);
    return parts.map((text) => toPart(text, parts.length === 1));
  });
}

function codesOf(part: Part): readonly LanguageCode[] | undefined {
  if (part.text === 'DL') return part.standalone ? ['multi'] : undefined;
  // Two-letter codes count only in capitals: `DE` is German, the `de` of an episode title isn't.
  if (part.text.length === 2 && part.raw !== part.text) return undefined;
  return LANGUAGE_TOKENS.get(part.text);
}

export function languages(cleanTitle: string, partial: ParsedRelease): ParsedRelease {
  const audio: LanguageCode[] = [];
  const subtitles: LanguageCode[] = [...partial.subtitleLanguages];
  const notes = [...partial.notes];
  let hardcoded = false;
  let multiSubtitles = false;
  const parts = partsAfterNumbers(cleanTitle, partial);
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i]!;
    if (Array.isArray(part)) {
      audio.push(...part);
      continue;
    }
    const { text } = part;
    if (text === 'DUBBED' && !notes.includes('dubbed')) notes.push('dubbed');
    if (HARDCODED_TOKENS.has(text)) hardcoded = true;
    const subtitleOnly = SUBTITLE_TOKENS.get(text);
    if (subtitleOnly) subtitles.push(...subtitleOnly);
    if (MULTI_SUBTITLE_TOKENS.has(text)) {
      subtitles.push('multi');
      multiSubtitles = true;
      continue;
    }
    const codes = codesOf(part);
    if (!codes) continue;
    const next = parts[i + 1];
    if (next !== undefined && !Array.isArray(next) && SUBS_MARKERS.has(next.text)) {
      subtitles.push(...codes);
      multiSubtitles ||= codes.includes('multi');
      i += 1;
    } else {
      audio.push(...codes);
    }
  }
  if (audio.length === 0) notes.push('languageAssumed');
  // The library reads `MSubs` as hardcoded subtitles; multi-subtitle tags name soft subtitles.
  const hardcodedSubs = hardcoded || (partial.hardcodedSubs && !multiSubtitles);
  return { ...partial, languages: [...new Set(audio)], subtitleLanguages: [...new Set(subtitles)], hardcodedSubs, notes };
}
