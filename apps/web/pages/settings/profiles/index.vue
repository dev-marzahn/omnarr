<!--
  Settings › Release profiles: the list with its
  Shipped, Edited and Update available badges, New, Duplicate and Delete.
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';
import type { ReleaseProfileSummary } from '@omnarr/contracts';

import { badges, profileErrorText } from '~/lib/releaseProfiles';

const toast = useToast();
const { data: profiles, error } = useQuery(api.api.releaseProfiles.list, {});
const create = useMutation(api.api.releaseProfiles.create);
const duplicate = useMutation(api.api.releaseProfiles.duplicate);
const remove = useMutation(api.api.releaseProfiles.remove);

const failed = (e: unknown) => toast.add({ title: profileErrorText(e), color: 'error', icon: 'i-lucide-triangle-alert' });

async function onNew() {
  try {
    const detail = await create({ name: `New profile ${(profiles.value?.length ?? 0) + 1}` });
    await navigateTo(`/settings/profiles/${detail.id}`);
  } catch (e) {
    failed(e);
  }
}

async function onDuplicate(profile: ReleaseProfileSummary) {
  try {
    const detail = await duplicate({ id: profile.id, name: `${profile.name} (copy)` });
    await navigateTo(`/settings/profiles/${detail.id}`);
  } catch (e) {
    failed(e);
  }
}

const usedByLine = (count: number) => (count === 0 ? 'Not used yet' : `Used by ${count} ${count === 1 ? 'library or title' : 'libraries and titles'}`);
const rowMenu = (profile: ReleaseProfileSummary) => [
  { label: 'Duplicate', icon: 'i-lucide-copy', onSelect: () => onDuplicate(profile) },
  {
    label: profile.usedBy > 0 ? 'Delete (in use)' : 'Delete',
    icon: 'i-lucide-trash',
    color: 'error' as const,
    disabled: profile.usedBy > 0,
    onSelect: () => onDelete(profile),
  },
];

async function onDelete(profile: ReleaseProfileSummary) {
  try {
    await remove({ id: profile.id });
    toast.add({ title: `Deleted ${profile.name}`, color: 'neutral' });
  } catch (e) {
    failed(e);
  }
}
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <PageHeader title="Release profiles" :actions="[{ label: 'New profile', icon: 'i-lucide-plus', primary: true, onClick: onNew }]" />
    </template>
    <template #body>
      <PageBody>
        <p class="text-sm text-muted">How releases are chosen. Editing a profile changes future picks only.</p>

        <UAlert v-if="error" color="error" variant="subtle" title="The profiles couldn't be loaded." :description="error.message" />
        <ul v-else class="divide-y divide-default rounded-lg ring ring-default">
          <li
            v-for="profile in profiles ?? []"
            :key="profile.id"
            class="grid gap-x-4 gap-y-1.5 px-4 py-3 sm:grid-cols-[minmax(0,2fr)_minmax(0,3fr)_auto] sm:items-center"
          >
            <div class="min-w-0">
              <NuxtLink :to="`/settings/profiles/${profile.id}`" class="block truncate font-medium text-highlighted hover:underline">{{
                profile.name
              }}</NuxtLink>
              <p class="text-xs text-muted">{{ usedByLine(profile.usedBy) }}</p>
            </div>
            <div class="flex flex-wrap gap-1">
              <UBadge
                v-for="badge in badges(profile)"
                :key="badge"
                size="sm"
                :color="badge === 'Shipped' ? 'neutral' : 'warning'"
                variant="subtle"
                :label="badge"
              />
              <UBadge v-if="!profile.shippedKey" size="sm" color="neutral" variant="outline" label="Yours" />
            </div>
            <div class="flex items-center gap-2 justify-end">
              <UButton size="xs" color="neutral" variant="outline" label="Edit" :to="`/settings/profiles/${profile.id}`" />
              <UDropdownMenu :items="rowMenu(profile)" :content="{ align: 'end' }">
                <UButton size="xs" color="neutral" variant="ghost" icon="i-lucide-ellipsis" square :aria-label="`More for ${profile.name}`" />
              </UDropdownMenu>
            </div>
          </li>
        </ul>
      </PageBody>
    </template>
  </UDashboardPanel>
</template>
