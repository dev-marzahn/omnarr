// What the worker fetches for a Grab: a
// definition indexer's http(s) link goes back to the engine as `siteUrl`;
// its magnets stay magnets; other indexers are unchanged.
import { expect, test } from 'vite-plus/test';

import type { Id } from '../convex/_generated/dataModel';
import { downloadSourceOf } from '../convex/pipeline/steps';

const indexerId = 'i1' as Id<'indexers'>;

test.each([
  ['a Newznab NZB', 'usenet', 'newznab', 'https://ix.test/getnzb/1', { kind: 'nzbUrl', url: 'https://ix.test/getnzb/1' }],
  ['a Torznab .torrent', 'torrent', 'torznab', 'https://ix.test/dl/1.torrent', { kind: 'torrentUrl', url: 'https://ix.test/dl/1.torrent' }],
  ['a definition link', 'torrent', 'definition', 'https://site.test/torrent/1', { kind: 'siteUrl', url: 'https://site.test/torrent/1', indexerId }],
  ['a definition magnet', 'torrent', 'definition', 'magnet:?xt=urn:btih:aa', { kind: 'magnet', uri: 'magnet:?xt=urn:btih:aa' }],
  ['a Nyaa magnet', 'torrent', 'nyaa', 'magnet:?xt=urn:btih:bb', { kind: 'magnet', uri: 'magnet:?xt=urn:btih:bb' }],
] as const)('%s', (_name, protocol, kind, downloadUrl, source) => {
  expect(downloadSourceOf(protocol, { downloadUrl, indexerId }, kind)).toEqual(source);
});
