<!--
  User formats: a name, a score and a rule over parser fields only:
  all of "all", at least one of "any", none of "none". No title regex.
-->
<script setup lang="ts">
import type { Condition, UserFormat } from '@omnarr/contracts';

import { newId } from '~/lib/browser';
import { buildCondition, CONDITION_FIELDS, conditionLabel } from '~/lib/releaseProfiles';

const formats = defineModel<UserFormat[]>({ required: true });
const draft = reactive({ field: 'group' as Condition['field'], op: 'in', values: '', part: 'all' as 'all' | 'any' | 'none', target: -1 });
const fieldItems = Object.keys(CONDITION_FIELDS);
const opItems = computed(() => [...CONDITION_FIELDS[draft.field]]);
const invalid = ref(false);
watch(
  () => draft.field,
  () => (draft.op = CONDITION_FIELDS[draft.field][0]!),
);

function addFormat() {
  formats.value = [...formats.value, { id: newId(), name: `Format ${formats.value.length + 1}`, rule: { all: [] }, score: 0 }];
}

function addCondition(index: number) {
  const condition = buildCondition(draft.field, draft.op, draft.values);
  invalid.value = !condition;
  if (!condition) return;
  formats.value = formats.value.map((format, i) =>
    i === index ? { ...format, rule: { ...format.rule, [draft.part]: [...(format.rule[draft.part] ?? []), condition] } } : format,
  );
  draft.values = '';
}

function removeCondition(index: number, part: 'all' | 'any' | 'none', at: number) {
  formats.value = formats.value.map((format, i) =>
    i === index ? { ...format, rule: { ...format.rule, [part]: (format.rule[part] ?? []).filter((_, j) => j !== at) } } : format,
  );
}

const update = (index: number, patch: Partial<UserFormat>) =>
  (formats.value = formats.value.map((format, i) => (i === index ? { ...format, ...patch } : format)));
</script>

<template>
  <div class="space-y-3">
    <div v-for="(format, index) in formats" :key="format.id" class="border border-default rounded-md p-3 space-y-2">
      <div class="flex gap-2">
        <UInput :model-value="format.name" class="flex-1" @update:model-value="update(index, { name: String($event) })" />
        <UInputNumber :model-value="format.score" class="w-32" @update:model-value="update(index, { score: $event ?? 0 })" />
        <UButton color="error" variant="ghost" icon="i-lucide-trash" aria-label="Remove format" @click="formats = formats.filter((_, i) => i !== index)" />
      </div>
      <div v-for="part in ['all', 'any', 'none'] as const" :key="part" class="text-sm">
        <template v-if="format.rule[part]?.length">
          <span class="text-muted">{{ part }}:</span>
          <UBadge v-for="(condition, at) in format.rule[part]" :key="at" color="neutral" variant="subtle" class="ms-1">
            {{ conditionLabel(condition) }}
            <UButton size="xs" variant="link" color="neutral" icon="i-lucide-x" aria-label="Remove condition" @click="removeCondition(index, part, at)" />
          </UBadge>
        </template>
      </div>
      <div class="flex flex-wrap items-center gap-2">
        <USelect v-model="draft.part" :items="['all', 'any', 'none']" size="sm" class="w-24" />
        <USelect v-model="draft.field" :items="fieldItems" size="sm" class="w-44" />
        <USelect v-model="draft.op" :items="opItems" size="sm" class="w-24" />
        <UInput v-model="draft.values" size="sm" placeholder="values, comma-separated (true/false for is)" class="flex-1" />
        <UButton size="sm" color="neutral" variant="outline" label="Add condition" @click="addCondition(index)" />
      </div>
      <p v-if="invalid" class="text-xs text-error">That condition isn't valid for this field.</p>
      <p v-if="!format.rule.all?.length && !format.rule.any?.length && !format.rule.none?.length" class="text-xs text-warning">
        A format needs at least one condition.
      </p>
    </div>
    <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-plus" label="Add format" @click="addFormat" />
  </div>
</template>
