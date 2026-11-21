<!--
  One timeline event: its message (or the run's own wording for it, such as
  a manual grab's pick step), time and, for a failure, what failed.
-->
<script setup lang="ts">
import type { TimelineStage } from '@omnarr/contracts';

import { failureText } from '~/lib/timeline';

defineProps<{ stage: TimelineStage; text?: string; detail?: string }>();
const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });
const ICON: Record<TimelineStage['kind'], string> = {
  stageStarted: 'i-lucide-circle-dot',
  stageFinished: 'i-lucide-circle-check',
  stageFailed: 'i-lucide-circle-x',
  decision: 'i-lucide-list-checks',
  retry: 'i-lucide-rotate-cw',
  blocklisted: 'i-lucide-ban',
  cancelled: 'i-lucide-circle-slash',
  paused: 'i-lucide-pause',
  resumed: 'i-lucide-play',
  metadataChanged: 'i-lucide-pencil',
};
</script>

<template>
  <li class="flex items-start gap-2 text-sm">
    <UIcon :name="ICON[stage.kind]" :class="stage.kind === 'stageFailed' ? 'text-error' : 'text-muted'" class="mt-0.5 shrink-0" />
    <span class="flex-1 min-w-0">
      {{ text ?? stage.message }}
      <span v-if="stage.failureCode" class="text-error">({{ failureText(stage.failureCode) }})</span>
      <span v-if="detail" class="block text-xs font-mono text-muted break-all">{{ detail }}</span>
    </span>
    <span class="text-xs text-muted tabular-nums">{{ time.format(stage.at) }}</span>
  </li>
</template>
