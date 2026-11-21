// The one /data tree, mounted at the same path in every container:
// downloads, staging (one folder per job, and held/
// for upgrade files that wait for preparation), the two library roots, and
// originals/, the kept originals outside every Jellyfin library.
import { join, relative } from 'node:path';

import type { StorageArea } from '@omnarr/contracts';

export type DataLayout = {
  root: string;
  downloads: string;
  usenetDownloads: string;
  torrentDownloads: string;
  staging: string;
  /** `staging/held/<jobId>/`: an upgrade import's files waiting for preparation; the start-up sweep and `cleanStaging` skip it. */
  held: string;
  library: string;
  series: string;
  movies: string;
  originals: string;
};

export function dataLayout(root = '/data'): DataLayout {
  return {
    root,
    downloads: join(root, 'downloads'),
    usenetDownloads: join(root, 'downloads/usenet'),
    torrentDownloads: join(root, 'downloads/torrents'),
    staging: join(root, 'staging'),
    held: join(root, 'staging/held'),
    library: join(root, 'library'),
    series: join(root, 'library/series'),
    movies: join(root, 'library/movies'),
    originals: join(root, 'originals'),
  };
}

/** The folder of each storage area. */
export const areaPath = (layout: DataLayout, area: StorageArea): string => layout[area];

/** Whether `path` is strictly inside `folder` (both absolute). */
export const inside = (folder: string, path: string): boolean => {
  const rel = relative(folder, path);
  return rel !== '' && !rel.startsWith('..') && !rel.startsWith('/');
};

const AREAS: StorageArea[] = ['downloads', 'staging', 'originals', 'series', 'movies'];

/** Which storage area holds a local path, for mapping a write failure to its area; undefined outside them all. */
export function areaOf(layout: DataLayout, path: string): StorageArea | undefined {
  return AREAS.find((area) => path === layout[area] || inside(layout[area], path));
}

/**
 * The `originals/` twin of a local library path, where a kept original goes:
 * `library/series/<Work>/Season 01/x.mkv` → `originals/series/<Work>/Season 01/x.mkv`.
 * Undefined for a path outside the library.
 */
export function originalsPathFor(layout: DataLayout, libraryPath: string): string | undefined {
  if (!inside(layout.library, libraryPath)) return undefined;
  return join(layout.originals, relative(layout.library, libraryPath));
}

/**
 * A path the backend wrote (always under `/data`) on this worker's
 * tree, which is `/data` in the container and elsewhere in tests.
 */
export const toLocal = (layout: DataLayout, path: string): string =>
  path === '/data' || path.startsWith('/data/') ? join(layout.root, path.slice('/data'.length)) : path;

/** `toLocal`'s inverse: a local path under this worker's tree as the backend writes it, under `/data`. */
export const toData = (layout: DataLayout, path: string): string =>
  path === layout.root || inside(layout.root, path) ? join('/data', relative(layout.root, path)) : path;

/** A job's own staging folder: a re-run finds its earlier work there. */
export const stagingPath = (layout: DataLayout, jobId: string): string => join(layout.staging, jobId);
