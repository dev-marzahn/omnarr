<!--
  "Match by hand": step 1 finds the title
  on TMDB through scan.searchTitle (the folder's suggestions first); step 2
  says what each file is, a season and episode from TMDB's seasons for a
  series, "The movie" or "Not this title" for a movie, then scan.matchFolder.
  "Use the file names" reads the folder's names against the title instead.
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';
import type { Id } from '@omnarr/backend/dataModel';
import { WORK_KIND_OF, type ScanGroup, type ScanSuggestion, type SeasonPreview } from '@omnarr/contracts';

import { metadataErrorText } from '~/lib/metadata';
import {
  type Assignment,
  assignedFiles,
  assignmentProblem,
  defaultAssignments,
  episodeItems,
  fileName,
  MATCH_HELP,
  matchButton,
  matchedToast,
  matchHeading,
  MOVIE_CHOICES,
  seasonItems,
  suggestionLine,
} from '~/lib/scan';
import { formatBytes } from '~/lib/system';

const props = defineProps<{ group: ScanGroup; scanRunId: Id<'scanRuns'>; path: string }>();
const open = defineModel<boolean>('open', { required: true });
const toast = useToast();

const kind = computed(() => WORK_KIND_OF[props.group.libraryKind]);
const { data: settings } = useQuery(api.api.metadata.settings, {});
const failureText = (e: unknown) => metadataErrorText(errorCode(e), settings.value?.tokenSource);

// ---- Step 1: the title ----
const searchTitle = useAction(api.api.scan.searchTitle);
const query = ref('');
const hits = ref<ScanSuggestion[]>();
const searching = ref(false);
const error = ref<string>();
const shown = computed(() => hits.value ?? props.group.suggestions);

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
    const result = await searchTitle({ query: value.trim(), kind: kind.value });
    if (value === query.value) hits.value = result;
  } catch (e) {
    error.value = failureText(e);
  } finally {
    searching.value = false;
  }
}

// ---- Step 2: the files ----
const title = ref<ScanSuggestion>();
const { data: folder } = useQuery(api.api.scan.folder, () =>
  open.value ? { scanRunId: props.scanRunId, libraryId: props.group.libraryId, folder: props.group.folder } : 'skip',
);
/** The files still to match: matched and imported ones stay as they are. */
const files = computed(() => (folder.value?.files ?? props.group.files).filter((file) => file.status === 'unmatched' || file.status === 'conflict'));
const assignments = ref<Assignment[]>([]);
const previewTitle = useAction(api.api.metadata.preview);
const seasons = ref<SeasonPreview[]>();

async function choose(suggestion: ScanSuggestion) {
  title.value = suggestion;
  assignments.value = defaultAssignments(suggestion.kind, files.value);
  seasons.value = undefined;
  error.value = undefined;
  if (suggestion.kind !== 'series') return;
  try {
    seasons.value = (await previewTitle({ tmdbId: suggestion.tmdbId, kind: suggestion.kind })).seasons;
  } catch (e) {
    error.value = failureText(e);
  }
}

const assigned = computed(() => assignedFiles(assignments.value));
const problem = computed(() => assignmentProblem(assignments.value));
const fileOf = (row: Assignment) => files.value.find((file) => file.scanItemId === row.scanItemId);
const nameOf = (row: Assignment) => fileName(fileOf(row)?.relPath ?? '');

function setSeason(row: Assignment, value: number | 'none') {
  if (value === 'none') Object.assign(row, { choice: 'none', season: undefined, episode: undefined });
  else Object.assign(row, { choice: 'episode', season: value, episode: row.season === value ? row.episode : undefined });
}
function setNumber(row: Assignment, field: 'season' | 'episode', value: number | null | undefined) {
  row[field] = value ?? undefined;
  row.choice = row.season === undefined && row.episode === undefined ? 'none' : 'episode';
}

const matchFolder = useMutation(api.api.scan.matchFolder);
const matching = ref(false);
async function onMatch(byName: boolean) {
  if (!title.value) return;
  matching.value = true;
  error.value = undefined;
  const { tmdbId, kind: titleKind, title: name, year } = title.value;
  try {
    await matchFolder({
      scanRunId: props.scanRunId,
      libraryId: props.group.libraryId,
      folder: props.group.folder,
      title: { tmdbId, kind: titleKind, title: name, ...(year === undefined ? {} : { year }) },
      ...(byName ? {} : { files: assigned.value }),
    });
    const label = suggestionLine(title.value).title;
    toast.add({ ...matchedToast(label, byName ? undefined : assigned.value.length), icon: 'i-lucide-circle-check', color: 'success' });
    open.value = false;
  } catch (e) {
    error.value = (e as Error).message;
  } finally {
    matching.value = false;
  }
}

watch(open, (value) => {
  if (value) return;
  query.value = '';
  hits.value = undefined;
  title.value = undefined;
  assignments.value = [];
  error.value = undefined;
});

const heading = computed(() => matchHeading(props.path, title.value ? 'files' : 'title'));
</script>

<template>
  <UModal v-model:open="open" :title="heading.title" :description="heading.step" :ui="{ content: 'sm:max-w-2xl' }">
    <template #body>
      <div v-if="!title" class="space-y-3">
        <UInput v-model="query" icon="i-lucide-search" :placeholder="`Search TMDB for a ${kind}`" autofocus class="w-full" :loading="searching" />
        <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-triangle-alert" :title="error" />
        <p v-else-if="hits && hits.length === 0" class="text-sm text-muted">
          No titles match "{{ query }}". Check the spelling, or search by the original title.
        </p>
        <p v-else-if="!hits && shown.length === 0" class="text-sm text-muted">Search for the title these files belong to.</p>
        <ul v-if="shown.length > 0" class="divide-y divide-default border border-default rounded-md">
          <li v-for="hit in shown" :key="`${hit.kind}:${hit.tmdbId}`">
            <button
              type="button"
              class="flex w-full items-center gap-3 px-3 py-2 text-left hover:bg-elevated/50 disabled:opacity-50"
              :disabled="!folder"
              @click="choose(hit)"
            >
              <div class="flex-1 min-w-0">
                <p class="font-medium truncate">{{ suggestionLine(hit).title }}</p>
                <p class="text-xs text-dimmed">{{ suggestionLine(hit).line }}</p>
              </div>
              <UIcon name="i-lucide-chevron-right" class="text-dimmed" />
            </button>
          </li>
        </ul>
        <TmdbAttribution />
      </div>

      <div v-else class="space-y-4 text-sm">
        <div class="flex items-center gap-3">
          <div class="flex-1">
            <p class="font-medium">{{ suggestionLine(title).title }}</p>
            <p class="text-muted">{{ suggestionLine(title).line }}</p>
          </div>
          <UButton size="xs" color="neutral" variant="ghost" label="Change title" @click="title = undefined" />
        </div>

        <table class="w-full">
          <thead class="text-left text-muted">
            <tr>
              <th class="font-normal pb-1">File</th>
              <th class="font-normal pb-1">Size</th>
              <th class="font-normal pb-1">Is</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-default">
            <tr v-for="row in assignments" :key="row.scanItemId">
              <td class="py-1.5 pe-3 font-mono text-xs break-all">{{ nameOf(row) }}</td>
              <td class="py-1.5 pe-3 text-dimmed whitespace-nowrap">{{ formatBytes(fileOf(row)?.sizeBytes ?? 0) }}</td>
              <td class="py-1.5">
                <USelect v-if="title.kind === 'movie'" v-model="row.choice" :items="MOVIE_CHOICES" size="sm" class="w-40" />
                <div v-else-if="seasons" class="flex gap-2">
                  <USelect
                    :model-value="row.choice === 'none' ? 'none' : row.season"
                    :items="seasonItems(seasons)"
                    size="sm"
                    class="w-36"
                    @update:model-value="setSeason(row, $event as number | 'none')"
                  />
                  <USelect
                    v-if="row.choice === 'episode' && row.season !== undefined"
                    v-model="row.episode"
                    :items="episodeItems(seasons, row.season)"
                    placeholder="Episode"
                    size="sm"
                    class="w-28"
                  />
                </div>
                <!-- Without TMDB's seasons, plain numbers. -->
                <div v-else class="flex gap-2">
                  <UInputNumber
                    :model-value="row.season"
                    :min="0"
                    placeholder="Season"
                    size="sm"
                    class="w-28"
                    @update:model-value="setNumber(row, 'season', $event)"
                  />
                  <UInputNumber
                    :model-value="row.episode"
                    :min="1"
                    placeholder="Episode"
                    size="sm"
                    class="w-28"
                    @update:model-value="setNumber(row, 'episode', $event)"
                  />
                </div>
              </td>
            </tr>
          </tbody>
        </table>

        <p class="text-xs text-muted">{{ MATCH_HELP }}</p>
        <UAlert v-if="problem" color="warning" variant="subtle" icon="i-lucide-triangle-alert" :title="problem" />
        <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-triangle-alert" :title="error" />
        <TmdbAttribution />
      </div>
    </template>

    <template v-if="title" #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" label="Back" @click="title = undefined" />
        <UButton v-if="title.kind === 'series'" color="neutral" variant="outline" label="Use the file names" :loading="matching" @click="onMatch(true)" />
        <UButton :label="matchButton(assigned.length)" :loading="matching" :disabled="assigned.length === 0 || !!problem" @click="onMatch(false)" />
      </div>
    </template>
  </UModal>
</template>
