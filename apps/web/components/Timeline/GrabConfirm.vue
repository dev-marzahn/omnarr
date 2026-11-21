<!--
  The grab confirm: its title and button name the Units
  the grab covers, the release line, one box for what the row's rejection
  means for this grab, and the note that a picked release isn't followed by
  another by itself. The rejection goes back as `confirmReason`. A refused
  grab says why and offers Search again or Cancel grab.
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';
import type { Id } from '@omnarr/backend/dataModel';
import type { CandidateRow, GrabCandidateResponse } from '@omnarr/contracts';

import { formatBytes } from '~/lib/system';
import { grabbedToast, grabConfirm, grabRefusal, grabUnitsLabel } from '~/lib/timeline';

const props = defineProps<{
  candidate: CandidateRow;
  unitTitle?: string;
  workTitle?: string;
  /** The runs the item has, oldest first: the new run's number, and a running Grab's. */
  runIds: string[];
}>();
const emit = defineEmits<{ grabbed: []; searchAgain: [] }>();
const open = defineModel<boolean>('open', { required: true });

const grab = useMutation(api.api.units.grabCandidate);
const toast = useToast();
const text = computed(() => grabConfirm(props.candidate, { unitTitle: props.unitTitle, workTitle: props.workTitle }));
const units = computed(() => grabUnitsLabel(props.candidate));
const age = computed(() => {
  const days = Math.max(0, Math.floor((Date.now() - props.candidate.publishedAt) / 86_400_000));
  return days === 0 ? 'today' : `${days} ${days === 1 ? 'day' : 'days'} old`;
});
const release = computed(() =>
  [
    props.candidate.indexerName,
    props.candidate.protocol === 'torrent' ? 'Torrent' : 'Usenet',
    formatBytes(props.candidate.sizeBytes),
    age.value,
    `score ${props.candidate.score}`,
  ].join(' · '),
);

const running = ref(false);
const refused = ref<{ text: string; action?: 'searchAgain' | 'cancelGrab' }>();
const busyGrab = ref<Id<'grabs'>>();
const cancelOpen = ref(false);
watch(open, (value) => {
  if (value) refused.value = undefined;
});

async function submit() {
  running.value = true;
  try {
    const result: GrabCandidateResponse = await grab({
      candidateId: props.candidate.candidateId,
      ...(props.candidate.reason ? { confirmReason: props.candidate.reason } : {}),
    });
    if (result.outcome === 'grabbed') {
      open.value = false;
      toast.add({ title: grabbedToast(units.value, props.runIds.length + 1), color: 'success', icon: 'i-lucide-arrow-down-to-line' });
      emit('grabbed');
      return;
    }
    if (result.outcome === 'busy') busyGrab.value = result.grabId;
    const run = result.outcome === 'busy' ? props.runIds.indexOf(result.grabId) + 1 : 0;
    refused.value = grabRefusal(result, units.value, run > 0 ? run : undefined);
  } catch {
    refused.value = { text: "The grab couldn't start. Try again." };
  } finally {
    running.value = false;
  }
}
</script>

<template>
  <UModal v-model:open="open" :title="text.title" :ui="{ content: 'sm:max-w-lg' }">
    <template #body>
      <div class="space-y-3 text-sm">
        <div>
          <p class="font-mono text-xs break-all text-highlighted">{{ candidate.title }}</p>
          <p class="text-xs text-muted">{{ release }}</p>
        </div>
        <UAlert v-for="box in text.boxes" :key="box.text" :color="box.kind === 'warning' ? 'warning' : 'info'" variant="subtle" :description="box.text" />
        <p class="text-muted">{{ text.note }}</p>
        <UAlert v-if="refused" color="error" variant="subtle" icon="i-lucide-triangle-alert" :description="refused.text" />
      </div>
    </template>
    <template #footer>
      <div class="flex w-full flex-wrap justify-end gap-2">
        <UButton color="neutral" variant="ghost" label="Cancel" @click="open = false" />
        <UButton
          v-if="refused?.action === 'searchAgain'"
          icon="i-lucide-search"
          label="Search again"
          @click="
            open = false;
            emit('searchAgain');
          "
        />
        <UButton v-else-if="refused?.action === 'cancelGrab'" color="error" variant="soft" icon="i-lucide-x" label="Cancel grab" @click="cancelOpen = true" />
        <UButton v-else-if="!refused" icon="i-lucide-arrow-down-to-line" :label="text.button" :loading="running" @click="submit" />
      </div>
    </template>
  </UModal>
  <TimelineCancelGrab v-if="busyGrab" v-model:open="cancelOpen" :grab-id="busyGrab" hide-button />
</template>
