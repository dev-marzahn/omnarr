<!--
  The first run's existing-media step: what the first-run scan found.
  "Review and import" opens the scan page; "Not now" the library. Both finish
  first run.
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';

definePageMeta({ layout: 'setup', step: 'existingMedia' });

const { data: scan } = useQuery(api.api.scan.status, {});
const counts = computed(() => scan.value?.run?.counts);
const advance = useAdvance();
</script>

<template>
  <div class="flex flex-col gap-6">
    <div>
      <h1 class="text-xl font-bold text-highlighted">Existing media</h1>
      <p class="text-sm text-muted">omnarr found videos in your library folders that it didn't import.</p>
    </div>
    <UCard v-if="counts">
      <dl class="grid grid-cols-3 gap-4 text-center">
        <div>
          <dt class="text-xs text-muted">Found</dt>
          <dd class="text-xl font-semibold tabular-nums">{{ counts.read - counts.tracked }}</dd>
        </div>
        <div>
          <dt class="text-xs text-muted">Recognised</dt>
          <dd class="text-xl font-semibold tabular-nums">{{ counts.matched }}</dd>
        </div>
        <div>
          <dt class="text-xs text-muted">Need input</dt>
          <dd class="text-xl font-semibold tabular-nums">{{ counts.unmatched }}</dd>
        </div>
      </dl>
    </UCard>
    <div class="flex items-center gap-2 max-lg:flex-col-reverse max-lg:items-stretch">
      <UButton class="lg:ms-auto max-lg:justify-center" color="neutral" variant="outline" label="Not now" @click="advance('done', '/library')" />
      <UButton class="max-lg:justify-center" label="Review and import" @click="advance('done', '/scan')" />
    </div>
  </div>
</template>
