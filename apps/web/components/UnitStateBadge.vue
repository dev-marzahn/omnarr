<!-- One derived Unit state as a badge, optionally with a count. -->
<script setup lang="ts">
import type { UnitState } from '@omnarr/contracts';

import { countLabel, STATE_LOOK } from '~/lib/unitStates';

const props = defineProps<{ state: UnitState; count?: number; size?: 'sm' | 'md' }>();
const look = computed(() => STATE_LOOK[props.state]);
</script>

<template>
  <UBadge
    :color="look.color"
    :variant="look.variant"
    :size="size ?? 'md'"
    :icon="look.icon"
    :ui="look.spin ? { leadingIcon: 'animate-spin' } : undefined"
    :label="count === undefined ? look.label : countLabel(state, count)"
  />
</template>
