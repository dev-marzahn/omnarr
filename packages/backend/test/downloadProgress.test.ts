// Download progress on the read DTOs and the worker's progress-only report:
// bytes, speed and the fraction of the running Grab's Download, on UnitRow,
// Timeline and WorkSummary.
import { beforeEach, describe, expect, test } from 'vite-plus/test';

import { api } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import type { FakeWorker } from './fakeWorker';
import { E1, pipelineHarness } from './harness';
import { worker } from './setup';

const h = pipelineHarness();
let w: FakeWorker;
let workId: Id<'works'>;

const bytes = {
  stage: 'DOWNLOADING',
  progress: 0.4,
  doneBytes: 600_000_000,
  totalBytes: 1_500_000_000,
  bytesPerSec: 12_500_000,
  raw: { Status: 'DOWNLOADING' },
};
const progress = (downloadId: Id<'downloads'>, clientStatus: typeof bytes) =>
  h.t.mutation(api.jobs.downloads.progress, { ...worker, sessionId: w.sessionId, progress: [{ downloadId, clientStatus }] });

beforeEach(async () => {
  await h.indexer([E1]);
  workId = await h.subscribe();
  w = await h.worker();
  await w.submitAll();
  await h.settle();
});

describe('downloads.progress', () => {
  test("writes the client's status with its bytes and speed, and keeps the stage", async () => {
    const downloadId = await h.activeDownload();
    await w.stage(downloadId, 'downloading');
    await progress(downloadId, bytes);
    const download = await h.get(downloadId);
    expect(download).toMatchObject({ clientStage: 'downloading', clientStatus: bytes });
  });

  test('adds no event: the timeline keeps one per stage', async () => {
    const downloadId = await h.activeDownload();
    await w.stage(downloadId, 'downloading');
    const before = (await h.all('events')).length;
    await progress(downloadId, bytes);
    await progress(downloadId, { ...bytes, progress: 0.5, doneBytes: 750_000_000 });
    expect((await h.all('events')).length).toBe(before);
  });

  test('leaves a Download that has ended alone', async () => {
    const downloadId = await h.activeDownload();
    await w.completed(downloadId);
    await h.settle();
    const after = await h.get(downloadId);
    await progress(downloadId, bytes);
    expect((await h.get(downloadId))!.clientStatus).toEqual(after!.clientStatus);
  });
});

describe('the download on the read DTOs', () => {
  test("UnitRow.download: the running Grab's protocol, stage, fraction, bytes and speed", async () => {
    const downloadId = await h.activeDownload();
    await w.stage(downloadId, 'downloading');
    await progress(downloadId, bytes);
    const [grab] = await h.all('grabs');
    const detail = await h.admin.query(api.api.library.detail, { workId });
    const row = detail!.units.find((unit) => unit.tmdbSeason === 1 && unit.tmdbEpisode === 1)!;
    expect(row.download).toEqual({
      grabId: grab!._id,
      protocol: 'usenet',
      stage: 'downloading',
      fraction: 0.4,
      doneBytes: 600_000_000,
      totalBytes: 1_500_000_000,
      bytesPerSec: 12_500_000,
    });
    expect(detail!.units.find((unit) => unit.tmdbEpisode === 2)!.download).toBeUndefined();
  });

  test('before the first report: no fraction, so the page says it is waiting', async () => {
    const detail = await h.admin.query(api.api.library.detail, { workId });
    const row = detail!.units.find((unit) => unit.tmdbSeason === 1 && unit.tmdbEpisode === 1)!;
    expect(row.download).toMatchObject({ protocol: 'usenet', stage: 'queued' });
    expect(row.download!.fraction).toBeUndefined();
  });

  test('Timeline.download and Timeline.workKind', async () => {
    const downloadId = await h.activeDownload();
    await w.stage(downloadId, 'downloading');
    await progress(downloadId, bytes);
    const unit = await h.unit(workId, 1, 1);
    const timeline = await h.admin.query(api.api.units.timeline, { unitId: unit._id });
    expect(timeline!.workKind).toBe('series');
    expect(timeline!.download).toMatchObject({ protocol: 'usenet', stage: 'downloading', fraction: 0.4, bytesPerSec: 12_500_000 });
  });

  test('no download once the Grab has ended', async () => {
    const downloadId = await h.activeDownload();
    await w.completed(downloadId);
    await h.settle();
    const unit = await h.unit(workId, 1, 1);
    expect((await h.admin.query(api.api.units.timeline, { unitId: unit._id }))!.download).toBeUndefined();
  });

  test("WorkSummary.activeDownloads: the Work's running Downloads, their fraction and speed", async () => {
    const downloadId = await h.activeDownload();
    await w.stage(downloadId, 'downloading');
    await progress(downloadId, bytes);
    const { works } = await h.admin.query(api.api.library.list, { kind: 'series' });
    expect(works[0]!.activeDownloads).toEqual({ count: 1, fraction: 0.4, bytesPerSec: 12_500_000 });
  });

  test('no activeDownloads on a Work with none running', async () => {
    const downloadId = await h.activeDownload();
    await w.completed(downloadId);
    await h.settle();
    const { works } = await h.admin.query(api.api.library.list, { kind: 'series' });
    expect(works[0]!.activeDownloads).toBeUndefined();
  });
});
