// Torrents for the e2e fakes: a bencode writer and a v1
// single-file torrent of a file, with web seeds (BEP 19). The Torznab fake
// serves the .torrent files and magnets; the web-seed fake serves the
// content, and seeds it as a peer for magnets. No package dependencies.
import { createHash } from 'node:crypto';

export type Bencodable = number | string | Uint8Array | Bencodable[] | { [key: string]: Bencodable | undefined };

const encoder = new TextEncoder();

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((total, part) => total + part.byteLength, 0));
  let at = 0;
  for (const part of parts) {
    out.set(part, at);
    at += part.byteLength;
  }
  return out;
}

/** Bencode (BEP 3): dict keys sorted by their bytes, undefined values left out. */
export function bencode(value: Bencodable): Uint8Array {
  if (typeof value === 'number') return encoder.encode(`i${Math.trunc(value)}e`);
  if (typeof value === 'string') return bencode(encoder.encode(value));
  if (value instanceof Uint8Array) return concat([encoder.encode(`${value.byteLength}:`), value]);
  if (Array.isArray(value)) return concat([encoder.encode('l'), ...value.map(bencode), encoder.encode('e')]);
  const keys = Object.keys(value)
    .filter((key) => value[key] !== undefined)
    .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));
  return concat([encoder.encode('d'), ...keys.flatMap((key) => [bencode(key), bencode(value[key]!)]), encoder.encode('e')]);
}

export type TorrentSpec = {
  /** The file's name, which is the torrent's. */
  name: string;
  content: Uint8Array;
  pieceLength?: number;
  /** BEP 19 `url-list`: a URL ending in `/` gets the name appended by the client. */
  webSeeds?: string[];
  private?: boolean;
  announce?: string;
};

export type Torrent = { bytes: Uint8Array<ArrayBuffer>; info: Uint8Array; infoHash: string; pieceLength: number };

export function makeTorrent(spec: TorrentSpec): Torrent {
  const pieceLength = spec.pieceLength ?? 16_384;
  const pieces: Uint8Array[] = [];
  for (let at = 0; at < spec.content.length; at += pieceLength)
    pieces.push(
      createHash('sha1')
        .update(spec.content.subarray(at, at + pieceLength))
        .digest(),
    );
  const info = bencode({
    length: spec.content.length,
    name: spec.name,
    'piece length': pieceLength,
    pieces: concat(pieces),
    private: spec.private ? 1 : undefined,
  });
  const infoHash = createHash('sha1').update(info).digest('hex');
  // The info dict is spliced in as written, between `announce` and `url-list` (sorted), so its bytes and the hash are these.
  const before = bencode({ announce: spec.announce }).subarray(1, -1);
  const after = bencode({ 'url-list': spec.webSeeds?.length ? spec.webSeeds : undefined }).subarray(1, -1);
  const bytes = concat([encoder.encode('d'), before, bencode('info'), info, after, encoder.encode('e')]);
  return { bytes: new Uint8Array(bytes), info, infoHash, pieceLength };
}
