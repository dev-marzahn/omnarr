// Browser helpers that also work on a plain-http LAN page (with no public URL, the web app is
// served over http on the LAN). Such a page isn't a secure context, so `crypto.randomUUID` and
// `navigator.clipboard` are undefined there; `crypto.getRandomValues` and `execCommand('copy')` aren't.

/** A random v4 UUID, from `crypto.getRandomValues` (available in every context). */
export function newId(source: Pick<Crypto, 'getRandomValues'> = globalThis.crypto): string {
  const bytes = source.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6]! & 0x0f) | 0x40;
  bytes[8] = (bytes[8]! & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** Copies through a hidden textarea and `execCommand('copy')`, which works without a secure context. */
function copyWithTextarea(text: string): boolean {
  const area = document.createElement('textarea');
  area.value = text;
  area.setAttribute('readonly', '');
  area.style.position = 'fixed';
  area.style.opacity = '0';
  document.body.append(area);
  area.select();
  try {
    return document.execCommand('copy');
  } finally {
    area.remove();
  }
}

type CopyDeps = { clipboard: Pick<Clipboard, 'writeText'> | undefined; fallback: (text: string) => boolean };

/** Copies `text`: the Clipboard API when the page has it, else the textarea fallback. Rejects when nothing copied. */
export async function copyText(
  text: string,
  { clipboard, fallback }: CopyDeps = { clipboard: globalThis.navigator?.clipboard, fallback: copyWithTextarea },
): Promise<void> {
  if (clipboard) return clipboard.writeText(text);
  if (!fallback(text)) throw new Error('copy failed');
}
