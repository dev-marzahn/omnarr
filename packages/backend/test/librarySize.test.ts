// `system.librarySize`: System › Free space's "Library" rows, summed from
// the tracked files, each inode once.
import { beforeEach, expect, test } from 'vite-plus/test';

import { api } from '../convex/_generated/api';
import type { Doc, Id } from '../convex/_generated/dataModel';
import { LIBRARY_SIZE_PAGE } from '../convex/library/size';
import { asAdmin, seedLibraries, setup, type Backend, type Libraries } from './setup';

let t: Backend;
let admin: Awaited<ReturnType<typeof asAdmin>>;
let libraries: Libraries;

beforeEach(async () => {
  t = setup();
  admin = await asAdmin(t);
  libraries = await seedLibraries(t);
});

const size = () => admin.action(api.api.system.librarySize, {});

/** A Work with one Unit. */
const work = (kind: 'series' | 'movie', title: string) =>
  t.run(async (ctx) => {
    const workId = await ctx.db.insert('works', {
      libraryId: kind === 'series' ? libraries.series : libraries.movies,
      kind,
      title,
      numberingScheme: 'standard',
      releaseProfileId: libraries.releaseProfileId,
      monitorNewUnits: true,
    });
    return ctx.db.insert('units', { workId, kind: kind === 'series' ? 'episode' : 'movie', monitored: true, derivedState: 'ready' });
  });

type FileRow = Pick<Doc<'files'>, 'sizeBytes' | 'inode'> & Partial<Pick<Doc<'files'>, 'origin' | 'role'>>;

/** A file, linked to the Unit unless it's a leftover (`unitId` null). */
const file = (unitId: Id<'units'> | null, { sizeBytes, inode, origin = 'download', role = 'source' }: FileRow) =>
  t.run(async (ctx) => {
    const fileId = await ctx.db.insert('files', { path: `/data/library/${inode}.mkv`, sizeBytes, inode, origin, role });
    if (unitId) await ctx.db.insert('fileUnits', { fileId, unitId });
  });

test('an empty library is 0 B in every row', async () => {
  expect(await size()).toMatchObject({ totalBytes: 0, seriesBytes: 0, moviesBytes: 0 });
});

test('series and movies sum apart; a rendition counts beside its source', async () => {
  const episode = await work('series', 'Harbour Lights');
  const movie = await work('movie', 'Night Ferry');
  await file(episode, { sizeBytes: 1_000, inode: '1:10' });
  await file(episode, { sizeBytes: 400, inode: '1:11', origin: 'prepared', role: 'rendition' });
  await file(movie, { sizeBytes: 5_000, inode: '2:20' });
  const before = Date.now();
  const result = await size();
  expect(result).toMatchObject({ totalBytes: 6_400, seriesBytes: 1_400, moviesBytes: 5_000 });
  expect(result.measuredAt).toBeGreaterThanOrEqual(before);
});

test('a file hardlinked or recorded twice counts once, by inode', async () => {
  const episode = await work('series', 'Harbour Lights');
  const other = await work('series', 'Cold Water');
  await file(episode, { sizeBytes: 1_000, inode: '1:10' });
  await file(other, { sizeBytes: 1_000, inode: '1:10' });
  // The same inode number on another filesystem is another file.
  await file(other, { sizeBytes: 300, inode: '2:10' });
  expect(await size()).toMatchObject({ totalBytes: 1_300, seriesBytes: 1_300, moviesBytes: 0 });
});

test('a file no Unit links (a leftover) is not counted', async () => {
  const movie = await work('movie', 'Night Ferry');
  await file(movie, { sizeBytes: 5_000, inode: '2:20' });
  await file(null, { sizeBytes: 9_999, inode: '2:21' });
  expect(await size()).toMatchObject({ totalBytes: 5_000, seriesBytes: 0, moviesBytes: 5_000 });
});

test('a library past one page sums every page, and a hardlink across pages still counts once', async () => {
  const episode = await work('series', 'Harbour Lights');
  const count = LIBRARY_SIZE_PAGE * 2 + 7;
  await t.run(async (ctx) => {
    for (let i = 0; i < count; i++) {
      const fileId = await ctx.db.insert('files', {
        path: `/data/library/series/${i}.mkv`,
        sizeBytes: 10,
        inode: `1:${i}`,
        origin: 'download',
        role: 'source',
      });
      await ctx.db.insert('fileUnits', { fileId, unitId: episode });
    }
  });
  // The last page repeats the first file's inode.
  await file(episode, { sizeBytes: 10, inode: '1:0' });
  expect(await size()).toMatchObject({ totalBytes: count * 10, seriesBytes: count * 10 });
});

test('only an admin can read it', async () => {
  await expect(t.action(api.api.system.librarySize, {})).rejects.toThrow(/unauthorized/);
});
