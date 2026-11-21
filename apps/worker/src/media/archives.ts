// RAR sets in a download: found by name, listed with
// `lsar -j`, extracted with `unar` (The Unarchiver, free; RARLAB's `unrar` is
// non-free and stays out of the image). Always `execFile`, never a shell.
//
// The `lsar -j` fields read (unar 1.10.8, Debian trixie): `lsarContents[]` with
// `XADFileName`, `XADFileSize`, `XADIsDirectory` and `XADIsEncrypted`;
// `lsarProperties.XADIsEncrypted`; and `lsarError`, non-zero for a damaged
// set. A set with encrypted headers makes lsar exit 2 with "This archive
// requires a password to unpack" instead of a listing.
import { execFile } from 'node:child_process';
import { mkdir, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';

import { DEFAULT_LIMITS } from '@omnarr/contracts';

import { JobFailure } from '../runtime/lease.ts';

const run = promisify(execFile);

export type RarListing = {
  entries: { name: string; sizeBytes: number }[];
  /** What extraction writes: the sum of the files' sizes, for the free-space check. */
  unpackedBytes: number;
  encrypted: boolean;
};

type LsarJson = {
  lsarError?: number;
  lsarContents?: { XADFileName?: string; XADFileSize?: number; XADIsDirectory?: number; XADIsEncrypted?: number }[];
  lsarProperties?: { XADIsEncrypted?: number };
};

type ExecError = NodeJS.ErrnoException & { code?: string | number; killed?: boolean; stdout?: string; stderr?: string };

const PART = /^(.*)\.part(\d+)\.rar$/i;
const RAR = /\.rar$/i;
const NEEDS_PASSWORD = /requires a password/i;

/**
 * The first volume of every RAR set under `dir`, sorted: `name.rar` (with or
 * without `.r00`…), or the lowest `name.partNN.rar` of a part set (part 1
 * when it is there). Symlinks are not followed.
 */
export async function findRarSets(dir: string): Promise<string[]> {
  const found: string[] = [];
  const walk = async (current: string) => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
      throw error;
    }
    const parts = new Map<string, { path: string; part: number }>();
    for (const entry of entries) {
      const path = join(current, entry.name);
      if (entry.isDirectory()) await walk(path);
      if (!entry.isFile() || !RAR.test(entry.name)) continue;
      const part = PART.exec(entry.name);
      if (!part) {
        found.push(path);
        continue;
      }
      const key = part[1]!.toLowerCase();
      const number = Number(part[2]);
      const lowest = parts.get(key);
      if (!lowest || number < lowest.part) parts.set(key, { path, part: number });
    }
    for (const { path } of parts.values()) found.push(path);
  };
  await walk(dir);
  return found.sort();
}

function missingTool(error: ExecError, tool: string): JobFailure | undefined {
  return error.code === 'ENOENT' ? new JobFailure('pipelineError', `${tool} is not installed in the worker.`) : undefined;
}

/** Lists a set with `lsar -j`. A damaged or incomplete set is `unpackFailed`; one with encrypted headers lists as encrypted and empty. */
export async function listSet(firstVolume: string, signal?: AbortSignal): Promise<RarListing> {
  let stdout: string;
  try {
    ({ stdout } = await run('lsar', ['-j', firstVolume], {
      ...(signal ? { signal } : {}),
      timeout: DEFAULT_LIMITS.unarTimeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 64 * 1024 * 1024,
    }));
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    const failure = error as ExecError;
    const missing = missingTool(failure, 'lsar');
    if (missing) throw missing;
    if (NEEDS_PASSWORD.test(`${failure.stdout ?? ''}${failure.stderr ?? ''}`)) return { entries: [], unpackedBytes: 0, encrypted: true };
    throw new JobFailure('unpackFailed', `lsar can't read ${firstVolume}: the set is damaged or incomplete.`);
  }
  let listing: LsarJson;
  try {
    listing = JSON.parse(stdout) as LsarJson;
  } catch {
    throw new JobFailure('unpackFailed', `lsar can't read ${firstVolume}: the set is damaged or incomplete.`);
  }
  if (listing.lsarError) throw new JobFailure('unpackFailed', `lsar can't read ${firstVolume}: the set is damaged or incomplete.`);
  const files = (listing.lsarContents ?? []).filter((entry) => entry.XADIsDirectory !== 1);
  const entries = files.map((entry) => ({ name: entry.XADFileName ?? '', sizeBytes: entry.XADFileSize ?? 0 }));
  return {
    entries,
    unpackedBytes: entries.reduce((sum, entry) => sum + entry.sizeBytes, 0),
    encrypted: listing.lsarProperties?.XADIsEncrypted === 1 || files.some((entry) => entry.XADIsEncrypted === 1),
  };
}

/**
 * Extracts a set with `unar -o <outDir> -D -f -q <first volume>` (never in
 * place: `outDir` is under staging). An encrypted set is `passwordProtected`,
 * any other non-zero exit or the `unarTimeoutMs` timeout `unpackFailed`, a
 * missing `unar` `pipelineError`; an abort rejects with the signal's reason.
 */
export async function extractSet(firstVolume: string, outDir: string, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw signal.reason;
  await mkdir(outDir, { recursive: true });
  try {
    const pending = run('unar', ['-o', outDir, '-D', '-f', '-q', firstVolume], {
      signal,
      timeout: DEFAULT_LIMITS.unarTimeoutMs,
      killSignal: 'SIGKILL',
      maxBuffer: 16 * 1024 * 1024,
    });
    pending.child.stdin?.end();
    await pending;
  } catch (error) {
    if (signal.aborted) throw signal.reason;
    const failure = error as ExecError;
    const missing = missingTool(failure, 'unar');
    if (missing) throw missing;
    if (NEEDS_PASSWORD.test(`${failure.stdout ?? ''}${failure.stderr ?? ''}`))
      throw new JobFailure('passwordProtected', `unar can't extract ${firstVolume}: it needs a password.`);
    if (failure.killed)
      throw new JobFailure('unpackFailed', `unar didn't finish extracting ${firstVolume} within ${DEFAULT_LIMITS.unarTimeoutMs / 60_000} min.`);
    throw new JobFailure('unpackFailed', `unar can't extract ${firstVolume}: the set is damaged or incomplete (exit code ${String(failure.code)}).`);
  }
}
