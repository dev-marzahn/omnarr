<!--
  The VPN card's live state: the state, and while it
  is up the exit IP (display only) and the port state; the `.env` step when
  the layout doesn't match the choice; and the apply note after a save,
  which stays until the user closes it (`applyNote`, kept by the page). It
  never names gluetun's or qBittorrent's address or port.
-->
<script setup lang="ts">
import type { VpnRuntime } from '@omnarr/contracts';

import type { Note } from '~/lib/downloads';
import { vpnLine } from '~/lib/system';

const props = defineProps<{ runtime?: VpnRuntime }>();
const applyNote = defineModel<Note | undefined>('applyNote');

const line = computed(() => (props.runtime ? vpnLine(props.runtime) : undefined));
</script>

<template>
  <div class="space-y-3">
    <div class="flex flex-wrap items-center gap-x-2 gap-y-1 text-sm">
      <span class="font-semibold text-highlighted">State</span>
      <template v-if="line">
        <UBadge size="sm" variant="subtle" :color="line.badge.color" :label="line.badge.label" />
        <span class="text-xs text-muted">{{ line.line }}</span>
      </template>
      <span v-else class="text-xs text-muted">Not reported yet</span>
    </div>
    <p v-if="line?.step" class="text-sm text-warning">
      <UIcon name="i-lucide-triangle-alert" class="align-[-2px]" />
      <DownloadsCodeText :text="line.step" />
    </p>

    <UAlert v-if="applyNote" color="info" variant="subtle" icon="i-lucide-terminal" close @update:open="applyNote = undefined">
      <template #title><DownloadsCodeText :text="applyNote.title" /></template>
      <template #description><DownloadsCodeText :text="applyNote.description" /></template>
    </UAlert>
  </div>
</template>
