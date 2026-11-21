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
    <div class="grid gap-3 sm:grid-cols-3" :class="disabled ? 'opacity-60' : ''">
      <label
        v-for="card in cards"
        :key="card.deviceId"
        class="rounded-lg border p-3 space-y-1 cursor-pointer"
        :class="devices.includes(card.deviceId) ? 'border-inverted ring-1 ring-inverted' : 'border-default'"
      >
        <div class="flex items-center gap-2">
          <UIcon :name="ICON[card.deviceId]" />
          <span class="font-medium flex-1">{{ card.name }}</span>
          <UCheckbox
            :model-value="devices.includes(card.deviceId)"
            :disabled="disabled"
            @update:model-value="devices = toggleDevice(devices, card.deviceId, $event === true)"
          />
        </div>
        <p class="text-xs text-muted">{{ card.subtitle }}</p>
        <p v-for="line in deviceLines(card)" :key="line" class="text-xs text-dimmed">{{ line }}</p>
      </label>
    </div>
    <p v-if="disabled" class="mt-2 text-xs text-muted">The target is edited directly. "Reset to devices" makes it follow the ticked devices again.</p>
  </div>
</template>
