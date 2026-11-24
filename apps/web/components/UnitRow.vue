<!--
  One episode on the Work page: its number, title and air date,
  its state with the Issue tag and one detail line (or the preparation's
  progress), one visible action that fits the state, and "…" for the rest.
  On a phone the state moves under the title. The page runs the actions.
-->
<script setup lang="ts">
import type { UnitRow } from '@omnarr/contracts';

import { downloadLine } from '~/lib/downloads';
import { unitPreparingLine } from '~/lib/preparingProgress';
import { formatAirDate, type RowActionKind, unitDetail, unitRowAction, upgradingTag } from '~/lib/unitStates';

const props = defineProps<{ unit: UnitRow; busy?: boolean }>();
const emit = defineEmits<{ action: [kind: RowActionKind] }>();

const action = computed(() => unitRowAction(props.unit));
const upgrading = computed(() => upgradingTag(props.unit));
const title = computed(() => props.unit.title ?? `Episode ${props.unit.tmdbEpisode}`);
const prep = computed(() => (props.unit.preparation ? unitPreparingLine(props.unit.preparation) : undefined));
// The running download's one-line progress, while the Unit is grabbed or downloading.
const dl = computed(() => (props.unit.download && !props.unit.cancelRequested ? downloadLine(props.unit.download) : undefined));
const aired = computed(() =>
  props.unit.airDateUtc === undefined ? undefined : `${props.unit.airDateUtc <= Date.now() ? 'Aired' : 'Airs'} ${formatAirDate(props.unit.airDateUtc)}`,
);
const menu = computed(() => [action.value.menu.map((item) => ({ label: item.label, icon: item.icon, onSelect: () => emit('action', item.kind) }))]);
const primary = computed(() => action.value.primary);
const look = computed(() => {
  const kind = primary.value?.kind;
  if (kind === 'fix') return { color: 'error' as const, variant: 'soft' as const };
  if (kind === 'openIssue' || kind === 'searchNow' || kind === 'searchAndPick') return { color: 'neutral' as const, variant: 'outline' as const };
  return { color: 'neutral' as const, variant: 'ghost' as const };
});
const iconOnly = computed(() => primary.value?.kind === 'jellyfin');
</script>

<template>
  <li
    class="grid grid-cols-[2rem_minmax(0,1fr)_auto] gap-x-3 gap-y-1 px-4 py-3 sm:grid-cols-[2rem_minmax(0,14rem)_minmax(0,1fr)_auto] sm:items-center"
    :class="unit.state === 'notAired' || unit.state === 'notMonitored' ? 'text-muted' : ''"
  >
    <span class="text-xs text-dimmed tabular-nums font-mono pt-0.5 sm:pt-0">{{ unit.tmdbEpisode ?? '' }}</span>
    <div class="min-w-0">
      <NuxtLink :to="`/items/${unit.unitId}`" class="block truncate font-medium text-highlighted hover:underline">{{ title }}</NuxtLink>
      <p v-if="aired" class="text-xs text-dimmed">{{ aired }}</p>
    </div>
    <div class="col-start-2 row-start-2 min-w-0 space-y-1 sm:col-start-3 sm:row-start-1">
      <div class="flex flex-wrap items-center gap-1.5">
        <UnitStateBadge :state="unit.state" size="sm" />
        <UBadge v-if="unit.openIssue" size="sm" color="error" variant="subtle" icon="i-lucide-triangle-alert" label="Issue" />
        <UBadge v-if="upgrading" size="sm" color="info" variant="subtle" icon="i-lucide-arrow-up-circle" :label="upgrading" />
      </div>
      <div v-if="prep" class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-xs text-muted">
        <template v-if="prep.percent !== undefined">
          <UProgress :model-value="prep.percent" color="secondary" size="xs" class="w-24 shrink-0" :aria-label="prep.text" />
          <b class="tabular-nums text-highlighted">{{ prep.percent }}%</b>
        </template>
        <span class="min-w-0">{{ prep.text }}</span>
      </div>
      <DownloadProgress v-else-if="dl && unit.download?.stage !== 'postProcessing'" variant="inline" :percent="dl.percent" :line="dl.line" />
      <p v-else-if="dl" class="text-xs text-muted">{{ dl.line }}</p>
      <p v-else-if="unitDetail(unit)" class="text-xs text-muted">{{ unitDetail(unit) }}</p>
    </div>
    <div class="col-start-3 row-start-1 flex items-center justify-end gap-1 sm:col-start-4">
      <UTooltip v-if="primary" :text="primary.label" :disabled="!iconOnly">
        <UButton
          size="xs"
          :color="look.color"
          :variant="look.variant"
          :icon="iconOnly ? primary.icon : undefined"
          :label="iconOnly ? undefined : primary.label"
          :square="iconOnly"
          :aria-label="primary.label"
          :loading="busy"
          @click="emit('action', primary.kind)"
        />
      </UTooltip>
      <UDropdownMenu :items="menu" :content="{ align: 'end' }">
        <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-ellipsis" square :aria-label="`More for ${title}`" />
      </UDropdownMenu>
    </div>
  </li>
</template>
