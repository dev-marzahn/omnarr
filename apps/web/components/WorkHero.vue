<!--
  A Work's hero: the backdrop faded to 34 % with a gradient into the page,
  the poster, the title once as the page's h1 with its year, a meta line
  and, below them, the page's slot (state bar and status line, or a movie's
  state). It spans the panel's width; its content
  sits in the page's width box.
-->
<script setup lang="ts">
import { mediaUrl } from '~/lib/media';

const props = defineProps<{ title: string; year?: number; posterUrl?: string; backdropUrl?: string; meta: string[]; overview?: string }>();
// A backdrop that fails to load is left out, never shown broken.
const failed = ref(false);
const { convex } = useUrls();
const backdrop = computed(() => mediaUrl(props.backdropUrl, convex));
watch(
  () => props.backdropUrl,
  () => (failed.value = false),
);
</script>

<template>
  <!-- shrink-0: it sits in the panel's scrolling flex column, which would squeeze it on a long page. -->
  <section class="relative shrink-0 overflow-hidden border-b border-default">
    <div v-if="backdrop && !failed" class="absolute inset-0" aria-hidden="true">
      <img :src="backdrop" alt="" class="size-full object-cover opacity-[.34]" @error="failed = true" />
      <div class="absolute inset-0 bg-gradient-to-t from-(--ui-bg) via-(--ui-bg)/60 to-transparent" />
    </div>
    <div class="relative mx-auto flex max-w-6xl gap-4 px-4 py-4 sm:gap-6 sm:px-6 sm:py-6">
      <Poster :src="posterUrl" :alt="title" size="lg" class="hidden sm:block" />
      <Poster :src="posterUrl" :alt="title" size="md" class="sm:hidden" />
      <div class="min-w-0 flex-1 self-center space-y-2">
        <h1 class="text-[22px] sm:text-[28px] font-bold leading-tight text-highlighted">
          {{ title }}<span v-if="year" class="font-normal text-muted"> ({{ year }})</span>
        </h1>
        <p class="flex flex-wrap gap-x-3 gap-y-0.5 text-sm text-muted">
          <span v-for="part in meta" :key="part">{{ part }}</span>
        </p>
        <p v-if="overview" class="max-w-2xl text-sm text-default line-clamp-3">{{ overview }}</p>
        <slot />
      </div>
    </div>
  </section>
</template>
