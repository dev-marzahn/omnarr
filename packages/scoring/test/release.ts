// A ParsedRelease for the scoring tests, with every field at its empty value.
import type { ParsedRelease } from '@omnarr/contracts';

export function release(overrides: Partial<ParsedRelease> = {}): ParsedRelease {
  return {
    title: 'The Long Harbor',
    normalizedTitle: 'the long harbor',
    episodes: [],
    special: false,
    extras: false,
    hdr: [],
    atmos: false,
    languages: [],
    subtitleLanguages: [],
    hardcodedSubs: false,
    edition: {},
    revision: { version: 1, real: 0, repack: false },
    notes: [],
    ...overrides,
  };
}
