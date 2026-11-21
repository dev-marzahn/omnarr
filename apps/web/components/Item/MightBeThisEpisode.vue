<!--
  The Candidates tab's "Might be this episode" (after "Possibly misread"):
  when the episode's last search has no picked or acceptable release, that
  search's releases that name the series but weren't matched to this
  episode, each with a one-line explanation. A row's Grab opens the grab
  confirm and imports the release as this episode; once the
  search is no longer open, the row offers Search again instead.
-->
<script setup lang="ts">
import type { CandidateRow } from '@omnarr/contracts';

import type { MisreadListRow } from '~/lib/misread';

defineProps<{ rows: MisreadListRow[] }>();
const emit = defineEmits<{ grab: [candidate: CandidateRow]; searchAgain: [] }>();
</script>

<template>
  <UCard :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <h3 class="text-sm font-semibold text-highlighted">Might be this episode</h3>
      <p class="mt-1 text-sm text-muted">
        These releases name this series but weren't matched to this episode, so none was grabbed. If one is this episode, grab it; it is imported as this
        episode.
      </p>
    </template>
    <ul class="divide-y divide-default">
      <li v-for="row in rows" :key="row.key" class="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 text-sm sm:px-6">
        <div class="min-w-0 flex-1 basis-72 space-y-1">
          <p class="font-mono text-xs break-all text-highlighted">{{ row.title }}</p>
          <p class="text-default">{{ row.explanation }}</p>
          <p class="text-xs text-muted tabular-nums">{{ row.source }}</p>
        </div>
        <UTooltip v-if="row.action.kind === 'grab'" :text="row.action.disabled" :disabled="!row.action.disabled">
          <UButton
            size="sm"
            color="neutral"
            variant="outline"
            icon="i-lucide-download"
            label="Grab"
            :disabled="!!row.action.disabled"
            @click="row.action.kind === 'grab' && emit('grab', row.action.candidate)"
          />
        </UTooltip>
        <UButton v-else size="sm" color="neutral" variant="outline" icon="i-lucide-list-checks" label="Search again" @click="emit('searchAgain')" />
      </li>
    </ul>
  </UCard>
</template>
