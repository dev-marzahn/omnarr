// A site's text encoding: bodies are decoded with TextDecoder, and
// query strings and `urlencode` encode in the site's encoding, as Prowlarr's
// HttpRequestBuilder does. Single-byte encodings (windows-125x, KOI8, ISO
// 8859) are encoded through a table built from TextDecoder; UTF-8 natively.

const tables = new Map<string, Map<string, number>>();

/** The WHATWG label of a definition's `encoding`, or undefined when TextDecoder doesn't know it. */
export function encodingLabel(encoding: string | undefined): string | undefined {
  const name = (encoding ?? 'UTF-8').trim();
  try {
    return new TextDecoder(name).encoding;
  } catch {
    return undefined;
  }
}

function singleByteTable(label: string): Map<string, number> | undefined {
  const cached = tables.get(label);
  if (cached) return cached;
  const decoder = new TextDecoder(label);
  const table = new Map<string, number>();
  for (let byte = 0; byte < 256; byte++) {
    const char = decoder.decode(new Uint8Array([byte]));
    if (char.length !== 1 || char === '�') continue;
    if (!table.has(char)) table.set(char, byte);
  }
  // A multi-byte encoding decodes high bytes alone as replacement characters: it has no table.
  if (table.size < 200) return undefined;
  tables.set(label, table);
  return table;
}

/** Whether omnarr can encode text in this encoding (UTF-8, or a single-byte one). */
export const canEncode = (encoding: string | undefined): boolean => {
  const label = encodingLabel(encoding);
  return label === 'utf-8' || (label !== undefined && singleByteTable(label) !== undefined);
};

/** The text's bytes in the encoding; a character it can't hold becomes `?`, as .NET's encoders do. */
export function encodeText(text: string, encoding: string | undefined): Uint8Array {
  const label = encodingLabel(encoding) ?? 'utf-8';
  if (label === 'utf-8') return new TextEncoder().encode(text);
  const table = singleByteTable(label);
  if (!table) return new TextEncoder().encode(text);
  return Uint8Array.from(Array.from(text, (char) => table.get(char) ?? 0x3f));
}

export function decodeBytes(bytes: Uint8Array, encoding: string | undefined): string {
  return new TextDecoder(encodingLabel(encoding) ?? 'utf-8').decode(bytes);
}

const UNRESERVED = /[A-Za-z0-9\-_.!*()]/;

/** HttpUtility.UrlEncode in the encoding: unreserved kept, space as `+`, the rest as uppercase %XX. */
export function urlEncode(text: string, encoding: string | undefined): string {
  let out = '';
  for (const char of text) {
    if (char === ' ') out += '+';
    else if (UNRESERVED.test(char)) out += char;
    else for (const byte of encodeText(char, encoding)) out += `%${byte.toString(16).toUpperCase().padStart(2, '0')}`;
  }
  return out;
}

/** WebUtility.UrlEncode (UTF-8), which template modifiers use for search paths. */
export const webUrlEncode = (text: string): string => urlEncode(text, 'utf-8');

/** HttpUtility.UrlDecode in the encoding: `+` as space, %XX as bytes. */
export function urlDecode(text: string, encoding: string | undefined): string {
  const bytes: number[] = [];
  let out = '';
  const flush = () => {
    if (bytes.length) out += decodeBytes(Uint8Array.from(bytes), encoding);
    bytes.length = 0;
  };
  for (let i = 0; i < text.length; i++) {
    const char = text[i]!;
    if (char === '%' && /^[0-9a-fA-F]{2}$/.test(text.slice(i + 1, i + 3))) {
      bytes.push(Number.parseInt(text.slice(i + 1, i + 3), 16));
      i += 2;
      continue;
    }
    flush();
    out += char === '+' ? ' ' : char;
  }
  flush();
  return out;
}
