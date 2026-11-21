// A seeding BitTorrent peer for the e2e fakes: it holds every
// piece of the torrents it is given and answers a leecher's metadata requests
// (BEP 9 over BEP 10), so a magnet downloads with no tracker, DHT or other
// peer. The Torznab fake names it in each magnet's `x.pe`. It speaks only
// what a leecher needs: the handshake, the extended handshake, a bitfield,
// unchoke on interest, pieces on request, and metadata pieces. No package
// dependencies.
import { randomBytes } from 'node:crypto';
import { createServer, type Server, type Socket } from 'node:net';

import { bencode, type Torrent } from '../torrent/torrent.ts';

export type SeededTorrent = Torrent & { content: Uint8Array };

const PROTOCOL = Buffer.from('\x13BitTorrent protocol', 'latin1');
const METADATA_PIECE = 16_384;
/** The id we advertise for ut_metadata in our extended handshake. */
const OUR_UT_METADATA = 3;

const message = (id: number, payload: Uint8Array = new Uint8Array()) => {
  const header = Buffer.alloc(5);
  header.writeUInt32BE(payload.byteLength + 1, 0);
  header.writeUInt8(id, 4);
  return Buffer.concat([header, payload]);
};

/** The small dicts peers send each other: integers, strings and nested dicts, enough for BEP 9 and 10. */
function decode(bytes: Buffer, at = 0): { value: unknown; end: number } {
  const c = bytes[at];
  if (c === 0x69) {
    const end = bytes.indexOf(0x65, at);
    return { value: Number(bytes.subarray(at + 1, end).toString('latin1')), end: end + 1 };
  }
  if (c !== undefined && c >= 0x30 && c <= 0x39) {
    const colon = bytes.indexOf(0x3a, at);
    const length = Number(bytes.subarray(at, colon).toString('latin1'));
    return { value: bytes.subarray(colon + 1, colon + 1 + length).toString('latin1'), end: colon + 1 + length };
  }
  if (c === 0x6c || c === 0x64) {
    const items: unknown[] = [];
    let cursor = at + 1;
    while (bytes[cursor] !== 0x65) {
      const next = decode(bytes, cursor);
      items.push(next.value);
      cursor = next.end;
    }
    if (c === 0x6c) return { value: items, end: cursor + 1 };
    const dict: Record<string, unknown> = {};
    for (let i = 0; i < items.length; i += 2) dict[items[i] as string] = items[i + 1];
    return { value: dict, end: cursor + 1 };
  }
  throw new Error('not bencode');
}

function serve(socket: Socket, torrents: Map<string, SeededTorrent>, peerId: Buffer): void {
  let buffer = Buffer.alloc(0);
  let torrent: SeededTorrent | undefined;
  let theirUtMetadata: number | undefined;

  const pieceCount = () => Math.ceil(torrent!.content.length / torrent!.pieceLength);
  const onMessage = (id: number, payload: Buffer) => {
    if (id === 2) socket.write(message(1)); // interested → unchoke
    else if (id === 6) {
      const index = payload.readUInt32BE(0);
      const begin = payload.readUInt32BE(4);
      const length = payload.readUInt32BE(8);
      const start = index * torrent!.pieceLength + begin;
      const header = Buffer.alloc(8);
      header.writeUInt32BE(index, 0);
      header.writeUInt32BE(begin, 4);
      socket.write(message(7, Buffer.concat([header, torrent!.content.subarray(start, start + length)])));
    } else if (id === 20) {
      const ext = payload[0];
      const body = payload.subarray(1);
      const dict = decode(body).value as Record<string, unknown>;
      if (ext === 0) theirUtMetadata = (dict.m as Record<string, number> | undefined)?.ut_metadata;
      else if (ext === OUR_UT_METADATA && dict.msg_type === 0 && theirUtMetadata !== undefined) {
        const piece = dict.piece as number;
        const data = torrent!.info.subarray(piece * METADATA_PIECE, (piece + 1) * METADATA_PIECE);
        const reply = Buffer.concat([Buffer.from([theirUtMetadata]), bencode({ msg_type: 1, piece, total_size: torrent!.info.length }), data]);
        socket.write(message(20, reply));
      }
    }
  };

  socket.on('data', (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    if (!torrent) {
      if (buffer.length < 68) return;
      if (!buffer.subarray(0, 20).equals(PROTOCOL)) return void socket.destroy();
      torrent = torrents.get(buffer.subarray(28, 48).toString('hex'));
      if (!torrent) return void socket.destroy();
      buffer = buffer.subarray(68);
      const reserved = Buffer.alloc(8);
      reserved[5] = 0x10; // the extension protocol (BEP 10)
      socket.write(Buffer.concat([PROTOCOL, reserved, Buffer.from(torrent.infoHash, 'hex'), peerId]));
      // BEP 3: the bitfield first, right after the handshake; then the extended handshake.
      const bits = Buffer.alloc(Math.ceil(pieceCount() / 8));
      for (let i = 0; i < pieceCount(); i++) bits[i >> 3]! |= 0x80 >> (i & 7);
      socket.write(message(5, bits));
      socket.write(message(20, Buffer.concat([Buffer.from([0]), bencode({ m: { ut_metadata: OUR_UT_METADATA }, metadata_size: torrent.info.length })])));
    }
    while (buffer.length >= 4) {
      const length = buffer.readUInt32BE(0);
      if (buffer.length < 4 + length) break;
      const body = buffer.subarray(4, 4 + length);
      buffer = buffer.subarray(4 + length);
      if (length > 0) onMessage(body[0]!, body.subarray(1));
    }
  });
  socket.on('error', () => socket.destroy());
}

/** A listening seed for these torrents (by info hash). */
export function createSeedPeer(seeded: SeededTorrent[]): Server {
  const torrents = new Map(seeded.map((torrent) => [torrent.infoHash, torrent]));
  const peerId = Buffer.concat([Buffer.from('-OF0001-', 'latin1'), randomBytes(12)]);
  return createServer((socket) => serve(socket, torrents, peerId));
}
