// Free bytes (`statfs`) and the device (`stat`) of a path, both read-only
//. A folder that doesn't exist yet reports the filesystem it
// would be made on: its nearest existing parent's.
import { stat, statfs } from 'node:fs/promises';
import { dirname } from 'node:path';

async function nearest<T>(path: string, read: (p: string) => Promise<T>, fallback: T): Promise<T> {
  for (let p = path; ; p = dirname(p)) {
    try {
      return await read(p);
    } catch {
      if (dirname(p) === p) return fallback;
    }
  }
}

/**
 * Available blocks are counted in the fragment size (`f_frsize`), not the
 * preferred I/O size (`f_bsize`); the two differ on Docker Desktop's virtiofs
 * (1 MiB and 4 KiB). `bsize` only when a runtime gives no fragment size.
 */
export const freeBytesOf = (stats: { bavail: number; bsize: number; frsize?: number }): number => stats.bavail * (stats.frsize || stats.bsize);

export const freeBytesAt = (path: string): Promise<number> => nearest(path, async (p) => freeBytesOf(await statfs(p)), 0);

/** `stat`'s device number as a string: two areas on one filesystem share it. */
export const deviceAt = (path: string): Promise<string> => nearest(path, async (p) => String((await stat(p)).dev), 'unknown');

/** `dev:ino`, the `files.inode` the backend stores. */
export const inodeOf = (info: { dev: number; ino: number }): string => `${info.dev}:${info.ino}`;
