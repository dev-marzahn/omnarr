// The download reconciler's worker functions: the active
// Downloads it compares, and the client items with no Grab it reports at
// worker start.
import { beforeEach, describe, expect, test } from 'vite-plus/test';

import { api } from '../convex/_generated/api';
import type { FakeWorker } from './fakeWorker';
import { E1, pipelineHarness } from './harness';
import { worker } from './setup';

const h = pipelineHarness();
let w: FakeWorker;

beforeEach(async () => {
  await h.indexer([E1]);
  await h.subscribe();
  w = await h.worker();
});

describe('downloads.watched', () => {
  test('lists every active Download with its correlation tag, stage and client reference', async () => {
    await w.submitAll();
    const [grab] = await h.all('grabs');
    const [download] = await h.all('downloads');
    expect(await h.t.query(api.jobs.downloads.watched, { ...worker, sessionId: w.sessionId })).toEqual([
      { downloadId: download!._id, clientKind: 'nzbget', clientRef: download!.clientRef, correlationTag: grab!._id, clientStage: 'queued', state: 'active' },
    ]);
  });

  test('a completed NZBGet Download is no longer watched; completed torrents are (seeding.test.ts)', async () => {
    await w.submitAll();
    await h.settle();
    await w.completed(await h.activeDownload());
    await h.settle();
    expect(await h.t.query(api.jobs.downloads.watched, { ...worker, sessionId: w.sessionId })).toEqual([]);
  });
});

describe('downloads.orphans', () => {
  const orphans = (items: { clientRef: string; correlationTag?: string; name: string }[]) =>
    h.t.mutation(api.jobs.downloads.orphans, { ...worker, sessionId: w.sessionId, items: items.map((item) => ({ clientKind: 'nzbget' as const, ...item })) });

  test('raises one orphanClientItem Issue for client items whose tag names no Grab the platform knows', async () => {
    await w.submitAll();
    const [grab] = await h.all('grabs');
    await orphans([
      { clientRef: '1', correlationTag: grab!._id, name: 'ours' },
      { clientRef: '2', correlationTag: 'someone-elses', name: 'Stray.Release.S01E01' },
      { clientRef: '3', name: 'Added.By.Hand' },
    ]);
    const issues = await h.all('issues');
    expect(issues).toEqual([
      expect.objectContaining({ scope: 'system', failureCode: 'orphanClientItem', state: 'open', fixActions: ['removeClientItem', 'dismiss'] }),
    ]);
    expect(issues[0]!.detail).toContain('Stray.Release.S01E01');
    expect(issues[0]!.detail).toContain('Added.By.Hand');
    expect(issues[0]!.detail).not.toContain('ours');
  });

  test('raises nothing when every item belongs to a Grab', async () => {
    await w.submitAll();
    const [grab] = await h.all('grabs');
    await orphans([{ clientRef: '1', correlationTag: grab!._id, name: 'ours' }]);
    expect(await h.all('issues')).toEqual([]);
  });
});
