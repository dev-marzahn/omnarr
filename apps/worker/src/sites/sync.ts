// The definitions sync: Prowlarr's package.zip from
// OMNARR_DEFINITIONS_URL for DEFINITION_VERSION, unzipped in memory with
// fflate, plus the user's own files from /definitions (a user file replaces
// the upstream one with its id). Each file goes through the support check and
// is written in batches of at most 50 rows and 256 KB, paced to 1 MB a second
// so the sync stays under Convex's write limit; the sync ends with
// the ids it found. A failed download writes nothing: the stored definitions
// stay in use. Nothing here is bundled: each instance downloads the files.
import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

import { DEFINITION_BATCH_SIZE, DEFINITION_VERSION, type SiteDefinitionUpsert, type UpsertDefinitionsRequest } from '@omnarr/contracts';
import { unzipSync } from 'fflate';

import type { SitesBackend } from '../convex.ts';
import { checkDefinition } from './check.ts';
import { siteUserAgent, type SiteFetch, where } from './http.ts';

export type SyncDeps = {
  backend: SitesBackend;
  /** The `syncDefinitions` job's lease, which the writes are fenced on. */
  lease: Pick<UpsertDefinitionsRequest, 'jobId' | 'leaseEpoch'>;
  /** `OMNARR_DEFINITIONS_URL`, e.g. https://indexers.prowlarr.com/master. */
  url: string;
  /** The read-only `/definitions` bind mount; absent is fine. */
  customDir: string;
  fetch: SiteFetch;
  log: (line: string) => void;
  signal?: AbortSignal;
  /** The pause after each batch; tests pass their own. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
};

export type SyncOutcome = { ok: boolean; supported: number; unsupported: number; pending: number };

const SYNC_TIMEOUT_MS = 120_000;

/**
 * A batch holds at most this many bytes of rows (their JSON) as well as
 * DEFINITION_BATCH_SIZE rows; a single larger row goes alone. A file over the
 * support check's 900 KB is sent without its YAML, so no row is much larger.
 */
export const BATCH_BYTES = 256 * 1024;

/**
 * The sync's write rate. Convex refuses every mutation of the
 * deployment with `TooManyWrites` while more than 4 MiB a second is written
 * (`MAX_BYTES_WRITTEN_PER_SECOND`), which drops the worker's connection: the
 * sync stays at a quarter of that, index rows and other writers included.
 */
export const BYTES_PER_SECOND = 1024 * 1024;

type File = { name: string; text: string; source: 'upstream' | 'custom' };

class SyncFailed extends Error {}

async function download(deps: SyncDeps, packageUrl: string): Promise<File[]> {
  const at = where(packageUrl);
  let response: Response;
  try {
    const signals = [AbortSignal.timeout(SYNC_TIMEOUT_MS), ...(deps.signal ? [deps.signal] : [])];
    response = await deps.fetch(packageUrl, { headers: { 'user-agent': siteUserAgent() }, redirect: 'follow', signal: AbortSignal.any(signals) });
  } catch {
    throw new SyncFailed(`${at.host} could not be reached (GET ${at.path}).`);
  }
  if (!response.ok) throw new SyncFailed(`${at.host} answered HTTP ${response.status} (GET ${at.path}).`);
  let entries: Record<string, Uint8Array>;
  try {
    entries = unzipSync(new Uint8Array(await response.arrayBuffer()));
  } catch {
    throw new SyncFailed(`The package from ${at.host} is not a zip archive.`);
  }
  const decoder = new TextDecoder();
  const files = Object.entries(entries)
    .filter(([name]) => name.endsWith('.yml'))
    .map(([name, bytes]) => ({ name: basename(name), text: decoder.decode(bytes), source: 'upstream' as const }));
  if (!files.length) throw new SyncFailed(`The package from ${at.host} has no .yml file.`);
  return files;
}

async function customFiles(dir: string, log: (line: string) => void): Promise<File[]> {
  let names: string[];
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.yml'));
  } catch {
    return [];
  }
  const files: File[] = [];
  for (const name of names.sort()) {
    try {
      files.push({ name, text: await readFile(join(dir, name), 'utf8'), source: 'custom' });
    } catch {
      log(`definitions: ${name} in the definitions folder could not be read`);
    }
  }
  return files;
}

const sha256 = (text: string) => createHash('sha256').update(text).digest('hex');

const rowBytes = (row: SiteDefinitionUpsert) => Buffer.byteLength(JSON.stringify(row));

/** Rows in batches of at most DEFINITION_BATCH_SIZE rows and BATCH_BYTES; a larger row goes alone. */
export function batches(rows: SiteDefinitionUpsert[]): { rows: SiteDefinitionUpsert[]; bytes: number }[] {
  const out: { rows: SiteDefinitionUpsert[]; bytes: number }[] = [];
  let current = { rows: [] as SiteDefinitionUpsert[], bytes: 0 };
  for (const row of rows) {
    const bytes = rowBytes(row);
    if (current.rows.length && (current.rows.length === DEFINITION_BATCH_SIZE || current.bytes + bytes > BATCH_BYTES)) {
      out.push(current);
      current = { rows: [], bytes: 0 };
    }
    current.rows.push(row);
    current.bytes += bytes;
  }
  if (current.rows.length) out.push(current);
  return out;
}

/**
 * Writes the batches no faster than BYTES_PER_SECOND: after each batch but the
 * last, a pause of its bytes at that rate. The pause doesn't count the time the
 * write took, so a write slowed by a busy backend earns no credit and the
 * batches after it are never sent back to back.
 */
async function writePaced(deps: SyncDeps, syncedAt: number, all: SiteDefinitionUpsert[]): Promise<void> {
  const sleep = deps.sleep ?? ((ms, signal) => delay(ms, undefined, signal ? { signal } : {}));
  const list = batches(all);
  for (const [i, batch] of list.entries()) {
    await deps.backend.upsertDefinitions({ ...deps.lease, syncedAt, rows: batch.rows });
    if (i < list.length - 1) await sleep((batch.bytes / BYTES_PER_SECOND) * 1000, deps.signal);
  }
}

export async function syncDefinitions(deps: SyncDeps): Promise<SyncOutcome> {
  const base = deps.url.replace(/\/+$/, '');
  const packageUrl = `${base}/${DEFINITION_VERSION}/package.zip`;
  const source = where(packageUrl).host;
  let upstream: File[];
  try {
    upstream = await download(deps, packageUrl);
  } catch (error) {
    if (!(error instanceof SyncFailed)) throw error;
    deps.log(`definitions: sync failed: ${error.message}`);
    const counts = await deps.backend.finishDefinitionSync({
      ...deps.lease,
      status: { at: Date.now(), ok: false, source, failure: { code: 'definitionSyncFailed', detail: error.message } },
    });
    return { ok: false, ...counts };
  }
  const rows = new Map<string, SiteDefinitionUpsert>();
  for (const file of [...upstream, ...(await customFiles(deps.customDir, deps.log))]) {
    const checked = checkDefinition(file.text);
    const definitionId = checked.definitionId ?? file.name.replace(/\.yml$/, '');
    rows.set(definitionId, {
      definitionId,
      source: file.source,
      sha256: sha256(file.text),
      yaml: checked.support.ok || checked.support.reason !== 'tooLarge' ? file.text : '',
      ...(checked.meta ? { meta: checked.meta } : {}),
      support: checked.support,
    });
  }
  const all = [...rows.values()];
  await writePaced(deps, Date.now(), all);
  const counts = await deps.backend.finishDefinitionSync({ ...deps.lease, status: { at: Date.now(), ok: true, source }, seenIds: [...rows.keys()].sort() });
  deps.log(
    `definitions: synced ${all.length} from ${source}: ${counts.supported} supported, ${counts.unsupported} unsupported, ${counts.pending} with an update not applied`,
  );
  return { ok: true, ...counts };
}
