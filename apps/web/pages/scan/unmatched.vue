<!--
  Scan untracked media, the Unmatched tab:
  one card per folder with unmatched or conflicting files, and the folders
  later scans skip, each of which can be read again.
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';
import type { Id } from '@omnarr/backend/dataModel';
import type { LibraryKind } from '@omnarr/contracts';

import { folderKey, ignoredLine, unignoreToast } from '~/lib/scan';

const toast = useToast();

// The same subscription as the header's; the client holds it once.
const { data: status } = useQuery(api.api.scan.status, {});
const scanRunId = computed(() => (status.value?.run?.state === 'ready' ? status.value.run.scanRunId : undefined));
const { groups, error, isLoading, hasMore, loadMore } = useScanGroups(scanRunId, 'unmatched');

// Each card imports with its library's default profile (C14).
const { data: series } = useQuery(api.api.library.list, { kind: 'series' });
const { data: movies } = useQuery(api.api.library.list, { kind: 'movies' });
const { data: profiles } = useQuery(api.api.releaseProfiles.list, {});
const libraryOf = (kind: LibraryKind) => (kind === 'series' ? series.value?.library : movies.value?.library);
const profileNameOf = (kind: LibraryKind) => profiles.value?.find((profile) => profile.id === libraryOf(kind)?.defaultReleaseProfileId)?.name;

const { data: ignored } = useQuery(api.api.scan.ignored, {});
const unignoreFolder = useMutation(api.api.scan.unignoreFolder);
async function onUnignore(entry: { libraryId: Id<'libraries'>; folder: string; path: string }) {
  try {
    await unignoreFolder({ libraryId: entry.libraryId, folder: entry.folder });
    toast.add({ ...unignoreToast(entry.path), icon: 'i-lucide-circle-check', color: 'success' });
  } catch (e) {
    toast.add({ title: "The folder couldn't be read again", description: (e as Error).message, color: 'error', icon: 'i-lucide-triangle-alert' });
  }
}
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <ScanPageHeader tab="unmatched" />
    </template>
    <template #body>
      <PageBody>
        <ScanState>
          <template #default="{ scanRunId: runId }">
            <UAlert
              v-if="error"
              color="error"
              variant="subtle"
              icon="i-lucide-triangle-alert"
              title="The unmatched folders couldn't be loaded."
              :description="error.message"
            />
            <p v-else-if="isLoading" class="text-sm text-muted">Loading…</p>
            <UEmpty
              v-else-if="groups.length === 0"
              icon="i-lucide-check"
              title="No unmatched folders"
              description="Every file the scan read is matched, ignored or imported."
              :actions="[{ label: 'Open Matched', to: '/scan', color: 'neutral', variant: 'outline' }]"
            />
            <div v-else class="space-y-3">
              <ScanFolderCard
                v-for="group in groups"
                :key="folderKey(group)"
                :group="group"
                :scan-run-id="runId"
                :library="libraryOf(group.libraryKind)"
                :profile-name="profileNameOf(group.libraryKind)"
              />
              <UButton v-if="hasMore" size="sm" color="neutral" variant="outline" label="Load more folders" @click="loadMore" />
            </div>
          </template>
        </ScanState>

        <details v-if="ignored && ignored.length > 0" class="text-sm">
          <summary class="cursor-pointer text-muted">{{ ignoredLine(ignored.length) }}</summary>
          <ul class="mt-2 divide-y divide-default rounded-lg ring ring-default">
            <li v-for="entry in ignored" :key="folderKey(entry)" class="flex items-center gap-2 px-3 py-1.5">
              <span class="font-mono text-xs break-all">{{ entry.path }}</span>
              <UButton class="ms-auto" size="xs" color="neutral" variant="ghost" label="Stop ignoring" @click="onUnignore(entry)" />
            </li>
          </ul>
        </details>
      </PageBody>
    </template>
  </UDashboardPanel>
</template>
