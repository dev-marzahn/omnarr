import { describe, expect, test } from 'vite-plus/test';

import { crc32, yencPart } from './yenc.ts';

const bytes = (...values: number[]) => Uint8Array.from(values);
const repeat = (value: number, count: number) => new Uint8Array(count).fill(value);

/** The lines between the =ypart and =yend lines. */
const dataLines = (body: string) => body.split('\r\n').slice(2, -1);

describe('crc32', () => {
  test('matches the standard check value', () => {
    expect(crc32(new TextEncoder().encode('123456789'))).toBe(0xcbf43926);
    expect(crc32(new Uint8Array())).toBe(0);
  });
});

describe('yencPart', () => {
  test('writes the multipart header and trailer around the part', () => {
    const file = new TextEncoder().encode('123456789');
    const body = yencPart({ file, name: 'a.mkv', part: 2, total: 3, begin: 3, end: 6 });
    const lines = body.split('\r\n');
    expect(lines[0]).toBe('=ybegin part=2 total=3 line=128 size=9 name=a.mkv');
    expect(lines[1]).toBe('=ypart begin=4 end=6');
    // '4', '5', '6' shifted by 42.
    expect(lines[2]).toBe('^_`');
    expect(lines[3]).toBe(`=yend size=3 part=2 pcrc32=${crc32(file.subarray(3, 6)).toString(16).padStart(8, '0')} crc32=cbf43926`);
    expect(lines).toHaveLength(4);
  });

  test('escapes NUL, LF, CR and = anywhere', () => {
    // 0xd6, 0xe0, 0xe3 and 0x13 become NUL, LF, CR and = after the shift by 42.
    const body = yencPart({ file: bytes(0x17, 0xd6, 0xe0, 0xe3, 0x13, 0x17), name: 'a', part: 1, total: 1, begin: 0, end: 6 });
    expect(dataLines(body)).toEqual(['A=@=J=M=}A']);
  });

  test('escapes a dot, tab or space at the start of a line, and a tab or space at its end', () => {
    // 0x04, 0xdf and 0xf6 become '.', TAB and space.
    const file = bytes(0x04, 0xdf, 0x04, 0xf6, ...repeat(0x17, 122), 0xf6, 0xf6, 0xdf, 0x17, 0xdf);
    const lines = dataLines(yencPart({ file, name: 'a', part: 1, total: 1, begin: 0, end: file.length }));
    expect(lines).toEqual([`=n\t. ${'A'.repeat(122)}=\``, '=`\tA=I']);
  });

  test('breaks lines after 128 characters', () => {
    const file = repeat(0x17, 300);
    const lines = dataLines(yencPart({ file, name: 'a', part: 1, total: 1, begin: 0, end: 300 }));
    expect(lines.map((line) => line.length)).toEqual([128, 128, 44]);
  });

  test('encodes every byte value so that a yEnc decoder gets the bytes back', () => {
    const file = Uint8Array.from({ length: 1000 }, (_, index) => (index * 7) % 256);
    const encoded = dataLines(yencPart({ file, name: 'a', part: 1, total: 1, begin: 0, end: 1000 })).join('');
    const decoded: number[] = [];
    for (let index = 0; index < encoded.length; index++) {
      let code = encoded.charCodeAt(index);
      if (code === 0x3d) code = encoded.charCodeAt(++index) - 64;
      decoded.push((code - 42 + 256) % 256);
    }
    expect(Uint8Array.from(decoded)).toEqual(file);
  });
});
