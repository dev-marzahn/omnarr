// `download.submit`, in this order: the client must have
// been configured in this worker session; a re-claimed job finds what an
// earlier attempt submitted by its tag; free space is checked; the worker
// fetches the candidate's release file itself, so no indexer key reaches the
// client; then it submits under the client's lock. The job completes once the
// client accepts the item; the reconciler reports the download from there.
// A torrent waits behind the VPN gate while the VPN isn't up.
import { type ClientKind, DownloadSubmitPayload, type IndexerFailure, type JobResult, type LeasedJob, type StorageSpace } from '@omnarr/contracts';

import type { DownloadClient, FetchedRelease } from '../clients/downloadClient.ts';
import type { SitesBackend } from '../convex.ts';
import { errorFailureCode } from '../failures.ts';
import { fetchRelease, type ReleaseFetch } from '../release/fetch.ts';
import { parseMagnet, parseTorrent } from '../release/torrent.ts';
import type { ClientRuntimeStore } from '../runtime/clientRuntime.ts';
import { type JobHandler, JobFailure } from '../runtime/lease.ts';
import { definitionFor, download as engineDownload } from '../sites/engine.ts';
import type { SiteFetch } from '../sites/http.ts';

export type DownloadSubmitDeps = {
  clients: Partial<Record<ClientKind, DownloadClient>>;
  /** What the reconciler configured this session. */
  runtime: ClientRuntimeStore;
  /** Each storage area's free bytes; the check reads `downloads`. */
  storage: () => Promise<StorageSpace>;
  /** The worker's outside GET; injected so tests never leave the process. */
  fetch: ReleaseFetch;
  /** A definition indexer's `siteUrl` goes through the engine: the site functions and the engine's GET. */
  sites?: { backend: SitesBackend; fetch: SiteFetch };
};

const CLIENT_NAME = { nzbget: 'NZBGet', qbittorrent: 'qBittorrent' } as const;

/** Usenet goes to NZBGet, torrents to qBittorrent. */
export const clientKindOf = (source: DownloadSubmitPayload['source']): ClientKind => (source.kind === 'nzbUrl' ? 'nzbget' : 'qbittorrent');

/**
 * In the VPN layout, qBittorrent loses gluetun's network when gluetun is recreated alone
 * (`up -d --force-recreate gluetun`, which compose.vpn.yml's `restart: true` doesn't cover).
 */
const FORCE_RECREATE = 'If qBittorrent lost the VPN container’s network, run docker compose up -d --force-recreate gluetun qbittorrent.';

/** The VPN states the reconciler sees only in the VPN layout. */
const VPN_LAYOUT = new Set(['connecting', 'up', 'down']);

export function downloadSubmitHandler(deps: DownloadSubmitDeps): JobHandler {
  return async (job, context): Promise<JobResult> => {
    const kind = clientKindOf(DownloadSubmitPayload.parse(job.payload).source);
    try {
      return await submitOnce(deps, job, context);
    } catch (error) {
      if (kind !== 'qbittorrent' || !VPN_LAYOUT.has(deps.runtime.vpnState())) throw error;
      const code = error instanceof JobFailure ? error.code : errorFailureCode(error);
      if (code !== 'clientUnreachable') throw error;
      const detail = error instanceof JobFailure ? error.detail : 'qBittorrent did not answer.';
      throw new JobFailure('clientUnreachable', `${detail} ${FORCE_RECREATE}`);
    }
  };
}

/** The steps above, in order. */
async function submitOnce(deps: DownloadSubmitDeps, job: Parameters<JobHandler>[0], { signal }: Parameters<JobHandler>[1]): Promise<JobResult> {
  const payload = DownloadSubmitPayload.parse(job.payload);
  const kind = clientKindOf(payload.source);
  const client = deps.clients[kind];

  // 1. Configured in this session; otherwise the Issue appears per Unit, as for any unreachable client.
  if (!client || !deps.runtime.configured(kind)) throw new JobFailure('clientUnreachable', `${CLIENT_NAME[kind]} isn't configured yet in this worker session.`);

  // 2. Find by tag.
  const existing = await client.findByTag(payload.correlationTag, signal);
  if (existing) return { class: 'download.submit', clientRef: existing.clientRef };

  // 3. The VPN gate (torrents only): wait, counting no attempt, while a chosen VPN or the VPN layout isn't up.
  if (kind === 'qbittorrent' && deps.runtime.vpnGated())
    throw new JobFailure(
      'vpnDown',
      deps.runtime.vpnState() === 'notActive'
        ? 'A VPN is chosen, but the VPN layout isn’t in use yet.'
        : 'The VPN isn’t up: qBittorrent moves no traffic until it is.',
    );

  // 4. Free space.
  const free = (await deps.storage()).downloads.freeBytes;
  if (payload.sizeBytes !== undefined && free < payload.sizeBytes)
    throw new JobFailure('diskFull', `The release needs ${payload.sizeBytes} bytes under downloads/; ${free} bytes free.`);

  // 5. The candidate's own download URL, fetched and checked by the worker; a magnet is used as it is.
  const release = await releaseOf(deps, job, payload, signal);

  // 6. Submit, never in the middle of a config apply.
  const options = { correlationTag: payload.correlationTag, category: payload.category, ...(payload.seedGoal ? { seedGoal: payload.seedGoal } : {}) };
  const { clientRef } = await deps.runtime.withClientLock(kind, () => client.submit(release, options, signal));
  return { class: 'download.submit', clientRef };
}

/** A site failure as the release fetch's codes: what may pass on retry, and what won't. */
function siteFailureCode(failure: IndexerFailure): 'releaseFetchFailed' | 'releaseFileInvalid' {
  if (['timeout', 'unreachable', 'rateLimited', 'challenged'].includes(failure.kind)) return 'releaseFetchFailed';
  if (failure.kind === 'httpError' && (failure.httpStatus ?? 500) >= 500) return 'releaseFetchFailed';
  return 'releaseFileInvalid';
}

/** A definition indexer's link through its engine: the download block, paced, with the indexer's cookies. */
async function siteRelease(
  deps: DownloadSubmitDeps,
  job: LeasedJob,
  source: Extract<DownloadSubmitPayload['source'], { kind: 'siteUrl' }>,
  indexerName: string,
  signal: AbortSignal,
): Promise<FetchedRelease> {
  if (!deps.sites) throw new JobFailure('releaseFileInvalid', `This worker can't fetch from ${indexerName}.`);
  const lease = { jobId: job.jobId, leaseEpoch: job.leaseEpoch };
  const config = await deps.sites.backend.siteConfig({ ...lease, indexerId: source.indexerId });
  if (!config) throw new JobFailure('releaseFileInvalid', `${indexerName} or its definition is no longer stored.`);
  const definition = definitionFor(config.sha256, config.yaml);
  const backend = deps.sites.backend;
  const result = await engineDownload({ indexerId: config.indexerId, baseUrl: config.baseUrl, settings: config.settings }, definition, source.url, {
    fetch: deps.sites.fetch,
    signal,
    pace: async (indexerId) => {
      const slot = await backend.reservePacing({ ...lease, indexerId: indexerId as never });
      if ('skip' in slot) return 'skip';
      if (slot.waitMs > 0) await new Promise((resolve) => setTimeout(resolve, slot.waitMs));
      return 'go';
    },
  });
  if (!result.ok) {
    if ('skipped' in result) throw new JobFailure('releaseFetchFailed', `Too many requests are queued for ${indexerName}; the grab tries again.`);
    const { failure } = result;
    throw new JobFailure(
      siteFailureCode(failure),
      `${indexerName} gave no torrent (${failure.kind}${failure.httpStatus ? ` ${failure.httpStatus}` : ''}, ${failure.host} ${failure.path}).`,
    );
  }
  if (result.value.kind === 'magnet') {
    const magnet = parseMagnet(result.value.uri);
    if (!magnet) throw new JobFailure('releaseFileInvalid', `The magnet from ${indexerName} has no info hash.`);
    return { kind: 'magnet', uri: result.value.uri, infoHash: magnet.infoHash };
  }
  const torrent = parseTorrent(result.value.bytes);
  if (!torrent) throw new JobFailure('releaseFileInvalid', `${indexerName} sent a file that is not a torrent.`);
  return { kind: 'torrentFile', bytes: result.value.bytes, infoHash: torrent.infoHash };
}

/** The release to hand the client: the fetched NZB or .torrent, or the magnet. */
async function releaseOf(deps: DownloadSubmitDeps, job: LeasedJob, payload: DownloadSubmitPayload, signal: AbortSignal): Promise<FetchedRelease> {
  const { fetch } = deps;
  const { source, indexerName } = payload;
  if (source.kind === 'siteUrl') return await siteRelease(deps, job, source, indexerName, signal);
  if (source.kind === 'magnet') {
    const magnet = parseMagnet(source.uri);
    if (!magnet) throw new JobFailure('releaseFileInvalid', `The magnet from ${indexerName} has no info hash.`);
    return { kind: 'magnet', uri: source.uri, infoHash: magnet.infoHash };
  }
  const fetched = await fetchRelease(source.url, { protocol: source.kind === 'nzbUrl' ? 'usenet' : 'torrent', indexerName, fetch, signal });
  return fetched.kind === 'nzb' ? { kind: 'nzb', name: payload.releaseTitle ?? payload.correlationTag, bytes: fetched.bytes } : fetched;
}
