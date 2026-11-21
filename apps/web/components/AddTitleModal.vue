<!--
  Add a title to one library: search TMDB, then choose the
  seasons to monitor, whether new episodes are monitored, the numbering and
  the release profile, and subscribe.
  The profile is the library's default, or the shipped Anime profile when the
  numbering is anime; subscribing searches the aired episodes.
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';
import type { Id } from '@omnarr/backend/dataModel';
import { WORK_KIND_OF, type LibraryRef, type MetadataHit, type NumberingScheme, type WorkPreview } from '@omnarr/contracts';

import { metadataErrorText, NUMBERING_REASON } from '~/lib/metadata';
import { seasonLabel } from '~/lib/seasons';
import { airedMonitored, defaultSeasons, preselectProfile, searchLine, seasonLine } from '~/lib/subscribe';
import { formatAirDate } from '~/lib/unitStates';

const props = defineProps<{ library: LibraryRef }>();
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ subscribed: [workId: string, title: string] }>();

const kind = computed(() => WORK_KIND_OF[props.library.kind]);
const searchTitles = useAction(api.api.metadata.search);
const previewTitle = useAction(api.api.metadata.preview);
const subscribe = useAction(api.api.library.subscribe);

const query = ref('');
const hits = ref<MetadataHit[]>();
const searching = ref(false);
const error = ref<string>();

const preview = ref<WorkPreview>();
const seasons = ref<number[]>([]);
const numbering = ref<NumberingScheme>('standard');
/** Stored as the Work's `monitorNewUnits`; on by default, as the backend's default. */
const monitorNewUnits = ref(true);
const subscribing = ref(false);

const { data: settings } = useQuery(api.api.metadata.settings, {});
const failureText = (e: unknown) => metadataErrorText(errorCode(e), settings.value?.tokenSource);

const { data: profiles } = useQuery(api.api.releaseProfiles.list, {});
const profileId = ref<string>();
const profileItems = computed(() => (profiles.value ?? []).map((profile) => ({ value: profile.id, label: profile.name })));
const { data: chosenProfile } = useQuery(api.api.releaseProfiles.get, () => (profileId.value ? { id: profileId.value as Id<'releaseProfiles'> } : 'skip'));
const targetWarning = computed(() => chosenProfile.value?.targetWarnings.find((warning) => warning.libraryId === props.library.libraryId)?.message);
watch(
  [numbering, profiles],
  () => {
    profileId.value = preselectProfile(profiles.value ?? [], props.library, numbering.value);
  },
  { immediate: true },
);

let searchTimer: ReturnType<typeof setTimeout> | undefined;
watch(query, (value) => {
  clearTimeout(searchTimer);
  if (!value.trim()) {
    hits.value = undefined;
    return;
  }
  searchTimer = setTimeout(() => void runSearch(value), 300);
});

async function runSearch(value: string) {
  searching.value = true;
  error.value = undefined;
  try {
    const result = await searchTitles({ query: value, kind: kind.value });
    if (value === query.value) hits.value = result;
  } catch (e) {
    error.value = failureText(e);
  } finally {
    searching.value = false;
  }
}

async function choose(hit: MetadataHit) {
  if (hit.workId) {
    open.value = false;
    await navigateTo(`/library/${hit.workId}`);
    return;
  }
  error.value = undefined;
  try {
    preview.value = await previewTitle({ tmdbId: hit.tmdbId, kind: hit.kind });
    seasons.value = defaultSeasons(preview.value);
    numbering.value = preview.value.numberingScheme;
    monitorNewUnits.value = true;
  } catch (e) {
    error.value = failureText(e);
  }
}

function toggleSeason(season: number, on: boolean | 'indeterminate') {
  seasons.value = on === true ? [...seasons.value, season] : seasons.value.filter((s) => s !== season);
}

async function confirm() {
  if (!preview.value) return;
  subscribing.value = true;
  error.value = undefined;
  try {
    const { workId } = await subscribe({
      tmdbId: preview.value.tmdbId,
      kind: preview.value.kind,
      libraryId: props.library.libraryId,
      releaseProfileId: (profileId.value ?? props.library.defaultReleaseProfileId) as Id<'releaseProfiles'>,
      seasons: seasons.value,
      numberingScheme: numbering.value,
      monitorNewUnits: monitorNewUnits.value,
    });
    emit('subscribed', workId, preview.value.title);
    open.value = false;
  } catch (e) {
    error.value = failureText(e);
  } finally {
    subscribing.value = false;
  }
}

watch(open, (value) => {
  if (value) return;
  query.value = '';
  hits.value = undefined;
  preview.value = undefined;
  error.value = undefined;
});

const numberingItems = [
  { value: 'standard', label: 'Standard (TMDB seasons)' },
  { value: 'anime', label: 'Anime (absolute numbers)', description: 'Matches releases by absolute episode number. Files are always named by TMDB season.' },
];
</script>

<template>
  <UModal v-model:open="open" :title="preview ? `${preview.title}${preview.year ? ` (${preview.year})` : ''}` : `Add to ${library.name}`">
    <template #body>
      <div v-if="!preview" class="space-y-3">
        <UInput v-model="query" icon="i-lucide-search" :placeholder="`Search TMDB for a ${kind}`" autofocus class="w-full" :loading="searching" />
        <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-triangle-alert" :title="error" />
        <p v-else-if="hits && hits.length === 0" class="text-sm text-muted">
          No titles match "{{ query }}". Check the spelling, or search by the original title.
        </p>
        <ul v-else-if="hits" class="divide-y divide-default">
          <li v-for="hit in hits" :key="`${hit.kind}:${hit.tmdbId}`" class="flex items-center gap-3 py-2">
            <!-- The backend's w92 copy, as a data URI: the browser never asks TMDB. -->
            <Poster size="sm" :src="hit.posterDataUri" :alt="hit.title" />
            <div class="flex-1 min-w-0">
              <p class="font-medium truncate">{{ hit.title }}<span v-if="hit.year" class="text-muted"> ({{ hit.year }})</span></p>
              <div v-if="hit.numberingScheme === 'anime'" class="flex flex-wrap gap-1">
                <UBadge size="sm" color="neutral" variant="subtle" label="Anime numbering" />
                <UBadge
                  v-if="NUMBERING_REASON[hit.numberingReason]"
                  size="sm"
                  color="secondary"
                  variant="subtle"
                  :label="NUMBERING_REASON[hit.numberingReason]"
                />
              </div>
            </div>
            <UButton v-if="hit.workId" size="sm" color="neutral" variant="outline" icon="i-lucide-check" label="In library · Open" @click="choose(hit)" />
            <UButton v-else size="sm" label="Subscribe…" @click="choose(hit)" />
          </li>
        </ul>
        <TmdbAttribution />
      </div>

      <div v-else class="space-y-4">
        <div v-if="preview.kind === 'series'" class="space-y-2">
          <p class="text-sm font-medium">Seasons to monitor</p>
          <!-- Specials always start unmonitored; they're monitored on the title's page. -->
          <UCheckbox
            v-for="season in preview.seasons"
            :key="season.season"
            :model-value="seasons.includes(season.season)"
            :disabled="season.season === 0"
            :label="seasonLabel(season.season)"
            :description="season.season === 0 ? `${seasonLine(season, formatAirDate)} · monitor them on the title's page` : seasonLine(season, formatAirDate)"
            @update:model-value="toggleSeason(season.season, $event)"
          />
          <USwitch
            v-model="monitorNewUnits"
            label="Monitor new episodes"
            :description="monitorNewUnits ? 'Episodes TMDB adds later are monitored and searched.' : 'Episodes TMDB adds later start unmonitored.'"
          />
        </div>
        <div v-if="preview.kind === 'series'" class="space-y-1">
          <URadioGroup v-model="numbering" legend="Episode numbering" :items="numberingItems" />
          <UBadge
            v-if="NUMBERING_REASON[preview.numberingReason]"
            size="sm"
            color="secondary"
            variant="subtle"
            :label="`${preview.numberingScheme === 'anime' ? 'Anime' : 'Standard'} preselected · ${NUMBERING_REASON[preview.numberingReason]}`"
          />
          <p class="text-xs text-muted">Changeable now or later. Changing it only affects future grabs; existing files keep their episodes.</p>
        </div>
        <UFormField label="Release profile">
          <USelect v-model="profileId" :items="profileItems" class="w-full" />
        </UFormField>
        <UAlert v-if="targetWarning" color="neutral" variant="subtle" icon="i-lucide-info" :title="targetWarning" />
        <UAlert color="neutral" variant="subtle" icon="i-lucide-search" :title="searchLine(airedMonitored(preview, seasons), preview.kind)" />
        <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-triangle-alert" :title="error" />
        <TmdbAttribution />
      </div>
    </template>

    <template v-if="preview" #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" label="Back" @click="preview = undefined" />
        <UButton label="Subscribe" :loading="subscribing" @click="confirm" />
      </div>
    </template>
  </UModal>
</template>
