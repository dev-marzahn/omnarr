<!--
  One release profile: qualities, minimum score and
  cutoff, languages, built-in and user formats, group tiers, size limits and
  protocols. Saving marks a shipped profile edited; "Reset to shipped" brings
  back the latest shipped version.
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';
import type { Id } from '@omnarr/backend/dataModel';
import { QualityId, type ReleaseProfileContent } from '@omnarr/contracts';

import { qualityLabel } from '~/lib/labels';
import { pendingBanner, profileBadges, profileErrorText, versionLine } from '~/lib/releaseProfiles';

const route = useRoute();
const toast = useToast();
const id = computed(() => route.params.id as Id<'releaseProfiles'>);
const { data: detail, error } = useQuery(api.api.releaseProfiles.get, () => ({ id: id.value }));
const save = useMutation(api.api.releaseProfiles.update);
const reset = useMutation(api.api.releaseProfiles.resetToShipped);

const draft = ref<ReleaseProfileContent>();
watch(
  detail,
  (value) => {
    if (!value || draft.value) return;
    const { shippedKey: _k, shippedVersion: _v, pendingShippedVersion: _p, editedByUser: _e, ...content } = value.profile;
    draft.value = structuredClone(content);
  },
  { immediate: true },
);

const saving = ref(false);
async function onSave() {
  if (!draft.value) return;
  saving.value = true;
  try {
    await save({ id: id.value, profile: draft.value });
    toast.add({ title: 'Saved. Future picks use the new settings.', color: 'success', icon: 'i-lucide-circle-check' });
  } catch (e) {
    toast.add({ title: profileErrorText(e), color: 'error', icon: 'i-lucide-triangle-alert' });
  } finally {
    saving.value = false;
  }
}

const confirmReset = ref(false);
async function onReset() {
  confirmReset.value = false;
  try {
    const value = await reset({ id: id.value });
    const { shippedKey: _k, shippedVersion: _v, pendingShippedVersion: _p, editedByUser: _e, ...content } = value.profile;
    draft.value = structuredClone(content);
    toast.add({ title: 'Reset to the shipped version.', color: 'success' });
  } catch (e) {
    toast.add({ title: profileErrorText(e), color: 'error' });
  }
}

const protocolItems = [
  { value: 'usenet', label: 'Usenet' },
  { value: 'torrent', label: 'Torrent' },
];
const qualityItems = QualityId.options.map((value) => ({ value, label: qualityLabel(value) }));
const banner = computed(() => (detail.value ? pendingBanner(detail.value.profile) : undefined));
const headerBadges = computed(() => (detail.value ? profileBadges(detail.value.profile) : []));
const version = computed(() => (detail.value ? versionLine(detail.value.profile) : undefined));
const usedBy = computed(() => {
  const names = detail.value ? [...detail.value.usedBy.libraries.map((l) => l.name), ...detail.value.usedBy.works.map((w) => w.title)] : [];
  return names.length ? `used by ${names.join(', ')}` : 'not used yet';
});
const headerActions = computed(() => [
  ...(detail.value?.profile.shippedKey && detail.value.profile.editedByUser
    ? [{ label: 'Reset to shipped', icon: 'i-lucide-rotate-ccw', onClick: () => (confirmReset.value = true) }]
    : []),
  { label: 'Save', icon: 'i-lucide-check', primary: true, loading: saving.value, disabled: !draft.value, onClick: onSave },
]);
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <PageHeader :breadcrumb="[{ label: 'Release profiles', to: '/settings/profiles' }]" :actions="headerActions" />
    </template>
    <template #body>
      <PageBody>
        <UAlert v-if="error" color="error" variant="subtle" title="The profile couldn't be loaded." :description="error.message" />

        <template v-if="detail && draft">
          <div class="space-y-2">
            <UInput v-model="draft.name" size="xl" aria-label="Profile name" class="w-full max-w-lg" />
            <div class="flex flex-wrap items-center gap-2 text-xs text-muted">
              <UBadge
                v-for="badge in headerBadges"
                :key="badge"
                :label="badge"
                size="sm"
                :color="badge === 'Shipped' ? 'neutral' : 'warning'"
                variant="subtle"
              />
              <span>{{ [version, usedBy].filter(Boolean).join(' · ') }}</span>
            </div>
          </div>
          <UAlert v-if="banner" color="warning" variant="subtle" icon="i-lucide-triangle-alert" :title="banner" />
          <UAlert
            v-for="warning in detail.targetWarnings"
            :key="warning.libraryId"
            color="neutral"
            variant="subtle"
            icon="i-lucide-info"
            :title="warning.message"
          />

          <Section title="Qualities" description="Ticked qualities can be grabbed, best first. Move one up or down to rank it.">
            <ReleaseProfileQualityRanking v-model="draft.qualities" />
          </Section>

          <Section title="Scores and upgrades" description="A release must reach the minimum score. Upgrades stop at the cutoff.">
            <div class="grid gap-4 sm:grid-cols-2 lg:grid-cols-4">
              <UFormField label="Minimum score" help="Compared without the preparation formats.">
                <UInputNumber v-model="draft.minimumScore" class="w-full" />
              </UFormField>
              <UFormField label="Cutoff quality">
                <USelect v-model="draft.cutoff.quality" :items="qualityItems" class="w-full" />
              </UFormField>
              <UFormField label="Cutoff score">
                <UInputNumber v-model="draft.cutoff.score" class="w-full" />
              </UFormField>
              <UFormField label="Minimum upgrade step">
                <UInputNumber v-model="draft.minimumUpgradeStep" class="w-full" />
              </UFormField>
            </div>
          </Section>

          <Section title="Season packs and protocols">
            <div class="flex items-start gap-4">
              <div class="flex-1">
                <p class="text-sm font-medium text-highlighted">Prefer full-season packs</p>
                <p class="text-xs text-muted">A pack of the whole season wins over single episodes when its quality and preparation are as good.</p>
              </div>
              <USwitch
                :model-value="draft.preferSeasonPacks === true"
                aria-label="Prefer full-season packs"
                @update:model-value="draft.preferSeasonPacks = $event"
              />
            </div>
            <div class="flex flex-wrap items-start gap-4 border-t border-default pt-4">
              <div class="flex-1">
                <p class="text-sm font-medium text-highlighted">Protocols</p>
                <p class="text-xs text-muted">Which kinds of release this profile may grab.</p>
              </div>
              <UCheckboxGroup v-model="draft.protocols" :items="protocolItems" orientation="horizontal" />
            </div>
          </Section>

          <Section title="Languages">
            <ReleaseProfileLanguageList v-model="draft.languages" />
          </Section>

          <Section
            title="Custom formats"
            description="Scores added to a release that matches. Built-in preparation formats are computed against the library's target."
          >
            <ReleaseProfileFormatScores v-model="draft.formatScores" :catalogue="detail.formatCatalogue" />
          </Section>

          <Section title="Your formats">
            <ReleaseProfileUserFormatEditor v-model="draft.userFormats" />
          </Section>

          <Section title="Release groups">
            <ReleaseProfileGroupTiers v-model="draft.groupTiers" />
          </Section>

          <UModal v-model:open="confirmReset" title="Reset to the shipped version?">
            <template #body>
              <p class="text-sm">Your changes to this profile are replaced by the shipped version. Future picks use it.</p>
            </template>
            <template #footer>
              <div class="flex w-full justify-end gap-2">
                <UButton color="neutral" variant="ghost" label="Keep my edits" @click="confirmReset = false" />
                <UButton color="warning" label="Reset" @click="onReset" />
              </div>
            </template>
          </UModal>
        </template>
      </PageBody>
    </template>
  </UDashboardPanel>
</template>
