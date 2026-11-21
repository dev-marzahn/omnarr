<!--
  The Work page's numbering panel: the numbering scheme, the
  mapping status and its notes, aliases with add and remove, a Unit's
  mappings with manual set and remove, the first write's failure with
  "Try again", and TMDB's "no longer lists" notice.
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';
import type { Id } from '@omnarr/backend/dataModel';
import type { NumberingScheme, UnitRow } from '@omnarr/contracts';

import { ALIAS_SOURCE, buildNotice, MAPPING_SOURCE, MAPPING_STATUS, mappingNumbers, NUMBERING_REASON } from '~/lib/metadata';
import { seasonLabel } from '~/lib/seasons';

const props = defineProps<{ workId: Id<'works'>; kind: 'series' | 'movie'; numberingScheme: NumberingScheme; units: UnitRow[] }>();
const toast = useToast();

const { data: info } = useQuery(api.api.metadata.workInfo, () => ({ workId: props.workId }));
const setScheme = useMutation(api.api.metadata.setNumberingScheme);
const addAlias = useMutation(api.api.metadata.addAlias);
const removeAlias = useMutation(api.api.metadata.removeAlias);
const setManual = useMutation(api.api.metadata.setManualMapping);
const removeManual = useMutation(api.api.metadata.removeManualMapping);
const syncNow = useMutation(api.api.metadata.syncNow);

const notice = computed(() => (info.value ? buildNotice(info.value) : undefined));
const status = computed(() => (info.value?.mappingStatus ? MAPPING_STATUS[info.value.mappingStatus] : undefined));

async function run(what: string, call: () => Promise<unknown>) {
  try {
    await call();
  } catch {
    toast.add({ title: `${what} failed`, description: 'Try again.', color: 'error', icon: 'i-lucide-triangle-alert' });
  }
}

const schemeItems = [
  { value: 'standard', label: 'Standard (TMDB seasons)' },
  { value: 'anime', label: 'Anime (absolute numbers)' },
];
const changeScheme = (scheme: NumberingScheme) => run('Changing the numbering', () => setScheme({ workId: props.workId, scheme }));

const newAlias = ref('');
async function submitAlias() {
  const title = newAlias.value.trim();
  if (!title) return;
  await run('Adding the alias', () => addAlias({ workId: props.workId, title }));
  newAlias.value = '';
}

// A Unit's mappings: pick one, see its rows, add or remove the user's own.
const unitItems = computed(() =>
  props.units
    .filter((u) => u.kind !== 'movie')
    .map((u) => ({ value: u.unitId, label: `${seasonLabel(u.tmdbSeason ?? 0)} · ${u.tmdbEpisode ?? ''} ${u.title ?? ''}`.trim() })),
);
const selectedUnit = ref<Id<'units'>>();
const { data: mappings } = useQuery(api.api.metadata.unitMappings, () => (selectedUnit.value ? { unitId: selectedUnit.value } : 'skip'));
const manual = reactive<{ ordering: 'scene' | 'tvdb' | 'absolute'; season?: number; episode?: number; absolute?: number }>({ ordering: 'scene' });
async function submitManual() {
  if (!selectedUnit.value) return;
  const { ordering, season, episode, absolute } = manual;
  await run('Saving the mapping', () => setManual({ unitId: selectedUnit.value!, ordering, season, episode, absolute }));
}
</script>

<template>
  <section class="border border-default rounded-md p-4 space-y-4">
    <div class="flex flex-wrap items-center gap-3">
      <h2 class="font-medium flex-1">Metadata and numbering</h2>
      <UButton
        size="xs"
        color="neutral"
        variant="outline"
        icon="i-lucide-refresh-cw"
        label="Refresh now"
        :loading="info?.syncing"
        @click="run('Refreshing', () => syncNow({ workId }))"
      />
    </div>

    <UAlert v-if="notice" :color="notice.color" variant="subtle" icon="i-lucide-info" :title="notice.title">
      <template v-if="info?.buildState === 'failed'" #actions>
        <UButton size="xs" label="Try again" :loading="info?.syncing" @click="run('Retrying', () => syncNow({ workId }))" />
      </template>
    </UAlert>

    <div v-if="kind === 'series'" class="space-y-1">
      <URadioGroup
        :model-value="numberingScheme"
        legend="Episode numbering"
        :items="schemeItems"
        @update:model-value="changeScheme($event as NumberingScheme)"
      />
      <p v-if="info?.numberingSuggestion && NUMBERING_REASON[info.numberingSuggestion.reason]" class="text-xs text-muted">
        Suggested: {{ info.numberingSuggestion.scheme === 'anime' ? 'Anime' : 'Standard' }} ({{ NUMBERING_REASON[info.numberingSuggestion.reason] }}). Changing
        it only affects future grabs.
      </p>
    </div>

    <div v-if="kind === 'series' && status" class="space-y-1">
      <UBadge :color="status.color" variant="subtle" :label="status.label" />
      <p class="text-xs text-muted">{{ status.description }}</p>
      <ul v-if="info?.mappingNotes.length" class="list-disc ps-5 text-xs text-muted">
        <li v-for="note in info.mappingNotes" :key="note">{{ note }}</li>
      </ul>
    </div>

    <div class="space-y-2">
      <p class="text-sm font-medium">Titles it is searched and matched by</p>
      <div class="flex flex-wrap gap-1">
        <UBadge
          v-for="alias in info?.aliases ?? []"
          :key="alias.aliasId"
          color="neutral"
          variant="outline"
          :label="alias.title"
          :title="ALIAS_SOURCE[alias.source]"
          :trailing-icon="alias.source === 'manual' ? 'i-lucide-x' : undefined"
          :class="alias.source === 'manual' ? 'cursor-pointer' : ''"
          @click="alias.source === 'manual' && run('Removing the alias', () => removeAlias({ aliasId: alias.aliasId }))"
        />
      </div>
      <form class="flex gap-2" @submit.prevent="submitAlias">
        <UInput v-model="newAlias" size="sm" placeholder="Add a title releases use" class="flex-1" />
        <UButton size="sm" type="submit" label="Add" :disabled="!newAlias.trim()" />
      </form>
    </div>

    <div v-if="kind === 'series' && units.length" class="space-y-2">
      <p class="text-sm font-medium">An episode's numbers</p>
      <USelect v-model="selectedUnit" :items="unitItems" placeholder="Choose an episode" size="sm" class="w-full" />
      <ul v-if="selectedUnit" class="divide-y divide-default text-sm">
        <li v-for="row in mappings ?? []" :key="row.mappingId" class="flex items-center gap-3 py-1">
          <span class="w-28 text-muted">{{ row.ordering }}</span>
          <span class="flex-1 tabular-nums">{{ mappingNumbers(row) }}</span>
          <span class="text-xs text-muted">{{ MAPPING_SOURCE[row.source] }}</span>
          <UButton
            v-if="row.source === 'manual'"
            size="xs"
            color="neutral"
            variant="ghost"
            icon="i-lucide-trash-2"
            aria-label="Remove"
            @click="run('Removing the mapping', () => removeManual({ mappingId: row.mappingId }))"
          />
        </li>
      </ul>
      <form v-if="selectedUnit" class="flex flex-wrap items-end gap-2" @submit.prevent="submitManual">
        <USelect v-model="manual.ordering" :items="['scene', 'tvdb', 'absolute']" size="sm" />
        <UInput v-model.number="manual.season" type="number" size="sm" placeholder="Season" class="w-24" />
        <UInput v-model.number="manual.episode" type="number" size="sm" placeholder="Episode" class="w-24" />
        <UInput v-model.number="manual.absolute" type="number" size="sm" placeholder="Absolute" class="w-24" />
        <UButton size="sm" type="submit" label="Set manually" />
      </form>
    </div>
  </section>
</template>
