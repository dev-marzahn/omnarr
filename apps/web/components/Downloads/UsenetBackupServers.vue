<!--
  The Usenet card's backup servers: each one is a UsenetProviderForm with
  its own "Test login" and Save, and a Remove. Each sits at its priority
  (NZBGet's level 1–9) below the main server (level 0), so NZBGet asks them
  only for articles the main server is missing. A new one gets its id here, so its test can name it
  before the first save. Adding needs the main server saved first.
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';
import type { DownloadClientsDetail } from '@omnarr/contracts';

import { newId } from '~/lib/browser';

const props = defineProps<{ usenet: DownloadClientsDetail['usenet']; workerConnected: boolean }>();
const emit = defineEmits<{ saved: []; removed: [] }>();

const removeUsenetBackup = useMutation(api.api.downloadClients.removeUsenetBackup);

/** Backup servers added on this page. A saved one stays here, hidden by its stored entry, so its form never blinks out before the query updates. */
const drafts = ref<string[]>([]);
const removing = ref<string>();
const error = ref<string>();

const entries = computed(() => [
  ...props.usenet.backupServers.map((server) => ({ id: server.id, server })),
  ...drafts.value.filter((id) => !props.usenet.backupServers.some((server) => server.id === id)).map((id) => ({ id, server: undefined })),
]);

function add() {
  drafts.value = [...drafts.value, newId()];
}

async function remove(id: string, saved: boolean) {
  error.value = undefined;
  drafts.value = drafts.value.filter((draft) => draft !== id);
  if (!saved) return;
  removing.value = id;
  try {
    await removeUsenetBackup({ backupId: id });
    emit('removed');
  } catch {
    error.value = "The backup server couldn't be removed. Try again.";
  } finally {
    removing.value = undefined;
  }
}
</script>

<template>
  <div class="space-y-4">
    <div class="flex flex-wrap items-start gap-3">
      <div class="flex-1 min-w-48">
        <h3 class="text-sm font-medium">Backup servers</h3>
        <p class="text-xs text-muted">
          Optional. NZBGet asks them only for articles the main server is missing, such as ones taken down: priority 1 first, then 2, and so on. Servers with
          the same priority share the work.
        </p>
      </div>
      <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-plus" label="Add backup server" :disabled="!usenet.server" @click="add" />
    </div>
    <p v-if="!usenet.server" class="text-xs text-muted">Save the main server first.</p>
    <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-triangle-alert" :title="error" />
    <div v-for="entry in entries" :key="entry.id" class="rounded-md border border-default p-4">
      <DownloadsUsenetProviderForm :usenet="usenet" :worker-connected="workerConnected" :backup="entry" @saved="emit('saved')">
        <template #actions>
          <UButton
            color="error"
            variant="ghost"
            icon="i-lucide-trash"
            label="Remove"
            :loading="removing === entry.id"
            @click="remove(entry.id, entry.server !== undefined)"
          />
        </template>
      </DownloadsUsenetProviderForm>
    </div>
  </div>
</template>
