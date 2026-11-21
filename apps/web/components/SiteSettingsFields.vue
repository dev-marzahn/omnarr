<!--
  A definition's form: the link to use, from the
  definition's links, and its settings: text, password, checkbox and select
  controls, and the info types as text. Text and password values are
  write-only: a stored one shows as "Stored", and an empty field keeps it.
-->
<script setup lang="ts">
import type { DefinitionMeta, SiteSettings } from '@omnarr/contracts';

import { settingFields } from '~/lib/sites';

const props = defineProps<{ meta: DefinitionMeta; secretsSet?: string[] }>();
const baseUrl = defineModel<string>('baseUrl', { required: true });
const settings = defineModel<SiteSettings>('settings', { required: true });

const fields = computed(() => settingFields(props.meta));
const links = computed(() => props.meta.links.map((link) => ({ value: link, label: link })));
const stored = (name: string) => props.secretsSet?.includes(name) ?? false;
</script>

<template>
  <div class="space-y-4">
    <UFormField label="Link" name="baseUrl" help="The site's address. Some sites have mirrors.">
      <USelect v-model="baseUrl" :items="links" class="w-full" />
    </UFormField>
    <template v-for="field in fields" :key="field.name">
      <UFormField v-if="field.kind === 'select'" :label="field.label" :name="field.name">
        <USelect v-model="settings[field.name] as string" :items="field.items" class="w-full" />
      </UFormField>
      <UCheckbox v-else-if="field.kind === 'checkbox'" v-model="settings[field.name] as boolean" :label="field.label" />
      <UFormField v-else-if="field.kind === 'text' || field.kind === 'password'" :label="field.label" :name="field.name">
        <UInput
          v-model="settings[field.name] as string"
          :type="field.kind === 'password' ? 'password' : 'text'"
          autocomplete="off"
          :placeholder="stored(field.name) ? 'Stored' : ''"
          class="w-full"
        />
      </UFormField>
      <UAlert v-else-if="field.text" color="neutral" variant="subtle" icon="i-lucide-info" :title="field.label" :description="field.text" />
    </template>
  </div>
</template>
