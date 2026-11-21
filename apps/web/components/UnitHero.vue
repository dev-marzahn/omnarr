<!--
  An episode's hero: the still, the kicker (S02E03 · aired …),
  the title as the page's h1 (24/700) and the state with its detail.
-->
<script setup lang="ts">
import type { UnitState } from '@omnarr/contracts';

defineProps<{ title: string; kicker: string; state: UnitState; stillUrl?: string; detail?: string; openIssue?: boolean }>();
</script>

<template>
  <section class="shrink-0 border-b border-default">
    <div class="mx-auto flex max-w-6xl flex-col gap-4 px-4 py-4 sm:flex-row sm:items-center sm:gap-6 sm:px-6 sm:py-6">
      <Poster :src="stillUrl" :alt="title" kind="still" size="fill" class="sm:w-48" />
      <div class="min-w-0 flex-1 space-y-2">
        <p class="text-xs text-muted tabular-nums">{{ kicker }}</p>
        <h1 class="text-xl sm:text-2xl font-bold leading-tight text-highlighted">{{ title }}</h1>
        <div class="flex flex-wrap items-center gap-2 text-xs text-muted">
          <UnitStateBadge :state="state" />
          <UBadge v-if="openIssue" color="error" variant="subtle" icon="i-lucide-triangle-alert" label="Issue" />
          <span v-if="detail">{{ detail }}</span>
        </div>
        <slot />
      </div>
    </div>
  </section>
</template>
