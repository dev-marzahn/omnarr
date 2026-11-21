// HDR tags, matched as whole tokens, ignoring case.
import type { HdrType } from '@omnarr/contracts';

export const HDR_TOKENS: Readonly<Record<string, HdrType>> = {
  dv: 'dv',
  dovi: 'dv',
  'hdr10+': 'hdr10plus',
  hdr10p: 'hdr10plus',
  hdr10plus: 'hdr10plus',
  hdr10: 'hdr10',
  hlg: 'hlg',
  hdr: 'hdr',
};
