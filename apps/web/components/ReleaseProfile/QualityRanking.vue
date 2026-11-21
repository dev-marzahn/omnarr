<!-- Ranked qualities: equal ranks form a group; move a quality up or down, allow or disallow it. -->
<script setup lang="ts">
import type { QualityEntry, QualityId } from '@omnarr/contracts';

import { qualityLabel } from '~/lib/labels';
import { moveQuality, rankedGroups, setAllowed } from '~/lib/releaseProfiles';

const qualities = defineModel<QualityEntry[]>({ required: true });
const groups = computed(() => rankedGroups(qualities.value));
const move = (quality: QualityId, direction: 'up' | 'down') => (qualities.value = moveQuality(qualities.value, quality, direction));
const allow = (quality: QualityId, allowed: boolean | 'indeterminate') => (qualities.value = setAllowed(qualities.value, quality, allowed === true));
</script>

<template>
  <ol class="space-y-2">
    <li v-for="(group, i) in groups" :key="i" class="border border-default rounded-md p-2 space-y-1" :class="group[0]?.allowed ? '' : 'opacity-60'">
      <p class="text-xs text-muted">{{ group[0]?.allowed ? `Rank ${group[0].rank}` : 'Not allowed' }}</p>
      <div v-for="entry in group" :key="entry.quality" class="flex items-center gap-2 text-sm">
        <UCheckbox :model-value="entry.allowed" @update:model-value="allow(entry.quality, $event)" />
        <span class="flex-1">{{ qualityLabel(entry.quality) }}</span>
        <template v-if="entry.allowed">
          <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-arrow-up" aria-label="Up" @click="move(entry.quality, 'up')" />
          <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-arrow-down" aria-label="Down" @click="move(entry.quality, 'down')" />
        </template>
      </div>
    </li>
  </ol>
</template>
