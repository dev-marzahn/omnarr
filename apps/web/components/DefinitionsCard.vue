<!--
  The System page's definitions card: the last sync of
  Prowlarr's site definitions, where it came from, how many omnarr runs, and
  "Check for definition updates", which enqueues a sync.
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';

import { syncCardRows } from '~/lib/sites';

defineProps<{ ui?: Record<string, string> }>();

const toast = useToast();
const { data: status } = useQuery(api.sites.definitions.status, {});
const syncNow = useMutation(api.sites.definitions.syncNow);
const checking = ref(false);

const time = (ms: number) => new Date(ms).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
const rows = computed(() => (status.value === undefined ? [] : syncCardRows(status.value, time)));

async function check() {
  checking.value = true;
  try {
    await syncNow({});
    toast.add({ title: 'Checking for definition updates', description: 'The worker downloads them in the background.', icon: 'i-lucide-refresh-cw' });
  } finally {
    checking.value = false;
  }
}
</script>

<template>
  <UCard :ui="ui">
    <template #header>
      <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
        <h2 class="text-sm font-semibold text-highlighted">Site definitions</h2>
        <UBadge v-if="status && !status.ok" size="sm" variant="subtle" color="error" label="Last sync failed" />
        <UButton
          class="ms-auto"
          size="xs"
          color="neutral"
          variant="outline"
          icon="i-lucide-refresh-cw"
          label="Check for definition updates"
          :loading="checking"
          @click="check"
        />
      </div>
    </template>
    <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 px-4 py-3 sm:px-6 text-sm">
      <template v-for="row in rows" :key="row.label">
        <dt class="text-muted">{{ row.label }}</dt>
        <dd class="min-w-0 break-words tabular-nums">{{ row.value }}</dd>
      </template>
    </dl>
  </UCard>
</template>
