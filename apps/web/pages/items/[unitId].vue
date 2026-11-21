<!--
  The item page: one episode's hero (still, kicker, title once, state),
  Open in Jellyfin in the header bar with the address for the Jellyfin app
  in "…", and the item's tabs (ItemContent). A movie's
  item is its Work page, so a movie's /items/:id redirects there.
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';
import type { Id } from '@omnarr/backend/dataModel';

import { itemCrumbs } from '~/lib/breadcrumbs';
import { copyText } from '~/lib/browser';
import { jellyfinItemUrl } from '~/lib/jellyfin';

const route = useRoute();
const toast = useToast();
const unitId = computed(() => route.params.unitId as Id<'units'>);
const { data, error, isLoading } = useQuery(api.api.units.timeline, () => ({ unitId: unitId.value }));
const workKind = computed(() => data.value?.workKind);
usePageWorkKind(workKind);
watch(
  () => (workKind.value === 'movie' ? data.value?.workId : undefined),
  (workId) => {
    if (workId) void navigateTo(`/library/${workId}`, { replace: true });
  },
  { immediate: true },
);

const crumbs = computed(() =>
  itemCrumbs(data.value && workKind.value ? { workKind: workKind.value, workId: data.value.workId, workTitle: data.value.workTitle } : undefined),
);
const pad = (n?: number) => String(n ?? 0).padStart(2, '0');
const title = computed(() => data.value?.title ?? (data.value ? `Episode ${data.value.tmdbEpisode}` : ''));
const kicker = computed(() => {
  const t = data.value;
  if (!t) return '';
  // The timeline carries no air date or runtime yet; the Work page's row has the date.
  return `S${pad(t.tmdbSeason)}E${pad(t.tmdbEpisode)}${t.tmdbSeason === 0 ? ' · Specials' : ''}`;
});

// "Open in Jellyfin" and the address the Android app needs.
const jellyfinAddress = useJellyfinAddress();
const searchNow = useMutation(api.api.units.searchNow);
const setMonitored = useMutation(api.api.units.setMonitored);
const searchAndPick = useSearchAndPick();
const fail = (title: string) => toast.add({ title, description: 'Try again.', color: 'error', icon: 'i-lucide-triangle-alert' });
const actions = computed(() =>
  data.value?.jellyfinItemPath
    ? [{ label: 'Open in Jellyfin', icon: 'i-lucide-external-link', to: jellyfinItemUrl(jellyfinAddress.value, data.value.jellyfinItemPath), target: '_blank' }]
    : [],
);
const menu = computed(() => {
  const t = data.value;
  if (!t) return [];
  return [
    ...(t.state === 'wanted' || t.state === 'failed'
      ? [{ label: 'Search now', icon: 'i-lucide-search', onSelect: () => searchNow({ unitIds: [t.unitId] }).catch(() => fail("The search couldn't start")) }]
      : []),
    // Beside the automatic Search now: a search that doesn't grab, opened on Candidates.
    { label: 'Search and pick', icon: 'i-lucide-list-checks', onSelect: () => searchAndPick({ unitId: t.unitId, workId: t.workId, workKind: t.workKind }) },
    {
      label: t.monitored ? 'Stop monitoring' : 'Monitor',
      icon: t.monitored ? 'i-lucide-eye-off' : 'i-lucide-eye',
      onSelect: () =>
        setMonitored({ target: { kind: 'units', unitIds: [t.unitId] }, monitored: !t.monitored }).catch(() => fail("Monitoring couldn't be changed")),
    },
    ...(t.jellyfinItemPath
      ? [
          {
            label: `Jellyfin app address: ${jellyfinAddress.value}`,
            icon: 'i-lucide-copy',
            onSelect: () =>
              copyText(jellyfinAddress.value).then(
                () => toast.add({ title: 'Address copied', color: 'success' }),
                () => toast.add({ title: "The address couldn't be copied", color: 'error' }),
              ),
          },
        ]
      : []),
  ];
});
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0 sm:p-0 gap-0 sm:gap-0' }">
    <template #header>
      <PageHeader :breadcrumb="crumbs" :actions="actions" :menu="menu" />
    </template>
    <template #body>
      <UnitHero v-if="data && workKind === 'series'" :title="title" :kicker="kicker" :state="data.state" :still-url="data.stillUrl" />
      <div class="shrink-0 p-4 sm:p-6">
        <PageBody>
          <UAlert
            v-if="error"
            color="error"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            title="This item couldn't be loaded."
            :description="error.message"
          />
          <UEmpty
            v-else-if="!isLoading && data === null"
            icon="i-lucide-search-x"
            title="This item isn't in the library"
            :actions="[{ label: 'Back to the library', to: '/library' }]"
          />
          <template v-else-if="isLoading">
            <USkeleton class="h-10 w-full" />
            <USkeleton class="h-40 w-full" />
          </template>
          <ItemContent v-else-if="data && workKind === 'series'" :timeline="data" :unit-id="unitId" />
        </PageBody>
      </div>
    </template>
  </UDashboardPanel>
</template>
