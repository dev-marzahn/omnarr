// Pass 3, video: HDR types, bit depth and codec spellings the library
// doesn't read.
import { HdrType, type ParsedRelease, type VideoCodec } from '@omnarr/contracts';

import { HDR_TOKENS } from '../tables/hdr.ts';
import { partsOf, tailTokens } from './tokens.ts';

const CODECS: Readonly<Record<string, VideoCodec>> = { avc: 'h264', hevc: 'h265', 'vc-1': 'vc1', vc1: 'vc1', mpeg2: 'mpeg2', 'mpeg-2': 'mpeg2' };

function bitDepthOf(token: string): 8 | 10 | undefined {
  if (/^(10-?bit|hi10p?)$/i.test(token)) return 10;
  if (/^8-?bit$/i.test(token)) return 8;
  return undefined;
}

export function video(cleanTitle: string, partial: ParsedRelease): ParsedRelease {
  const tail = tailTokens(cleanTitle, partial);
  const hdr = new Set(partial.hdr);
  const release = { ...partial };
  for (const token of tail) {
    const whole = token.toLowerCase();
    // Compounds first, so `VC-1` and `10-bit` read as one tag.
    const codec = CODECS[whole];
    if (codec && release.videoCodec === undefined) release.videoCodec = codec;
    const depth = bitDepthOf(whole);
    if (depth !== undefined) release.bitDepth = depth;
    for (const part of partsOf(whole)) {
      const type = HDR_TOKENS[part];
      if (type) hdr.add(type);
      const partCodec = CODECS[part];
      if (partCodec && release.videoCodec === undefined) release.videoCodec = partCodec;
      const partDepth = bitDepthOf(part);
      if (partDepth !== undefined) release.bitDepth = partDepth;
    }
  }
  release.hdr = HdrType.options.filter((type) => hdr.has(type));
  return release;
}
