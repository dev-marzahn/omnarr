<!--
  An indexer's health on its row: one badge, then one line: the
  rate limit with its reason (after a site's browser check, which one), the
  failure, or a site's pacing, API use and errors in the last 24 hours with
  the latency and the last RSS check. A disabled indexer says so.
-->
<script setup lang="ts">
import type { IndexerRow } from '@omnarr/contracts';

import { failureText, HEALTH_LABEL, healthPath, pacingText, rateLimitText } from '~/lib/indexers';

const props = defineProps<{ row: IndexerRow }>();
const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const limit = computed(() => rateLimitText(props.row, Date.now(), time));
const health = computed(() => HEALTH_LABEL[props.row.health.status]);
const detail = computed(() =>
  props.row.health.detail ? failureText({ ...props.row.health.detail, host: props.row.host, path: healthPath(props.row.kind) }) : undefined,
);
/** A rate limit set by a browser check says why. */
const challenge = computed(() => (props.row.health.detail?.kind === 'challenged' ? detail.value : undefined));
const usage = computed(() =>
  [
    ...(props.row.pacingIntervalMs !== undefined ? [pacingText(props.row.pacingIntervalMs)] : []),
    `API use (24 h) ${props.row.apiUse24h}`,
    `errors ${props.row.errors24h}`,
    ...(props.row.health.latencyMs !== undefined ? [`${props.row.health.latencyMs} ms`] : []),
    ...(props.row.health.lastRss
      ? [`last RSS ${time(props.row.health.lastRss.at)}, ${props.row.health.lastRss.matched} of ${props.row.health.lastRss.newItems} new matched`]
      : []),
  ].join(' · '),
);
</script>

<template>
  <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs min-w-0">
    <template v-if="row.enabled">
      <UBadge size="sm" :color="health.color" variant="subtle" :label="health.label" />
      <span v-if="limit" class="text-warning">{{ challenge ? `${challenge} ${limit}` : limit }}</span>
      <span v-else-if="detail && row.health.status !== 'ok'" class="text-error">{{ detail }}</span>
      <span v-else class="text-muted tabular-nums">{{ usage }}</span>
    </template>
    <span v-else class="text-muted">Disabled</span>
  </div>
</template>
