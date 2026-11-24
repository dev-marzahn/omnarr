<!--
  The playback settings' "Devices you watch on": one card per device of the table, ticked
  or not. The target follows the ticked devices in devices mode; after "Edit
  directly" the cards wait until "Reset to devices".
-->
<script setup lang="ts">
import type { DeviceCard, DeviceId } from '@omnarr/contracts';

import { deviceLines, toggleDevice } from '~/lib/playback';

defineProps<{ cards: DeviceCard[]; disabled?: boolean }>();
const devices = defineModel<DeviceId[]>({ required: true });
const ICON: Record<DeviceId, string> = { chrome: 'i-lucide-monitor', jellyfinAndroid: 'i-lucide-smartphone', jellyfinFireTv: 'i-lucide-tv' };
</script>

<template>
  <div>
    <!-- Three columns only from lg: below it each card is too narrow for its codec lines. -->
    <div class="grid gap-3 lg:grid-cols-3" :class="disabled ? 'opacity-60' : ''">
      <label
        v-for="card in cards"
        :key="card.deviceId"
        class="min-w-0 rounded-lg border p-3 space-y-1 cursor-pointer"
        :class="devices.includes(card.deviceId) ? 'border-inverted ring-1 ring-inverted' : 'border-default'"
      >
        <div class="flex items-start gap-2">
          <UIcon :name="ICON[card.deviceId]" class="shrink-0 mt-1" />
          <span class="font-medium flex-1 min-w-0 break-words">{{ card.name }}</span>
          <UCheckbox
            class="shrink-0 mt-0.5"
            :model-value="devices.includes(card.deviceId)"
            :disabled="disabled"
            @update:model-value="devices = toggleDevice(devices, card.deviceId, $event === true)"
          />
        </div>
        <p class="text-xs text-muted break-words">{{ card.subtitle }}</p>
        <p v-for="line in deviceLines(card)" :key="line" class="text-xs text-dimmed break-words">{{ line }}</p>
      </label>
    </div>
    <p v-if="disabled" class="mt-2 text-xs text-muted">The target is edited directly. "Reset to devices" makes it follow the ticked devices again.</p>
  </div>
</template>
