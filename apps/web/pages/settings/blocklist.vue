<!--
  Settings › Blocklist: every Work's blocked releases,
  each with its series or movie, protocol, reason and when it was added, and
  "Unblock release" behind a confirm. Unblocking grabs nothing. An entry from
  before the protocol was stored shows none.
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';
import type { SettingsBlocklistEntry } from '@omnarr/contracts';

import {
  BLOCKLIST_EMPTY,
  type BlocklistKindFilter,
  blocklistCapNote,
  blocklistFilters,
  blocklistRows,
  matchesBlocklistFilter,
  unblockConfirm,
} from '~/lib/blocklist';

const { data, error, isLoading } = useQuery(api.api.settings.blocklist, {});
const unblock = useMutation(api.api.settings.unblock);
const toast = useToast();

const filter = ref<string>('all');
const text = ref('');
const entries = computed(() => data.value ?? []);
const filters = computed(() => blocklistFilters(entries.value));
const shown = computed(() => entries.value.filter((entry) => matchesBlocklistFilter(entry, filter.value as BlocklistKindFilter, text.value)));
const added = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const rows = computed(() => blocklistRows(shown.value, added.format));
const capNote = computed(() => blocklistCapNote(entries.value.length));

const chosen = ref<SettingsBlocklistEntry>();
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
  <UDashboardPanel>
    <template #header>
      <PageHeader title="Blocklist" />
    </template>
    <template #body>
      <PageBody>
        <UAlert
          v-if="error"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          title="The blocklist couldn't be loaded."
          :description="error.message"
        />
        <template v-else>
          <p class="text-sm text-muted">A blocked release is never picked again for that series or movie. Entries apply per title, not across the library.</p>
          <template v-if="isLoading">
            <USkeleton v-for="i in 3" :key="i" class="h-16 w-full" />
          </template>
          <template v-else-if="data">
            <UEmpty v-if="entries.length === 0" icon="i-lucide-circle-slash" :title="BLOCKLIST_EMPTY.title" :description="BLOCKLIST_EMPTY.description" />
            <template v-else>
              <div class="flex flex-col gap-3 sm:flex-row sm:items-center">
                <ResponsiveFilter v-model="filter" :items="filters" class="flex-1" />
                <UInput v-model="text" icon="i-lucide-search" placeholder="Filter releases" size="sm" class="sm:w-60" aria-label="Filter releases" />
              </div>
              <ul v-if="rows.length" class="divide-y divide-default rounded-lg ring ring-default">
                <li v-for="row in rows" :key="row.entryId" class="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3 text-sm">
                  <div class="min-w-0 flex-1 space-y-1">
                    <p class="font-mono text-xs break-all text-highlighted">{{ row.title }}</p>
                    <p class="flex flex-wrap gap-x-3 gap-y-1 text-xs text-muted">
                      <NuxtLink :to="`/library/${row.workId}`" class="font-medium text-default hover:underline">{{ row.workTitle }}</NuxtLink>
                      <span v-if="row.protocol">{{ row.protocol }}</span>
                      <span class="text-default">{{ row.reason }}</span>
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
              <UEmpty v-else icon="i-lucide-filter-x" title="No entry matches" description="Change the filter to see the others." />
              <p v-if="capNote" class="text-xs text-muted">{{ capNote }}</p>
            </template>
          </template>
        </template>
      </PageBody>
    </template>
  </UDashboardPanel>

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
