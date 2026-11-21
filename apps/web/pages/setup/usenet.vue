<!--
  The Usenet provider: the UsenetProviderForm, with "Test login" and the applied state; saving moves on. A provider already
  saved (in Settings, or on an earlier visit) moves on without a new save.
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';

import { COPY, usenetSaved } from '~/lib/firstRun';

definePageMeta({ layout: 'setup', step: 'usenet' });

const { data } = useQuery(api.api.downloadClients.get, {});
const { data: status } = useQuery(api.api.system.status, {});
const workerConnected = computed(() => status.value?.worker?.connected === true && status.value.worker.accepted);
const advance = useAdvance();
</script>

<template>
  <div class="flex flex-col gap-6">
    <div>
      <h1 class="text-xl font-bold text-highlighted">Usenet provider</h1>
      <p class="text-sm text-muted">The server NZBGet downloads from. {{ COPY.usenetHint }}</p>
    </div>
    <UCard v-if="data">
      <DownloadsUsenetProviderForm :usenet="data.usenet" :worker-connected="workerConnected" submit-label="Save and continue" @saved="advance('torrents')" />
    </UCard>
    <div class="flex items-center gap-2 max-lg:flex-col-reverse max-lg:items-stretch">
      <UButton color="neutral" variant="link" to="/setup/indexer" icon="i-lucide-arrow-left" label="Back" />
      <UButton
        v-if="data && usenetSaved(data.usenet)"
        class="lg:ms-auto max-lg:justify-center"
        color="neutral"
        variant="outline"
        label="Continue with the saved provider"
        @click="advance('torrents')"
      />
    </div>
  </div>
</template>
