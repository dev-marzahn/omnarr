// release/torrent.ts: a .torrent's info hash over the bytes
// of its `info` value as served, and a magnet's hash. The fixture files'
// expected hashes are the ones qBittorrent 5.3.0-2 reported for them
// (fixtures/qbittorrent/README.md).
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';

import { describe, expect, test } from 'vite-plus/test';

import { parseMagnet, parseTorrent } from '../src/release/torrent.ts';

const bytes = (text: string) => new TextEncoder().encode(text);
const sha1 = (text: string) => createHash('sha1').update(text, 'latin1').digest('hex');
const sha256 = (text: string) => createHash('sha256').update(text, 'latin1').digest('hex');

// A v1 info dict, written by hand: its span is known by construction.
const PIECES = 'ABCDEFGHIJKLMNOPQRST';
const V1_INFO = `d6:lengthi5e4:name5:a.mkv12:piece lengthi16384e6:pieces20:${PIECES}e`;

describe('parseTorrent', () => {
  test('a v1 torrent: the SHA-1 of its info value, byte for byte as served', () => {
    expect(parseTorrent(bytes(`d8:announce14:http://t.e/ann4:info${V1_INFO}e`))).toEqual({ infoHash: sha1(V1_INFO) });
  });

  test('keys after info and nested lists do not change the span', () => {
    const torrent = `d8:url-listl21:http://webseed:4130/a5:extrae4:info${V1_INFO}7:privatei1ee`;
    expect(parseTorrent(bytes(torrent))).toEqual({ infoHash: sha1(V1_INFO) });
  });

  test('an info value whose keys are out of order is still hashed as served, not re-encoded', () => {
    const unsorted = `d4:name5:a.mkv6:lengthi5e12:piece lengthi16384e6:pieces20:${PIECES}e`;
    expect(parseTorrent(bytes(`d4:info${unsorted}e`))).toEqual({ infoHash: sha1(unsorted) });
  });

  test('a v2-only torrent (meta version 2, no pieces): the SHA-256, truncated to 40 hex characters', () => {
    const info = 'd9:file treed5:a.mkvd0:d6:lengthi5eeee12:meta versioni2e4:name5:a.mkv12:piece lengthi16384ee';
    expect(parseTorrent(bytes(`d4:info${info}e`))).toEqual({ infoHash: sha256(info).slice(0, 40) });
  });

  test('a hybrid torrent (meta version 2 and pieces): the truncated SHA-256, as qBittorrent 5.3 names it', () => {
    const info = `d9:file treed5:a.mkvd0:d6:lengthi5eeee6:lengthi5e12:meta versioni2e4:name5:a.mkv12:piece lengthi16384e6:pieces20:${PIECES}e`;
    expect(parseTorrent(bytes(`d4:info${info}e`))).toEqual({ infoHash: sha256(info).slice(0, 40) });
  });

  // The `hash` qBittorrent 5.3.0-2 reported for each file it made (fixtures README, "Info hashes").
  test.each([
    ['v1-single.torrent', 'f3170e36e5aefb892f6640007f31068957d50856'],
    ['v1-multi.torrent', '36c5180481b017827d85f17f097cb4fefc17541b'],
    ['hybrid-multi.torrent', '532ca42b979ffddc7a36b99af8c5a9010812af97'],
    ['v2-single.torrent', '36c337ee7b2f2a944e626e0bb68f61b9f4cddf2a'],
    ['private-dead-tracker.torrent', 'a8cff320805c912c48de5be2d969f8ca925d0f44'],
  ])('%s gets the hash qBittorrent reported', (file, hash) => {
    const body = readFileSync(new URL(`./fixtures/qbittorrent/torrents/${file}`, import.meta.url));
    expect(parseTorrent(new Uint8Array(body))).toEqual({ infoHash: hash });
  });

  test.each([
    ['not bencode', '<html>login</html>'],
    ['a list, not a dict', 'l4:infoe'],
    ['no info', 'd8:announce3:abce'],
    ['info is not a dict', 'd4:info3:abce'],
    ['truncated', `d4:info${V1_INFO.slice(0, 20)}`],
    ['a string longer than the body', 'd4:info99:abce'],
    ['trailing bytes', `d4:info${V1_INFO}ee`],
    ['empty', ''],
  ])('%s is not a torrent', (_name, text) => {
    expect(parseTorrent(bytes(text))).toBeUndefined();
  });
});

describe('parseMagnet', () => {
  test('btih in hex, in either case', () => {
    expect(parseMagnet('magnet:?xt=urn:btih:C12FE1C06BBA254A9DC9F519B335AA7C1367A88A&dn=x')).toEqual({
      infoHash: 'c12fe1c06bba254a9dc9f519b335aa7c1367a88a',
    });
  });

  test('btih in base32', () => {
    expect(parseMagnet('magnet:?dn=x&xt=urn:btih:ABCDEFGHIJKLMNOPQRSTUVWXYZ234567')).toEqual({ infoHash: '00443214c74254b635cf84653a56d7c675be77df' });
  });

  test('a v2-only magnet (btmh): the truncated SHA-256', () => {
    expect(parseMagnet(`magnet:?xt=urn:btmh:1220${'ab'.repeat(32)}`)).toEqual({ infoHash: 'ab'.repeat(20) });
  });

  test('a hybrid magnet with both: the truncated btmh, as qBittorrent names a hybrid', () => {
    expect(parseMagnet(`magnet:?xt=urn:btih:${'cd'.repeat(20)}&xt=urn:btmh:1220${'ab'.repeat(32)}`)).toEqual({ infoHash: 'ab'.repeat(20) });
  });

  test.each(['magnet:?dn=no-hash', 'magnet:?xt=urn:btih:xyz', 'http://tracker.example/a.torrent', 'magnet:?xt=urn:sha1:ABCDEFGHIJKLMNOPQRSTUVWXYZ234567'])(
    '%s has no hash',
    (uri) => {
      expect(parseMagnet(uri)).toBeUndefined();
    },
  );
});
