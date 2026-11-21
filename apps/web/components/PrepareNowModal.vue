<!--
  "Prepare now": what preparing the Unit's
  primary file does to each stream, from units.preparationPlan, and its
  "already queued" state. Confirming calls units.prepareNow; the row then
  shows "Preparing".
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';
import type { UnitRow } from '@omnarr/contracts';

import { originalAfterwards, planNotice, planRows, planSource, prepareTitle, stepTag, whileItRuns } from '~/lib/preparation';

const props = defineProps<{ unit: UnitRow; workTitle: string; keepOriginal: boolean }>();
const open = defineModel<boolean>('open', { required: true });
const toast = useToast();

const { data: plan, error } = useQuery(api.api.units.preparationPlan, () => (open.value ? { unitId: props.unit.unitId } : 'skip'));
const rows = computed(() => (plan.value ? planRows(plan.value.comparison) : []));
const notice = computed(() => (plan.value ? planNotice(plan.value) : undefined));

const prepareNow = useMutation(api.api.units.prepareNow);
const starting = ref(false);
async function onPrepare() {
  starting.value = true;
  try {
    await prepareNow({ unitId: props.unit.unitId });
    open.value = false;
  } catch {
    toast.add({ title: "The preparation couldn't start", description: 'Try again.', color: 'error', icon: 'i-lucide-triangle-alert' });
  } finally {
    starting.value = false;
  }
}
</script>

<template>
  <UModal v-model:open="open" :title="prepareTitle(unit, workTitle)" :ui="{ content: 'sm:max-w-2xl' }">
    <template #description>
      <span v-if="plan"> {{ planSource(plan) }} · <code>{{ plan.fileName }}</code> </span>
    </template>
    <template #body>
      <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-triangle-alert" title="The plan couldn't be loaded." :description="error.message" />
      <p v-else-if="plan === null" class="text-sm text-muted">This item has no file to prepare.</p>
      <div v-else-if="plan" class="space-y-4 text-sm">
        <UAlert
          v-if="notice"
          :color="notice.color"
          variant="subtle"
          :icon="notice.color === 'warning' ? 'i-lucide-info' : 'i-lucide-check'"
          :title="notice.title"
          :description="notice.description"
        />
        <table class="w-full">
          <thead class="text-left text-muted">
            <tr>
              <th class="font-normal pb-1">Plan</th>
              <th class="font-normal pb-1">Step</th>
            </tr>
          </thead>
          <tbody class="divide-y divide-default">
            <tr v-for="(row, i) in rows" :key="i">
              <td class="py-1.5">{{ row.text }}</td>
              <td class="py-1.5">
                <UBadge v-if="row.step" size="sm" :color="row.step === 'video' ? 'secondary' : 'neutral'" variant="subtle" :label="stepTag(row.step)" />
              </td>
            </tr>
          </tbody>
        </table>
        <div v-if="!plan.comparison.fits" class="rounded-md border border-default p-3 space-y-1">
          <p class="font-medium">While it runs</p>
          <p class="text-muted">{{ whileItRuns(plan, unit.kind) }}</p>
          <p class="text-muted">{{ originalAfterwards(plan.origin, keepOriginal) }}</p>
        </div>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" label="Cancel" @click="open = false" />
        <UButton icon="i-lucide-wand-sparkles" label="Prepare now" :loading="starting" :disabled="!plan || plan.comparison.fits" @click="onPrepare" />
      </div>
    </template>
  </UModal>
</template>
