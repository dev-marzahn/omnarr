import { describe, expect, test } from 'vite-plus/test';

import { sha256 } from '../../convex/lib/sha256';
import { RESYNC_BATCH, storeList, type ListStore } from '../../convex/mapping/listStore';

function recordingStore(changedPerItem: (item: number) => number[]) {
  const calls: string[] = [];
  const resyncs: number[][] = [];
  const store: ListStore<number> = {
    parse: (body) => JSON.parse(body) as number[],
    batchSize: 500,
    writeBatch: async (_version, batch) => {
      calls.push('write');
      return batch.flatMap(changedPerItem);
    },
    deleteStalePage: async () => {
      calls.push('stale');
      return { ids: [], done: true };
    },
    recordFetch: async (version) => {
      calls.push(version === undefined ? 'record unchanged' : 'record');
    },
    resync: async (ids) => {
      calls.push('resync');
      resyncs.push(ids);
    },
  };
  return { store, calls, resyncs };
}

describe('storeList', () => {
  test('resyncs thousands of changed IDs once each, in batches of at most RESYNC_BATCH, after the version is recorded', async () => {
    const items = Array.from({ length: 3000 }, (_, i) => i);
    const { store, calls, resyncs } = recordingStore((item) => [item, item]);
    await storeList(JSON.stringify(items), undefined, store);
    expect(resyncs.every((ids) => ids.length <= RESYNC_BATCH)).toBe(true);
    expect(resyncs.flat().sort((a, b) => a - b)).toEqual(items);
    expect(calls.indexOf('record')).toBeLessThan(calls.indexOf('resync'));
  });

  test('a body with the stored hash writes nothing and resyncs nothing', async () => {
    const body = JSON.stringify([1, 2, 3]);
    const { store, calls } = recordingStore((item) => [item]);
    await storeList(body, await sha256(body), store);
    expect(calls).toEqual(['record unchanged']);
  });
});
