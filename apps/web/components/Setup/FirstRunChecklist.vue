<!--
  The first run's automatic-setup checklist: one line per part, read live, from
  lib/firstRun.ts's `checklist`.
-->
<script setup lang="ts">
import type { ChecklistLine } from '~/lib/firstRun';

defineProps<{ lines: ChecklistLine[] }>();

const ICON: Record<ChecklistLine['state'], { name: string; class: string }> = {
  done: { name: 'i-lucide-circle-check', class: 'text-success' },
  pending: { name: 'i-lucide-loader-circle', class: 'text-muted animate-spin' },
  failed: { name: 'i-lucide-circle-x', class: 'text-error' },
  skipped: { name: 'i-lucide-circle-minus', class: 'text-dimmed' },
};
</script>

<template>
  <ul class="flex flex-col gap-2.5 text-sm">
    <li v-for="line in lines" :key="line.key" class="flex items-start gap-2.5" :data-step="line.key" :data-state="line.state">
      <UIcon :name="ICON[line.state].name" class="size-4 mt-0.5 shrink-0" :class="ICON[line.state].class" />
      <div class="min-w-0">
        <p :class="line.state === 'skipped' ? 'text-muted' : 'text-highlighted'">{{ line.label }}</p>
        <p v-if="line.detail" class="text-xs text-error">{{ line.detail }}</p>
      </div>
    </li>
  </ul>
</template>
