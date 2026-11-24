<!--
  Settings › Downloads: the Usenet provider (with its
  backup servers), Torrents and VPN cards. No client's WebUI, address or
  port is shown or linked; qBittorrent's peer port and the VPN's forwarded
  port are the only ports shown, read-only.
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';

import { type Note, vpnApplyNote } from '~/lib/downloads';

const toast = useToast();
const { data, error } = useQuery(api.api.downloadClients.get, {});
const { data: status } = useQuery(api.api.system.status, {});
const workerConnected = computed(() => status.value?.worker?.connected === true && status.value.worker.accepted);

const usenetToasts = useUsenetToasts();

function onTorrentsSaved() {
  toast.add({
    title: 'Saved the torrent settings',
    description: 'The worker applies them within 30 seconds.',
    icon: 'i-lucide-circle-check',
    color: 'success',
  });
}

/** The apply note, from the choice saved and the runtime seen at the save; closing it clears it. */
const applyNote = ref<Note>();

function onVpnSaved(chosen: boolean) {
  applyNote.value = vpnApplyNote(chosen, data.value?.vpn.runtime);
  toast.add({ title: 'Saved the VPN settings', icon: 'i-lucide-circle-check', color: 'success' });
}
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <PageHeader title="Downloads" />
    </template>
    <template #body>
      <PageBody>
        <p class="text-sm text-muted">omnarr writes these settings into its download clients. You won't need to open them.</p>

        <UAlert v-if="error" color="error" variant="subtle" title="The download settings couldn't be loaded." :description="error.message" />
        <template v-else-if="data">
          <Section title="Usenet provider" description="Your news server's login. NZBGet downloads with it.">
            <UCard>
              <DownloadsUsenetProviderForm :usenet="data.usenet" :worker-connected="workerConnected" @saved="usenetToasts.providerSaved" />
              <template #footer>
                <DownloadsUsenetBackupServers
                  :usenet="data.usenet"
                  :worker-connected="workerConnected"
                  @saved="usenetToasts.backupSaved"
                  @removed="usenetToasts.backupRemoved"
                />
              </template>
            </UCard>
          </Section>
          <Section title="Torrents" description="qBittorrent downloads torrents and seeds each one until its goal is met.">
            <UCard>
              <DownloadsTorrentSettingsForm :torrents="data.torrents" :vpn="data.vpn" @saved="onTorrentsSaved" />
            </UCard>
          </Section>
          <Section title="VPN" description="Torrent traffic can go through a VPN. Usenet doesn't use it.">
            <UCard>
              <template #header>
                <DownloadsVpnStatus v-model:apply-note="applyNote" :runtime="data.vpn.runtime" />
              </template>
              <DownloadsVpnForm :vpn="data.vpn" @saved="onVpnSaved" />
            </UCard>
          </Section>
        </template>
      </PageBody>
    </template>
  </UDashboardPanel>
</template>
