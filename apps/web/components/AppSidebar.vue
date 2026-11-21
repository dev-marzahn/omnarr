<!--
  The sidebar: Library, Scan with the untracked count, Issues, Settings,
  System with the worker dot, About; "Open Jellyfin" and the user menu in
  the footer. From lg it is always shown and collapses to icons, a parent's
  children opening as a flyout; below lg it is a slideover from the left
  that closes on navigation.
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';

import { activeNav, navBadges, sidebarItems } from '~/lib/nav';

const route = useRoute();
const workKind = usePageWorkKind();
const { data: scan } = useQuery(api.api.scan.status, {});
const { data: system } = useQuery(api.api.system.status, {});
// The Issues badge counts Needs action and System.
const { data: issues } = useQuery(api.api.issues.counts, {});
const badges = computed(() => navBadges({ untracked: scan.value?.untracked, system: system.value, issues: issues.value }));
const items = computed(() =>
  sidebarItems(activeNav({ path: route.path, query: route.query }, workKind.value), badges.value).map((item) => ({
    ...item,
    chip: item.key === 'system' && badges.value.systemDot ? { color: badges.value.systemDot } : undefined,
  })),
);
const jellyfin = useJellyfinAddress();
const open = ref(false);
</script>

<template>
  <UDashboardSidebar
    v-model:open="open"
    collapsible
    :default-size="15"
    :min-size="15"
    :max-size="15"
    :collapsed-size="4"
    mode="slideover"
    :ui="{ footer: 'flex-col items-stretch gap-1 border-t border-default py-3', body: 'gap-1' }"
  >
    <template #header="{ collapsed }">
      <NuxtLink to="/library" class="flex items-center gap-2 min-w-0" :class="collapsed ? 'mx-auto' : ''" aria-label="omnarr">
        <span class="size-7 shrink-0 rounded-lg bg-inverted text-inverted grid place-items-center">
          <UIcon name="i-lucide-play" class="size-4" />
        </span>
        <span v-if="!collapsed" class="font-semibold text-highlighted">omnarr</span>
      </NuxtLink>
      <UDashboardSidebarCollapse v-if="!collapsed" class="ms-auto hidden lg:inline-flex" />
    </template>

    <template #default="{ collapsed }">
      <UNavigationMenu :items="items" orientation="vertical" :collapsed="collapsed" tooltip popover highlight :ui="{ list: 'gap-0.5' }" />
      <UDashboardSidebarCollapse v-if="collapsed" class="mx-auto mt-auto hidden lg:inline-flex" />
    </template>

    <template #footer="{ collapsed }">
      <UNavigationMenu
        :items="[{ label: 'Open Jellyfin', icon: 'i-lucide-external-link', to: jellyfin, target: '_blank' }]"
        orientation="vertical"
        :collapsed="collapsed"
        tooltip
        :external-icon="false"
      />
      <UserMenu :collapsed="collapsed" />
    </template>
  </UDashboardSidebar>
</template>
