<!--
  The VPN form: "No VPN" or "Use a VPN", the kind, the config file (pasted
  or uploaded) for the file kinds, the credentials, countries (regions for
  PIA) and the optional static forwarded port. The secrets are never sent
  to the page: a stored one shows "Stored", and a blank field keeps it. A
  refused save shows the server's reason. It never names gluetun's or
  qBittorrent's address or port. The first run's torrents step reuses it:
  pass `submitLabel` and listen for `saved`, which carries whether a VPN
  was chosen, for the apply note.
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';
import type { DownloadClientsDetail } from '@omnarr/contracts';

import { VPN_KINDS, vpnFields, vpnFormValues, vpnSaveErrorText, vpnSaveInput, vpnStoredSecrets } from '~/lib/downloads';

const props = withDefaults(defineProps<{ vpn: DownloadClientsDetail['vpn']; submitLabel?: string }>(), { submitLabel: 'Save' });
const emit = defineEmits<{ saved: [chosen: boolean] }>();

const saveVpn = useMutation(api.api.downloadClients.saveVpn);

const { useVpn, ...initial } = vpnFormValues(props.vpn);
const state = reactive({ ...initial, choice: useVpn ? 'vpn' : 'none' });
const choices = [
  { value: 'none', label: 'No VPN', description: 'Torrents connect directly.' },
  { value: 'vpn', label: 'Use a VPN', description: 'Torrent traffic goes only through the VPN, and stops when it is down.' },
];

const fields = computed(() => vpnFields(state.kind));
const stored = computed(() => vpnStoredSecrets(props.vpn, state.kind));
const parsed = computed(() => vpnSaveInput({ ...state, useVpn: state.choice === 'vpn', staticPort: state.staticPort ?? null }));
const formError = computed(() => ('error' in parsed.value ? parsed.value.error : undefined));
const saving = ref(false);
const error = ref<string>();

const fileInput = ref<HTMLInputElement>();
const fileName = ref<string>();

async function readFile(event: Event) {
  const file = (event.target as HTMLInputElement).files?.[0];
  if (!file) return;
  state.config = await file.text();
  fileName.value = file.name;
  (event.target as HTMLInputElement).value = '';
}

async function save() {
  const result = parsed.value;
  if ('error' in result) return;
  saving.value = true;
  error.value = undefined;
  try {
    await saveVpn({ input: result.input });
    Object.assign(state, { config: '', username: '', password: '', privateKey: '' });
    fileName.value = undefined;
    emit('saved', result.input !== null);
  } catch (e) {
    error.value = vpnSaveErrorText(e);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <UForm :state="state" class="space-y-4" @submit="save">
    <URadioGroup v-model="state.choice" :items="choices" />

    <template v-if="state.choice === 'vpn'">
      <UFormField label="VPN" name="kind" class="max-w-64">
        <USelect v-model="state.kind" :items="VPN_KINDS" class="w-full" />
      </UFormField>

      <UFormField v-if="fields.config" :label="fields.config.label" name="config" :help="fields.config.hint">
        <UTextarea
          v-model="state.config"
          :rows="6"
          autocomplete="off"
          spellcheck="false"
          :placeholder="stored.config ? 'Stored' : 'Paste the file here, or upload it.'"
          class="w-full font-mono text-xs"
        />
        <div class="mt-2 flex items-center gap-2">
          <UButton color="neutral" variant="outline" size="sm" icon="i-lucide-upload" label="Upload file" @click="fileInput?.click()" />
          <span v-if="fileName" class="text-xs text-muted">{{ fileName }}</span>
          <input ref="fileInput" type="file" :accept="fields.config.accept" class="hidden" @change="readFile" />
        </div>
      </UFormField>

      <UFormField v-if="fields.privateKey" :label="fields.privateKey.label" name="privateKey" :help="fields.privateKey.hint">
        <UInput v-model="state.privateKey" type="password" autocomplete="off" :placeholder="stored.config ? 'Stored' : ''" class="w-full font-mono" />
      </UFormField>

      <div v-if="fields.credentials" class="space-y-1">
        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField label="Username" name="username">
            <UInput v-model="state.username" autocomplete="off" :placeholder="stored.credentials ? 'Stored' : ''" class="w-full" />
          </UFormField>
          <UFormField label="Password" name="password">
            <UInput v-model="state.password" type="password" autocomplete="off" :placeholder="stored.credentials ? 'Stored' : ''" class="w-full" />
          </UFormField>
        </div>
        <p class="text-xs text-muted">{{ fields.credentials.hint }}</p>
      </div>

      <UFormField v-if="fields.countries" :label="fields.countries.label" name="countries" :help="fields.countries.hint">
        <UInput v-model="state.countries" autocomplete="off" class="w-full" />
      </UFormField>

      <UFormField :label="fields.staticPort.label" name="staticPort" :help="fields.staticPort.hint" class="max-w-64">
        <UInputNumber v-model="state.staticPort" :min="1" :max="65535" :format-options="{ useGrouping: false }" placeholder="None" class="w-full" />
      </UFormField>
      <p v-if="formError" class="text-sm text-error">{{ formError }}</p>
    </template>

    <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-triangle-alert" :title="error" />

    <div class="flex items-center justify-end gap-2 border-t border-default pt-4">
      <slot name="actions" />
      <UButton type="submit" :label="submitLabel" :loading="saving" :disabled="formError !== undefined" />
    </div>
  </UForm>
</template>
