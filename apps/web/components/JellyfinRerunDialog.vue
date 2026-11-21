<!--
  "Set up Jellyfin again": the first run's password is gone, so the admin
  enters it again. A jellyfinSetupNeeded or jellyfinPasswordNotPushed
  Issue's fix opens it, on the Issues page and on System's Jellyfin card
  (`jellyfinActions`).
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';

import { RERUN_PROMPT, rerunErrorText } from '~/lib/system';

const open = defineModel<boolean>('open', { required: true });
const rerun = useAction(api.api.jellyfin.rerunSetup);

const password = ref('');
const error = ref<string>();
const running = ref(false);

watch(open, (value) => {
  if (value) {
    password.value = '';
    error.value = undefined;
  }
});

async function submit() {
  running.value = true;
  error.value = undefined;
  try {
    const result = await rerun({ password: password.value });
    if ('error' in result) error.value = rerunErrorText(result.error);
    else open.value = false;
  } catch {
    error.value = "The setup couldn't be started.";
  } finally {
    running.value = false;
    password.value = '';
  }
}
</script>

<template>
  <UModal v-model:open="open" title="Re-run Jellyfin setup">
    <template #body>
      <form id="jellyfin-rerun" class="space-y-3" @submit.prevent="submit">
        <p class="text-sm">{{ RERUN_PROMPT }}</p>
        <UFormField label="Platform password">
          <UInput v-model="password" type="password" autocomplete="current-password" class="w-full" />
        </UFormField>
        <UAlert v-if="error" color="error" variant="subtle" :title="error" />
      </form>
    </template>
    <template #footer>
      <UButton color="neutral" variant="ghost" label="Cancel" @click="open = false" />
      <UButton type="submit" form="jellyfin-rerun" label="Re-run setup" :loading="running" :disabled="!password" />
    </template>
  </UModal>
</template>
