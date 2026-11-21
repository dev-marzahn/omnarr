// yEnc 1.3 multipart encoding for the NNTP fake. One part of a
// file becomes one article body. The body is a binary string (one character
// per byte, 0–255) for writing as latin1; NNTP dot-stuffing is the server's.

const CRC_TABLE = Uint32Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

/** CRC-32 (IEEE 802.3), as yEnc's pcrc32 and crc32 carry it. */
export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

const hex = (value: number) => value.toString(16).padStart(8, '0');

const NUL = 0x00;
const TAB = 0x09;
const LF = 0x0a;
const CR = 0x0d;
const SPACE = 0x20;
const DOT = 0x2e;
const EQUALS = 0x3d;

export type YencPartInput = {
  /** The whole file: `size` and `crc32` describe it. */
  file: Uint8Array;
  name: string;
  /** 1-based. */
  part: number;
  total: number;
  /** Byte offsets into `file`, `end` exclusive. */
  begin: number;
  end: number;
  lineLength?: number;
};

/** One yEnc part as an article body: `=ybegin`, `=ypart`, the data lines and `=yend`, joined with CRLF. */
export function yencPart({ file, name, part, total, begin, end, lineLength = 128 }: YencPartInput): string {
  const data = file.subarray(begin, end);
  const lines: string[] = [];
  let line = '';
  data.forEach((byte, index) => {
    const code = (byte + 42) & 0xff;
    const atStart = line.length === 0;
    const atEnd = line.length + 1 >= lineLength || index === data.length - 1;
    const critical =
      code === NUL || code === LF || code === CR || code === EQUALS || ((atStart || atEnd) && (code === TAB || code === SPACE)) || (atStart && code === DOT);
    line += critical ? `=${String.fromCharCode((code + 64) & 0xff)}` : String.fromCharCode(code);
    if (line.length >= lineLength) {
      lines.push(line);
      line = '';
    }
  });
  if (line) lines.push(line);
  return [
    `=ybegin part=${part} total=${total} line=${lineLength} size=${file.length} name=${name}`,
    `=ypart begin=${begin + 1} end=${end}`,
    ...lines,
    `=yend size=${data.length} part=${part} pcrc32=${hex(crc32(data))} crc32=${hex(crc32(file))}`,
  ].join('\r\n');
}
