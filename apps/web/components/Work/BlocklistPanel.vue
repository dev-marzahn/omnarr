<!--
  The series Work page's Blocklist tab: the Work's blocked releases, each
  with its episode, reason and the run that added it, and "Unblock release"
  behind a confirm. Unblocking grabs nothing; "Retry this release" stays on
  the Issue.
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';
import type { BlocklistEntry } from '@omnarr/contracts';

import { blocklistRows, unblockConfirm } from '~/lib/library';

const props = defineProps<{ entries: BlocklistEntry[] }>();
const toast = useToast();
const unblock = useMutation(api.api.library.unblock);
const added = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const rows = computed(() => blocklistRows(props.entries, added.format));

const chosen = ref<BlocklistEntry>();
const open = computed({
  get: () => chosen.value !== undefined,
  set: (value) => {
    if (!value) chosen.value = undefined;
  },
});
const confirm = computed(() => (chosen.value ? unblockConfirm(chosen.value) : undefined));
const busy = ref(false);
async function onUnblock() {
  if (!chosen.value) return;
  busy.value = true;
  try {
    await unblock({ entryId: chosen.value.entryId });
    chosen.value = undefined;
    toast.add({ title: 'Removed from the blocklist', color: 'success', icon: 'i-lucide-circle-slash' });
  } catch {
    toast.add({ title: "The release couldn't be unblocked", description: 'Try again.', color: 'error', icon: 'i-lucide-triangle-alert' });
  } finally {
    busy.value = false;
  }
}
</script>

<template>
  <UEmpty
    v-if="rows.length === 0"
    icon="i-lucide-circle-slash"
    title="No blocked releases"
    description="Failed releases are added here automatically when omnarr tries the next-best one."
  />
  <template v-else>
    <p class="text-sm text-muted">Releases here are never grabbed again for this series. Other titles aren't affected.</p>
    <ul class="divide-y divide-default rounded-lg ring ring-default">
      <li v-for="row in rows" :key="row.entryId" class="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 text-sm">
        <div class="min-w-0 flex-1 space-y-1">
          <p class="font-mono text-xs break-all text-highlighted">{{ row.title }}</p>
          <p class="flex flex-wrap gap-x-3 text-xs text-muted">
            <span v-if="row.episode" class="tabular-nums">{{ row.episode }}</span>
            <span class="text-default">{{ row.reason }}</span>
            <span class="font-mono">{{ row.source }}</span>
            <span class="tabular-nums">{{ row.added }}</span>
          </p>
        </div>
        <UButton
          size="xs"
          color="neutral"
          variant="ghost"
          icon="i-lucide-circle-slash"
          label="Unblock release"
          @click="chosen = entries.find((e) => e.entryId === row.entryId)"
        />
      </li>
    </ul>
  </template>

  <UModal v-if="confirm" v-model:open="open" :title="confirm.title">
    <template #body>
      <div class="space-y-2 text-sm">
        <p class="font-mono text-xs break-all text-highlighted">{{ chosen?.title }}</p>
        <p>{{ confirm.description }}</p>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" label="Cancel" @click="open = false" />
        <UButton icon="i-lucide-circle-slash" label="Unblock" :loading="busy" @click="onUnblock" />
      </div>
    </template>
  </UModal>
</template>
