// The e2e failure dump: when a scenario fails, stack.ts's down() writes what
// CI otherwise loses with the stack, into the scenario's artifact directory,
// which CI uploads (.github/workflows/ci.yml):
//
//   worker.log, backend.log   the containers' output
//   dmesg-oom.txt             the kernel log's out-of-memory lines
//   <table>.jsonl             the jobs, renditions, downloads, issues and grabs rows
//   timeouts.txt              the run's timed-out waits, with their explain state
//
// Everything is scrubbed first: the planted secrets (stack.ts
// plantedSecrets), and secret-shaped values.
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const MASK = '[secret]';

/** Values shorter than this would scrub ordinary words; every planted secret is longer. */
const MIN_LENGTH = 6;

/** Secret-shaped values, whatever their value: the part that is the secret, masked. */
const PATTERNS: [RegExp, string][] = [
  // An indexer key or a tracker passkey in a link (as in the Torznab fake's .torrent links).
  [/\b(apikey|passkey|api_key|token)=[^&\s"'<>]+/gi, `$1=${MASK}`],
  // A magnet can carry a private tracker's passkey.
  [/magnet:\?[^\s"'<>]+/g, `magnet:${MASK}`],
  // A password or key field in a payload or row.
  [/("(?:password|apiKey|api_key|token|secret|privateKey|wireguardPrivateKey|controlPassword)"\s*:\s*)"[^"]*"/gi, `$1"${MASK}"`],
  // PEM private keys (an OpenVPN file's), WireGuard keys.
  [/-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g, MASK],
  [/^(\s*(?:PrivateKey|PresharedKey)\s*=\s*).+$/gim, `$1${MASK}`],
  // Jellyfin's and gluetun's request headers.
  [/(MediaBrowser\s+Token=")[^"]*"/gi, `$1${MASK}"`],
  [/^(\s*(?:x-api-key|authorization|cookie|set-cookie)\s*:\s*).+$/gim, `$1${MASK}`],
];

const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The text with every planted value (and its URL-encoded form) and every secret-shaped value masked. */
export function scrub(text: string, planted: readonly string[]): string {
  let out = text;
  const values = [...new Set(planted.flatMap((value) => [value, encodeURIComponent(value)]))]
    .filter((value) => value.length >= MIN_LENGTH)
    .sort((a, b) => b.length - a.length);
  for (const value of values) out = out.replace(new RegExp(escape(value), 'g'), MASK);
  for (const [pattern, replacement] of PATTERNS) out = out.replace(pattern, replacement);
  return out;
}

/** The kernel log's lines about the OOM killer. */
export const oomLines = (dmesg: string): string[] => dmesg.split('\n').filter((line) => /oom-kill|out of memory|killed process/i.test(line));

export type DumpSources = {
  dir: string;
  planted: readonly string[];
  logs: Record<string, () => string>;
  dmesg: () => string;
  rows: (table: string) => unknown[];
  tables: readonly string[];
  /** The run's timed-out waits, each with the state its `explain` read (stack.ts waitFor). */
  timeouts?: readonly string[];
};

/** Writes the dump; a source that can't be read leaves a note in its file, so the rest still lands. */
export async function writeFailureDump(sources: DumpSources): Promise<void> {
  mkdirSync(sources.dir, { recursive: true });
  const write = (name: string, read: () => string) => {
    let body: string;
    try {
      body = read();
    } catch (error) {
      body = `# not read: ${(error as Error).message}\n`;
    }
    writeFileSync(join(sources.dir, name), scrub(body, sources.planted));
  };
  for (const [service, read] of Object.entries(sources.logs)) write(`${service}.log`, read);
  if (sources.timeouts?.length) write('timeouts.txt', () => `${sources.timeouts!.join('\n\n')}\n`);
  write('dmesg-oom.txt', () =>
    oomLines(sources.dmesg())
      .map((line) => `${line}\n`)
      .join(''),
  );
  for (const table of sources.tables)
    write(`${table}.jsonl`, () =>
      sources
        .rows(table)
        .map((row) => `${JSON.stringify(row)}\n`)
        .join(''),
    );
}
