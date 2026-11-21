// The Torznab adapter. Requests are Newznab's; the
// items are torrents, so feed.ts reads each one's `torznab:attr` fields
// (seeders, peers, info hash, magnet, minimums) into its `torrent`.
import type { AdapterIndexer, IndexerAdapter } from './adapter';
import { createFeedAdapter } from './newznab';

export const createTorznabAdapter = (indexer: AdapterIndexer, options: { timeoutMs?: number } = {}): IndexerAdapter =>
  createFeedAdapter(indexer, 'torrent', options);
