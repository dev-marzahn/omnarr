<!--
  "Edit monitoring" in the Work page's "…": what subscribe sets, changed in
  place. Each season's switch is the Episodes tab's
  (units.setMonitored), and "Monitor new episodes" is the Work's
  monitorNewUnits. A movie has its one switch and no new episodes.
  Every switch applies at once.
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';
import type { Id } from '@omnarr/backend/dataModel';
import type { WorkKind } from '@omnarr/contracts';

import { monitoringDescription, seasonKey } from '~/lib/library';
import type { SeasonGroup } from '~/lib/seasons';

const props = defineProps<{ workId: Id<'works'>; kind: WorkKind; seasons: SeasonGroup[]; monitorNewUnits: boolean; pending: Set<string> }>();
const emit = defineEmits<{ season: [group: SeasonGroup, on: boolean] }>();
const open = defineModel<boolean>('open', { default: false });
const toast = useToast();
const setMonitorNew = useMutation(api.api.library.setMonitorNew);
const saving = ref(false);
async function onMonitorNew(on: boolean) {
  saving.value = true;
  try {
    await setMonitorNew({ workId: props.workId, monitorNewUnits: on });
  } catch {
    toast.add({ title: "Monitoring couldn't be changed", description: 'Try again.', color: 'error', icon: 'i-lucide-triangle-alert' });
  } finally {
    saving.value = false;
  }
}
const monitoringLabel = { all: 'Monitored', some: 'Partly monitored', none: 'Not monitored' } as const;
const count = (group: SeasonGroup) => `${group.units.length} ${group.units.length === 1 ? 'episode' : 'episodes'}`;
</script>

<template>
  <UModal v-model:open="open" title="Edit monitoring" :description="monitoringDescription(kind)">
    <template #body>
      <div class="space-y-4 text-sm">
        <div v-if="kind === 'series'" class="flex items-start gap-3">
          <div class="flex-1">
            <p class="font-semibold text-highlighted">Monitor new episodes</p>
            <p class="text-xs text-muted">Seasons and episodes TMDB adds later are monitored too.</p>
          </div>
          <USwitch :model-value="monitorNewUnits" :loading="saving" aria-label="Monitor new episodes" @update:model-value="onMonitorNew" />
        </div>
        <ul class="divide-y divide-default rounded-lg ring ring-default">
          <li v-for="group in seasons" :key="group.label" class="flex items-center gap-3 px-4 py-2.5">
            <span class="flex-1 font-medium text-highlighted">{{ group.label }}</span>
            <span class="text-xs text-muted tabular-nums">{{ kind === 'series' ? `${count(group)} · ` : '' }}{{ monitoringLabel[group.monitoring] }}</span>
            <USwitch
              :model-value="group.monitoring === 'all'"
              :aria-label="`${group.label}: ${monitoringLabel[group.monitoring]}`"
              :loading="pending.has(seasonKey(group.season))"
              @update:model-value="emit('season', group, $event)"
            />
          </li>
        </ul>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end">
        <UButton color="neutral" variant="ghost" label="Done" @click="open = false" />
      </div>
    </template>
  </UModal>
</template>
