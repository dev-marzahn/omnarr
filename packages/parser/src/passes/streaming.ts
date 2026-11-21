// Pass 6, streaming service. Runs before the languages pass, which
// skips the token this pass took (such as `iT`).
import type { ParsedRelease } from '@omnarr/contracts';

import { STREAMING_SERVICES } from '../tables/streamingServices.ts';
import { tailTokens } from './tokens.ts';

const WEB_TAG = /^(web|web-dl|webdl|webrip)$/i;

/** The index in `tail` of a listed service directly before a WEB tag, or -1. */
export function streamingTokenIndex(tail: string[]): number {
  return tail.findIndex((token, i) => STREAMING_SERVICES.includes(token) && WEB_TAG.test(tail[i + 1] ?? ''));
}

export function streaming(cleanTitle: string, partial: ParsedRelease): ParsedRelease {
  const tail = tailTokens(cleanTitle, partial);
  const index = streamingTokenIndex(tail);
  return index < 0 ? partial : { ...partial, streamingService: tail[index]! };
}
