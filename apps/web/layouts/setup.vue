<!--
  First run's shell: the vertical step list beside the form on a desktop;
  below `lg`, one line "Step n of 9 · <step>" with a thin bar, and the form
  at full width. Each page sets its
  step in `definePageMeta({ step })`.
-->
<script setup lang="ts">
import { SETUP_STEPS } from '~/composables/useFirstRun';

const route = useRoute();
const index = computed(() =>
  Math.max(
    0,
    SETUP_STEPS.findIndex((step) => step.key === route.meta.step),
  ),
);
const current = computed(() => SETUP_STEPS[index.value]!);
const items = SETUP_STEPS.map((step) => ({ title: step.label, description: step.note, value: step.key }));
</script>

<template>
  <div class="min-h-svh flex justify-center px-4 py-6 sm:px-6 lg:py-16">
    <div class="w-full max-w-5xl flex flex-col gap-6 lg:flex-row lg:gap-12">
      <aside class="lg:w-56 shrink-0">
        <div class="flex items-center gap-2.5 mb-4 lg:mb-8">
          <span class="size-7 rounded-lg bg-inverted text-inverted grid place-items-center">
            <UIcon name="i-lucide-play" class="size-4" />
          </span>
          <span class="font-semibold text-highlighted">omnarr</span>
        </div>
        <UStepper class="hidden lg:flex" orientation="vertical" size="sm" :items="items" :model-value="current.key" disabled />
        <div class="lg:hidden flex flex-col gap-2">
          <p class="text-sm text-muted">Step {{ index + 1 }} of {{ SETUP_STEPS.length }} · {{ current.label }}{{ current.note ? ` · ${current.note}` : '' }}</p>
          <UProgress :model-value="index + 1" :max="SETUP_STEPS.length" size="xs" />
        </div>
      </aside>
      <main class="flex-1 min-w-0 max-w-2xl">
        <slot />
      </main>
    </div>
  </div>
</template>
