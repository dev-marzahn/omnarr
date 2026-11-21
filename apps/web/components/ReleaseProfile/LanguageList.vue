<!-- The profile's languages: a release needs one of them. "Preferred" and "Original" follow the setting and the title. -->
<script setup lang="ts">
import { LanguageCode, type LanguageSpec } from '@omnarr/contracts';

import { languageSpecOf } from '~/lib/releaseProfiles';

const languages = defineModel<LanguageSpec[]>({ required: true });
const label = (spec: LanguageSpec) => (spec.kind === 'code' ? spec.code : spec.kind === 'preferred' ? 'Preferred language' : "The title's original language");
const added = ref<string>();
const options = [
  { value: 'preferred', label: 'Preferred language' },
  { value: 'original', label: "The title's original language" },
  ...LanguageCode.options.filter((code) => code !== 'multi').map((code) => ({ value: code, label: code })),
];

function add(value: string | undefined) {
  const spec = value ? languageSpecOf(value) : undefined;
  if (spec && !languages.value.some((entry) => JSON.stringify(entry) === JSON.stringify(spec))) languages.value = [...languages.value, spec];
  added.value = undefined;
}
</script>

<template>
  <div class="space-y-2">
    <div class="flex flex-wrap gap-2">
      <UBadge v-for="(spec, i) in languages" :key="i" color="neutral" variant="subtle">
        {{ label(spec) }}
        <UButton size="xs" color="neutral" variant="link" icon="i-lucide-x" aria-label="Remove" @click="languages = languages.filter((_, j) => j !== i)" />
      </UBadge>
    </div>
    <USelect v-model="added" :items="options" placeholder="Add a language" class="w-60" @update:model-value="add" />
  </div>
</template>
