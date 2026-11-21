// The support bundle: the backend's DTOs from
// `worker.bundleData`, the worker's versions and its recent log lines, as
// one gzipped JSON file uploaded as the `buildSupportBundle` job's artifact.
// Nothing is kept on disk. The DTOs hold no secret, and the worker's log
// lines name jobs, classes and codes only.
import { gzipSync } from 'node:zlib';

import type { LeasedJob } from '@omnarr/contracts';
import type { GenericId } from 'convex/values';

import type { WorkerBackend } from './convex.ts';

/** The worker's last log lines, oldest first, for the bundle. */
export class LogBuffer {
  private lines: string[] = [];
  public constructor(private readonly size = 500) {}

  public push(line: string): void {
    this.lines.push(line);
    if (this.lines.length > this.size) this.lines.splice(0, this.lines.length - this.size);
  }

  public recent(): string[] {
    return [...this.lines];
  }
}

export type BundleDeps = {
  backend: Pick<WorkerBackend, 'bundleData' | 'artifactUploadUrl'>;
  /** The worker's own part: its ID, protocol and release version. */
  worker: { workerId: string; protocolVersion: number; version?: string };
  logs: LogBuffer;
  fetch?: typeof fetch;
};

/** The bundle's format, so a reader knows which shape it holds. */
const FORMAT = 'omnarr-support-bundle/1';

/** Builds the bundle for a leased job and uploads it; returns its storage ID. */
export async function buildSupportBundle(deps: BundleDeps, job: Pick<LeasedJob, 'jobId' | 'leaseEpoch'>): Promise<GenericId<'_storage'>> {
  const lease = { jobId: job.jobId, leaseEpoch: job.leaseEpoch };
  const backend = await deps.backend.bundleData(lease);
  const body = gzipSync(JSON.stringify({ format: FORMAT, worker: { ...deps.worker, logs: deps.logs.recent() }, backend }, null, 2));
  const { uploadUrl } = await deps.backend.artifactUploadUrl(lease);
  const response = await (deps.fetch ?? fetch)(uploadUrl, { method: 'POST', headers: { 'Content-Type': 'application/gzip' }, body });
  if (!response.ok) throw new Error(`The support bundle's upload was refused (HTTP ${response.status}).`);
  const { storageId } = (await response.json()) as { storageId?: GenericId<'_storage'> };
  if (!storageId) throw new Error("The support bundle's upload returned no storage ID.");
  return storageId;
}
