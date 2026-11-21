// `maintenance` `renameLibraryFile`: after a title change
// the sidecars are renamed first, then the file, within its folder; a re-run
// after the rename counts as done. On a real temporary /data tree.
import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LeasedJob, MaintenancePayload } from '@omnarr/contracts';
import { afterEach, beforeEach, expect, test } from 'vite-plus/test';

import { dataLayout, type DataLayout } from '../src/fs/layout.ts';
import { maintenanceHandler } from '../src/jobs/maintenance.ts';
import { ClientRuntimeStore } from '../src/runtime/clientRuntime.ts';
import { FakeBackend } from './fakeBackend.ts';

let root: string;
let layout: DataLayout;
let season: string;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'omnarr-rename-'));
  layout = dataLayout(root);
  season = join(layout.series, 'Show (2019) [tmdbid-123]', 'Season 01');
  await mkdir(season, { recursive: true });
});
afterEach(() => rm(root, { recursive: true, force: true }));

const OLD = 'Show (2019) - S01E02 [AMZN][WEBDL-1080p][AAC 2.0][h264]-GRP';
const NEW = 'Show (2019) - S01E02 - Pilot [AMZN][WEBDL-1080p][AAC 2.0][h264]-GRP';
const dataPath = (name: string) => `/data/library/series/Show (2019) [tmdbid-123]/Season 01/${name}`;

const payload = (overrides: Partial<Extract<MaintenancePayload, { action: 'renameLibraryFile' }>> = {}): MaintenancePayload => ({
  class: 'maintenance',
  action: 'renameLibraryFile',
  fileId: 'f1' as never,
  from: dataPath(`${OLD}.mp4`),
  to: dataPath(`${NEW}.mp4`),
  sidecars: [
    { from: dataPath(`${OLD}.en.srt`), to: dataPath(`${NEW}.en.srt`) },
    { from: dataPath(`${OLD}.de.forced.srt`), to: dataPath(`${NEW}.de.forced.srt`) },
  ],
  ...overrides,
});

const run = (p: MaintenancePayload) =>
  maintenanceHandler({
    layout,
    clients: {},
    runtime: new ClientRuntimeStore(),
    backend: new FakeBackend(),
    probe: async () => {
      throw new Error('A rename never probes.');
    },
  })({ jobId: 'j' as never, class: 'maintenance', leaseEpoch: 1, payload: p } as LeasedJob, {
    signal: new AbortController().signal,
    progress: () => {},
  });

const files = async () => (await readdir(season)).sort();

test('renames the sidecars, then the file, and returns the new path', async () => {
  for (const name of [`${OLD}.mp4`, `${OLD}.en.srt`, `${OLD}.de.forced.srt`]) await writeFile(join(season, name), name);
  expect(await run(payload())).toEqual({ class: 'maintenance', action: 'renameLibraryFile', path: dataPath(`${NEW}.mp4`) });
  expect(await files()).toEqual([`${NEW}.de.forced.srt`, `${NEW}.en.srt`, `${NEW}.mp4`]);
});

test('a re-run after the rename (a missing from with an existing to) counts as done', async () => {
  for (const name of [`${NEW}.mp4`, `${NEW}.en.srt`, `${NEW}.de.forced.srt`]) await writeFile(join(season, name), name);
  expect(await run(payload())).toEqual({ class: 'maintenance', action: 'renameLibraryFile', path: dataPath(`${NEW}.mp4`) });
  expect(await files()).toEqual([`${NEW}.de.forced.srt`, `${NEW}.en.srt`, `${NEW}.mp4`]);
});

test('a re-run after only the sidecars were renamed finishes with the file', async () => {
  for (const name of [`${OLD}.mp4`, `${NEW}.en.srt`, `${NEW}.de.forced.srt`]) await writeFile(join(season, name), name);
  await run(payload());
  expect(await files()).toEqual([`${NEW}.de.forced.srt`, `${NEW}.en.srt`, `${NEW}.mp4`]);
});

test('a file missing at both names fails as pipelineError', async () => {
  await expect(run(payload({ sidecars: [] }))).rejects.toMatchObject({ code: 'pipelineError', detail: expect.stringMatching(/missing/) });
});

test('a rename into another folder is refused and changes nothing', async () => {
  await writeFile(join(season, `${OLD}.mp4`), 'x');
  await expect(run(payload({ to: dataPath(`../Season 02/${NEW}.mp4`), sidecars: [] }))).rejects.toMatchObject({ code: 'pipelineError' });
  expect(await files()).toEqual([`${OLD}.mp4`]);
});

test('another file already at the new name is never overwritten', async () => {
  await writeFile(join(season, `${OLD}.mp4`), 'ours');
  await writeFile(join(season, `${NEW}.mp4`), 'theirs');
  await expect(run(payload({ sidecars: [] }))).rejects.toMatchObject({ code: 'pipelineError' });
  expect(await files()).toEqual([`${NEW}.mp4`, `${OLD}.mp4`]);
});
