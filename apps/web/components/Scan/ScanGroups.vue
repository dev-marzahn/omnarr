<!--
  The Matched tab: one card per folder with its checkbox and roll-up tags,
  its first files (all of them after "Show all"), the release profile for
  new titles (the library's default), "After import, series are" (the
  labels name what is selected) and "Import N files". `scan.import` takes
  folders, so a folder is selected as a whole.
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';
import type { Id } from '@omnarr/backend/dataModel';
import type { ScanGroup, ScanItemRow } from '@omnarr/contracts';

import {
  allChecked,
  fileRow,
  folderKey,
  groupHeading,
  groupTitle,
  importFooter,
  importPanelText,
  importToast,
  MONITOR_ITEMS,
  type MonitorChoice,
  moreFiles,
} from '~/lib/scan';

const props = defineProps<{ scanRunId: Id<'scanRuns'> }>();
const toast = useToast();

const { groups, error, isLoading, hasMore, loadMore } = useScanGroups(() => props.scanRunId, 'matched');

// Every folder starts selected; the user unticks the ones to leave.
const deselected = ref(new Set<string>());
const selected = computed(() => new Set(groups.value.map(folderKey).filter((key) => !deselected.value.has(key))));
const footer = computed(() => importFooter(groups.value, selected.value));
const headerChecked = computed(() => allChecked(groups.value, selected.value));

function toggle(group: ScanGroup, on: boolean | 'indeterminate') {
  const next = new Set(deselected.value);
  if (on === true) next.delete(folderKey(group));
  else next.add(folderKey(group));
  deselected.value = next;
}
function toggleAll(on: boolean | 'indeterminate') {
  deselected.value = on === true ? new Set() : new Set(groups.value.map(folderKey));
}

// "Show all": the folder's every file, read once.
const readFolder = useQueryOnce(api.api.scan.folder);
const allFiles = ref<Record<string, ScanItemRow[]>>({});
async function showAll(group: ScanGroup) {
  const full = await readFolder({ scanRunId: props.scanRunId, libraryId: group.libraryId, folder: group.folder });
  if (full) allFiles.value = { ...allFiles.value, [folderKey(group)]: full.files };
}
const rows = computed(() =>
  groups.value.map((group) => {
    const key = folderKey(group);
    const shown = allFiles.value[key];
    return {
      group,
      key,
      heading: groupHeading(group),
      files: (shown ?? group.files).map((file) => ({ file, text: fileRow(file, group) })),
      more: shown ? undefined : moreFiles(group),
    };
  }),
);
const fitClass = (fits: boolean | undefined) => (fits === true ? 'text-success' : fits === false ? 'text-warning' : 'text-muted');

// The release profile for new titles: the series library's default.
const { data: series } = useQuery(api.api.library.list, { kind: 'series' });
const { data: profiles } = useQuery(api.api.releaseProfiles.list, {});
const profileItems = computed(() => (profiles.value ?? []).map((profile) => ({ value: profile.id, label: profile.name })));
const profileId = ref<string>();
watch(
  () => series.value?.library?.defaultReleaseProfileId,
  (id) => {
    if (id && !profileId.value) profileId.value = id;
  },
  { immediate: true },
);
const monitor = ref<MonitorChoice>('tracked');
// The panel's labels follow the kinds selected.
const panel = computed(() => {
  const chosen = groups.value.filter((group) => selected.value.has(folderKey(group)));
  return importPanelText(
    { series: chosen.filter((group) => group.libraryKind === 'series').length, movies: chosen.filter((group) => group.libraryKind === 'movies').length },
    monitor.value,
  );
});

const runImport = useAction(api.api.scan.import);
const importing = ref(false);
async function onImport() {
  if (!profileId.value) return;
  const chosen = groups.value.filter((group) => selected.value.has(folderKey(group)));
  const notFit = chosen.reduce((sum, group) => sum + group.counts.notFit, 0);
  importing.value = true;
  try {
    const response = await runImport({
      scanRunId: props.scanRunId,
      folders: chosen.map(({ libraryId, folder }) => ({ libraryId, folder })),
      releaseProfileId: profileId.value as Id<'releaseProfiles'>,
      monitor: monitor.value === 'monitored',
    });
    const titleOf = (ref: { libraryId: string; folder: string }) => {
      const group = chosen.find((entry) => folderKey(entry) === folderKey(ref));
      return group ? groupTitle(group) : ref.folder;
    };
    for (const entry of importToast(response, notFit, titleOf))
      toast.add({
        ...entry,
        icon: entry.color === 'success' ? 'i-lucide-circle-check' : entry.color === 'error' ? 'i-lucide-triangle-alert' : 'i-lucide-info',
      });
  } catch (e) {
    toast.add({ title: "The import couldn't run", description: (e as Error).message, color: 'error', icon: 'i-lucide-triangle-alert' });
  } finally {
    importing.value = false;
  }
}
</script>

<template>
  <UAlert
    v-if="error"
    color="error"
    variant="subtle"
    icon="i-lucide-triangle-alert"
    title="The matched folders couldn't be loaded."
    :description="error.message"
  />
  <p v-else-if="isLoading" class="text-sm text-muted">Loading…</p>
  <UEmpty
    v-else-if="groups.length === 0"
    icon="i-lucide-folder-search"
    title="No matched files"
    description="The folders on the Unmatched tab need a numbering or a match by hand."
    :actions="[{ label: 'Open Unmatched', to: '/scan/unmatched', color: 'neutral', variant: 'outline' }]"
  />

  <template v-else>
    <div class="flex items-center gap-2 text-sm text-muted">
      <UCheckbox :model-value="headerChecked" label="Select all" @update:model-value="toggleAll" />
    </div>

    <!-- A card per matched title; a folder is selected as a whole. -->
    <section v-for="row in rows" :key="row.key" class="rounded-lg ring ring-default overflow-hidden">
      <header class="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3 border-b border-default bg-elevated/40">
        <UCheckbox :model-value="selected.has(row.key)" :aria-label="`Select ${row.heading.title}`" @update:model-value="toggle(row.group, $event)" />
        <Poster size="xs" :alt="row.heading.title" />
        <div class="min-w-0 flex-1">
          <NuxtLink v-if="row.group.match?.workId" :to="`/library/${row.group.match.workId}`" class="text-sm font-semibold text-highlighted hover:underline">
            {{ row.heading.title }}
          </NuxtLink>
          <span v-else class="text-sm font-semibold text-highlighted">{{ row.heading.title }}</span>
          <span class="text-xs text-muted"> · {{ row.heading.line }}</span>
        </div>
        <span class="flex flex-wrap gap-1">
          <UBadge v-for="tag in row.heading.tags" :key="tag.label" size="sm" variant="subtle" :color="tag.color" :icon="tag.icon" :label="tag.label" />
        </span>
      </header>
      <ul class="divide-y divide-default">
        <li
          v-for="{ file, text } in row.files"
          :key="file.scanItemId"
          class="grid gap-x-4 gap-y-0.5 px-4 py-2 text-sm sm:grid-cols-[minmax(0,3fr)_minmax(0,2fr)_auto_auto] sm:items-center"
          :class="file.status === 'matched' ? '' : 'text-muted'"
        >
          <span class="font-mono text-xs truncate" :title="file.path">{{ text.file }}</span>
          <span class="truncate">{{ text.matchedTo }}</span>
          <span class="inline-flex items-center gap-1 sm:whitespace-nowrap">
            <UBadge class="hidden sm:inline-flex" size="sm" color="neutral" variant="subtle" :label="text.readAs" />
            <span v-if="text.naming" class="text-xs text-muted"><span class="hidden sm:inline">· </span>{{ text.naming }}</span>
          </span>
          <span class="hidden sm:inline whitespace-nowrap text-xs">
            <span :class="fitClass(text.target.fits)">{{ text.target.text }}</span>
            <span v-if="text.target.format" class="ms-1 text-dimmed">{{ text.target.format }}</span>
          </span>
        </li>
        <li v-if="row.more" class="px-4 py-2 text-sm text-muted">
          {{ row.more }} ·
          <UButton size="xs" color="neutral" variant="ghost" label="Show all" @click="showAll(row.group)" />
        </li>
      </ul>
    </section>

    <div v-if="hasMore">
      <UButton size="sm" color="neutral" variant="outline" label="Load more folders" @click="loadMore" />
    </div>

    <UCard>
      <div class="grid gap-4 sm:grid-cols-2">
        <UFormField :label="panel.profileLabel" :help="panel.profileHelp">
          <USelect v-model="profileId" :items="profileItems" class="w-full" />
        </UFormField>
        <UFormField :label="panel.monitorLabel" :help="panel.monitorHelp">
          <USelect v-model="monitor" :items="MONITOR_ITEMS" class="w-full" />
        </UFormField>
      </div>
      <template #footer>
        <div class="flex flex-wrap items-center justify-between gap-3">
          <span class="text-sm text-muted">{{ footer.line }}</span>
          <UButton :label="footer.button" :loading="importing" :disabled="footer.files === 0 || !profileId" @click="onImport" />
        </div>
      </template>
    </UCard>
  </template>
</template>
