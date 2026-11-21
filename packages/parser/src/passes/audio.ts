// Pass 4, audio: Atmos and DTS:X, which the library doesn't read.
import type { ParsedRelease } from '@omnarr/contracts';

import { partsOf, tailTokens } from './tokens.ts';

/** `DTS:X`, `DTSX`, and `DTS-X` (a compound whose parts are DTS and X). */
const isDtsX = (token: string, parts: string[]) => /^dts:?x$/i.test(token) || (parts.length === 2 && /^dts$/i.test(parts[0]!) && /^x$/i.test(parts[1]!));

export function audio(cleanTitle: string, partial: ParsedRelease): ParsedRelease {
  const release = { ...partial };
  for (const token of tailTokens(cleanTitle, partial)) {
    const parts = partsOf(token);
    if (parts.some((part) => /^atmos$/i.test(part))) release.atmos = true;
    if (isDtsX(token, parts)) release.audioCodec = 'dtsx';
  }
  return release;
}
