<!--
  The Torrents form: the "Use torrents" switch, the seeding goal (a ratio
  and a number of days, at least one; an empty field is no limit on it),
  the applied state, the read-only peer port and qBittorrent's connection
  status. It never names qBittorrent's address or
  WebUI port; the peer port is the one port it shows. The first run's
  torrents step reuses it: pass `submitLabel` and listen for `saved`.
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';
import type { DownloadClientsDetail } from '@omnarr/contracts';

import {
  connectionStatusText,
  GOAL_CHANGE_TEXT,
  peerPortText,
  seedGoalFromValues,
  seedGoalValues,
  seedingSummary,
  TORRENTS_OFF_TEXT,
  torrentsConfigStateText,
} from '~/lib/downloads';

const props = withDefaults(
  defineProps<{
    torrents: DownloadClientsDetail['torrents'];
    /** The VPN choice and its runtime: through a VPN, the peer port shown is the forwarded one. */
    vpn?: Pick<DownloadClientsDetail['vpn'], 'kind' | 'runtime'>;
    submitLabel?: string;
  }>(),
  { submitLabel: 'Save', vpn: undefined },
);
const emit = defineEmits<{ saved: [] }>();

const saveTorrents = useMutation(api.api.downloadClients.saveTorrents);

const state = reactive({ enabled: props.torrents.enabled, ...seedGoalValues(props.torrents.seedGoal) });

const parsed = computed(() => seedGoalFromValues({ ratio: state.ratio ?? null, days: state.days ?? null }));
const goalError = computed(() => ('error' in parsed.value ? parsed.value.error : undefined));
const saving = ref(false);
const error = ref<string>();

const peerPort = computed(() => peerPortText(props.torrents.peerPort, props.vpn?.runtime, props.vpn?.kind));
const connection = computed(() => connectionStatusText(props.torrents.connectionStatus));
// The seeding progress: "Seeding 3 torrents · 4.2 GB uploaded".
const seedingText = computed(() => seedingSummary(props.torrents.seeding));

async function save() {
  const result = parsed.value;
  if ('error' in result) return;
  saving.value = true;
  error.value = undefined;
  try {
    await saveTorrents({ input: { enabled: state.enabled, seedGoal: result.goal } });
    emit('saved');
  } catch {
    error.value = "The torrent settings couldn't be saved. Try again.";
  } finally {
    saving.value = false;
  }
}

/** The applied-state line's clock, ticking every 30 s. */
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  timer = setInterval(() => (now.value = Date.now()), 30_000);
});
onBeforeUnmount(() => clearInterval(timer));
</script>

<template>
  <UForm :state="state" class="divide-y divide-default [&>*]:py-4 [&>*:first-child]:pt-0 [&>*:last-child]:pb-0" @submit="save">
    <div class="flex items-start gap-4">
      <div class="flex-1">
        <p class="text-sm font-medium text-highlighted">Use torrents</p>
        <p class="text-xs text-muted">{{ TORRENTS_OFF_TEXT }}</p>
      </div>
      <USwitch v-model="state.enabled" aria-label="Use torrents" />
    </div>

    <div class="flex flex-wrap items-start gap-4" role="group" aria-label="Seeding goal">
      <div class="flex-1 min-w-48">
        <p class="text-sm font-medium text-highlighted">Seeding goal</p>
        <p class="text-xs text-muted">Seeding stops at whichever comes first. Leave a field empty for no limit on it. {{ GOAL_CHANGE_TEXT }}</p>
        <p v-if="goalError" class="mt-1 text-sm text-error">{{ goalError }}</p>
      </div>
      <div class="flex gap-3">
        <UFormField label="Ratio" name="ratio" class="w-36">
          <UInputNumber v-model="state.ratio" :min="0" :step="0.1" placeholder="No limit" class="w-full" />
        </UFormField>
        <UFormField label="Days" name="days" class="w-36">
          <UInputNumber v-model="state.days" :min="0" :step="1" placeholder="No limit" class="w-full" />
        </UFormField>
      </div>
    </div>

    <div class="flex items-start gap-4">
      <div class="flex-1">
        <p class="text-sm font-medium text-highlighted">Peer port</p>
        <p v-if="peerPort.hint" class="text-xs text-muted">{{ peerPort.hint }}</p>
      </div>
      <span class="text-sm tabular-nums" :class="/^\d+$/.test(peerPort.value) ? 'font-mono text-highlighted' : 'text-muted'">{{ peerPort.value }}</span>
    </div>

    <div class="flex items-start gap-4">
      <div class="flex-1">
        <p class="text-sm font-medium text-highlighted">Connection</p>
        <p
          v-if="connection.description"
          class="text-xs"
          :class="connection.color === 'warning' ? 'text-warning' : connection.color === 'error' ? 'text-error' : 'text-muted'"
        >
          {{ connection.description }}
        </p>
      </div>
      <UBadge size="sm" variant="subtle" :color="connection.color" :label="connection.label" />
    </div>

    <div v-if="seedingText" class="flex items-center gap-2 text-sm">
      <UIcon name="i-lucide-arrow-up-circle" class="size-4 shrink-0 text-success" />
      <span class="tabular-nums text-highlighted">{{ seedingText }}</span>
    </div>

    <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-triangle-alert" :title="error" />

    <div class="flex items-center gap-2">
      <p class="flex-1 text-xs text-muted">{{ torrentsConfigStateText(torrents, now) }}</p>
      <slot name="actions" />
      <UButton type="submit" :label="submitLabel" :loading="saving" :disabled="goalError !== undefined" />
    </div>
  </UForm>
</template>
