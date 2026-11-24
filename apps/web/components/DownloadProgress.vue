<!--
  A download's progress: `full` on the item and movie pages (stage, run,
  percent, bar, the line and the release; also a done torrent's seeding
  towards its goal), `inline` in rows (bar, percent, the line). `percent`
  is undefined before the client's first report.
-->
<script setup lang="ts">
const props = withDefaults(
  defineProps<{
    variant?: 'full' | 'inline';
    percent?: number;
    /** "Downloading", "Repair / unpack", "Queued". */
    stage?: string;
    /** "Run 3 · Usenet". */
    context?: string;
    /** Size, speed and time left, or what it is waiting for. */
    line?: string;
    release?: string;
    /** `success` for a torrent seeding to its goal. */
    color?: 'info' | 'secondary' | 'success';
  }>(),
  { variant: 'full', percent: undefined, stage: undefined, context: undefined, line: undefined, release: undefined, color: 'info' },
);
const label = computed(() => [props.stage, props.line].filter(Boolean).join(' · ') || 'Progress');
</script>

<template>
  <div v-if="variant === 'inline'" class="flex items-center gap-2 text-xs text-muted">
    <UProgress :model-value="percent ?? null" :color="color" size="xs" class="w-24 shrink-0" :aria-label="label" />
    <b v-if="percent !== undefined" class="tabular-nums text-highlighted">{{ percent }}%</b>
    <span v-if="line" class="truncate">{{ line }}</span>
  </div>
  <div v-else class="rounded-lg ring ring-default px-4 py-3 sm:px-5 sm:py-4 space-y-2">
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
      <span class="text-sm font-semibold text-highlighted">{{ stage }}</span>
      <span v-if="context" class="text-xs text-muted">{{ context }}</span>
      <span class="flex-1" />
      <slot name="actions" />
    </div>
    <div class="flex items-center gap-3">
      <span v-if="percent !== undefined" class="text-2xl font-bold tabular-nums text-highlighted w-16 shrink-0">{{ percent }}%</span>
      <UProgress :model-value="percent ?? null" :color="color" size="md" class="flex-1" :aria-label="label" />
    </div>
    <div class="flex flex-wrap items-baseline gap-x-4 gap-y-1 text-sm text-muted">
      <span v-if="line" class="tabular-nums">{{ line }}</span>
      <span v-if="release" class="font-mono text-xs truncate max-w-full">{{ release }}</span>
    </div>
  </div>
</template>
