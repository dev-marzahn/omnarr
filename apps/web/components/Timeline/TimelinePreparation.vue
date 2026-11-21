<!--
  One Rendition on the item page: its own
  "Preparation" entry outside the runs, with its events, among them the
  dropped-track note, and Cancel while it is pending.
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';
import type { Id } from '@omnarr/backend/dataModel';

import { entryHeader, entryTitle, type PreparationEntry } from '~/lib/preparation';

const props = defineProps<{ entry: PreparationEntry; unitId: Id<'units'> }>();
const toast = useToast();
const header = computed(() => entryHeader(props.entry));
const title = computed(() => entryTitle(props.entry));
const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit', second: '2-digit' });

const cancelPreparation = useMutation(api.api.units.cancelPreparation);
const cancelling = ref(false);
async function cancel() {
  cancelling.value = true;
  try {
    await cancelPreparation({ unitId: props.unitId });
  } catch {
    toast.add({ title: "The preparation couldn't be cancelled", description: 'Try again.', color: 'error', icon: 'i-lucide-triangle-alert' });
  } finally {
    cancelling.value = false;
  }
}
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex flex-wrap items-center gap-2">
        <UIcon name="i-lucide-wand-sparkles" class="text-secondary" />
        <h3 class="font-medium">{{ title }}</h3>
        <UBadge :color="header.color" variant="subtle" :label="header.state" />
        <span class="text-xs text-muted tabular-nums">
          {{ time.format(entry.startedAt) }}<template v-if="entry.endedAt"> → {{ time.format(entry.endedAt) }}</template>
        </span>
        <UButton
          v-if="entry.state === 'pending'"
          size="xs"
          color="neutral"
          variant="outline"
          label="Cancel preparation"
          class="ms-auto"
          :loading="cancelling"
          @click="cancel"
        />
      </div>
    </template>
    <ul class="space-y-1">
      <TimelineStage v-for="(stage, i) in entry.events" :key="i" :stage="stage" />
    </ul>
  </UCard>
</template>
