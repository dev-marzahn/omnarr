// A torrent's info hash in one spelling: qBittorrent's
// `clientRef` and the torrent blocklist key. Pure, so the worker, the backend
// and the scoring package share it.

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

function base32ToHex(value: string): string | undefined {
  let bits = '';
  for (const char of value.toUpperCase()) {
    const index = BASE32.indexOf(char);
    if (index < 0) return undefined;
    bits += index.toString(2).padStart(5, '0');
  }
  let hex = '';
  for (let at = 0; at < bits.length; at += 4) hex += Number.parseInt(bits.slice(at, at + 4), 2).toString(16);
  return hex;
}

/**
 * 40 hex characters (any case), 32 base32 characters, or a `btmh` SHA-256
 * multihash (`1220` + 64 hex), as 40 lowercase hex characters: a v2 hash is
 * truncated, as qBittorrent names a v2-only torrent. Undefined for anything else.
 */
export function normalizeInfoHash(value: string): string | undefined {
  if (/^[0-9a-f]{40}$/i.test(value)) return value.toLowerCase();
  if (/^[a-z2-7]{32}$/i.test(value)) return base32ToHex(value);
  const multihash = /^1220([0-9a-f]{64})$/i.exec(value);
  if (multihash) return multihash[1]!.slice(0, 40).toLowerCase();
  return undefined;
}
