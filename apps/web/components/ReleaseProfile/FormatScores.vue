<!-- Built-in format scores. The preparation rows order releases only, and never block one. -->
<script setup lang="ts">
import type { FormatScore, ReleaseProfileDetail } from '@omnarr/contracts';

const props = defineProps<{ catalogue: ReleaseProfileDetail['formatCatalogue'] }>();
const scores = defineModel<FormatScore[]>({ required: true });

const scoreOf = (formatId: string) => scores.value.find((entry) => entry.formatId === formatId)?.score ?? 0;
function setScore(formatId: string, score: number | null) {
  const rest = scores.value.filter((entry) => entry.formatId !== formatId);
  scores.value = score ? [...rest, { formatId, score }] : rest;
}
const sorted = computed(() => [...props.catalogue].sort((a, b) => Number(b.kind === 'preparation') - Number(a.kind === 'preparation')));
</script>

<template>
  <table class="w-full text-sm">
    <tbody class="divide-y divide-default">
      <tr v-for="format in sorted" :key="format.id">
        <td class="py-1">
          {{ format.name }}
          <span v-if="format.kind === 'preparation'" class="text-xs text-muted"> · Built in, orders only, never blocks</span>
        </td>
        <td class="py-1 w-36"><UInputNumber :model-value="scoreOf(format.id)" size="sm" @update:model-value="setScore(format.id, $event)" /></td>
      </tr>
    </tbody>
  </table>
</template>
