// The indexer DTOs: the Indexers page row and the form's detail.
// Neither carries `apiKey`; the detail says only whether one is stored.
import type { IndexerDetail, IndexerRow } from '@omnarr/contracts';

import type { Doc } from '../_generated/dataModel';
import { whereOf } from './http';
import { pacingIntervalOf } from './pacing';
import { effectiveRssIntervalMinutes } from './rateLimit';
import { errors24h, total24h } from './usage';

/** A definition's setting types whose values never leave the backend. */
export const SECRET_SETTING_TYPES = new Set(['text', 'password']);

export function toRow(indexer: Doc<'indexers'>, now: number): IndexerRow {
  const pacingIntervalMs = pacingIntervalOf(indexer);
  return {
    id: indexer._id,
    name: indexer.name,
    kind: indexer.kind,
    host: whereOf(indexer.apiUrl).host,
    enabled: indexer.enabled,
    priority: indexer.priority,
    health: indexer.health,
    ...(indexer.rateLimitedUntil === undefined ? {} : { rateLimitedUntil: indexer.rateLimitedUntil }),
    ...(indexer.rateLimitReason === undefined ? {} : { rateLimitReason: indexer.rateLimitReason }),
    apiUse24h: total24h(indexer.usage, now),
    errors24h: errors24h(indexer.usage, now),
    effectiveRssIntervalMinutes: effectiveRssIntervalMinutes(indexer),
    ...(pacingIntervalMs === undefined ? {} : { pacingIntervalMs }),
    ...(indexer.site ? { definitionName: indexer.site.definitionName } : {}),
  };
}

/**
 * The indexer detail. A definition indexer's settings come with their
 * types from the definition: `select` and `checkbox` values are returned,
 * `text` and `password` ones only as set or not.
 */
export function toDetail(indexer: Doc<'indexers'>, now: number, settingTypes: Map<string, string> = new Map()): IndexerDetail {
  const site = indexer.site;
  const visible = site ? Object.entries(site.settings).filter(([name]) => !SECRET_SETTING_TYPES.has(settingTypes.get(name) ?? 'text')) : [];
  const secretsSet = site
    ? Object.entries(site.settings).filter(([name, value]) => SECRET_SETTING_TYPES.has(settingTypes.get(name) ?? 'text') && value !== '')
    : [];
  return {
    ...(site
      ? {
          site: { definitionId: site.definitionId, baseUrl: site.baseUrl, settings: Object.fromEntries(visible), secretsSet: secretsSet.map(([name]) => name) },
        }
      : {}),
    ...toRow(indexer, now),
    apiUrl: indexer.apiUrl,
    caps: { searchModes: indexer.caps.searchModes, categories: indexer.caps.categories, pageLimit: indexer.caps.pageLimit },
    categories: indexer.categories,
    ...(indexer.apiLimit ? { apiLimit: indexer.apiLimit } : {}),
    apiKeySet: indexer.apiKey.length > 0,
    rssIntervalMinutes: indexer.rssIntervalMinutes,
  };
}
