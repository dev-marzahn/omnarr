// The seed peer, against a leecher written here from BEP 3, 9 and 10.
import { connect, type AddressInfo, type Socket } from 'node:net';

import { afterAll, beforeAll, describe, expect, test } from 'vite-plus/test';

import { bencode, makeTorrent } from '../torrent/torrent.ts';
import { createSeedPeer } from './peer.ts';

const content = new Uint8Array(40_000).map((_, i) => (i * 7) % 256);
const torrent = { ...makeTorrent({ name: 'Show.S01E02.mkv', content, pieceLength: 16_384 }), content };
const peer = createSeedPeer([torrent]);
let port: number;
beforeAll(() => new Promise<void>((resolve) => peer.listen(0, '127.0.0.1', () => resolve())));
beforeAll(() => {
  port = (peer.address() as AddressInfo).port;
});
afterAll(() => new Promise<void>((resolve) => peer.close(() => resolve())));

/** A leecher's socket that reads whole messages. */
function leecher(infoHash: string) {
  const socket: Socket = connect(port, '127.0.0.1');
  let buffer = Buffer.alloc(0);
  let handshake: Buffer | undefined;
  const waiting: ((value: { id: number; body: Buffer }) => void)[] = [];
  const queue: { id: number; body: Buffer }[] = [];
  let closed = false;
  socket.on('close', () => (closed = true));
  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!handshake && buffer.length >= 68) {
      handshake = buffer.subarray(0, 68);
      buffer = buffer.subarray(68);
    }
    while (handshake && buffer.length >= 4 && buffer.length >= 4 + buffer.readUInt32BE(0)) {
      const length = buffer.readUInt32BE(0);
      const msg = { id: buffer[4]!, body: buffer.subarray(5, 4 + length) };
      buffer = buffer.subarray(4 + length);
      const next = waiting.shift();
      if (next) next(msg);
      else queue.push(msg);
    }
  });
  const reserved = Buffer.alloc(8);
  reserved[5] = 0x10;
  socket.write(Buffer.concat([Buffer.from('\x13BitTorrent protocol', 'latin1'), reserved, Buffer.from(infoHash, 'hex'), Buffer.alloc(20, 1)]));
  const send = (id: number, payload: Uint8Array = new Uint8Array()) => {
    const header = Buffer.alloc(5);
    header.writeUInt32BE(payload.byteLength + 1, 0);
    header[4] = id;
    socket.write(Buffer.concat([header, payload]));
  };
  return {
    socket,
    handshake: () => handshake,
    closed: () => closed,
    next: () => new Promise<{ id: number; body: Buffer }>((resolve) => (queue.length > 0 ? resolve(queue.shift()!) : waiting.push(resolve))),
    send,
  };
}

describe('the seed peer', () => {
  test('a leecher with only the info hash gets the metadata and every piece', async () => {
    const l = leecher(torrent.infoHash);
    // BEP 3: a bitfield comes only right after the handshake.
    const bitfield = await l.next();
    expect([bitfield.id, [...bitfield.body]]).toEqual([5, [0b1110_0000]]);
    const extHandshake = await l.next();
    expect(extHandshake.id).toBe(20);
    expect(extHandshake.body[0]).toBe(0);
    const theirs = extHandshake.body.subarray(1).toString('latin1');
    expect(theirs).toContain(`13:metadata_sizei${torrent.info.length}e`);
    const utMetadata = Number(/11:ut_metadatai(\d+)e/.exec(theirs)![1]);
    expect(l.handshake()!.subarray(28, 48).toString('hex')).toBe(torrent.infoHash);
    expect(l.handshake()![25]! & 0x10).toBe(0x10);

    // Our ut_metadata is 9; ask for metadata piece 0.
    l.send(20, Buffer.concat([Buffer.from([0]), bencode({ m: { ut_metadata: 9 } })]));
    l.send(20, Buffer.concat([Buffer.from([utMetadata]), bencode({ msg_type: 0, piece: 0 })]));
    const metadata = await l.next();
    expect([metadata.id, metadata.body[0]]).toEqual([20, 9]);
    const dict = bencode({ msg_type: 1, piece: 0, total_size: torrent.info.length });
    expect(metadata.body.subarray(1, 1 + dict.length)).toEqual(Buffer.from(dict));
    expect(new Uint8Array(metadata.body.subarray(1 + dict.length))).toEqual(torrent.info);

    l.send(2);
    expect((await l.next()).id).toBe(1);
    const request = Buffer.alloc(12);
    request.writeUInt32BE(2, 0);
    request.writeUInt32BE(1000, 4);
    request.writeUInt32BE(500, 8);
    l.send(6, request);
    const piece = await l.next();
    expect(piece.id).toBe(7);
    expect([piece.body.readUInt32BE(0), piece.body.readUInt32BE(4)]).toEqual([2, 1000]);
    expect(new Uint8Array(piece.body.subarray(8))).toEqual(content.subarray(2 * 16_384 + 1000, 2 * 16_384 + 1500));
    l.socket.destroy();
  });

  test('a torrent it does not hold is refused', async () => {
    const l = leecher('ab'.repeat(20));
    await new Promise((resolve) => l.socket.on('close', resolve));
    expect(l.handshake()).toBeUndefined();
  });
});
