<script setup lang="ts">
import { api } from '@omnarr/backend/api';

import { COPY, usenetSaved, usenetStepCanContinue, usenetStepLeadingButton } from '~/lib/firstRun';

definePageMeta({ layout: 'setup', step: 'usenet' });

const { data } = useQuery(api.api.downloadClients.get, {});
const { data: status } = useQuery(api.api.system.status, {});
const workerConnected = computed(() => status.value?.worker?.connected === true && status.value.worker.accepted);
const mainServerSaved = computed(() => data.value !== undefined && usenetSaved(data.value.usenet));
const mainServerUnsaved = ref(false);
const backupsUnsaved = ref(false);
const canContinue = computed(() => data.value !== undefined && usenetStepCanContinue(data.value.usenet, backupsUnsaved.value));
const continueLeads = computed(
  () =>
    data.value !== undefined &&
    usenetStepLeadingButton(data.value.usenet, { mainServerUnsaved: mainServerUnsaved.value, backupsUnsaved: backupsUnsaved.value }) === 'continue',
);
const advance = useAdvance();
const usenetToasts = useUsenetToasts();
</script>

<template>
  <div class="flex flex-col gap-6">
    <div>
      <h1 class="text-xl font-bold text-highlighted">Usenet provider</h1>
      <p class="text-sm text-muted">The server NZBGet downloads from. {{ COPY.usenetHint }}</p>
    </div>
    <UCard v-if="data">
      <DownloadsUsenetProviderForm
        :usenet="data.usenet"
        :worker-connected="workerConnected"
        :save-leads="!continueLeads"
        @unsaved="mainServerUnsaved = $event"
        @saved="usenetToasts.providerSaved"
      />
      <template v-if="mainServerSaved" #footer>
        <DownloadsUsenetBackupServers
          :usenet="data.usenet"
          :worker-connected="workerConnected"
          @saved="usenetToasts.backupSaved"
          @removed="usenetToasts.backupRemoved"
          @unsaved="backupsUnsaved = $event"
        />
      </template>
    </UCard>
    <div class="flex items-center gap-2 max-lg:flex-col-reverse max-lg:items-stretch">
      <UButton color="neutral" variant="link" to="/setup/indexer" icon="i-lucide-arrow-left" label="Back" />
      <UButton
        class="lg:ms-auto max-lg:justify-center"
        :color="continueLeads ? 'primary' : 'neutral'"
        :variant="continueLeads ? 'solid' : 'outline'"
        :disabled="!canContinue"
        label="Continue"
        @click="advance('torrents')"
      />
    </div>
  </div>
</template>
