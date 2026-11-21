// The TMDB adapter's findByExternalId: TMDB's /find endpoint for the library
// scan, whose folders may carry a TVDB or IMDb tag.
// The adapter runs against the TMDB fake, as in an action.
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';

import { metadataProvider } from '../../convex/metadata/provider';
import { TMDB_API_KEY, useMetadataFakes, type FakeRequests } from '../setup';

let requests: FakeRequests;
beforeEach(() => {
  requests = useMetadataFakes();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

const provider = () => metadataProvider(TMDB_API_KEY, 'en-US');

describe('MetadataProvider.findByExternalId', () => {
  test('a TVDB ID finds the series, through /find with external_source=tvdb_id', async () => {
    expect(await provider().findByExternalId('tvdb', '7700001')).toEqual([
      { tmdbId: '900001', kind: 'series', title: 'Harbour Lights', year: 2021, posterPath: '/harbour-lights.jpg', genreIds: [18], originCountry: ['GB'] },
    ]);
    expect(requests.at(-1)?.pathname).toBe('/3/find/7700001');
    expect(requests.at(-1)?.searchParams.get('external_source')).toBe('tvdb_id');
  });

  test('an IMDb ID finds a movie or a series', async () => {
    expect(await provider().findByExternalId('imdb', 'tt9900101')).toEqual([
      { tmdbId: '900101', kind: 'movie', title: 'The Quiet Orchard', year: 2020, posterPath: '/quiet-orchard.jpg', genreIds: [18], originCountry: [] },
    ]);
    expect(await provider().findByExternalId('imdb', 'tt9900003')).toEqual([expect.objectContaining({ tmdbId: '900003', kind: 'series' })]);
  });

  test('an ID TMDB does not know finds nothing', async () => {
    expect(await provider().findByExternalId('tvdb', '1')).toEqual([]);
  });
});
