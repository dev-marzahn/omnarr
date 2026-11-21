<!-- The group lists the tier formats match, case-insensitively. One name per line. -->
<script setup lang="ts">
import type { GroupTier } from '@omnarr/contracts';

import { groupTierLabel } from '~/lib/labels';

const tiers = defineModel<GroupTier[]>({ required: true });
const text = (tier: GroupTier) => tier.groups.join('\n');
function setText(formatId: string, value: string) {
  const groups = value
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  tiers.value = tiers.value.map((tier) => (tier.formatId === formatId ? { ...tier, groups } : tier));
}
</script>

<template>
  <div class="grid gap-3 sm:grid-cols-2">
    <UFormField v-for="tier in tiers" :key="tier.formatId" :label="`${groupTierLabel(tier.formatId)} (${tier.groups.length})`">
      <UTextarea :model-value="text(tier)" :rows="4" class="w-full font-mono text-xs" @update:model-value="setText(tier.formatId, String($event))" />
    </UFormField>
  </div>
</template>
