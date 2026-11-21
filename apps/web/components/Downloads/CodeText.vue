<!-- A text whose backticked parts (commands, `.env` lines) show as code: the VPN steps. -->
<script setup lang="ts">
import { codeParts } from '~/lib/downloads';

defineProps<{ text: string }>();
</script>

<template>
  <template v-for="(part, i) in codeParts(text)" :key="i">
    <code v-if="'code' in part" class="font-mono">{{ part.code }}</code>
    <template v-else>{{ part.text }}</template>
  </template>
</template>
