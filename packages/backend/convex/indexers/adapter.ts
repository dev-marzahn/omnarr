// The indexer adapter port: caps, one search request and
// one RSS page, each answered with a page or an IndexerFailure. A site
// indexer answers the same port; its requests are paced, so it may
// also answer that no request was sent (`skipped: 'paced'`).
import type { IndexerCaps, IndexerCategories, IndexerKind, IndexerPage, IndexerRequest, IndexerResult } from '@omnarr/contracts';

import type { Id } from '../_generated/dataModel';
import type { ActionCtx } from '../_generated/server';
import { createNewznabAdapter } from './newznab';
import { createNyaaAdapter, nyaaCaps } from './nyaa';
import { paced, pacingIntervalOf } from './pacing';
import { createRelayAdapter } from './relay';
import { createTorznabAdapter } from './torznab';

export interface IndexerAdapter {
  caps(): Promise<IndexerResult<IndexerCaps>>;
  search(request: IndexerRequest): Promise<IndexerResult<IndexerPage>>;
  rss(page: { offset: number }): Promise<IndexerResult<IndexerPage>>;
}

/** What an adapter needs of an indexer record. `apiKey` is internal only. */
export type AdapterIndexer = {
  id: Id<'indexers'>;
  apiUrl: string;
  apiKey: string;
  kind: IndexerKind;
  categories: IndexerCategories;
  /** The stored caps; the Newznab and Torznab adapters read only `pageLimit`. */
  caps?: Pick<IndexerCaps, 'pageLimit'> & Partial<IndexerCaps>;
};

/**
 * The implementation for the indexer's kind. A site indexer's pacing slot
 * goes through `ctx`; a definition indexer is the relay to the worker's
 * engine, which takes its slots there.
 */
export function createAdapter(
  indexer: AdapterIndexer,
  ctx: Pick<ActionCtx, 'runMutation' | 'runQuery'>,
  options: { timeoutMs?: number; slotWaitLeftMs: () => number },
): IndexerAdapter {
  switch (indexer.kind) {
    case 'definition':
      return createRelayAdapter({ id: indexer.id, apiUrl: indexer.apiUrl, ...(indexer.caps?.searchModes ? { caps: indexer.caps as IndexerCaps } : {}) }, ctx);
    case 'nyaa':
      return createNyaaAdapter(indexer, {
        ...options,
        pace: () => paced(ctx, indexer.id, pacingIntervalOf({ kind: 'nyaa' })!, options.slotWaitLeftMs()),
      });
    case 'torznab':
      return createTorznabAdapter(indexer, options);
    case 'newznab':
      return createNewznabAdapter(indexer, options);
  }
}

/**
 * Kinds whose caps are built, not fetched: the 24-hour caps refresh rebuilds
 * them without a request. A definition's were built from its file at
 * create and at each sync, so they are kept, with the time of the refresh.
 */
export function builtCaps(indexer: { kind: IndexerKind; caps: IndexerCaps }, now: number): IndexerCaps | undefined {
  if (indexer.kind === 'nyaa') return nyaaCaps(now);
  if (indexer.kind === 'definition') return { ...indexer.caps, fetchedAt: now };
  return undefined;
}
