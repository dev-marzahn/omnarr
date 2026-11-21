// RAR sets in a download. `findRarSets` is
// tested on a made-up tree; `listSet` and `extractSet` run the real `lsar` and
// `unar` on fixtures/media/rar/, which hold one 112,323-byte video each.
import { createHash } from 'node:crypto';
import { chmod, mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';

import { extractSet, findRarSets, listSet } from '../src/media/archives.ts';
import { JobFailure } from '../src/runtime/lease.ts';
import { MEDIA, mediaTools } from './fixtures/media/tools.ts';

const RAR = join(MEDIA, 'rar');
/** sha256 of the video inside every set (fits.mp4 when the sets were made). */
const VIDEO_SHA256 = '213454f7ecb7cb3fe59bc44b1c05919c55294de793e2a468a047081062405261';

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'omnarr-archives-'));
});
afterEach(() => rm(dir, { recursive: true, force: true }));

const touch = async (...names: string[]) => {
  for (const name of names) {
    await mkdir(dirname(join(dir, name)), { recursive: true });
    await writeFile(join(dir, name), '');
  }
};
const signal = () => new AbortController().signal;
const sha256 = async (path: string) =>
  createHash('sha256')
    .update(await readFile(path))
    .digest('hex');

describe('findRarSets', () => {
  test('the first volume of each set: .rar with .r00…, .partNN.rar, and a lone .rar, in every folder', async () => {
    await touch(
      'Show.S01E01/show.s01e01.rar',
      'Show.S01E01/show.s01e01.r00',
      'Show.S01E01/show.s01e01.r01',
      'Show.S01E01/show.s01e01.nfo',
      'Show.S01E02/Show.S01E02.part01.rar',
      'Show.S01E02/Show.S01E02.part02.rar',
      'Show.S01E02/Show.S01E02.part10.rar',
      'Show.S01E03/Show.S01E03.PART1.RAR',
      'Show.S01E03/Show.S01E03.PART2.RAR',
      'Subs/subs.rar',
      'Sample/sample.mkv',
    );
    expect(await findRarSets(dir)).toEqual([
      join(dir, 'Show.S01E01/show.s01e01.rar'),
      join(dir, 'Show.S01E02/Show.S01E02.part01.rar'),
      join(dir, 'Show.S01E03/Show.S01E03.PART1.RAR'),
      join(dir, 'Subs/subs.rar'),
    ]);
  });

  test('a part set without its first part gives its lowest part, which unar then refuses', async () => {
    await touch('Movie.part03.rar', 'Movie.part02.rar');
    expect(await findRarSets(dir)).toEqual([join(dir, 'Movie.part02.rar')]);
  });

  test('a folder without archives, or a missing folder, has none', async () => {
    await touch('Show.S01E01.mkv', 'Show.S01E01.r00');
    expect(await findRarSets(dir)).toEqual([]);
    expect(await findRarSets(join(dir, 'gone'))).toEqual([]);
  });
});

describe('without the tools', () => {
  let path: string | undefined;
  beforeEach(() => {
    path = process.env.PATH;
    process.env.PATH = dir;
  });
  afterEach(() => {
    process.env.PATH = path;
  });

  test('a missing lsar or unar is pipelineError', async () => {
    await expect(listSet(join(RAR, 'rar5', 'Show.S01E02.part1.rar'))).rejects.toEqual(new JobFailure('pipelineError', 'lsar is not installed in the worker.'));
    await expect(extractSet(join(RAR, 'rar5', 'Show.S01E02.part1.rar'), join(dir, 'out'), signal())).rejects.toEqual(
      new JobFailure('pipelineError', 'unar is not installed in the worker.'),
    );
  });

  test('unar runs as `unar -o <outDir> -D -f -q <first volume>`, without a shell', async () => {
    const log = join(dir, 'argv.json');
    await writeFile(join(dir, 'unar'), `#!${process.execPath}\nrequire('fs').writeFileSync(${JSON.stringify(log)}, JSON.stringify(process.argv.slice(2)));\n`);
    await chmod(join(dir, 'unar'), 0o755);
    const first = join(dir, "it's $(touch pwned); a set.part1.rar");
    await extractSet(first, join(dir, 'out'), signal());
    expect(JSON.parse(await readFile(log, 'utf8'))).toEqual(['-o', join(dir, 'out'), '-D', '-f', '-q', first]);
    expect(await readdir(dir)).not.toContain('pwned');
  });
});

describe.skipIf(!mediaTools('lsar', 'unar'))('with lsar and unar', () => {
  test('a RAR4 set (.rar, .r00, .r01) lists its unpacked size and extracts whole', async () => {
    const first = join(RAR, 'rar4', 'Show.S01E01.rar');
    expect(await listSet(first)).toEqual({ entries: [{ name: 'Show.S01E01.mp4', sizeBytes: 112323 }], unpackedBytes: 112323, encrypted: false });
    await extractSet(first, join(dir, 'extract'), signal());
    expect(await readdir(join(dir, 'extract'))).toEqual(['Show.S01E01.mp4']);
    expect(await sha256(join(dir, 'extract', 'Show.S01E01.mp4'))).toBe(VIDEO_SHA256);
  });

  test('a RAR5 multi-volume set (.part1.rar …) lists and extracts whole', async () => {
    const first = join(RAR, 'rar5', 'Show.S01E02.part1.rar');
    expect(await listSet(first)).toEqual({ entries: [{ name: 'Show.S01E02.mp4', sizeBytes: 112323 }], unpackedBytes: 112323, encrypted: false });
    await extractSet(first, join(dir, 'extract'), signal());
    expect(await sha256(join(dir, 'extract', 'Show.S01E02.mp4'))).toBe(VIDEO_SHA256);
  });

  test('an encrypted set is flagged by the listing and fails extraction as passwordProtected', async () => {
    const first = join(RAR, 'encrypted', 'Show.S01E03.rar');
    expect(await listSet(first)).toEqual({ entries: [{ name: 'Show.S01E03.mp4', sizeBytes: 112323 }], unpackedBytes: 112323, encrypted: true });
    await expect(extractSet(first, join(dir, 'extract'), signal())).rejects.toEqual(
      new JobFailure('passwordProtected', `unar can't extract ${first}: it needs a password.`),
    );
  });

  test('a set with encrypted headers lists as encrypted with nothing in it', async () => {
    const first = join(RAR, 'encrypted-headers', 'Show.S01E04.rar');
    expect(await listSet(first)).toEqual({ entries: [], unpackedBytes: 0, encrypted: true });
    await expect(extractSet(first, join(dir, 'extract'), signal())).rejects.toMatchObject({ code: 'passwordProtected' });
  });

  test('a truncated set fails as unpackFailed, listing and extracting', async () => {
    const first = join(RAR, 'truncated', 'Show.S01E05.part1.rar');
    await expect(listSet(first)).rejects.toEqual(new JobFailure('unpackFailed', `lsar can't read ${first}: the set is damaged or incomplete.`));
    await expect(extractSet(first, join(dir, 'extract'), signal())).rejects.toEqual(
      new JobFailure('unpackFailed', `unar can't extract ${first}: the set is damaged or incomplete (exit code 1).`),
    );
  });

  test('an aborted extraction rejects with the abort reason', async () => {
    const controller = new AbortController();
    controller.abort('cancelled');
    await expect(extractSet(join(RAR, 'rar5', 'Show.S01E02.part1.rar'), join(dir, 'extract'), controller.signal)).rejects.toBe('cancelled');
  });
});
