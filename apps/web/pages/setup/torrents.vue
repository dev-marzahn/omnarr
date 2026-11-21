<!--
  Torrents (optional): the TorrentSettingsForm and VpnForm, with the VPN layout's .env step. Skip saves torrents off.
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';

definePageMeta({ layout: 'setup', step: 'torrents' });

const { data } = useQuery(api.api.downloadClients.get, {});
const saveTorrents = useMutation(api.api.downloadClients.saveTorrents);
const advance = useAdvance();
const pending = ref(false);

async function skip() {
  if (!data.value) return;
  pending.value = true;
  try {
    await saveTorrents({ input: { enabled: false, seedGoal: data.value.torrents.seedGoal } });
    await advance('devices');
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <div>
      <h1 class="text-xl font-bold text-highlighted">Torrents <span class="text-sm font-normal text-muted">optional</span></h1>
      <p class="text-sm text-muted">qBittorrent downloads torrents and seeds each one until its goal is met. Torrent traffic can go through a VPN.</p>
    </div>
    <template v-if="data">
      <UCard>
        <DownloadsTorrentSettingsForm :torrents="data.torrents" :vpn="data.vpn" />
      </UCard>
      <UCard v-if="data.torrents.enabled">
        <DownloadsVpnForm :vpn="data.vpn" />
      </UCard>
    </template>
    <div class="flex items-center gap-2 max-lg:flex-col-reverse max-lg:items-stretch">
      <UButton color="neutral" variant="link" to="/setup/usenet" icon="i-lucide-arrow-left" label="Back" />
      <UButton class="lg:ms-auto max-lg:justify-center" color="neutral" variant="outline" :loading="pending" label="Skip torrents" @click="skip" />
      <UButton class="max-lg:justify-center" :disabled="!data?.torrents.enabled" label="Continue" @click="advance('devices')" />
    </div>
  </div>
</template>
