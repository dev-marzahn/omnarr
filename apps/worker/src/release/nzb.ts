// The NZB check before a submit: the body the worker fetched is uploaded to
// NZBGet only when it is XML with the root `nzb` and at least one `file`.
import { XMLParser, XMLValidator } from 'fast-xml-parser';

const parser = new XMLParser({ ignoreAttributes: true, parseTagValue: false, removeNSPrefix: true, processEntities: false });

export function validateNzb(bytes: Uint8Array): boolean {
  const text = new TextDecoder().decode(bytes);
  if (text.trim() === '' || XMLValidator.validate(text) !== true) return false;
  const root = parser.parse(text) as { nzb?: { file?: unknown } | string };
  return typeof root.nzb === 'object' && root.nzb !== null && root.nzb.file !== undefined;
}
