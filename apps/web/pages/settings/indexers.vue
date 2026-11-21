<!--
  Settings › Indexers: the list with each indexer's
  health, and a drawer to add or edit one.
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';
import type { IndexerDetail } from '@omnarr/contracts';

import { kindLabel, removeConfirm } from '~/lib/indexers';

const toast = useToast();
const { data: rows, error } = useQuery(api.api.indexers.list, {});
const setEnabled = useMutation(api.api.indexers.setEnabled);
const remove = useMutation(api.api.indexers.remove);

const editing = ref<string | 'new'>();
const { data: detail } = useQuery(api.api.indexers.get, () =>
  editing.value && editing.value !== 'new' ? { id: editing.value as IndexerDetail['id'] } : 'skip',
);
const open = computed({
  get: () => editing.value !== undefined,
  set: (value) => {
    if (!value) editing.value = undefined;
  },
});

function onSaved(saved: IndexerDetail) {
  toast.add({ title: `Saved ${saved.name}`, icon: 'i-lucide-circle-check', color: 'success' });
  editing.value = undefined;
}

/** The row the Remove confirm is open for. */
const removing = ref<{ id: IndexerDetail['id']; name: string; hasKey: boolean }>();
const confirmRemove = computed({
  get: () => removing.value !== undefined,
  set: (value) => {
    if (!value) removing.value = undefined;
  },
});

async function onRemove() {
  const target = removing.value;
  removing.value = undefined;
  if (!target) return;
  await remove({ id: target.id });
  toast.add({ title: `Removed ${target.name}`, color: 'neutral' });
}
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <PageHeader title="Indexers" :actions="[{ label: 'Add indexer', icon: 'i-lucide-plus', primary: true, onClick: () => (editing = 'new') }]" />
    </template>
    <template #body>
      <PageBody>
        <p class="text-sm text-muted">
          Newznab and Torznab APIs, Nyaa, and the public sites of Prowlarr's definitions. The type, search modes and categories are read from each indexer.
        </p>

        <UAlert v-if="error" color="error" variant="subtle" title="The indexers couldn't be loaded." :description="error.message" />
        <UEmpty
          v-else-if="rows && rows.length === 0"
          icon="i-lucide-rss"
          title="No indexer yet"
          description="Add a Newznab or Torznab indexer, or Nyaa, to start searching."
          :actions="[{ label: 'Add indexer', icon: 'i-lucide-plus', onClick: () => (editing = 'new') }]"
        />
        <ul v-else class="divide-y divide-default rounded-lg ring ring-default">
          <li v-for="row in rows ?? []" :key="row.id" class="grid gap-x-4 gap-y-1.5 px-4 py-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] sm:items-center">
            <div class="min-w-0" :class="row.enabled ? '' : 'opacity-60'">
              <p class="font-medium text-highlighted truncate">{{ row.name }}</p>
              <p class="text-xs text-muted truncate">
                {{ kindLabel(row.kind, row.definitionName) }} · {{ row.host }} · priority {{ row.priority }}
                <template v-if="row.enabled"> · RSS every {{ row.effectiveRssIntervalMinutes }} min</template>
              </p>
            </div>
            <IndexerHealth :row="row" />
            <div class="flex items-center gap-2 justify-end">
              <USwitch
                :model-value="row.enabled"
                :aria-label="row.enabled ? `Disable ${row.name}` : `Enable ${row.name}`"
                @update:model-value="setEnabled({ id: row.id, enabled: $event })"
              />
              <UButton size="xs" color="neutral" variant="outline" label="Edit" @click="editing = row.id" />
              <UDropdownMenu
                :items="[
                  {
                    label: 'Remove',
                    icon: 'i-lucide-trash',
                    color: 'error',
                    onSelect: () => (removing = { id: row.id, name: row.name, hasKey: row.kind !== 'nyaa' && row.kind !== 'definition' }),
                  },
                ]"
                :content="{ align: 'end' }"
              >
                <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-ellipsis" square :aria-label="`More for ${row.name}`" />
              </UDropdownMenu>
            </div>
          </li>
        </ul>

        <USlideover v-model:open="open" :title="editing === 'new' ? 'Add indexer' : (detail?.name ?? 'Indexer')">
          <template #body>
            <IndexerForm v-if="editing === 'new'" @saved="onSaved" @cancel="editing = undefined" />
            <IndexerForm v-else-if="detail" :key="detail.id" :indexer="detail" @saved="onSaved" @cancel="editing = undefined" />
          </template>
        </USlideover>

        <UModal v-model:open="confirmRemove" :title="removing ? removeConfirm(removing.name).title : ''">
          <template #body>
            <p v-if="removing" class="text-sm">{{ removeConfirm(removing.name, removing.hasKey).description }}</p>
          </template>
          <template #footer>
            <div class="flex w-full justify-end gap-2">
              <UButton color="neutral" variant="ghost" label="Keep it" @click="removing = undefined" />
              <UButton color="error" label="Remove" @click="onRemove" />
            </div>
          </template>
        </UModal>
      </PageBody>
    </template>
  </UDashboardPanel>
</template>
