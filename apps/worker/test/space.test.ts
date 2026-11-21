// Free bytes from `statfs`: available blocks are counted in fragment
// size (`f_frsize`), not the preferred I/O size (`f_bsize`). The two differ on
// Docker Desktop's virtiofs mounts.
import { expect, test } from 'vite-plus/test';

import { freeBytesOf } from '../src/fs/space.ts';

test('counts available blocks in fragment size on a virtiofs mount', () => {
  // Read on a Docker Desktop /data bind mount; `df` said 386G available.
  const virtiofs = { bsize: 1048576, frsize: 4096, bavail: 101000000 };
  expect(freeBytesOf(virtiofs)).toBe(413_696_000_000);
});

test('falls back to the block size when the fragment size is missing or 0', () => {
  expect(freeBytesOf({ bsize: 4096, frsize: 0, bavail: 10 })).toBe(40960);
  expect(freeBytesOf({ bsize: 4096, bavail: 10 })).toBe(40960);
});
