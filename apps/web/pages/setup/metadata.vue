<!--
  The metadata key (optional): test your own TMDB token with
  `metadata.testKey`, or skip and use the built-in one.
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';

definePageMeta({ layout: 'setup', step: 'metadata' });

const testKey = useAction(api.api.metadata.testKey);
const advance = useAdvance();
const token = ref('');
const testing = ref(false);
const accepted = ref(false);
const result = ref<{ color: 'success' | 'error' | 'warning'; title: string }>();
const RESULT = {
  valid: { color: 'success', title: 'TMDB accepted this token. It is used from now on.' },
  rejected: { color: 'error', title: 'TMDB rejected this token (HTTP 401). The built-in token stays in use.' },
  unreachable: { color: 'warning', title: "Couldn't reach TMDB to test the token. Nothing was changed." },
} as const;

async function test() {
  testing.value = true;
  result.value = undefined;
  try {
    const { outcome } = await testKey({ token: token.value.trim() });
    result.value = RESULT[outcome];
    accepted.value = outcome === 'valid';
    if (accepted.value) token.value = '';
  } catch {
    result.value = RESULT.unreachable;
  } finally {
    testing.value = false;
  }
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <div>
      <h1 class="text-xl font-bold text-highlighted">Metadata key <span class="text-sm font-normal text-muted">optional</span></h1>
      <p class="text-sm text-muted">
        omnarr gets titles, episodes and artwork from TMDB with a built-in token. You can use your own Read Access Token instead.
      </p>
    </div>
    <UCard>
      <div class="flex flex-col gap-4">
        <UFormField label="TMDB Read Access Token">
          <UInput v-model="token" type="password" autocomplete="off" class="w-full" />
        </UFormField>
        <UAlert v-if="result" :color="result.color" variant="subtle" :title="result.title" />
        <UButton
          class="self-start"
          color="neutral"
          variant="outline"
          icon="i-lucide-plug"
          label="Test token"
          :loading="testing"
          :disabled="!token.trim()"
          @click="test"
        />
        <TmdbAttribution />
      </div>
    </UCard>
    <div class="flex items-center gap-2 max-lg:flex-col-reverse max-lg:items-stretch">
      <UButton color="neutral" variant="link" to="/setup/devices" icon="i-lucide-arrow-left" label="Back" />
      <UButton v-if="!accepted" class="lg:ms-auto max-lg:justify-center" color="neutral" variant="outline" label="Skip" @click="advance('finish')" />
      <UButton v-else class="lg:ms-auto max-lg:justify-center" label="Continue" @click="advance('finish')" />
    </div>
  </div>
</template>
