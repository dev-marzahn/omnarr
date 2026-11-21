// The `indexer` job class: one relayed request of a
// definition indexer. The handler reads the indexer's config (`sites.config`,
// fenced on the job's lease), loads its definition, runs the engine, and
// completes the job with the IndexerResult or the test's answer. Site failures
// are results for the backend to record; only a missing indexer or definition fails the
// job. Settings are never logged.
import { IndexerJobPayload, type JobResult } from '@omnarr/contracts';

import type { SitesBackend } from '../convex.ts';
import type { JobHandler } from '../runtime/lease.ts';
import { JobFailure } from '../runtime/lease.ts';
import { definitionFor, type EngineDeps, rss, search, test } from '../sites/engine.ts';
import type { SiteFetch } from '../sites/http.ts';

export type IndexerJobDeps = { backend: SitesBackend; fetch: SiteFetch; log: (line: string) => void };

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener('abort', () => (clearTimeout(timer), resolve()), { once: true });
  });

export function indexerHandler(deps: IndexerJobDeps): JobHandler {
  return async (job, { signal }): Promise<JobResult> => {
    const payload = IndexerJobPayload.parse(job.payload);
    const lease = { jobId: job.jobId, leaseEpoch: job.leaseEpoch };
    const engine = (name: string): EngineDeps => ({
      fetch: deps.fetch,
      signal,
      pace: async (indexerId) => {
        if (payload.action === 'testDraft') return 'go';
        const slot = await deps.backend.reservePacing({ ...lease, indexerId: indexerId as never });
        if ('skip' in slot) return 'skip';
        if (slot.waitMs > 0) await sleep(slot.waitMs, signal);
        return 'go';
      },
      onLegacyLink: (_id, from, to) => deps.log(`indexer ${name}: its link ${from} is a legacy link; using ${to}`),
    });

    if (payload.action === 'testDraft') {
      const file = await deps.backend.definitionFile({ ...lease, definitionId: payload.draft.definitionId });
      if (!file) throw new JobFailure('pipelineError', `The definition ${payload.draft.definitionId} is no longer stored.`);
      const definition = definitionFor(file.sha256, file.yaml);
      const indexer = { indexerId: `draft:${job.jobId}`, baseUrl: payload.draft.baseUrl, settings: payload.draft.settings };
      return { class: 'indexer', test: await test(indexer, definition, engine(file.name)) };
    }

    const config = await deps.backend.siteConfig({ ...lease, indexerId: payload.indexerId });
    if (!config) throw new JobFailure('pipelineError', 'The indexer or its definition is no longer stored.');
    const definition = definitionFor(config.sha256, config.yaml);
    const indexer = { indexerId: config.indexerId, baseUrl: config.baseUrl, settings: config.settings };
    const run = engine(config.name);
    if (payload.action === 'test') return { class: 'indexer', test: await test(indexer, definition, run) };
    if (payload.action === 'rss') return { class: 'indexer', outcome: await rss(indexer, definition, run) };
    return { class: 'indexer', outcome: await search(indexer, definition, payload.request, run) };
  };
}
