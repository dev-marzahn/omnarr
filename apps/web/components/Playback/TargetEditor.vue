<!--
  The playback settings' "Target format" card. In devices mode it shows the
  target the ticked devices give, with the resolution cap as the one field
  to edit. "Edit directly" switches to custom mode, where every part of the
  target is a field; "Reset to devices" goes back. In each list the first
  entry is what a remux or transcode produces.
-->
<script setup lang="ts">
import {
  type PlaybackDraft,
  type PlaybackProfileDetail,
  TargetAudioCodec,
  TargetContainer,
  type TargetFormat,
  TargetVideoCodec,
  TextSubtitleFormat,
} from '@omnarr/contracts';

import {
  BIT_DEPTH_ITEMS,
  capField,
  capKey,
  capOverride,
  CHANNEL_ITEMS,
  draftTarget,
  editDirectly,
  HDR_ITEMS,
  HEIGHT_ITEMS,
  optionItems,
  resetToDevices,
  setFirst,
  setIncluded,
  subtitleModeItems,
  targetProblems,
  targetRows,
} from '~/lib/playback';

const props = defineProps<{ detail: PlaybackProfileDetail }>();
const draft = defineModel<PlaybackDraft>({ required: true });

const target = computed(() => draftTarget(draft.value));
const derivedCap = computed(() => {
  const d = draft.value;
  return d.mode === 'devices' ? draftTarget({ ...d, maxHeightOverride: undefined }).video.maxHeight : null;
});
const cap = computed(() => capField(derivedCap.value));
const problems = computed(() => targetProblems(target.value));

function setCap(key: string) {
  const d = draft.value;
  if (d.mode !== 'devices') return;
  const { maxHeightOverride: _old, ...rest } = d;
  const override = capOverride(key);
  draft.value = override === undefined ? rest : { ...rest, maxHeightOverride: override };
}

/** Changes the target edited directly. Each change returns new objects, so the draft is never mutated in place. */
function edit(change: (t: TargetFormat) => TargetFormat) {
  const d = draft.value;
  if (d.mode === 'custom') draft.value = { ...d, target: change(d.target) };
}
</script>

<template>
  <UCard>
    <template #header>
      <div class="flex flex-wrap items-center gap-2">
        <UBadge v-if="draft.mode === 'devices'" color="success" variant="subtle" icon="i-lucide-link" label="Follows devices" />
        <UBadge v-else color="neutral" variant="subtle" icon="i-lucide-pencil" label="Edited directly" />
        <UButton
          v-if="draft.mode === 'devices'"
          class="ms-auto"
          size="sm"
          color="neutral"
          variant="outline"
          label="Edit directly"
          @click="draft = editDirectly(draft)"
        />
      </div>
    </template>

    <UAlert
      v-if="draft.mode === 'custom'"
      class="mb-4"
      color="warning"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      title="Edited: no longer follows the device list"
      :actions="[{ label: 'Reset to devices', size: 'xs', color: 'neutral', variant: 'outline', onClick: () => (draft = resetToDevices(draft, props.detail)) }]"
    />

    <template v-if="draft.mode === 'devices'">
      <dl class="grid grid-cols-[8rem_1fr] gap-y-1 text-sm">
        <template v-for="row in targetRows(target)" :key="row.label">
          <dt class="text-muted">{{ row.label }}</dt>
          <dd>{{ row.value }}</dd>
        </template>
      </dl>
      <UFormField class="mt-4 max-w-xs" label="Resolution cap" help="Files above it are scaled down. Leave it to follow the devices.">
        <USelect
          :model-value="capKey(draft.maxHeightOverride)"
          :items="cap.items"
          :placeholder="cap.placeholder"
          class="w-full"
          @update:model-value="setCap($event as string)"
        />
      </UFormField>
    </template>

    <div v-else-if="draft.mode === 'custom'" class="grid gap-4 sm:grid-cols-2">
      <UFormField label="Containers" help="A remux produces the first one.">
        <div class="flex flex-wrap gap-3">
          <UCheckbox
            v-for="item in optionItems(TargetContainer.options)"
            :key="item.value"
            :label="item.label"
            :model-value="draft.target.containers.includes(item.value)"
            @update:model-value="edit((t) => ({ ...t, containers: setIncluded(t.containers, item.value, $event === true, TargetContainer.options) }))"
          />
        </div>
        <USelect
          class="mt-2 w-full"
          :model-value="draft.target.containers[0]"
          :items="optionItems(draft.target.containers)"
          @update:model-value="edit((t) => ({ ...t, containers: setFirst(t.containers, $event as TargetContainer) }))"
        />
      </UFormField>

      <UFormField label="Video codecs" help="A transcode produces the first one.">
        <div class="flex flex-wrap gap-3">
          <UCheckbox
            v-for="item in optionItems(TargetVideoCodec.options)"
            :key="item.value"
            :label="item.label"
            :model-value="draft.target.video.codecs.includes(item.value)"
            @update:model-value="
              edit((t) => ({ ...t, video: { ...t.video, codecs: setIncluded(t.video.codecs, item.value, $event === true, TargetVideoCodec.options) } }))
            "
          />
        </div>
        <USelect
          class="mt-2 w-full"
          :model-value="draft.target.video.codecs[0]"
          :items="optionItems(draft.target.video.codecs)"
          @update:model-value="edit((t) => ({ ...t, video: { ...t.video, codecs: setFirst(t.video.codecs, $event as TargetVideoCodec) } }))"
        />
      </UFormField>

      <UFormField label="Max height">
        <USelect
          class="w-full"
          :model-value="capKey(draft.target.video.maxHeight)"
          :items="HEIGHT_ITEMS"
          @update:model-value="edit((t) => ({ ...t, video: { ...t.video, maxHeight: capOverride($event as string) ?? null } }))"
        />
      </UFormField>

      <UFormField label="Bit-rate cap (kbit/s)" help="Empty: no cap.">
        <UInputNumber
          class="w-full"
          placeholder="No cap"
          :min="100"
          :model-value="draft.target.video.maxBitrateKbps ?? undefined"
          @update:model-value="edit((t) => ({ ...t, video: { ...t.video, maxBitrateKbps: typeof $event === 'number' ? $event : null } }))"
        />
      </UFormField>

      <UFormField label="HDR">
        <USelect
          class="w-full"
          :model-value="draft.target.video.hdr"
          :items="HDR_ITEMS"
          @update:model-value="edit((t) => ({ ...t, video: { ...t.video, hdr: $event as TargetFormat['video']['hdr'] } }))"
        />
      </UFormField>

      <UFormField label="Bit depth" help="H.264 is always 8-bit.">
        <div class="flex gap-2">
          <USelect
            class="flex-1"
            :model-value="draft.target.video.maxBitDepth.hevc"
            :items="BIT_DEPTH_ITEMS.map((i) => ({ ...i, label: `HEVC ${i.label}` }))"
            @update:model-value="edit((t) => ({ ...t, video: { ...t.video, maxBitDepth: { ...t.video.maxBitDepth, hevc: $event as 8 | 10 } } }))"
          />
          <USelect
            class="flex-1"
            :model-value="draft.target.video.maxBitDepth.av1"
            :items="BIT_DEPTH_ITEMS.map((i) => ({ ...i, label: `AV1 ${i.label}` }))"
            @update:model-value="edit((t) => ({ ...t, video: { ...t.video, maxBitDepth: { ...t.video.maxBitDepth, av1: $event as 8 | 10 } } }))"
          />
        </div>
      </UFormField>

      <UFormField label="Audio codecs" help="A conversion produces the first one.">
        <div class="flex flex-wrap gap-3">
          <UCheckbox
            v-for="item in optionItems(TargetAudioCodec.options)"
            :key="item.value"
            :label="item.label"
            :model-value="draft.target.audio.codecs.includes(item.value)"
            @update:model-value="
              edit((t) => ({ ...t, audio: { ...t.audio, codecs: setIncluded(t.audio.codecs, item.value, $event === true, TargetAudioCodec.options) } }))
            "
          />
        </div>
        <USelect
          class="mt-2 w-full"
          :model-value="draft.target.audio.codecs[0]"
          :items="optionItems(draft.target.audio.codecs)"
          @update:model-value="edit((t) => ({ ...t, audio: { ...t.audio, codecs: setFirst(t.audio.codecs, $event as TargetAudioCodec) } }))"
        />
      </UFormField>

      <UFormField label="Channels" help="More channels are mixed down.">
        <USelect
          class="w-full"
          :model-value="draft.target.audio.maxChannels"
          :items="CHANNEL_ITEMS"
          @update:model-value="edit((t) => ({ ...t, audio: { ...t.audio, maxChannels: $event as number } }))"
        />
      </UFormField>

      <UFormField label="Subtitles">
        <USelect
          class="w-full"
          :model-value="draft.target.subtitles.mode"
          :items="subtitleModeItems(draft.target.containers)"
          @update:model-value="edit((t) => ({ ...t, subtitles: { ...t.subtitles, mode: $event as TargetFormat['subtitles']['mode'] } }))"
        />
      </UFormField>

      <UFormField v-if="draft.target.subtitles.mode !== 'keep'" label="Text formats" help="Sidecar files in these formats.">
        <div class="flex flex-wrap gap-3">
          <UCheckbox
            v-for="item in optionItems(TextSubtitleFormat.options)"
            :key="item.value"
            :label="item.label"
            :model-value="draft.target.subtitles.textFormats.includes(item.value)"
            @update:model-value="
              edit((t) => ({
                ...t,
                subtitles: {
                  ...t.subtitles,
                  textFormats:
                    $event === true
                      ? TextSubtitleFormat.options.filter((f) => f === item.value || t.subtitles.textFormats.includes(f))
                      : t.subtitles.textFormats.filter((f) => f !== item.value),
                },
              }))
            "
          />
        </div>
      </UFormField>
    </div>

    <UAlert v-for="problem in problems" :key="problem" class="mt-4" color="error" variant="subtle" icon="i-lucide-circle-x" :title="problem" />
  </UCard>
</template>
