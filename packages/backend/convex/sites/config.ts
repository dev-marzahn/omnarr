// `sites.config`: what the worker's engine needs to run one
// definition indexer: its definition file, base URL and settings. It returns
// text and password settings, so it is a worker function, the second after
// `jellyfin.setup.connection` that returns secrets, and only to the holder of
// a job for that indexer. Never log its answer.
import { DefinitionFile, DefinitionFileRequest, SiteConfig, SiteConfigRequest } from '@omnarr/contracts';

import { workerQuery } from '../lib/functions';
import { definitionRow, definitionYaml } from './definitions';
import { leaseForDraft, leaseForIndexer } from './lease';

/** A definition's file, for a test of the form's values before the indexer is saved (`testDraft`). */
export const definitionFile = workerQuery({
  args: DefinitionFileRequest.shape,
  returns: DefinitionFile.nullable(),
  handler: async (ctx, { jobId, leaseEpoch, definitionId }) => {
    await leaseForDraft(ctx, { jobId, leaseEpoch }, definitionId);
    const definition = await definitionRow(ctx, definitionId);
    return definition ? { name: definition.meta?.name ?? definitionId, sha256: definition.sha256, yaml: await definitionYaml(ctx, definition) } : null;
  },
});

export const config = workerQuery({
  args: SiteConfigRequest.shape,
  returns: SiteConfig.nullable(),
  handler: async (ctx, { jobId, leaseEpoch, indexerId }) => {
    await leaseForIndexer(ctx, { jobId, leaseEpoch }, indexerId);
    const indexer = await ctx.db.get(indexerId);
    if (!indexer?.site) return null;
    const definition = await definitionRow(ctx, indexer.site.definitionId);
    if (!definition) return null;
    return {
      indexerId,
      name: indexer.name,
      definitionId: definition.definitionId,
      sha256: definition.sha256,
      yaml: await definitionYaml(ctx, definition),
      baseUrl: indexer.site.baseUrl,
      settings: indexer.site.settings,
    };
  },
});
