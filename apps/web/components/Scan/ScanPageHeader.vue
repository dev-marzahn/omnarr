<!--
  The scan pages' header bar: "Scan now"
  with its re-scan confirm, "Repeat" in the header bar on a desktop and in
  "…" on a phone, and the three tabs while a ready run has files to review.
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';
import type { ScanSchedule } from '@omnarr/contracts';

import { rescanConfirm, SCHEDULE_ITEMS, scanBusy, scanTabs, scanView, scheduleHelp, type ScanTabValue } from '~/lib/scan';

const props = defineProps<{ tab: ScanTabValue }>();
const toast = useToast();

const { data: status } = useQuery(api.api.scan.status, {});
const run = computed(() => status.value?.run ?? undefined);
const view = computed(() => (status.value ? scanView(status.value) : undefined));
const readyRunId = computed(() => (run.value?.state === 'ready' ? run.value.scanRunId : undefined));

// The Unmatched tab counts folders once all of them are loaded.
const unmatched = useScanGroups(readyRunId, 'unmatched');
const tabs = computed(() =>
  run.value
    ? scanTabs(run.value.counts, unmatched.complete.value ? unmatched.groups.value.length : undefined).map((tab) => ({
        value: tab.value,
        label: tab.label,
        count: tab.count,
        icon: tab.value === 'matched' ? 'i-lucide-check' : tab.value === 'unmatched' ? 'i-lucide-folder' : 'i-lucide-library',
        color: tab.value === 'unmatched' ? ('warning' as const) : ('neutral' as const),
        to: tab.to,
      }))
    : [],
);
const toTab = (value: string) => tabs.value.find((tab) => tab.value === value)?.to ?? '/scan';

const start = useMutation(api.api.scan.start);
const updateSettings = useMutation(api.api.scan.updateSettings);
const starting = ref(false);
const confirming = ref(false);
const confirm = computed(() => (status.value ? rescanConfirm(status.value) : undefined));

async function onScanNow() {
  if (confirm.value && !confirming.value) {
    confirming.value = true;
    return;
  }
  confirming.value = false;
  starting.value = true;
  try {
    await start({ trigger: 'manual' });
  } catch (e) {
    toast.add({ title: "The scan couldn't start", description: (e as Error).message, color: 'error', icon: 'i-lucide-triangle-alert' });
  } finally {
    starting.value = false;
  }
}

async function onSchedule(schedule: ScanSchedule) {
  try {
    await updateSettings({ schedule });
    toast.add({ title: 'Repeat saved', description: scheduleHelp(schedule), icon: 'i-lucide-circle-check', color: 'success' });
  } catch (e) {
    toast.add({ title: "Repeat couldn't be saved", description: (e as Error).message, color: 'error', icon: 'i-lucide-triangle-alert' });
  }
}

const actions = computed(() =>
  status.value
    ? [{ label: 'Scan now', icon: 'i-lucide-refresh-cw', primary: true, loading: starting.value, disabled: scanBusy(status.value), onClick: onScanNow }]
    : [],
);
// On a phone, Repeat's choices sit in "…".
const phoneMenu = computed(() =>
  status.value
    ? [
        { type: 'label' as const, label: 'Repeat' },
        ...SCHEDULE_ITEMS.map((item) => ({
          label: item.label,
          type: 'checkbox' as const,
          checked: status.value?.schedule === item.value,
          onSelect: () => onSchedule(item.value),
        })),
      ]
    : [],
);
</script>

<template>
  <PageHeader title="Scan" :actions="actions">
    <template #right>
      <template v-if="status">
        <span class="hidden sm:inline text-sm text-muted">Repeat</span>
        <USelect
          :model-value="status.schedule"
          :items="SCHEDULE_ITEMS"
          class="hidden sm:flex w-28"
          aria-label="Repeat"
          @update:model-value="onSchedule($event as ScanSchedule)"
        />
        <UDropdownMenu :items="phoneMenu" :content="{ align: 'end' }">
          <UButton class="sm:hidden" icon="i-lucide-ellipsis" color="neutral" variant="outline" square aria-label="More actions" />
        </UDropdownMenu>
      </template>
    </template>
    <template v-if="view?.kind === 'review' && tabs.length" #tabs>
      <ResponsiveTabs :model-value="props.tab" :items="tabs" :to="toTab" />
    </template>
  </PageHeader>

  <UModal v-if="confirm" v-model:open="confirming" :title="confirm.title" :description="confirm.description">
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" label="Keep this review" @click="confirming = false" />
        <UButton :label="confirm.confirm" @click="onScanNow" />
      </div>
    </template>
  </UModal>
</template>
