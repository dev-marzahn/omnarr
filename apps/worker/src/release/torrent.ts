// A .torrent file and a magnet. The info
// hash is computed over the bytes of the `info` value as served: a minimal
// bencode reader finds its span, since decoding and re-encoding could change
// the bytes (an unsorted dict, say) and so the hash qBittorrent computes.
// A v1 torrent is named by its SHA-1; a v2 torrent, hybrid or v2-only, by its
// SHA-256 truncated to 40 hex characters, as qBittorrent 5.3 names it.
import { createHash } from 'node:crypto';

import { normalizeInfoHash } from '@omnarr/contracts';

type Value = { kind: 'int' } | { kind: 'string'; bytes: Uint8Array } | { kind: 'list' } | { kind: 'dict'; entries: Map<string, Span> };
type Span = { value: Value; start: number; end: number };

const DIGIT_0 = 0x30;
const DIGIT_9 = 0x39;
const COLON = 0x3a;
const decoder = new TextDecoder('latin1');

/** Reads one bencoded value at `at`, or throws on anything malformed. */
function read(bytes: Uint8Array, at: number, depth = 0): Span {
  if (depth > 64) throw new Error('too deep');
  const byte = bytes[at];
  if (byte === undefined) throw new Error('truncated');
  if (byte === 0x69 /* i */) {
    const end = bytes.indexOf(0x65 /* e */, at + 1);
    if (end < 0 || !/^-?\d+$/.test(decoder.decode(bytes.subarray(at + 1, end)))) throw new Error('bad integer');
    return { value: { kind: 'int' }, start: at, end: end + 1 };
  }
  if (byte >= DIGIT_0 && byte <= DIGIT_9) {
    const colon = bytes.indexOf(COLON, at);
    const length = colon < 0 ? Number.NaN : Number(decoder.decode(bytes.subarray(at, colon)));
    if (!Number.isSafeInteger(length) || colon + 1 + length > bytes.length) throw new Error('bad string');
    const start = colon + 1;
    return { value: { kind: 'string', bytes: bytes.subarray(start, start + length) }, start: at, end: start + length };
  }
  if (byte === 0x6c /* l */ || byte === 0x64 /* d */) {
    const entries = new Map<string, Span>();
    let cursor = at + 1;
    while (bytes[cursor] !== 0x65 /* e */) {
      if (byte === 0x64) {
        const key = read(bytes, cursor, depth + 1);
        if (key.value.kind !== 'string') throw new Error('bad key');
        const value = read(bytes, key.end, depth + 1);
        entries.set(decoder.decode(key.value.bytes), value);
        cursor = value.end;
      } else cursor = read(bytes, cursor, depth + 1).end;
    }
    return { value: byte === 0x64 ? { kind: 'dict', entries } : { kind: 'list' }, start: at, end: cursor + 1 };
  }
  throw new Error('not bencode');
}

const hex = (algorithm: 'sha1' | 'sha256', bytes: Uint8Array) => createHash(algorithm).update(bytes).digest('hex');

/** A torrent: a bencoded dict, and nothing after it, with an `info` dict. Undefined for anything else. */
export function parseTorrent(bytes: Uint8Array): { infoHash: string } | undefined {
  let root: Span;
  try {
    root = read(bytes, 0);
  } catch {
    return undefined;
  }
  if (root.end !== bytes.length || root.value.kind !== 'dict') return undefined;
  const info = root.value.entries.get('info');
  if (info?.value.kind !== 'dict') return undefined;
  const span = bytes.subarray(info.start, info.end);
  // qBittorrent 5.3 names every v2 torrent, hybrids included, by its truncated v2 hash.
  const v2 = info.value.entries.has('meta version');
  return { infoHash: v2 ? hex('sha256', span).slice(0, 40) : hex('sha1', span) };
}

/**
 * A magnet's hash, normalized: its `btmh` when it has one, as
 * qBittorrent names a hybrid by its v2 hash, else its `btih`. Undefined without either.
 */
export function parseMagnet(uri: string): { infoHash: string } | undefined {
  if (!uri.toLowerCase().startsWith('magnet:?')) return undefined;
  const topics = new URLSearchParams(uri.slice('magnet:?'.length)).getAll('xt');
  const of = (prefix: string) =>
    topics
      .filter((topic) => topic.toLowerCase().startsWith(prefix))
      .map((topic) => normalizeInfoHash(topic.slice(prefix.length)))
      .find((hash) => hash !== undefined);
  const infoHash = of('urn:btmh:') ?? of('urn:btih:');
  return infoHash ? { infoHash } : undefined;
}
