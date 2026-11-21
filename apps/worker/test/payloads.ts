// Job payload pieces the worker's tests share: a series episode's naming
// context and an import payload around it.
import type { ImportPayload, NamingContext } from '@omnarr/contracts';

export const release = (overrides: Partial<NamingContext['release']> = {}): NamingContext['release'] => ({
  title: 'Show',
  normalizedTitle: 'show',
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
  quality: 'webdl-1080p',
  ...overrides,
});

/** `Show (2019) [tmdbid-123]`, from an AMZN WEB-DL by GRP. */
export const SERIES_NAMING: NamingContext = {
  kind: 'series',
  title: 'Show',
  year: 2019,
  tmdbId: 123,
  anime: false,
  release: release({ streamingService: 'AMZN', group: 'GRP' }),
};

/** `Film (2020) [tmdbid-9]`, a Bluray-1080p by GRP. */
export const MOVIE_NAMING: NamingContext = {
  kind: 'movie',
  title: 'Film',
  year: 2020,
  tmdbId: 9,
  anime: false,
  release: release({ title: 'Film', normalizedTitle: 'film', group: 'GRP', quality: 'bluray-1080p' }),
};

export const IMPORT_PAYLOAD: ImportPayload = {
  class: 'import',
  grabId: 'g' as never,
  importJobId: 'i' as never,
  contentPath: '/data/downloads/usenet/platform-series/Show.S01E02',
  workFolderPath: '/data/library/series/Show (2019) [tmdbid-123]',
  expectedUnits: [],
  naming: SERIES_NAMING,
};
