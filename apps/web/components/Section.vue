<!--
  A settings section: the title and description in a 280 px left column,
  the controls or card on the right; stacked on a phone.
-->
<script setup lang="ts">
defineProps<{ title: string; description?: string }>();
</script>

<template>
  <section class="grid gap-3 sm:gap-6 md:grid-cols-[280px_minmax(0,1fr)] not-first-of-type:border-t not-first-of-type:border-default not-first-of-type:pt-6">
    <div class="space-y-1">
      <h2 class="text-sm font-semibold text-highlighted">{{ title }}</h2>
      <p v-if="description" class="text-sm text-muted">{{ description }}</p>
      <slot name="description" />
    </div>
    <div class="min-w-0 flex flex-col gap-4">
      <slot />
    </div>
  </section>
</template>
