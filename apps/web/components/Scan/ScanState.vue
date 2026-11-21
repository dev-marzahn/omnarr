<!--
  The scan pages' body top: the last-scan
  line and the run's state (scanning, matching, nothing untracked, failed,
  cancelled). The page's tab content is the default slot, shown while a
  ready run has untracked files. ScanPageHeader holds Scan now, Repeat and
  the tabs.
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';

import { lastScanLine, scanBusy, scanView } from '~/lib/scan';

const toast = useToast();

const { data: status, error } = useQuery(api.api.scan.status, {});
const run = computed(() => status.value?.run ?? undefined);
const view = computed(() => (status.value ? scanView(status.value) : undefined));
const ended = computed(() => run.value && !scanBusy(status.value!));

const cancel = useMutation(api.api.scan.cancel);
async function onCancel() {
  if (!run.value) return;
  try {
    await cancel({ scanRunId: run.value.scanRunId });
  } catch (e) {
    toast.add({ title: "The scan couldn't be cancelled", description: (e as Error).message, color: 'error', icon: 'i-lucide-triangle-alert' });
  }
}
</script>

<template>
  <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-triangle-alert" title="The scan couldn't be loaded." :description="error.message" />

  <template v-else-if="status && view">
    <p v-if="run && ended" class="flex items-center gap-1.5 text-sm text-muted">
      <UIcon name="i-lucide-clock" class="shrink-0" />
      {{ lastScanLine(run, Date.now()) }}
    </p>

    <UCard v-if="view.kind === 'reading' || view.kind === 'matching'">
      <div class="space-y-2 text-sm">
        <div class="flex items-center gap-2">
          <UIcon name="i-lucide-loader-circle" class="animate-spin text-info" />
          <span class="font-medium">{{ view.title }}</span>
          <UButton class="ms-auto" size="sm" color="neutral" variant="outline" label="Cancel" @click="onCancel" />
        </div>
        <div v-if="view.kind === 'reading'" class="flex items-center gap-3 text-muted">
          <UProgress :model-value="view.progress.percent ?? null" class="flex-1" />
          <span class="font-mono whitespace-nowrap tabular-nums">{{ view.progress.text }}</span>
        </div>
        <p class="text-xs text-dimmed">{{ view.description }}</p>
      </div>
    </UCard>

    <UEmpty
      v-else-if="view.kind === 'never' || view.kind === 'nothing' || view.kind === 'cancelled'"
      :icon="view.kind === 'nothing' ? 'i-lucide-check' : view.kind === 'never' ? 'i-lucide-scan-search' : 'i-lucide-circle-slash'"
      :title="view.title"
      :description="view.description"
    />

    <UAlert
      v-else-if="view.kind === 'failed'"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="view.title"
      :description="view.description"
    />

    <slot v-else-if="view.kind === 'review' && run" :scan-run-id="run.scanRunId" :counts="run.counts" />
  </template>
</template>
