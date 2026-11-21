import { describe, expect, test } from 'vite-plus/test';

import { movesToLibraryNaming } from '../src/dto/scan.ts';

describe('movesToLibraryNaming: which scanned files the import moves to library naming', () => {
  const sonarr = { readAs: 'sonarr', ordering: 'tmdb' } as const;

  test('files Jellyfin would misread move: unrecognised naming, matched by hand, absolute numbering', () => {
    expect(movesToLibraryNaming({ readAs: 'unknown', ordering: 'tmdb' }, 'Show (2019)', undefined)).toBe(true);
    expect(movesToLibraryNaming({ readAs: 'sonarr', ordering: 'manual' }, 'Show (2019)', undefined)).toBe(true);
    expect(movesToLibraryNaming({ readAs: 'sonarr', ordering: 'absolute' }, 'Show (2019)', undefined)).toBe(true);
  });

  test('Sonarr, Radarr and Jellyfin naming in their Work folder, or in a folder that will become it, stay', () => {
    expect(movesToLibraryNaming(sonarr, 'Show (2019)', 'Show (2019)')).toBe(false);
    expect(movesToLibraryNaming(sonarr, 'Show (2019)', undefined)).toBe(false);
    expect(movesToLibraryNaming({ readAs: 'radarr', ordering: 'tmdb' }, 'Film (2020)', undefined)).toBe(false);
    expect(movesToLibraryNaming({ readAs: 'jellyfin', ordering: 'tvdb' }, 'Show [tmdbid-1]', 'Show [tmdbid-1]')).toBe(false);
  });

  test("a file outside its Work's folder moves whatever its naming: one Work, one folder, one series in Jellyfin", () => {
    expect(movesToLibraryNaming(sonarr, 'Show (2019) {tvdb-7}', 'Show (2019) [tmdbid-1]')).toBe(true);
  });
});
