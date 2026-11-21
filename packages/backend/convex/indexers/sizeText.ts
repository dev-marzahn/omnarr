// Sizes as sites print them: a number, then a unit, every unit a
// power of 1024 as in Prowlarr's GetBytes (KB, MB, GB and TB too). Anything
// else is 0, never NaN. Pure.
const POWERS: Record<string, number> = { b: 0, bytes: 0, kib: 1, kb: 1, mib: 2, mb: 2, gib: 3, gb: 3, tib: 4, tb: 4 };

export function parseSizeText(text: string): number {
  const match = /^\s*(\d{1,3}(?:,\d{3})+|\d+)(\.\d+)?\s*([a-z]+)\s*$/i.exec(text);
  const power = match ? POWERS[match[3]!.toLowerCase()] : undefined;
  if (!match || power === undefined) return 0;
  return Math.round(Number(`${match[1]!.replaceAll(',', '')}${match[2] ?? ''}`) * 1024 ** power);
}
