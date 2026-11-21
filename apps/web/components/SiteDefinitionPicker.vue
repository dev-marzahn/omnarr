<!--
  The catalogue of site definitions: every synced
  definition with its name, language, type and whether omnarr runs it, a
  search box and a type filter. Unsupported ones are listed greyed out with
  their reason and can't be chosen.
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';

import { filterCatalogue, pendingText, supportText, type TypeFilter, typeLabel } from '~/lib/sites';

const selected = defineModel<string>();

const { data: rows, error } = useQuery(api.sites.definitions.list, {});
const search = ref('');
const type = ref<TypeFilter>('public');
const shown = computed(() => filterCatalogue(rows.value ?? [], search.value, type.value));
const types = [
  { value: 'public', label: 'Public' },
  { value: 'semi-private', label: 'Semi-private' },
  { value: 'private', label: 'Private' },
  { value: 'all', label: 'All types' },
];
</script>

<template>
  <div class="space-y-2">
    <div class="flex gap-2">
      <UInput v-model="search" icon="i-lucide-search" placeholder="Search sites" class="flex-1" aria-label="Search sites" />
      <USelect v-model="type" :items="types" class="w-36" aria-label="Type" />
    </div>
    <UAlert v-if="error" color="error" variant="subtle" title="The site list couldn't be loaded." :description="error.message" />
    <p v-else-if="rows && rows.length === 0" class="text-sm text-muted">
      No site definitions yet. The worker downloads them when it connects; System › Site definitions can check now.
    </p>
    <p v-else-if="rows && shown.length === 0" class="text-sm text-muted">No site matches.</p>
    <ul v-else class="max-h-80 overflow-y-auto divide-y divide-default rounded-lg ring ring-default" role="listbox" aria-label="Sites">
      <li v-for="row in shown" :key="row.definitionId">
        <button
          type="button"
          role="option"
          class="w-full px-3 py-2 text-left disabled:cursor-not-allowed"
          :class="[row.support.ok ? 'hover:bg-elevated/50' : 'opacity-60', selected === row.definitionId ? 'bg-elevated' : '']"
          :aria-selected="selected === row.definitionId"
          :disabled="!row.support.ok"
          @click="selected = row.definitionId"
        >
          <span class="flex items-center gap-2">
            <span class="font-medium text-highlighted truncate">{{ row.name }}</span>
            <span class="text-xs text-muted">{{ row.language }} · {{ typeLabel(row.type) }}</span>
            <UIcon v-if="selected === row.definitionId" name="i-lucide-check" class="ms-auto text-primary" />
          </span>
          <span v-if="!row.support.ok" class="block text-xs text-muted">{{ supportText(row.support) }}</span>
          <span v-else-if="pendingText(row)" class="block text-xs text-warning">{{ pendingText(row) }}</span>
          <span v-else-if="row.description" class="block text-xs text-muted truncate">{{ row.description }}</span>
        </button>
      </li>
    </ul>
  </div>
</template>
