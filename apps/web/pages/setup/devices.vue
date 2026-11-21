<!--
  Devices: the device cards for both libraries, then
  `playback.setupDefaults`, and the metadata language from the browser's
  locale (`setup.saveLanguage`).
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';
import { DEFAULT_DEVICES, type DeviceId } from '@omnarr/contracts';

definePageMeta({ layout: 'setup', step: 'devices' });

const { data: series } = useQuery(api.api.library.list, { kind: 'series' });
const libraryId = computed(() => series.value?.library?.libraryId);
const { data: detail } = useQuery(api.api.playback.get, () => (libraryId.value ? { libraryId: libraryId.value } : 'skip'));
const devices = ref<DeviceId[]>([...DEFAULT_DEVICES]);
const language = ref(navigator.language || 'en-US');
const setupDefaults = useMutation(api.api.playback.setupDefaults);
const saveLanguage = useMutation(api.api.setup.saveLanguage);
const advance = useAdvance();
const pending = ref(false);

async function next() {
  pending.value = true;
  try {
    await setupDefaults({ devices: devices.value });
    await saveLanguage({ language: language.value.trim() || 'en-US' });
    await advance('metadata');
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <div>
      <h1 class="text-xl font-bold text-highlighted">Devices you watch on</h1>
      <p class="text-sm text-muted">omnarr prepares each file so these devices play it directly. You can change this later in Settings › Playback.</p>
    </div>
    <UCard>
      <PlaybackDeviceCards v-if="detail" v-model="devices" :cards="detail.devicesAvailable" />
      <UFormField class="mt-4" label="Metadata language" help="Titles and overviews from TMDB come in this language (a code like de-DE).">
        <UInput v-model="language" class="w-full sm:w-48" />
      </UFormField>
    </UCard>
    <div class="flex items-center gap-2 max-lg:flex-col-reverse max-lg:items-stretch">
      <UButton color="neutral" variant="link" to="/setup/torrents" icon="i-lucide-arrow-left" label="Back" />
      <UButton class="lg:ms-auto max-lg:justify-center" :disabled="devices.length === 0" :loading="pending" label="Continue" @click="next" />
    </div>
  </div>
</template>
