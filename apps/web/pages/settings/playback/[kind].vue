<!--
  Settings › Libraries & playback: one playback
  profile per library, on the Series and Movies tabs. The target follows the
  ticked devices, with a resolution cap to override, or is edited directly.
  Save first reads playback.previewChange: a change that moves no file saves
  at once, any other opens the save dialog with its counts.
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';
import type { ChangePreview, LibraryKind, PlaybackDraft } from '@omnarr/contracts';

import { changeLine, changesNoFile, draftOf, draftTarget, KEEP_ORIGINAL, saveDialog, savedToast, targetProblems } from '~/lib/playback';

const route = useRoute();
const toast = useToast();
const kind = computed<LibraryKind>(() => (route.params.kind === 'movies' ? 'movies' : 'series'));
const tabs = [
  { value: 'series', label: 'Series', icon: 'i-lucide-tv' },
  { value: 'movies', label: 'Movies', icon: 'i-lucide-film' },
];

const { data: list, error: listError } = useQuery(api.api.library.list, () => ({ kind: kind.value }));
const libraryId = computed(() => list.value?.library?.libraryId);
const { data: detail, error } = useQuery(api.api.playback.get, () => (libraryId.value ? { libraryId: libraryId.value } : 'skip'));

// The draft starts from the stored profile, and again when the tab changes.
const draft = ref<PlaybackDraft>();
const draftLibrary = ref<string>();
watch(
  detail,
  (value) => {
    if (!value || draftLibrary.value === value.libraryId) return;
    draft.value = draftOf(value);
    draftLibrary.value = value.libraryId;
  },
  { immediate: true },
);

const devices = computed({
  get: () => (draft.value?.mode === 'devices' ? draft.value.devices : (detail.value?.devices ?? [])),
  set: (value) => {
    if (draft.value?.mode === 'devices') draft.value = { ...draft.value, devices: value };
  },
});
const change = computed(() => (draft.value && detail.value ? changeLine(draft.value, detail.value) : undefined));
const blocked = computed(() => !draft.value || targetProblems(draftTarget(draft.value)).length > 0);

const previewChange = useQueryOnce(api.api.playback.previewChange);
const update = useMutation(api.api.playback.update);
const preview = ref<ChangePreview>();
const confirming = ref(false);
const saving = ref(false);
const dialog = computed(() => (preview.value && detail.value ? saveDialog(preview.value, detail.value.name) : undefined));

const failed = () => toast.add({ title: "The profile couldn't be saved", description: 'Try again.', color: 'error', icon: 'i-lucide-triangle-alert' });

async function onSave() {
  if (!draft.value || !libraryId.value || !detail.value) return;
  saving.value = true;
  try {
    const counts = await previewChange({ libraryId: libraryId.value, draft: draft.value });
    if (changesNoFile(counts)) {
      await update({ libraryId: libraryId.value, draft: draft.value });
      toast.add({ ...savedToast(detail.value.name), color: 'success', icon: 'i-lucide-circle-check' });
    } else {
      preview.value = counts;
      confirming.value = true;
    }
  } catch {
    failed();
  } finally {
    saving.value = false;
  }
}

async function onConfirm() {
  if (!draft.value || !libraryId.value) return;
  saving.value = true;
  try {
    await update({ libraryId: libraryId.value, draft: draft.value });
    confirming.value = false;
    toast.add({ title: 'Saved', color: 'success', icon: 'i-lucide-circle-check' });
  } catch {
    failed();
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <PageHeader
        title="Libraries &amp; playback"
        :actions="
          detail && draft ? [{ label: 'Save', icon: 'i-lucide-check', primary: true, loading: saving, disabled: !change || blocked, onClick: onSave }] : []
        "
      >
        <template #right>
          <span v-if="change" class="hidden md:inline text-xs text-muted">{{ change }}</span>
        </template>
        <template #tabs>
          <ResponsiveTabs :model-value="kind" :items="tabs" :to="(value) => `/settings/playback/${value}`" />
        </template>
      </PageHeader>
    </template>
    <template #body>
      <PageBody>
        <p v-if="change" class="md:hidden text-xs text-muted">{{ change }}</p>

        <UAlert
          v-if="listError || error"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          title="The playback profile couldn't be loaded."
          :description="(listError ?? error)?.message"
        />
        <UAlert
          v-else-if="list && !list.library"
          color="neutral"
          variant="subtle"
          icon="i-lucide-info"
          title="No library yet"
          description="First-run setup creates the Series and Movies libraries."
        />

        <template v-else-if="detail && draft">
          <Section title="Devices you watch on" description="The target format is what every ticked device plays directly.">
            <PlaybackDeviceCards v-model="devices" :cards="detail.devicesAvailable" :disabled="draft.mode === 'custom'" />
          </Section>
          <Section title="Target format" description="Follows the devices. Edit it directly to set your own.">
            <PlaybackTargetEditor v-model="draft" :detail="detail" />
          </Section>
          <Section title="Originals">
            <div class="flex items-start gap-4">
              <div class="flex-1">
                <p class="text-sm font-medium text-highlighted">{{ KEEP_ORIGINAL.label }}</p>
                <p class="text-xs text-muted">{{ KEEP_ORIGINAL.description }}</p>
              </div>
              <USwitch :model-value="draft.keepOriginal" :aria-label="KEEP_ORIGINAL.label" @update:model-value="draft = { ...draft, keepOriginal: $event }" />
            </div>
          </Section>

          <PlaybackSaveDialog v-if="dialog" v-model:open="confirming" :dialog="dialog" :saving="saving" @confirm="onConfirm" />
        </template>
      </PageBody>
    </template>
  </UDashboardPanel>
</template>
