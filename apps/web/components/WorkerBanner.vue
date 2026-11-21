<!--
  One banner on every page, worker offline or version mismatch (mismatch
  wins), from system.status.
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';

import { bannerOf } from '~/lib/system';

const { data } = useQuery(api.api.system.status, {});
const banner = computed(() => (data.value ? bannerOf(data.value) : undefined));
</script>

<template>
  <UAlert
    v-if="banner"
    :color="banner.color"
    variant="subtle"
    icon="i-lucide-server-off"
    :title="banner.title"
    :description="banner.description"
    :actions="[{ label: 'Details', to: '/system', color: 'neutral', variant: 'outline' }]"
    class="rounded-none"
  />
</template>
