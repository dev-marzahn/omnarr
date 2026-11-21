<!--
  TMDB's attribution: the TMDB mark and the notice from TMDB's
  current terms. Shown on the add-title modal, the Work and movie pages,
  Settings › Metadata and About. `logoOnly` leaves the notice to the row
  around it (About's sources).
-->
<script setup lang="ts">
import { TMDB_NOTICE } from '~/lib/metadata';

defineProps<{ logoOnly?: boolean }>();
</script>

<template>
  <a v-if="logoOnly" href="https://www.themoviedb.org" target="_blank" rel="noopener" class="shrink-0" aria-label="TMDB">
    <UBadge color="info" variant="solid" size="sm" label="TMDB" class="font-bold tracking-wide" />
  </a>
  <p v-else class="flex items-center gap-2 text-xs text-dimmed">
    <a href="https://www.themoviedb.org" target="_blank" rel="noopener" class="shrink-0" aria-label="TMDB">
      <UBadge color="info" variant="solid" size="sm" label="TMDB" class="font-bold tracking-wide" />
    </a>
    <span>{{ TMDB_NOTICE }}</span>
  </p>
</template>
