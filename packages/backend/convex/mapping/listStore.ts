import { sha256 } from '../lib/sha256';

export const RESYNC_BATCH = 200;

export type ListStore<Item> = {
  parse: (body: string) => Item[] | Promise<Item[]>;
  batchSize: number;
  writeBatch: (version: string, batch: Item[]) => Promise<number[]>;
  deleteStalePage: (version: string) => Promise<{ ids: number[]; done: boolean }>;
  recordFetch: (version?: string) => Promise<unknown>;
  resync: (ids: number[]) => Promise<unknown>;
};

export async function storeList<Item>(body: string, storedVersion: string | undefined, store: ListStore<Item>): Promise<void> {
  const version = await sha256(body);
  if (version === storedVersion) {
    await store.recordFetch();
    return;
  }
  const items = await store.parse(body);
  const changed = new Set<number>();
  for (let i = 0; i < items.length; i += store.batchSize)
    for (const id of await store.writeBatch(version, items.slice(i, i + store.batchSize))) changed.add(id);
  for (;;) {
    const page = await store.deleteStalePage(version);
    for (const id of page.ids) changed.add(id);
    if (page.done) break;
  }
  await store.recordFetch(version);
  await resyncInBatches([...changed], store.resync);
}

export async function resyncInBatches(ids: number[], resync: (ids: number[]) => Promise<unknown>): Promise<void> {
  for (let i = 0; i < ids.length; i += RESYNC_BATCH) await resync(ids.slice(i, i + RESYNC_BATCH));
}
