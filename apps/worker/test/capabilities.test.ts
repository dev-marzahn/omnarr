// What the worker reports at connect and in each heartbeat:
// the ffmpeg build, and per storage area its free bytes, its device and the
// write check. Run on a real temporary /data tree.
import { chmod, mkdir, mkdtemp, readdir, rm, stat, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';

import { capabilities, parseEncoders, parseFfmpegVersion, storageSpace, writeCheck } from '../src/capabilities.ts';
import { areaOf, dataLayout, type DataLayout, originalsPathFor } from '../src/fs/layout.ts';

let root: string;
let layout: DataLayout;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'omnarr-capabilities-'));
  layout = dataLayout(root);
  for (const folder of [layout.usenetDownloads, layout.torrentDownloads, layout.staging, layout.series, layout.movies, layout.originals])
    await mkdir(folder, { recursive: true });
});
afterEach(async () => {
  await chmod(layout.staging, 0o755).catch(() => {});
  await rm(root, { recursive: true, force: true });
});

/** Every file and folder under `dir`, relative to it. */
const tree = async (dir: string) => (await readdir(dir, { recursive: true })).sort();

test('reads the version from ffmpeg -version', () => {
  expect(parseFfmpegVersion('ffmpeg version 7.1.1 Copyright (c) 2000-2025 the FFmpeg developers\nbuilt with gcc')).toBe('7.1.1');
  expect(parseFfmpegVersion('something else')).toBe('unknown');
});

test('lists the encoders after the legend of ffmpeg -encoders', () => {
  const output = [
    'Encoders:',
    ' V..... = Video',
    ' A..... = Audio',
    ' ------',
    ' V....D libx264              libx264 H.264 / AVC',
    ' A....D aac                  AAC (Advanced Audio Coding)',
    ' S..... mov_text             3GPP Timed Text subtitle',
  ].join('\n');
  expect(parseEncoders(output)).toEqual(['libx264', 'aac', 'mov_text']);
});

describe('storage', () => {
  test('one device: every area reports the same device and its free bytes', async () => {
    const space = await storageSpace(layout);
    const device = String((await stat(root)).dev);
    expect(Object.keys(space).sort()).toEqual(['downloads', 'movies', 'originals', 'series', 'staging']);
    for (const area of Object.values(space)) {
      expect(area.device).toBe(device);
      expect(area.freeBytes).toBeGreaterThan(0);
    }
  });

  test('two devices: a library root mounted from another filesystem reports that device', async () => {
    await rm(layout.movies, { recursive: true });
    await symlink('/dev', layout.movies);
    const space = await storageSpace(layout);
    expect(space.movies.device).toBe(String((await stat('/dev')).dev));
    expect(space.movies.device).not.toBe(space.staging.device);
    expect(space.series.device).toBe(space.staging.device);
  });

  test('an area that does not exist yet reports the filesystem it would be made on', async () => {
    await rm(layout.originals, { recursive: true });
    const space = await storageSpace(layout);
    expect(space.originals.device).toBe(space.staging.device);
  });

  test('the write check: every area writable, and no file is left behind or written under downloads', async () => {
    expect(await writeCheck(layout, 'w1')).toEqual({ downloads: true, staging: true, originals: true, series: true, movies: true });
    expect(await tree(layout.downloads)).toEqual(['torrents', 'usenet']);
    expect(await tree(layout.staging)).toEqual(['.omnarr']);
    expect(await tree(layout.series)).toEqual(['.omnarr']);
  });

  test.skipIf(process.getuid?.() === 0)('an unwritable area fails the write check', async () => {
    await chmod(layout.staging, 0o555);
    expect(await writeCheck(layout, 'w1')).toEqual({ downloads: true, staging: false, originals: true, series: true, movies: true });
  });

  test('capabilities carry the storage with the write check', async () => {
    const caps = await capabilities(layout, 'w1');
    expect(caps.storage.staging).toEqual({ ...(await storageSpace(layout)).staging, writable: true, freeBytes: expect.any(Number) });
    expect(await tree(layout.downloads)).toEqual(['torrents', 'usenet']);
  });
});

describe('the layout', () => {
  test('areaOf names the area that holds a path', () => {
    expect(areaOf(layout, join(layout.torrentDownloads, 'x', 'a.mkv'))).toBe('downloads');
    expect(areaOf(layout, join(layout.series, 'Show (2019) [tmdbid-1]', 'Season 01', 'a.mkv'))).toBe('series');
    expect(areaOf(layout, join(layout.staging, 'job1'))).toBe('staging');
    expect(areaOf(layout, join(layout.originals, 'movies', 'a.mkv'))).toBe('originals');
    expect(areaOf(layout, '/etc/passwd')).toBeUndefined();
  });

  test('originalsPathFor gives the originals/ twin of a library path', () => {
    expect(originalsPathFor(layout, join(layout.movies, 'Film (2020) [tmdbid-9]', 'Film.mkv'))).toBe(
      join(root, 'originals', 'movies', 'Film (2020) [tmdbid-9]', 'Film.mkv'),
    );
    expect(originalsPathFor(layout, join(layout.staging, 'x.mkv'))).toBeUndefined();
  });
});
