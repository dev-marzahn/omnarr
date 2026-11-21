<!--
  "Delete series…" and "Delete movie…": what leaves
  omnarr, the downloads that are cancelled, and the files, which stay on
  disk unless "Also delete files from disk" is ticked. Typing the title
  enables the confirm. Calls library.deleteWork(workId, { deleteFiles }),
  then goes back to the library.
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';
import type { Id } from '@omnarr/backend/dataModel';

import { deleteConfirmed, deleteWorkDialog, type DeleteWorkFacts } from '~/lib/library';

const props = defineProps<{ workId: Id<'works'>; facts: Omit<DeleteWorkFacts, 'deleteFiles'>; back: string }>();
const open = defineModel<boolean>('open', { default: false });
const toast = useToast();
const deleteWork = useMutation(api.api.library.deleteWork);
const deleteFiles = ref(false);
const typed = ref('');
const dialog = computed(() => deleteWorkDialog({ ...props.facts, deleteFiles: deleteFiles.value }));
const deleting = ref(false);
async function onDelete() {
  deleting.value = true;
  try {
    await deleteWork({ workId: props.workId, deleteFiles: deleteFiles.value });
    open.value = false;
    toast.add({ title: `${props.facts.title} is being deleted`, color: 'success', icon: 'i-lucide-trash' });
    await navigateTo(props.back);
  } catch {
    toast.add({ title: dialog.value.failure, description: 'Try again.', color: 'error', icon: 'i-lucide-triangle-alert' });
  } finally {
    deleting.value = false;
  }
}
</script>

<template>
  <UModal v-model:open="open" :title="dialog.title" :description="dialog.subtitle">
    <template #body>
      <div class="space-y-3 text-sm">
        <div v-if="dialog.downloads" class="rounded-md bg-elevated px-3 py-2">
          <p class="font-semibold text-highlighted">{{ dialog.downloads.title }}</p>
          <p class="text-muted">{{ dialog.downloads.description }}</p>
        </div>
        <div v-if="dialog.files" class="rounded-md bg-elevated px-3 py-2 space-y-2">
          <p class="font-semibold text-highlighted">{{ dialog.files.title }}</p>
          <p class="text-muted">{{ dialog.files.description }}</p>
          <UCheckbox v-model="deleteFiles" label="Also delete files from disk" :description="dialog.deleteFilesHelp" />
        </div>
        <p v-if="dialog.blocklist" class="text-muted">{{ dialog.blocklist }}</p>
        <UFormField label="Type the title to confirm" :help="facts.title">
          <UInput v-model="typed" class="w-full" autocomplete="off" />
        </UFormField>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" label="Cancel" @click="open = false" />
        <UButton
          color="error"
          icon="i-lucide-trash"
          :label="dialog.confirm"
          :loading="deleting"
          :disabled="!deleteConfirmed(typed, facts.title)"
          @click="onDelete"
        />
      </div>
    </template>
  </UModal>
</template>
