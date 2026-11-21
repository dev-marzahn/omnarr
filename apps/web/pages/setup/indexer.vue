<!--
  The first indexer: the IndexerForm, whose Save unlocks only after a
  passing test. Continue needs one indexer.
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';

definePageMeta({ layout: 'setup', step: 'indexer' });

const { data: indexers } = useQuery(api.api.indexers.list, {});
const adding = ref(true);
watch(indexers, (list) => {
  if (list?.length) adding.value = false;
});
const advance = useAdvance();
const pending = ref(false);
async function next() {
  pending.value = true;
  await advance('usenet').finally(() => (pending.value = false));
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <div>
      <h1 class="text-xl font-bold text-highlighted">Add an indexer</h1>
      <p class="text-sm text-muted">omnarr searches your indexers for releases. Test the connection, then save.</p>
    </div>
    <UCard v-if="indexers?.length">
      <ul class="flex flex-col gap-2 text-sm">
        <li v-for="indexer in indexers" :key="indexer.id" class="flex items-center gap-2">
          <UIcon name="i-lucide-circle-check" class="text-success" />
          <span class="font-medium text-highlighted">{{ indexer.name }}</span>
          <span class="text-muted truncate">{{ indexer.host }}</span>
        </li>
      </ul>
      <UButton v-if="!adding" class="mt-3" color="neutral" variant="outline" size="sm" icon="i-lucide-plus" label="Add another" @click="adding = true" />
    </UCard>
    <UCard v-if="adding">
      <IndexerForm @saved="adding = false" @cancel="adding = !indexers?.length" />
    </UCard>
    <UButton :disabled="!indexers?.length" :loading="pending" class="self-end max-lg:self-stretch max-lg:justify-center" @click="next">Continue</UButton>
  </div>
</template>
