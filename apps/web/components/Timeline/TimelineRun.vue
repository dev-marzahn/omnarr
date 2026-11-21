<!--
  One run (one Grab): its header with the run ID to copy, the search it
  came from, its stages, the client's raw status on demand, and "Cancel
  grab" with the blocklist choice while it runs.
-->
<script setup lang="ts">
import type { TimelineRun } from '@omnarr/contracts';

import { copyText } from '~/lib/browser';
import { isPickStage, pickStepText, runHeader, searchSummary, shortRunId, triggerLabel } from '~/lib/timeline';

const props = defineProps<{ run: TimelineRun; number: number; recovered?: boolean }>();
// A manual grab: "Picked by you", and its pick step names what the release was picked over.
const picked = computed(() => props.run.search.candidates.find((c) => c.outcome === 'picked' && c.pickedBy === 'user'));
const stageText = (stage: TimelineRun['stages'][number]) => (isPickStage(stage) ? pickStepText(stage, picked.value) : undefined);
// A failed run a later run took over from starts collapsed.
const expanded = ref(false);
const open = computed(() => !props.recovered || expanded.value);
const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const header = computed(() => runHeader(props.run, props.number));
const running = computed(() => !['done', 'failed', 'cancelled'].includes(props.run.state));
const showCandidates = ref(false);
const showStatus = ref(false);
const copy = () => copyText(props.run.grabId);
</script>

<template>
  <UCard :ui="{ header: open ? undefined : 'border-b-0', body: open ? undefined : 'hidden' }">
    <template #header>
      <div class="flex flex-wrap items-center gap-2">
        <h3 class="text-sm font-semibold text-highlighted">{{ header.label }}</h3>
        <UBadge size="sm" :color="header.color" variant="subtle" :label="header.state" />
        <UBadge v-if="run.pickedBy === 'user'" size="sm" color="secondary" variant="subtle" icon="i-lucide-hand" label="Picked by you" />
        <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-copy" :label="shortRunId(run.grabId)" title="Copy run ID" @click="copy" />
        <span class="flex-1" />
        <span class="text-xs text-muted tabular-nums">{{ clock.format(run.startedAt) }}<template v-if="recovered"> · recovered on its own</template></span>
        <TimelineCancelGrab v-if="running && !run.cancelRequested" :grab-id="run.grabId" />
        <UButton
          v-if="recovered"
          size="xs"
          color="neutral"
          variant="ghost"
          square
          :icon="open ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
          :aria-label="open ? 'Collapse run' : 'Expand run'"
          :aria-expanded="open"
          @click="expanded = !expanded"
        />
      </div>
      <p v-if="open" class="mt-1 text-xs font-mono text-muted break-all">{{ run.title }}</p>
    </template>

    <div v-if="open" class="space-y-3">
      <div class="text-sm">
        <UBadge size="sm" color="neutral" variant="outline" :label="triggerLabel(run.search.trigger)" />
        <span class="text-muted ms-2">{{ searchSummary(run.search) }}</span>
        <UButton
          size="xs"
          color="neutral"
          variant="link"
          :label="showCandidates ? 'Hide candidates' : 'See candidates'"
          @click="showCandidates = !showCandidates"
        />
      </div>
      <TimelineCandidateTable v-if="showCandidates" :candidates="run.search.candidates" />

      <ul class="space-y-1">
        <TimelineStage
          v-for="(stage, i) in run.stages"
          :key="i"
          :stage="stage"
          :text="stageText(stage)"
          :detail="isPickStage(stage) ? picked?.title : undefined"
        />
      </ul>

      <div v-if="run.download?.clientStatus">
        <UButton size="xs" color="neutral" variant="link" :label="showStatus ? 'Hide client details' : 'Client details'" @click="showStatus = !showStatus" />
        <dl v-if="showStatus" class="grid grid-cols-[10rem_1fr] text-xs gap-y-0.5">
          <template v-for="(value, key) in run.download.clientStatus.raw" :key="key">
            <dt class="text-muted">{{ key }}</dt>
            <dd>{{ value }}</dd>
          </template>
        </dl>
      </div>
    </div>
  </UCard>
</template>
