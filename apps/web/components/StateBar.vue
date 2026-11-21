<!--
  The state bar: a Work's monitored Units by derived state, in rule order,
  each segment as wide as its count. Empty when none is monitored.
-->
<script setup lang="ts">
import type { StateCount } from '@omnarr/contracts';

import { type BadgeColor, stateBarSegments } from '~/lib/unitStates';

const props = defineProps<{ states: readonly StateCount[] }>();
const segments = computed(() => stateBarSegments(props.states));
const BG: Record<BadgeColor, string> = {
  primary: 'bg-inverted',
  secondary: 'bg-secondary',
  success: 'bg-success',
  info: 'bg-info',
  warning: 'bg-warning',
  error: 'bg-error',
  neutral: 'bg-accented',
};
const label = computed(() => (segments.value.length ? segments.value.map((s) => s.label).join(', ') : 'None monitored'));
</script>

<template>
  <div class="flex h-1 w-full gap-0.5 overflow-hidden rounded-full" role="img" :aria-label="label" :title="label">
    <i v-for="segment in segments" :key="segment.state" :class="BG[segment.color]" :style="{ flexGrow: segment.count }" class="block h-full min-w-1" />
    <i v-if="segments.length === 0" class="block h-full flex-1 bg-accented/50" />
  </div>
</template>
