<!--
  The series Work page's Files tab: the item page's Files rows (ItemContent)
  for every episode, each with its episode, size, quality and preparation
  state. The one file action is "Prepare now" on a primary that doesn't
  fit.
-->
<script setup lang="ts">
import type { UnitRow, WorkFileRow } from '@omnarr/contracts';

import { workFileRows } from '~/lib/preparation';
import { filePreparingText } from '~/lib/preparingProgress';

const props = defineProps<{ files: WorkFileRow[]; units: UnitRow[] }>();
const emit = defineEmits<{ prepare: [unit: UnitRow] }>();
const unitOf = computed(() => new Map(props.units.map((unit) => [unit.unitId, unit])));
const rows = computed(() =>
  workFileRows(props.files, props.units).map((row) => {
    const preparation = unitOf.value.get(row.unitId)?.preparation;
    return row.preparing && preparation ? { ...row, preparing: filePreparingText(preparation) } : row;
  }),
);
</script>

<template>
  <UEmpty v-if="rows.length === 0" icon="i-lucide-file" title="No files yet" description="Each episode's file shows here once a download is imported." />
  <ul v-else class="divide-y divide-default rounded-lg ring ring-default">
    <li v-for="file in rows" :key="file.key" class="flex flex-wrap items-start gap-x-3 gap-y-2 px-4 py-3 text-sm">
      <div class="min-w-0 flex-1 space-y-1">
        <div class="flex flex-wrap items-center gap-2">
          <NuxtLink :to="`/items/${file.unitId}`" class="font-semibold tabular-nums text-highlighted hover:underline">{{ file.unit }}</NuxtLink>
          <UBadge size="sm" color="neutral" variant="subtle" :label="file.kind" />
          <UBadge size="sm" color="neutral" variant="outline" :label="file.origin" />
          <span class="text-xs tabular-nums text-muted">{{ [file.size, file.quality].filter(Boolean).join(' · ') }}</span>
          <UBadge v-if="file.seeding" size="sm" color="success" variant="subtle" icon="i-lucide-arrow-up" class="tabular-nums" :label="file.seeding" />
          <span v-if="file.preparing" class="text-xs text-secondary tabular-nums">{{ file.preparing }}</span>
          <span v-else class="text-xs" :class="file.fit.fits ? 'text-success' : 'text-warning'">{{ file.fit.text }}</span>
        </div>
        <p class="font-mono text-xs break-all text-highlighted">{{ file.name }}</p>
        <p class="font-mono text-xs text-muted break-all">{{ file.folder }}</p>
        <p v-if="file.sidecars.length" class="text-xs text-muted">Subtitle files: {{ file.sidecars.join(', ') }}</p>
      </div>
      <UButton
        v-if="file.prepareNow && unitOf.get(file.unitId)"
        size="xs"
        color="neutral"
        variant="ghost"
        icon="i-lucide-wand-sparkles"
        label="Prepare now"
        @click="emit('prepare', unitOf.get(file.unitId)!)"
      />
    </li>
  </ul>
</template>
