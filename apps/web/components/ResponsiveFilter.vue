<!--
  Filters: UTabs variant="pill" size="sm" with the count in the label; below sm a USelect with a filter icon. In the URL as
  `?filter=`.
-->
<script setup lang="ts">
import type { TabItem } from './ResponsiveTabs.vue';

withDefaults(defineProps<{ items: TabItem[]; param?: string }>(), { param: 'filter' });
const model = defineModel<string>();
</script>

<template>
  <ResponsiveTabs v-model="model" :items="items" :param="param" variant="pill" select-icon="i-lucide-filter" />
</template>
