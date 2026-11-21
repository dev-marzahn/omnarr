<!--
  One unmatched folder: its path, files and reason; "Numbering: TMDB / TVDB
  (Sonarr) / Absolute" for a series folder (scan.setNumbering), "Match by
  hand", "Ignore folder"; the preview of the files read so far with "Import
  N files"; and the conflict rows. The card imports into the title it
  matched, with the library's default profile and, for a new series,
  tracked and not monitored.
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';
import type { Id } from '@omnarr/backend/dataModel';
import type { LibraryRef, ScanGroup, ScanNumbering } from '@omnarr/contracts';

import {
  cardHeading,
  cardImportButton,
  cardImportLine,
  conflictLine,
  fileName,
  fileRow,
  filesPreview,
  groupTitle,
  ignoreToast,
  importToast,
  NUMBERING_ITEMS,
  numberingHint,
  numberingOf,
  numberingToast,
  previewAlert,
  readAsLine,
} from '~/lib/scan';

const props = defineProps<{ group: ScanGroup; scanRunId: Id<'scanRuns'>; library?: LibraryRef; profileName?: string }>();
const toast = useToast();

const heading = computed(() => cardHeading(props.group));
const preview = computed(() => previewAlert(props.group));
const isSeries = computed(() => props.group.libraryKind === 'series');

// The card shows the group's first files until "Show all" reads the folder.
const expanded = ref(false);
const { data: folder } = useQuery(api.api.scan.folder, () =>
  expanded.value ? { scanRunId: props.scanRunId, libraryId: props.group.libraryId, folder: props.group.folder } : 'skip',
);
const files = computed(() => folder.value?.files ?? props.group.files);
const matchedFiles = computed(() => files.value.filter((file) => file.status === 'matched'));
const conflicts = computed(() => files.value.filter((file) => file.status === 'conflict'));
const unmatchedFiles = computed(() => files.value.filter((file) => file.status === 'unmatched'));
const hidden = computed(() => props.group.counts.files - files.value.length);

const fail = (title: string) => (e: unknown) => toast.add({ title, description: (e as Error).message, color: 'error', icon: 'i-lucide-triangle-alert' });

const setNumbering = useMutation(api.api.scan.setNumbering);
async function onNumbering(ordering: ScanNumbering) {
  try {
    await setNumbering({ scanRunId: props.scanRunId, libraryId: props.group.libraryId, folder: props.group.folder, ordering });
    toast.add({ ...numberingToast(groupTitle(props.group), ordering), icon: 'i-lucide-circle-check', color: 'success' });
  } catch (e) {
    fail("The numbering couldn't be changed")(e);
  }
}

const ignoreFolder = useMutation(api.api.scan.ignoreFolder);
const unignoreFolder = useMutation(api.api.scan.unignoreFolder);
async function onIgnore() {
  const ref = { libraryId: props.group.libraryId, folder: props.group.folder };
  try {
    await ignoreFolder({ ...ref, scanRunId: props.scanRunId });
    toast.add({
      ...ignoreToast(heading.value.path),
      icon: 'i-lucide-eye-off',
      actions: [
        { label: 'Undo', color: 'neutral', variant: 'outline', onClick: () => void unignoreFolder(ref).catch(fail("The folder couldn't be read again")) },
      ],
    });
  } catch (e) {
    fail("The folder couldn't be ignored")(e);
  }
}

const matching = ref(false);

const runImport = useAction(api.api.scan.import);
const importing = ref(false);
async function onImport() {
  if (!props.library) return;
  importing.value = true;
  try {
    const response = await runImport({
      scanRunId: props.scanRunId,
      folders: [{ libraryId: props.group.libraryId, folder: props.group.folder }],
      releaseProfileId: props.library.defaultReleaseProfileId,
      monitor: false,
    });
    for (const entry of importToast(response, props.group.counts.notFit, () => groupTitle(props.group)))
      toast.add({
        ...entry,
        icon: entry.color === 'success' ? 'i-lucide-circle-check' : entry.color === 'error' ? 'i-lucide-triangle-alert' : 'i-lucide-info',
      });
  } catch (e) {
    fail("The import couldn't run")(e);
  } finally {
    importing.value = false;
  }
}
</script>

<template>
  <UCard :ui="{ header: 'py-3', footer: 'py-3' }">
    <template #header>
      <div class="flex flex-wrap items-center gap-2 text-sm">
        <UIcon name="i-lucide-folder" class="text-dimmed" />
        <span class="font-mono break-all">{{ heading.path }}</span>
        <span class="text-muted">{{ heading.files }}</span>
        <UBadge v-if="heading.tag" class="ms-auto" size="sm" color="warning" variant="subtle" :label="heading.tag" />
      </div>
    </template>

    <div class="space-y-3 text-sm">
      <p class="font-mono text-xs text-muted break-all">{{ filesPreview(group) }}</p>
      <p v-if="heading.help" class="text-muted">{{ heading.help }}</p>

      <div v-if="isSeries" class="flex flex-wrap items-center gap-2">
        <span class="text-muted">Numbering</span>
        <USelect
          :model-value="numberingOf(group)"
          :items="NUMBERING_ITEMS"
          placeholder="Choose…"
          size="sm"
          class="w-40"
          :disabled="!!numberingHint(group)"
          :title="numberingHint(group)"
          @update:model-value="onNumbering($event as ScanNumbering)"
        />
        <span class="text-dimmed">or match it by hand</span>
      </div>

      <UAlert
        v-if="preview"
        :color="preview.color"
        variant="subtle"
        :icon="preview.color === 'info' ? 'i-lucide-info' : 'i-lucide-triangle-alert'"
        :title="preview.title"
        :description="preview.description"
      >
        <template v-if="matchedFiles.length > 0 && group.match" #description>
          <p>{{ preview.description }}</p>
          <table class="mt-2 w-full">
            <thead class="text-left">
              <tr>
                <th class="font-normal pb-1">File</th>
                <th class="font-normal pb-1">Read as</th>
              </tr>
            </thead>
            <tbody>
              <tr v-for="file in matchedFiles" :key="file.scanItemId">
                <td class="py-0.5 pe-3 font-mono text-xs break-all">{{ fileName(file.relPath) }}</td>
                <td class="py-0.5">{{ readAsLine(file, group.match.ordering) }}</td>
              </tr>
            </tbody>
          </table>
        </template>
      </UAlert>

      <ul v-if="conflicts.length > 0" class="divide-y divide-default border border-default rounded-md">
        <li v-for="file in conflicts" :key="file.scanItemId" class="flex flex-wrap items-center gap-2 px-3 py-1.5">
          <UIcon name="i-lucide-copy" class="text-warning" />
          <span>{{ conflictLine(file) }}</span>
          <span class="font-mono text-xs text-dimmed break-all ms-auto">{{ fileName(file.relPath) }}</span>
        </li>
      </ul>

      <ul v-if="expanded && unmatchedFiles.length > 0" class="divide-y divide-default border border-default rounded-md">
        <li v-for="file in unmatchedFiles" :key="file.scanItemId" class="flex flex-wrap items-center gap-2 px-3 py-1.5">
          <span class="font-mono text-xs break-all">{{ fileName(file.relPath) }}</span>
          <span class="text-muted ms-auto">{{ fileRow(file, group).matchedTo }}</span>
        </li>
      </ul>
      <UButton
        v-if="!expanded && hidden > 0"
        size="xs"
        color="neutral"
        variant="ghost"
        :label="`Show all ${group.counts.files} files`"
        @click="expanded = true"
      />
    </div>

    <template #footer>
      <div class="flex flex-wrap items-center gap-2">
        <UButton color="neutral" variant="ghost" icon="i-lucide-eye-off" label="Ignore folder" @click="onIgnore" />
        <span class="flex-1" />
        <template v-if="group.match && group.counts.matched > 0">
          <span class="w-full sm:w-auto order-first sm:order-none text-sm text-muted">{{ cardImportLine(group, profileName) }}</span>
          <UButton color="neutral" variant="outline" label="Match by hand…" @click="matching = true" />
          <UButton :label="cardImportButton(group)" :loading="importing" :disabled="!library" @click="onImport" />
        </template>
        <UButton v-else label="Match by hand…" @click="matching = true" />
      </div>
    </template>

    <ScanMatchByHand v-model:open="matching" :group="group" :scan-run-id="scanRunId" :path="heading.path" />
  </UCard>
</template>
