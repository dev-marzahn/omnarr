import { describe, expect, test } from 'vite-plus/test';

import { normalizeInfoHash } from '../src/torrentHash.ts';

// Worked by hand: the base32 alphabet in order is the 5-bit values 0..31,
// which read as 160 bits give this hex.
const ALPHABET_BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const ALPHABET_HEX = '00443214c74254b635cf84653a56d7c675be77df';

describe('normalizeInfoHash', () => {
  test('40 hex characters in any case become lowercase', () => {
    expect(normalizeInfoHash('C12FE1C06BBA254A9DC9F519B335AA7C1367A88A')).toBe('c12fe1c06bba254a9dc9f519b335aa7c1367a88a');
    expect(normalizeInfoHash('c12fe1c06bba254a9dc9f519b335aa7c1367a88a')).toBe('c12fe1c06bba254a9dc9f519b335aa7c1367a88a');
  });

  test('32 base32 characters become the same 40 hex characters', () => {
    expect(normalizeInfoHash(ALPHABET_BASE32)).toBe(ALPHABET_HEX);
    expect(normalizeInfoHash(ALPHABET_BASE32.toLowerCase())).toBe(ALPHABET_HEX);
    expect(normalizeInfoHash('A'.repeat(32))).toBe('0'.repeat(40));
    expect(normalizeInfoHash('7'.repeat(32))).toBe('f'.repeat(40));
  });

  test('a btmh SHA-256 multihash becomes its digest truncated to 40 hex characters', () => {
    expect(normalizeInfoHash(`1220${'AB'.repeat(32)}`)).toBe('ab'.repeat(20));
    expect(normalizeInfoHash(`1220${'0123456789abcdef'.repeat(4)}`)).toBe('0123456789abcdef0123456789abcdef01234567');
  });

  test('anything else has no hash', () => {
    for (const value of ['', 'xyz', 'c12fe1c06bba254a9dc9f519b335aa7c1367a8', `1221${'ab'.repeat(32)}`, '1'.repeat(32), `1220${'ab'.repeat(31)}`]) {
      expect(normalizeInfoHash(value)).toBeUndefined();
    }
  });
});
