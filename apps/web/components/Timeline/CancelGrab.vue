<!--
  "Cancel grab" with its confirm and the blocklist choice, on a
  run's header, the item page's progress card and a Work page row (which
  opens it through `open` and hides the button). Runs units.cancelGrab.
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';
import type { Id } from '@omnarr/backend/dataModel';

const props = defineProps<{ grabId: Id<'grabs'>; hideButton?: boolean }>();
const toast = useToast();
const cancelGrab = useMutation(api.api.units.cancelGrab);
const confirming = defineModel<boolean>('open', { default: false });
const blocklist = ref(false);
const cancelling = ref(false);
async function cancel() {
  cancelling.value = true;
  try {
    await cancelGrab({ grabId: props.grabId, blocklist: blocklist.value });
    confirming.value = false;
  } catch {
    toast.add({ title: "The grab couldn't be cancelled", description: 'Try again.', color: 'error', icon: 'i-lucide-triangle-alert' });
  } finally {
    cancelling.value = false;
  }
}
</script>

<template>
  <UButton v-if="!hideButton" size="xs" color="neutral" variant="outline" icon="i-lucide-x" label="Cancel grab" @click="confirming = true" />
  <UModal v-model:open="confirming" title="Cancel this grab?">
    <template #body>
      <p class="text-sm">The download is removed from the client. A release that isn't blocklisted can be picked again by the next search.</p>
      <UCheckbox v-model="blocklist" label="Also blocklist this release" class="mt-3" />
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" label="Keep it" @click="confirming = false" />
        <UButton color="error" label="Cancel grab" :loading="cancelling" @click="cancel" />
      </div>
    </template>
  </UModal>
</template>
