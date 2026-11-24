<!--
  A Work in the library grid: its poster with the download or
  failure badge, the state bar, and the title, year, tags and status line.
-->
<script setup lang="ts">
import type { WorkSummary } from '@omnarr/contracts';

import { activeDownloadsLine, seedingMarker } from '~/lib/downloads';
import { workLine } from '~/lib/library';
import { posterBadge } from '~/lib/preparingProgress';

const props = defineProps<{ work: WorkSummary }>();
const status = computed(() => workLine(props.work));
// After the status line, never on the poster: the poster's corner is for downloads and failures.
const marker = computed(() => seedingMarker(props.work.seeding));
const badge = computed(() => posterBadge(props.work, activeDownloadsLine(props.work.activeDownloads)));
</script>

<template>
  <NuxtLink :to="`/library/${work.workId}`" class="group flex flex-col gap-2 min-w-0 focus-visible:outline-2 focus-visible:outline-primary rounded-lg">
    <Poster :src="work.posterUrl" :alt="work.title" size="fill" class="transition group-hover:ring-accented">
      <span
        v-if="badge"
        class="absolute bottom-2 left-2 inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-xs font-medium tabular-nums"
        :class="badge.color === 'error' ? 'bg-error text-inverted' : 'bg-default/90 text-highlighted'"
      >
        <UIcon :name="badge.icon" class="size-3.5" />{{ badge.label }}
      </span>
    </Poster>
    <StateBar :states="work.states" />
    <div class="min-w-0">
      <p class="truncate text-sm font-semibold text-highlighted group-hover:underline">{{ work.title }}</p>
      <p class="flex items-center gap-1.5 text-xs text-muted">
        <span class="tabular-nums">{{ work.year ?? '—' }}</span>
        <UBadge v-if="work.numberingScheme === 'anime'" size="sm" color="secondary" variant="outline" label="Anime" class="px-1.5 py-0 text-[11px]" />
      </p>
      <p class="mt-0.5 flex flex-wrap gap-x-1.5 text-xs text-muted">
        <span v-if="status.issues" class="inline-flex items-center gap-1 text-error"><UIcon name="i-lucide-triangle-alert" />{{ status.issues }}</span>
        <span>{{ status.line }}</span>
        <span v-if="marker" class="inline-flex items-center gap-1 text-success tabular-nums whitespace-nowrap" :title="marker.title">
          <UIcon name="i-lucide-arrow-up" class="size-3.5" />{{ marker.label }}
        </span>
      </p>
    </div>
  </NuxtLink>
</template>
