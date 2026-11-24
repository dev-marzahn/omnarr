<!--
  The System page: omnarr's running version (with room for a release-check
  note), the worker and Jellyfin, the download clients and the VPN as one
  line each, free space per filesystem with the storage warnings, indexer
  health and the job queue, from system.status. "Support bundle" in the
  header bar with the latest bundle's download and line, and the Jellyfin
  card's fix from the open Jellyfin Issues.
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';
import type { Id } from '@omnarr/backend/dataModel';

import { VPN_KINDS } from '~/lib/downloads';
import { HEALTH_LABEL } from '~/lib/indexers';
import { actErrorMessage } from '~/lib/issues';
import { jellyfinCardActions } from '~/lib/jellyfin';
import {
  clientStatus,
  jellyfinLibrariesLine,
  jellyfinStateLabel,
  jellyfinVersionLine,
  setupStepRows,
  storageGroups,
  storageNotes,
  storageWarnings,
  supportBundleLine,
  updateNote,
  videoEncoders,
  vpnLine,
  workerLine,
} from '~/lib/system';
import { rewriteStorageUrl } from '~/lib/urls';

const urls = useUrls();
const { data, error } = useQuery(api.api.system.status, {});
// The VPN's kind names who forwards the peer port.
const { data: downloads } = useQuery(api.api.downloadClients.get, {});
const vpnKind = computed(() => downloads.value?.vpn.kind);
const clients = computed(() => (data.value?.clients ?? []).map((row) => ({ row, ...clientStatus(row, vpnKind.value) })));
const vpn = computed(() => {
  const runtime = data.value?.clients.find((row) => row.clientKind === 'qbittorrent')?.vpn;
  if (!runtime || runtime.state === 'off') return undefined;
  return { ...vpnLine(runtime), provider: VPN_KINDS.find((kind) => kind.value === vpnKind.value)?.label };
});
const jellyfin = computed(() => data.value?.jellyfin);
const jellyfinColor = computed(() =>
  jellyfin.value?.state === 'ready' ? ('success' as const) : jellyfin.value?.state === 'blocked' ? ('error' as const) : ('neutral' as const),
);
const jellyfinAddress = useJellyfinAddress();
const rerunOpen = ref(false);

// The Jellyfin card's fixes follow the open Jellyfin Issues.
const { data: issues } = useQuery(api.api.issues.list, {});
const jellyfinFixes = computed(() => (issues.value ? jellyfinCardActions(issues.value) : []));
const act = useMutation(api.api.issues.act);
const toast = useToast();
const retrying = ref(false);
async function onJellyfinFix(fix: ReturnType<typeof jellyfinCardActions>[number]) {
  if (fix.action === 'rerunJellyfinSetup') return (rerunOpen.value = true);
  retrying.value = true;
  try {
    for (const issueId of fix.issueIds) await act({ issueId: issueId as Id<'issues'>, action: 'retryNow' });
    toast.add({ title: 'Publishing again', color: 'success', icon: 'i-lucide-rotate-cw' });
  } catch (error) {
    toast.add({ title: "Retry now didn't run", description: actErrorMessage(error), color: 'error', icon: 'i-lucide-triangle-alert' });
  } finally {
    retrying.value = false;
  }
}

// "Support bundle" in the header bar: queue a build, then download the newest one.
const buildBundle = useMutation(api.api.system.buildSupportBundle);
const building = ref(false);
// The bundle shown when the build was asked for: the build is pending until a newer one is there.
const before = ref<number | null>();
const bundle = computed(() => data.value?.supportBundle);
const bundlePending = computed(() => building.value || (before.value !== undefined && (bundle.value?.builtAt ?? null) === before.value));
async function onBuildBundle() {
  building.value = true;
  try {
    before.value = bundle.value?.builtAt ?? null;
    await buildBundle({});
  } catch {
    toast.add({ title: "The support bundle couldn't be queued", description: 'Try again.', color: 'error', icon: 'i-lucide-triangle-alert' });
  } finally {
    building.value = false;
  }
}
const headerActions = computed(() => [
  ...(bundle.value && !bundlePending.value
    ? [{ label: 'Download bundle', icon: 'i-lucide-file-down', to: rewriteStorageUrl(bundle.value.url, urls.convex), target: '_blank' }]
    : []),
  {
    label: bundlePending.value ? 'Building…' : 'Support bundle',
    icon: 'i-lucide-package',
    loading: bundlePending.value,
    disabled: bundlePending.value,
    onClick: onBuildBundle,
  },
]);
const time = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const worker = computed(() => data.value?.worker);
const workerState = computed(() =>
  !worker.value
    ? { label: 'Not connected', color: 'neutral' as const }
    : !worker.value.accepted
      ? { label: 'Refused', color: 'error' as const }
      : worker.value.connected
        ? { label: 'Online', color: 'success' as const }
        : { label: 'Offline', color: 'error' as const },
);
const encoders = computed(() => (worker.value ? videoEncoders(worker.value.encoders) : []));
const card = { header: 'py-3 sm:py-3', body: 'p-0 sm:p-0' };
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <PageHeader title="System" :actions="headerActions" />
    </template>
    <template #body>
      <PageBody>
        <UAlert
          v-if="error"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          title="The system status couldn't be loaded."
          :description="error.message"
        />

        <template v-else-if="data">
          <UAlert
            v-for="warning in data.storage ? storageWarnings(data.storage).filter((w) => w.color === 'error') : []"
            :key="warning.title"
            color="error"
            variant="subtle"
            icon="i-lucide-hard-drive"
            :title="warning.title"
            :description="warning.description"
          />

          <!-- The running version, and the daily release check's note. -->
          <div class="flex flex-wrap items-center gap-x-4 gap-y-1 rounded-lg ring ring-default px-4 py-3">
            <div class="min-w-0">
              <!-- The release the backend applied (CONVEX_RELEASE_VERSION). -->
              <p class="font-medium text-highlighted">omnarr {{ data.release.version === '0.0.0-dev' ? 'development build' : data.release.version }}</p>
              <p class="text-xs text-dimmed">Worker protocol v{{ worker?.expectedVersion ?? '—' }}</p>
            </div>
            <ULink v-if="updateNote(data.release)" :to="updateNote(data.release)!.url" target="_blank" class="text-sm font-medium text-primary">
              <UIcon name="i-lucide-arrow-up-circle" class="align-[-2px]" />
              {{ updateNote(data.release)!.text }}
            </ULink>
            <p class="ms-auto text-xs text-muted">
              <UIcon name="i-lucide-package" class="align-[-2px]" />
              {{ supportBundleLine(bundle) ? `Support bundle: ${supportBundleLine(bundle)}` : 'No support bundle yet' }}
            </p>
          </div>

          <div class="grid gap-4 sm:gap-6 lg:grid-cols-2">
            <UCard :ui="{ header: card.header }">
              <template #header>
                <div class="flex items-center gap-2">
                  <h2 class="text-sm font-semibold text-highlighted">Worker</h2>
                  <UBadge size="sm" :color="workerState.color" variant="subtle" :label="workerState.label" />
                </div>
              </template>
              <p v-if="!worker" class="text-sm text-muted">
                No worker has connected yet. Check that the worker container is running: <code>docker compose ps worker</code>.
              </p>
              <dl v-else class="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-y-1.5 text-sm">
                <dt class="text-muted">Status</dt>
                <dd>{{ workerLine(worker) }}</dd>
                <dt class="text-muted">Last heartbeat</dt>
                <dd class="tabular-nums">{{ time.format(worker.lastSeenAt) }}</dd>
                <dt class="text-muted">Protocol</dt>
                <dd>
                  v{{ worker.protocolVersion }}
                  <span v-if="worker.protocolVersion === worker.expectedVersion" class="text-muted">· matches</span>
                  <span v-else class="text-error"
                    >· this release needs v{{ worker.expectedVersion }}; the worker claims no jobs and tries again every 60 s</span
                  >
                </dd>
                <dt class="text-muted">Worker ID</dt>
                <dd class="truncate">{{ worker.workerId }}</dd>
                <dt class="text-muted">ffmpeg</dt>
                <dd class="min-w-0">
                  {{ worker.ffmpegVersion }}
                  <UCollapsible v-if="worker.encoders.length" class="mt-1">
                    <UButton
                      size="xs"
                      color="neutral"
                      variant="link"
                      class="px-0"
                      trailing-icon="i-lucide-chevron-down"
                      :label="`Encoders (${worker.encoders.length})`"
                    />
                    <template #content>
                      <ul class="mt-1 space-y-0.5 text-xs">
                        <li v-for="group in encoders" :key="group.codec">
                          <span class="inline-block w-12 text-muted">{{ group.codec }}</span>
                          software {{ group.software.join(', ') || 'none' }} · hardware {{ group.hardware.join(', ') || 'none' }}
                        </li>
                      </ul>
                      <p class="mt-1 text-xs text-dimmed break-words">{{ worker.encoders.join(', ') }}</p>
                    </template>
                  </UCollapsible>
                </dd>
              </dl>
            </UCard>

            <UCard v-if="jellyfin" :ui="{ header: card.header }">
              <template #header>
                <div class="flex items-center gap-2">
                  <h2 class="text-sm font-semibold text-highlighted">Jellyfin</h2>
                  <UBadge size="sm" :color="jellyfinColor" variant="subtle" :label="jellyfinStateLabel(jellyfin.state)" />
                  <!-- The open Jellyfin Issues decide the button; none open, none shown. -->
                  <span class="flex-1" />
                  <UButton
                    v-for="fix in jellyfinFixes"
                    :key="fix.action"
                    size="sm"
                    color="neutral"
                    variant="outline"
                    :icon="fix.action === 'retryNow' ? 'i-lucide-rotate-cw' : 'i-lucide-settings'"
                    :label="fix.label"
                    :loading="retrying && fix.action === 'retryNow'"
                    @click="onJellyfinFix(fix)"
                  />
                </div>
              </template>
              <dl class="grid grid-cols-[8.5rem_minmax(0,1fr)] gap-y-1.5 text-sm">
                <template v-if="jellyfinVersionLine(jellyfin)">
                  <dt class="text-muted">Version</dt>
                  <dd :class="jellyfin.pinned ? '' : 'text-warning'">{{ jellyfinVersionLine(jellyfin) }}</dd>
                </template>
                <dt class="text-muted">Libraries</dt>
                <dd>{{ jellyfinLibrariesLine(jellyfin) }}</dd>
                <template v-if="jellyfin.lastSetupAt">
                  <dt class="text-muted">Last setup</dt>
                  <dd class="tabular-nums">{{ time.format(jellyfin.lastSetupAt) }}</dd>
                </template>
                <dt class="text-muted">Address</dt>
                <dd class="truncate">
                  <code>{{ jellyfinAddress }}</code>
                </dd>
              </dl>
              <ul v-if="jellyfin.state !== 'ready' && jellyfin.steps.length" class="mt-3 text-sm space-y-0.5">
                <li v-for="row in setupStepRows(jellyfin.steps)" :key="row.label">
                  <UIcon
                    :name="row.state === 'done' ? 'i-lucide-check' : row.state === 'failed' ? 'i-lucide-x' : 'i-lucide-circle-dashed'"
                    :class="row.state === 'failed' ? 'text-error' : 'text-muted'"
                  />
                  {{ row.label }}
                  <span v-if="row.reason" class="text-error">· {{ row.reason }}</span>
                </li>
              </ul>
              <JellyfinRerunDialog v-model:open="rerunOpen" />
            </UCard>
          </div>

          <UCard :ui="card">
            <template #header>
              <div class="flex flex-wrap items-center gap-x-2">
                <h2 class="text-sm font-semibold text-highlighted">Download clients</h2>
                <span class="ms-auto hidden sm:inline text-xs text-muted">
                  Managed by omnarr · change them in
                  <NuxtLink to="/settings/downloads" class="underline">Settings › Downloads</NuxtLink>
                </span>
              </div>
            </template>
            <ul class="divide-y divide-default text-sm">
              <li
                v-for="client in clients"
                :key="client.name"
                class="grid gap-x-4 gap-y-1 px-4 py-3 sm:px-6 sm:grid-cols-[10rem_minmax(0,1fr)_auto] sm:items-center"
              >
                <div>
                  <p class="font-medium text-highlighted">{{ client.name }}</p>
                  <p v-if="client.version" class="text-xs text-dimmed">{{ client.version }}</p>
                </div>
                <div class="min-w-0 text-xs text-muted">
                  <p>{{ client.line }}</p>
                  <p v-for="warning in client.warnings ?? []" :key="warning" class="text-warning">
                    <UIcon name="i-lucide-triangle-alert" class="align-[-2px]" />
                    {{ warning }}
                  </p>
                </div>
                <UBadge size="sm" variant="subtle" :color="client.badge.color" :label="client.badge.label" class="justify-self-start sm:justify-self-end" />
              </li>
              <li v-if="vpn" class="grid gap-x-4 gap-y-1 px-4 py-3 sm:px-6 sm:grid-cols-[10rem_minmax(0,1fr)_auto] sm:items-center">
                <div>
                  <p class="font-medium text-highlighted">VPN</p>
                  <p v-if="vpn.provider" class="text-xs text-dimmed">{{ vpn.provider }} · gluetun</p>
                </div>
                <div class="min-w-0 text-xs text-muted">
                  <p>{{ vpn.line }}</p>
                  <p v-if="vpn.step" class="text-warning">
                    <UIcon name="i-lucide-triangle-alert" class="align-[-2px]" />
                    <DownloadsCodeText :text="vpn.step" />
                  </p>
                </div>
                <UBadge size="sm" variant="subtle" :color="vpn.badge.color" :label="vpn.badge.label" class="justify-self-start sm:justify-self-end" />
              </li>
            </ul>
          </UCard>

          <div class="grid gap-4 sm:gap-6 lg:grid-cols-2">
            <UCard v-if="data.storage" :ui="card">
              <template #header>
                <div class="flex items-center gap-2">
                  <h2 class="text-sm font-semibold text-highlighted">Free space</h2>
                  <span class="ms-auto text-xs text-muted tabular-nums">reported {{ clock.format(data.storage.reportedAt) }}</span>
                </div>
              </template>
              <ul class="divide-y divide-default text-sm">
                <li v-for="row in storageGroups(data.storage)" :key="row.label" class="flex items-center gap-3 px-4 py-3 sm:px-6">
                  <span class="flex-1 min-w-0">{{ row.label }}</span>
                  <span v-if="!row.writable" class="text-xs text-error">not writable</span>
                  <span class="tabular-nums text-highlighted">{{ row.free }}</span>
                </li>
                <li v-if="storageNotes(data.storage).length > 0" class="px-4 py-3 sm:px-6 text-xs text-muted">
                  <p v-for="note in storageNotes(data.storage)" :key="note">{{ note }}</p>
                </li>
                <li v-for="warning in storageWarnings(data.storage).filter((w) => w.color === 'warning')" :key="warning.title" class="px-4 py-3 sm:px-6">
                  <UAlert color="warning" variant="subtle" icon="i-lucide-hard-drive" :title="warning.title" :description="warning.description" />
                </li>
              </ul>
            </UCard>

            <UCard :ui="card">
              <template #header>
                <div class="flex flex-wrap items-center gap-x-2">
                  <h2 class="text-sm font-semibold text-highlighted">Indexers</h2>
                  <span class="ms-auto text-xs text-muted">search errors show here, not under Issues</span>
                </div>
              </template>
              <p v-if="data.indexers.length === 0" class="px-4 py-3 sm:px-6 text-sm text-muted">
                No indexer yet. <NuxtLink to="/settings/indexers" class="underline">Add one</NuxtLink>.
              </p>
              <ul v-else class="divide-y divide-default text-sm">
                <li v-for="indexer in data.indexers" :key="indexer.indexerId" class="flex items-center gap-3 px-4 py-3 sm:px-6">
                  <span class="flex-1 min-w-0 truncate">
                    {{ indexer.name }}
                    <span v-if="indexer.health.latencyMs !== undefined" class="text-xs text-dimmed tabular-nums">{{ indexer.health.latencyMs }} ms</span>
                  </span>
                  <UBadge
                    v-if="indexer.enabled"
                    size="sm"
                    variant="subtle"
                    :color="HEALTH_LABEL[indexer.health.status].color"
                    :label="HEALTH_LABEL[indexer.health.status].label"
                  />
                  <span v-else class="text-xs text-muted">Disabled</span>
                </li>
              </ul>
            </UCard>

            <DefinitionsCard :ui="card" />
          </div>

          <!-- The counts are in the support bundle too, so a phone leaves the table out. -->
          <UCard :ui="card" class="hidden sm:block">
            <template #header><h2 class="text-sm font-semibold text-highlighted">Job queue</h2></template>
            <table class="w-full text-sm">
              <thead class="text-left text-xs text-highlighted">
                <tr class="border-b border-default">
                  <th class="px-6 py-2 font-semibold">Class</th>
                  <th class="w-40 px-6 py-2 font-semibold whitespace-nowrap">On the worker</th>
                  <th class="w-40 px-6 py-2 font-semibold whitespace-nowrap">Queued</th>
                  <th class="w-40 px-6 py-2 font-semibold whitespace-nowrap">Backing off</th>
                </tr>
              </thead>
              <tbody class="divide-y divide-default">
                <tr v-for="row in data.jobCounts" :key="row.class">
                  <td class="px-6 py-2">{{ row.class }}</td>
                  <td class="px-6 py-2 tabular-nums">{{ row.leased }}</td>
                  <td class="px-6 py-2 tabular-nums">{{ row.queued }}</td>
                  <td class="px-6 py-2 tabular-nums">{{ row.waiting }}</td>
                </tr>
              </tbody>
            </table>
          </UCard>
        </template>
      </PageBody>
    </template>
  </UDashboardPanel>
</template>
