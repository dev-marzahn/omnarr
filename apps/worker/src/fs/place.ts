// Where a file goes in the library and how it gets there:
// the Work folder, or the season folder for the file's lowest season, under
// the name `libraryFileName` gives; then a rename into place that never
// replaces a file it doesn't own. The import and the scan's move to library
// naming (`moveLibraryFile`) share it; the move takes the file's subtitle
// sidecars along under the platform's sidecar names.
import { readdir, rename, stat } from 'node:fs/promises';
import { basename, dirname, extname, join } from 'node:path';

import {
  libraryFileName,
  type NamedUnit,
  type NamingContext,
  type ProbeSummary,
  type Sidecar,
  seasonFolderFor,
  sidecarName,
  sidecarOf,
} from '@omnarr/contracts';

import { inodeOf } from './space.ts';

/** The library path of a file: `<workFolder>[/<season folder>]/<libraryFileName>`. `ext` has its dot. */
export async function libraryTarget(workFolder: string, naming: NamingContext, units: NamedUnit[], probe: ProbeSummary, ext: string): Promise<string> {
  const name = libraryFileName({ naming, units, probe, ext });
  const seasons = units.map((unit) => unit.season).filter((season) => season !== undefined);
  if (naming.kind === 'movie' || seasons.length === 0) return join(workFolder, name);
  const existing = (await readdir(workFolder, { withFileTypes: true }).catch(() => [])).filter((entry) => entry.isDirectory()).map((entry) => entry.name);
  return join(workFolder, seasonFolderFor(existing, Math.min(...seasons)), name);
}

/** `name.ext` → `name (n).ext`. */
const numbered = (path: string, n: number) => {
  const ext = extname(path);
  return `${path.slice(0, path.length - ext.length)} (${n})${ext}`;
};

/** `target`, then `target (1)`, `target (2)`, … */
const candidates = function* (target: string): Generator<string> {
  for (let n = 0; ; n++) yield n === 0 ? target : numbered(target, n);
};

/**
 * Renames `source` to `target`, or to `target (n)` when a file that isn't
 * this one is there: the worker can't see `files` rows, so any other file at
 * the name counts as not ours. Ours is the same inode (a re-run's link), or
 * for a copy or an extraction a file of the same size. Returns where it is.
 */
export async function placeAt(source: string, target: string, copy: boolean): Promise<string> {
  const mine = await stat(source);
  for (const candidate of candidates(target)) {
    const existing = await stat(candidate).catch(() => undefined);
    if (!existing) {
      await rename(source, candidate);
      return candidate;
    }
    if (inodeOf(existing) === inodeOf(mine) || (copy && existing.size === mine.size)) return candidate;
  }
  throw new Error('unreachable');
}

const baseOf = (path: string) => basename(path, extname(path));

/** The subtitle sidecars beside a video by the sidecar rule (`sidecarOf`), sorted by name. */
export async function sidecarsBeside(video: string): Promise<Sidecar[]> {
  const folder = dirname(video);
  const names = (await readdir(folder).catch(() => [])).sort((a, b) => a.localeCompare(b));
  return names.flatMap((name) => {
    const sidecar = sidecarOf(baseOf(video), name);
    return sidecar ? [{ path: join(folder, name), ...sidecar }] : [];
  });
}

/**
 * Moves the sidecars of the video that was at `from` to beside `to`, renamed
 * after `to`'s base with `sidecarName`, by `placeAt`; a sidecar already
 * moved keeps its name. Returns every sidecar now beside `to`.
 */
export async function moveSidecars(from: string, to: string): Promise<Sidecar[]> {
  const taken = new Set((await sidecarsBeside(to)).map((sidecar) => basename(sidecar.path)));
  for (const { path, ...sidecar } of await sidecarsBeside(from)) await placeAt(path, join(dirname(to), sidecarName(baseOf(to), sidecar, taken)), false);
  return await sidecarsBeside(to);
}

/** Where an earlier `placeAt` put the file with this inode: `target` or a numbered twin; undefined when none of them is it. */
export async function placedAt(target: string, inode: string): Promise<string | undefined> {
  for (const candidate of candidates(target)) {
    const existing = await stat(candidate).catch(() => undefined);
    if (!existing) return undefined;
    if (inodeOf(existing) === inode) return candidate;
  }
  return undefined;
}
