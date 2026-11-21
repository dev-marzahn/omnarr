<!--
  A search's decision records: this episode's releases, or all of them,
  with the source, size, score and its breakdown, quality, preparation and
  the decision with its detail (what an unclear release could be, the
  language, when it was blocklisted). On an offered "Search and pick" every
  row has a Grab, rejected and unclear ones too; the row ranked first is
  primary and "Would pick". Cards below sm. Read from stored rows only.
-->
<script setup lang="ts">
import type { CandidateRow, TimelineSearch } from '@omnarr/contracts';

import { formatBytes } from '~/lib/system';
import { breakdownText, decisionDetail, decisionText, grabButton, qualityText } from '~/lib/timeline';

const props = withDefaults(defineProps<{ candidates: CandidateRow[]; search?: TimelineSearch; now?: number }>(), { search: undefined, now: () => Date.now() });
const emit = defineEmits<{ grab: [candidate: CandidateRow] }>();
const view = ref<'mine' | 'all'>('mine');
const rows = computed(() => (view.value === 'all' ? props.candidates : props.candidates.filter((c) => c.coversUnit)));
const grabOf = (c: CandidateRow) => (props.search ? grabButton(c, props.search, props.now) : { show: false });
const grabbable = computed(() => props.candidates.some((c) => grabOf(c).show));
const age = (publishedAt: number) => {
  const days = Math.max(0, Math.floor((props.now - publishedAt) / 86_400_000));
  return days === 0 ? 'today' : `${days} ${days === 1 ? 'day' : 'days'} old`;
};
const source = (c: CandidateRow) =>
  [
    c.indexerName,
    c.protocol === 'torrent' ? 'Torrent' : 'Usenet',
    age(c.publishedAt),
    ...(c.torrent?.seeders !== undefined ? [`${c.torrent.seeders} seeders`] : []),
  ].join(' · ');
const color = (c: CandidateRow) =>
  c.outcome === 'picked' || (c.outcome === 'pending' && c.rank === 1) ? 'success' : c.matchProblem === 'ambiguous' ? 'warning' : 'neutral';
</script>

<template>
  <div class="space-y-2">
    <UTabs
      v-model="view"
      size="xs"
      variant="pill"
      :content="false"
      :items="[
        { label: `This episode ${candidates.filter((c) => c.coversUnit).length}`, value: 'mine' },
        { label: `All ${candidates.length}`, value: 'all' },
      ]"
    />
    <p v-if="rows.length === 0" class="text-sm text-muted">No release for this episode. "All" lists the releases of other episodes.</p>

    <!-- Desktop: a table, to compare across columns. -->
    <div v-else class="hidden sm:block overflow-x-auto">
      <table class="text-sm w-full">
        <thead class="text-muted text-left">
          <tr>
            <th class="font-normal">#</th>
            <th class="font-normal">Release</th>
            <th class="font-normal">Size</th>
            <th class="font-normal">Score</th>
            <th class="font-normal">Quality and preparation</th>
            <th class="font-normal">Decision</th>
            <th v-if="grabbable" class="font-normal"><span class="sr-only">Grab</span></th>
          </tr>
        </thead>
        <tbody class="divide-y divide-default">
          <tr v-for="c in rows" :key="c.candidateId" class="align-top">
            <td class="tabular-nums text-muted py-1.5">{{ c.rank ?? '' }}</td>
            <td class="py-1.5 pe-3">
              <p class="break-all">{{ c.title }}</p>
              <p class="text-xs text-muted">{{ source(c) }}</p>
            </td>
            <td class="tabular-nums whitespace-nowrap py-1.5">{{ formatBytes(c.sizeBytes) }}</td>
            <td class="py-1.5">
              <p class="tabular-nums">{{ c.score }}</p>
              <p v-for="entry in c.breakdown" :key="entry.name" class="text-xs text-muted whitespace-nowrap">
                {{ breakdownText(entry, c.preparationAssumed) }}
              </p>
            </td>
            <td class="py-1.5">
              <p>{{ qualityText(c) }}</p>
              <p class="text-xs text-muted">
                Preparation: {{ c.preparationStep === 'none' ? 'none' : c.preparationStep }}{{ c.preparationAssumed ? ' (assumed)' : '' }}
              </p>
            </td>
            <td class="py-1.5">
              <UBadge :color="color(c)" variant="subtle" :label="decisionText(c)" />
              <p v-if="decisionDetail(c)" class="mt-0.5 text-xs text-muted">{{ decisionDetail(c) }}</p>
            </td>
            <td v-if="grabbable" class="py-1.5 text-right">
              <UTooltip v-if="grabOf(c).show" :text="grabOf(c).disabled ?? ''" :disabled="!grabOf(c).disabled">
                <UButton
                  size="xs"
                  :color="grabOf(c).primary ? 'primary' : 'neutral'"
                  :variant="grabOf(c).primary ? 'solid' : 'outline'"
                  label="Grab"
                  :disabled="!!grabOf(c).disabled"
                  @click="emit('grab', c)"
                />
              </UTooltip>
            </td>
          </tr>
        </tbody>
      </table>
    </div>

    <!-- Phone: a card per release. -->
    <ul v-if="rows.length" class="sm:hidden divide-y divide-default rounded-lg ring ring-default">
      <li v-for="c in rows" :key="c.candidateId" class="space-y-1.5 px-3 py-3 text-sm">
        <p class="break-all font-medium text-highlighted">{{ c.title }}</p>
        <p class="text-xs text-muted">{{ source(c) }}</p>
        <p class="text-xs text-muted tabular-nums">{{ formatBytes(c.sizeBytes) }} · score {{ c.score }} · {{ qualityText(c) }}</p>
        <div class="flex items-start gap-2">
          <div class="min-w-0 flex-1">
            <UBadge :color="color(c)" variant="subtle" :label="decisionText(c)" />
            <p v-if="decisionDetail(c)" class="mt-0.5 text-xs text-muted">{{ decisionDetail(c) }}</p>
          </div>
          <UButton
            v-if="grabOf(c).show"
            size="xs"
            :color="grabOf(c).primary ? 'primary' : 'neutral'"
            :variant="grabOf(c).primary ? 'solid' : 'outline'"
            :label="grabOf(c).disabled ?? 'Grab'"
            :disabled="!!grabOf(c).disabled"
            @click="emit('grab', c)"
          />
        </div>
      </li>
    </ul>
  </div>
</template>
