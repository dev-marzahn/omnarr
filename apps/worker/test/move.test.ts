// `maintenance` `moveLibraryFile`: a scanned file that
// Jellyfin would misread moves into its Work folder under the name and
// season folder the import gives. On a real temporary
// /data tree.
import { mkdir, mkdtemp, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import type { LeasedJob, MaintenancePayload, ProbeSummary } from '@omnarr/contracts';
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';

import { dataLayout, type DataLayout } from '../src/fs/layout.ts';
import { inodeOf } from '../src/fs/space.ts';
import { maintenanceHandler } from '../src/jobs/maintenance.ts';
import { ClientRuntimeStore } from '../src/runtime/clientRuntime.ts';
import { FakeBackend } from './fakeBackend.ts';
import { release } from './payloads.ts';

let root: string;
let layout: DataLayout;
beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), 'omnarr-move-'));
  layout = dataLayout(root);
  await mkdir(join(layout.series, 'Holiday Footage 2019'), { recursive: true });
  // A Sonarr-named season folder the Work already has: the move uses it.
  await mkdir(join(layout.series, 'Old Show (2015)', 'Season 1'), { recursive: true });
});
afterEach(() => rm(root, { recursive: true, force: true }));

const PROBE: ProbeSummary = {
  container: 'mp4',
  durationMs: 1_440_000,
  streams: [
    {
      index: 0,
      kind: 'video',
      codec: 'h264',
      default: true,
      forced: false,
      hearingImpaired: false,
      width: 1920,
      height: 1080,
      bitDepth: 8,
      pixFmt: 'yuv420p',
      interlaced: false,
      hdr: 'sdr',
    },
    { index: 1, kind: 'audio', codec: 'aac', channels: 2, default: true, forced: false, hearingImpaired: false },
  ],
};

const FROM = '/data/library/series/Holiday Footage 2019/clip_0001.mp4';
/** The series naming template: title and year of the Work folder, S01E25, the episode title, then the audio and video tags. */
const NAME = 'Old Show (2015) - S01E25 - The Slump [AAC 2.0][h264].mp4';
const TO = `/data/library/series/Old Show (2015)/Season 1/${NAME}`;
const local = (dataPath: string) => join(root, dataPath.slice('/data'.length));

const payload = async (overrides: Partial<Extract<MaintenancePayload, { action: 'moveLibraryFile' }>> = {}): Promise<MaintenancePayload> => ({
  class: 'maintenance',
  action: 'moveLibraryFile',
  fileId: 'f1' as never,
  from: FROM,
  inode: inodeOf(await stat(local(FROM)).catch(() => stat(local(TO)))),
  workFolderPath: '/data/library/series/Old Show (2015)',
  naming: {
    kind: 'series',
    title: 'Old Show',
    year: 2015,
    tmdbId: 900008,
    anime: false,
    release: release({ title: 'clip', normalizedTitle: 'clip', quality: 'unknown' }),
  },
  units: [{ season: 1, episode: 25, title: 'The Slump' }],
  probe: PROBE,
  ...overrides,
});

const run = (p: MaintenancePayload) =>
  maintenanceHandler({
    layout,
    clients: {},
    runtime: new ClientRuntimeStore(),
    backend: new FakeBackend(),
    probe: async () => {
      throw new Error('A move never probes: the payload carries the probe.');
    },
  })({ jobId: 'j' as never, class: 'maintenance', leaseEpoch: 1, payload: p } as LeasedJob, {
    signal: new AbortController().signal,
    progress: () => {},
  });

test('moves the file into its Work folder under its library name, keeps its inode, and removes the emptied folder', async () => {
  await writeFile(local(FROM), 'clip');
  const before = inodeOf(await stat(local(FROM)));
  expect(await run(await payload())).toEqual({ class: 'maintenance', action: 'moveLibraryFile', path: TO, sidecars: [] });
  expect(inodeOf(await stat(local(TO)))).toBe(before);
  expect((await readdir(layout.series)).sort()).toEqual(['Old Show (2015)']);
});

test('a re-run after the move (from gone, the file at its name) returns the same path', async () => {
  await writeFile(local(FROM), 'clip');
  const p = await payload();
  await run(p);
  expect(await run(p)).toEqual({ class: 'maintenance', action: 'moveLibraryFile', path: TO, sidecars: [] });
});

test('another file at the name is never replaced: the moved file gets " (1)", as at import', async () => {
  await writeFile(local(FROM), 'clip');
  await writeFile(local(TO), 'someone else');
  const result = await run(await payload());
  expect(result).toEqual({ class: 'maintenance', action: 'moveLibraryFile', path: TO.replace(/\.mp4$/, ' (1).mp4'), sidecars: [] });
  expect(await readFile(local(TO), 'utf8')).toBe('someone else');
});

describe('subtitle sidecars move with their file, named by the sidecar rule', () => {
  const BASE = NAME.replace(/\.mp4$/, '');
  const SEASON = '/data/library/series/Old Show (2015)/Season 1';
  const OLD = '/data/library/series/Holiday Footage 2019';

  test("the file's sidecars go beside it under its new base name; another video's stay", async () => {
    for (const name of ['clip_0001.mp4', 'clip_0001.en.srt', 'clip_0001.ger.forced.ass', 'clip_0002.en.srt']) await writeFile(local(`${OLD}/${name}`), name);
    const result = await run(await payload());
    expect(result).toEqual({
      class: 'maintenance',
      action: 'moveLibraryFile',
      path: TO,
      sidecars: [
        { path: `${SEASON}/${BASE}.de.forced.ass`, language: 'de', forced: true, sdh: false, format: 'ass' },
        { path: `${SEASON}/${BASE}.en.srt`, language: 'en', forced: false, sdh: false, format: 'srt' },
      ],
    });
    expect(await readFile(local(`${SEASON}/${BASE}.en.srt`), 'utf8')).toBe('clip_0001.en.srt');
    // The folder still holds another video's subtitle, so it stays.
    expect(await readdir(local(OLD))).toEqual(['clip_0002.en.srt']);
  });

  test('a re-run after the file moved but before its sidecars did moves them too', async () => {
    await writeFile(local(FROM), 'clip');
    const p = await payload();
    await run(p);
    // As if the earlier run had stopped after the file: its sidecar still in the old folder.
    await mkdir(local(OLD), { recursive: true });
    await writeFile(local(`${OLD}/clip_0001.en.srt`), 'late');
    expect(await run(p)).toMatchObject({ sidecars: [{ path: `${SEASON}/${BASE}.en.srt`, language: 'en', forced: false, sdh: false, format: 'srt' }] });
    expect(await readFile(local(`${SEASON}/${BASE}.en.srt`), 'utf8')).toBe('late');
  });
});

test('a file missing at both places fails as pipelineError; a path outside the library is refused', async () => {
  await writeFile(local(FROM), 'clip');
  const p = await payload();
  await rm(local(FROM));
  await expect(run(p)).rejects.toMatchObject({ code: 'pipelineError', detail: expect.stringMatching(/missing/) });
  await expect(run({ ...p, from: '/data/downloads/usenet/x.mkv' } as MaintenancePayload)).rejects.toMatchObject({ code: 'pipelineError' });
});
