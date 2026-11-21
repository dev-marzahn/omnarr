<!--
  Automatic setup: the worker, the download clients and Jellyfin's five
  steps, live. Once the worker is connected it starts the first-run scan;
  Continue unlocks when that scan has ended, with or without Jellyfin (an
  open Jellyfin Issue stays under Issues). The fixes: "Set up Jellyfin
  again" for a setup or password Issue, "Retry now" when Jellyfin didn't
  respond.
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';
import type { Id } from '@omnarr/backend/dataModel';
import type { FailureCode } from '@omnarr/contracts';

import { advanceTarget, canContinue, checklist, COPY, shouldStartScan } from '~/lib/firstRun';
import { jellyfinCardActions } from '~/lib/jellyfin';

definePageMeta({ layout: 'setup', step: 'finish' });

const { data: status } = useQuery(api.api.system.status, {});
const { data: clients } = useQuery(api.api.downloadClients.get, {});
const { data: issues } = useQuery(api.api.issues.list, {});
const { data: scan } = useQuery(api.api.scan.status, {});
const startScan = useMutation(api.api.scan.start);
const act = useMutation(api.api.issues.act);
const advance = useAdvance();

const jellyfinCodes = computed<FailureCode[]>(() => (issues.value ? [...issues.value.system, ...issues.value.needsAction].map((row) => row.failureCode) : []));
const view = computed(() => (status.value && clients.value ? checklist(status.value, clients.value, jellyfinCodes.value) : undefined));
const fixes = computed(() => (issues.value ? jellyfinCardActions(issues.value) : []));
const ready = computed(() => Boolean(status.value && scan.value && canContinue(status.value, scan.value)));
const target = computed(() => (scan.value ? advanceTarget(scan.value) : 'done'));

// The first-run scan, once, after the worker connects; "scanRunning" means one has started.
let starting = false;
watch(
  [() => status.value?.worker?.connected, scan],
  async ([connected, current]) => {
    if (!connected || !current || starting || !shouldStartScan(current)) return;
    starting = true;
    await startScan({ trigger: 'firstRun' }).catch((error: unknown) => {
      if (errorCode(error) !== 'scanRunning') starting = false;
    });
  },
  { immediate: true },
);

const rerunOpen = ref(false);
const retrying = ref(false);
async function onFix(fix: (typeof fixes.value)[number]) {
  if (fix.action === 'rerunJellyfinSetup') return (rerunOpen.value = true);
  retrying.value = true;
  try {
    for (const issueId of fix.issueIds) await act({ issueId: issueId as Id<'issues'>, action: 'retryNow' });
  } finally {
    retrying.value = false;
  }
}
const pending = ref(false);
async function next() {
  pending.value = true;
  await advance(target.value).finally(() => (pending.value = false));
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <div>
      <h1 class="text-xl font-bold text-highlighted">Automatic setup</h1>
      <p class="text-sm text-muted">omnarr sets up NZBGet, qBittorrent and Jellyfin for you. This takes a minute.</p>
    </div>
    <UCard v-if="view">
      <SetupFirstRunChecklist :lines="view.lines" />
      <UAlert v-if="view.mismatch" class="mt-4" color="error" variant="subtle" icon="i-lucide-triangle-alert" :title="view.mismatch" />
      <UAlert v-if="view.jellyfinNote" class="mt-4" color="warning" variant="subtle" icon="i-lucide-triangle-alert" :title="view.jellyfinNote" />
      <div v-if="fixes.length" class="mt-4 flex flex-wrap gap-2">
        <UButton
          v-for="fix in fixes"
          :key="fix.action"
          color="neutral"
          variant="outline"
          :label="fix.label"
          :loading="fix.action === 'retryNow' && retrying"
          @click="onFix(fix)"
        />
      </div>
    </UCard>
    <UAlert v-if="ready && target === 'done'" color="success" variant="subtle" icon="i-lucide-party-popper" :title="COPY.done" />
    <div class="flex items-center gap-2 max-lg:flex-col-reverse max-lg:items-stretch">
      <UButton color="neutral" variant="link" to="/setup/metadata" icon="i-lucide-arrow-left" label="Back" />
      <UButton
        class="lg:ms-auto max-lg:justify-center"
        :disabled="!ready"
        :loading="pending"
        :label="target === 'done' ? 'Find a series or movie' : 'Continue to omnarr'"
        @click="next"
      />
    </div>
    <JellyfinRerunDialog v-model:open="rerunOpen" />
  </div>
</template>
