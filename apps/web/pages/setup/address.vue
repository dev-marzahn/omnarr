<!--
  The first run's addresses step: read-only. Each URL as the web
  container was started with it, or this browser's address on its port, and
  which origins sign-in accepts.
-->
<script setup lang="ts">
import { addressLines } from '~/lib/firstRun';

definePageMeta({ layout: 'setup', step: 'address' });

const config = useRuntimeConfig().public;
const view = addressLines({
  webUrl: config.webUrl,
  convexUrl: config.convexUrl,
  convexSiteUrl: config.convexSiteUrl,
  jellyfinUrl: config.jellyfinPublicUrl,
  ports: { web: String(config.webPort), convex: String(config.convexPort), convexSite: String(config.convexSitePort), jellyfin: String(config.jellyfinPort) },
});
const advance = useAdvance();
const pending = ref(false);
async function next() {
  pending.value = true;
  await advance('indexer').finally(() => (pending.value = false));
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <div>
      <h1 class="text-xl font-bold text-highlighted">Addresses</h1>
      <p class="text-sm text-muted">Where omnarr and Jellyfin are reached. They come from <code>.env</code>.</p>
    </div>
    <UCard>
      <dl class="grid grid-cols-[8rem_minmax(0,1fr)] gap-y-2 text-sm">
        <template v-for="line in view.lines" :key="line.label">
          <dt class="text-muted">{{ line.label }}</dt>
          <dd class="break-all">{{ line.value }}</dd>
        </template>
      </dl>
      <UAlert class="mt-4" color="neutral" variant="subtle" icon="i-lucide-info" :description="view.note" />
    </UCard>
    <UButton :loading="pending" class="self-end max-lg:self-stretch max-lg:justify-center" @click="next">Continue</UButton>
  </div>
</template>
