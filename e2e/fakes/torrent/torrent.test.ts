import { createHash } from 'node:crypto';

import { describe, expect, test } from 'vite-plus/test';

import { bencode, makeTorrent } from './torrent.ts';

const text = (bytes: Uint8Array) => Buffer.from(bytes).toString('latin1');

describe('bencode', () => {
  test('integers, strings, lists and dicts with sorted keys', () => {
    expect(text(bencode(42))).toBe('i42e');
    expect(text(bencode('spam'))).toBe('4:spam');
    expect(text(bencode(['a', 1]))).toBe('l1:ai1ee');
    expect(text(bencode({ zeta: 1, alpha: 'x' }))).toBe('d5:alpha1:x4:zetai1ee');
  });

  test('byte strings are written as they are', () => {
    expect(bencode(new Uint8Array([0, 255]))).toEqual(new Uint8Array([...new TextEncoder().encode('2:'), 0, 255]));
  });
});

describe('makeTorrent', () => {
  const content = new Uint8Array(40_000).map((_, i) => i % 251);

  test('a single-file v1 torrent with a web seed: pieces are the SHA-1 of each piece, the hash the SHA-1 of the info dict', () => {
    const torrent = makeTorrent({ name: 'Show.S01E01.mkv', content, pieceLength: 16_384, webSeeds: ['http://webseed:4130/files/'] });
    const pieces = [0, 16_384, 32_768]
      .map((at) =>
        createHash('sha1')
          .update(content.subarray(at, at + 16_384))
          .digest('latin1'),
      )
      .join('');
    const info = `d6:lengthi40000e4:name15:Show.S01E01.mkv12:piece lengthi16384e6:pieces60:${pieces}e`;
    expect(text(torrent.info)).toBe(info);
    expect(torrent.infoHash).toBe(createHash('sha1').update(info, 'latin1').digest('hex'));
    expect(text(torrent.bytes)).toBe(`d4:info${info}8:url-listl26:http://webseed:4130/files/ee`);
  });

  test('private and an announce URL go where clients read them', () => {
    const torrent = makeTorrent({ name: 'a', content, pieceLength: 16_384, private: true, announce: 'http://tracker.invalid/announce' });
    expect(text(torrent.bytes).startsWith('d8:announce31:http://tracker.invalid/announce4:infod')).toBe(true);
    expect(text(torrent.info)).toContain('7:privatei1e');
  });
});
