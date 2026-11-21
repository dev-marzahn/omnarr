<!--
  Scan untracked media, the Matched tab, and the
  Already tracked tab (`?tab=tracked`), which only counts: the platform keeps
  no list of the tracked files it read.
-->
<script setup lang="ts">
import { trackedLine } from '~/lib/scan';

const route = useRoute();
const tab = computed(() => (route.query.tab === 'tracked' ? 'tracked' : 'matched'));
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <ScanPageHeader :tab="tab" />
    </template>
    <template #body>
      <PageBody>
        <ScanState>
          <template #default="{ scanRunId, counts }">
            <UEmpty v-if="tab === 'tracked'" icon="i-lucide-library" :title="trackedLine(counts).title" :description="trackedLine(counts).description" />
            <ScanGroups v-else :scan-run-id="scanRunId" />
          </template>
        </ScanState>
      </PageBody>
    </template>
  </UDashboardPanel>
</template>
