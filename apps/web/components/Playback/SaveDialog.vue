<!--
  The playback settings' save dialog: what the change does to the library's files, from
  playback.previewChange: the files that stop fitting by their most
  expensive step, how many are prepared, the scanned files that stay on
  demand, and the files that now fit.
-->
<script setup lang="ts">
import type { SaveDialog } from '~/lib/playback';

defineProps<{ dialog: SaveDialog; saving: boolean }>();
const open = defineModel<boolean>('open', { required: true });
const emit = defineEmits<{ confirm: [] }>();
</script>

<template>
  <UModal v-model:open="open" :title="dialog.title">
    <template #body>
      <div class="space-y-3 text-sm">
        <div class="rounded-md border border-default p-3 space-y-1">
          <p v-if="dialog.headline" class="flex items-center gap-2 font-medium">
            <UIcon name="i-lucide-triangle-alert" class="text-warning" />{{ dialog.headline }}
          </p>
          <p v-for="line in dialog.lines" :key="line" class="text-muted">{{ line }}</p>
        </div>
        <dl v-if="dialog.steps.length" class="grid grid-cols-[10rem_1fr] gap-y-1">
          <template v-for="row in dialog.steps" :key="row.label">
            <dt class="text-muted">{{ row.label }}</dt>
            <dd>{{ row.value }}</dd>
          </template>
        </dl>
        <p v-if="dialog.note" class="text-xs text-muted">{{ dialog.note }}</p>
        <p v-if="dialog.help" class="text-xs text-muted">{{ dialog.help }}</p>
      </div>
    </template>
    <template #footer>
      <div class="flex w-full justify-end gap-2">
        <UButton color="neutral" variant="ghost" label="Cancel" @click="open = false" />
        <UButton :label="dialog.confirm" :loading="saving" @click="emit('confirm')" />
      </div>
    </template>
  </UModal>
</template>
