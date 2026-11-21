// Source, modifier and resolution fixes after the library mapping. The library
// reads any BluRay title with HEVC or AVC and no encoder tag as a disc, and
// then forces 1080p; it reads `DVD.REMUX` as a Bluray remux and misses
// `br.remux`.
import type { ParsedRelease, Resolution } from '@omnarr/contracts';

import { tokensOf } from './tokens.ts';

const RESOLUTION_TOKEN = /^(2160|1080|720|576|540|480|360)p$/i;
/** An encode, not a disc: HEVC is how UHD encodes are labelled, 10-bit how HD ones often are. */
const ENCODE_TOKEN = /^(hevc|x265|h265|10bit|10-bit)$/i;
/** What a real disc release names. */
const DISC_TOKEN = /^(complete|bdmv|iso|bd25|bd50|bd66|bd100)$/i;

export function quality(cleanTitle: string, partial: ParsedRelease): ParsedRelease {
  const tokens = tokensOf(cleanTitle);
  const lower = tokens.map((token) => token.toLowerCase());
  const release = { ...partial };

  if (release.modifier === 'brdisk' && tokens.some((t) => ENCODE_TOKEN.test(t)) && !tokens.some((t) => DISC_TOKEN.test(t))) delete release.modifier;

  // A resolution the title writes out beats one the library inferred.
  const written = tokens.find((t) => RESOLUTION_TOKEN.test(t));
  if (written !== undefined && release.modifier !== 'brdisk') release.resolution = Number(written.slice(0, -1)) as Resolution;

  const remuxAt = lower.indexOf('remux');
  if (remuxAt >= 0) {
    if (lower[remuxAt - 1] === 'br' || lower[remuxAt - 1] === 'bd') Object.assign(release, { source: 'bluray', modifier: 'remux' });
    if (lower.includes('dvd')) Object.assign(release, { source: 'dvd', modifier: 'remux' });
  }
  return release;
}
