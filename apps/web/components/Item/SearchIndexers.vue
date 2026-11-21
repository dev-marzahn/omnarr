<!--
  The Candidates tab's indexer lines (test-install backlog): for the
  episode's last search, one line per indexer with what it found, or why it
  was skipped or failed, from the search attempt's recorded results.
-->
<script setup lang="ts">
import type { SearchIndexerLine } from '~/lib/timeline';

defineProps<{ lines: SearchIndexerLine[] }>();

const ICONS: Record<SearchIndexerLine['tone'], string> = {
  searched: 'i-lucide-circle-check',
  skipped: 'i-lucide-circle-minus',
  failed: 'i-lucide-triangle-alert',
};
const COLORS: Record<SearchIndexerLine['tone'], string> = { searched: 'text-success', skipped: 'text-muted', failed: 'text-error' };
</script>

<template>
  <UCard :ui="{ body: 'py-3 sm:py-3' }">
    <template #header>
      <h3 class="text-sm font-semibold text-highlighted">Indexers in the last search</h3>
    </template>
    <ul class="space-y-1.5 text-sm">
      <li v-for="line in lines" :key="line.name" class="flex flex-wrap items-baseline gap-x-2">
        <UIcon :name="ICONS[line.tone]" class="size-4 shrink-0 self-center" :class="COLORS[line.tone]" />
        <span class="font-medium text-highlighted">{{ line.name }}</span>
        <span class="text-muted">{{ line.text }}</span>
      </li>
    </ul>
  </UCard>
</template>
