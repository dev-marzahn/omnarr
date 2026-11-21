<!--
  Every page's header bar: the worker banner above it, then the page name
  (a top-level page) or the parents as a breadcrumb (a detail page, whose
  title is its hero's h1), and the actions on the right: at most one primary, then outline buttons, then "…". On a phone
  the breadcrumb is a back link to the nearest parent, buttons keep only
  their icon, and any past the second go into "…". The optional tabs and
  toolbar (filters, search) sit under it in the same width box.
-->
<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui';

import { backLink, type Crumb } from '~/lib/breadcrumbs';

export type HeaderAction = {
  label: string;
  icon: string;
  primary?: boolean;
  to?: string;
  target?: string;
  loading?: boolean;
  disabled?: boolean;
  onClick?: () => void;
};

const props = defineProps<{
  title?: string;
  breadcrumb?: Crumb[];
  actions?: HeaderAction[];
  /** The "…" menu's items. */
  menu?: DropdownMenuItem[];
}>();
const slots = defineSlots<{ default?: () => unknown; right?: () => unknown; tabs?: () => unknown; toolbar?: () => unknown }>();

const back = computed(() => backLink(props.breadcrumb ?? []));
const actions = computed(() => props.actions ?? []);
/** On a phone: the first two actions as icons, the rest at the top of "…". */
const phoneMenu = computed<DropdownMenuItem[][]>(() =>
  [
    actions.value.slice(2).map((a) => ({ label: a.label, icon: a.icon, to: a.to, target: a.target, disabled: a.disabled, onSelect: a.onClick })),
    props.menu ?? [],
  ].filter((group) => group.length > 0),
);
const BOX = 'px-[max(1rem,calc((100%_-_72rem)/2))] sm:px-[max(1.5rem,calc((100%_-_72rem)/2))]';
</script>

<template>
  <WorkerBanner />
  <UDashboardNavbar :ui="{ root: BOX, title: 'text-base', right: 'gap-2' }" :toggle="{ class: 'lg:hidden -ms-1.5' }">
    <template #title>
      <template v-if="breadcrumb?.length">
        <UBreadcrumb :items="breadcrumb" class="hidden sm:flex min-w-0" :ui="{ link: 'text-sm font-normal', list: 'min-w-0' }" />
        <NuxtLink v-if="back" :to="back.to" class="sm:hidden inline-flex items-center gap-1 text-sm font-normal text-muted hover:text-default min-w-0">
          <UIcon name="i-lucide-chevron-left" class="size-4 shrink-0" />
          <span class="truncate">{{ back.label }}</span>
        </NuxtLink>
      </template>
      <span v-else class="truncate">{{ title }}</span>
    </template>

    <template #right>
      <slot name="right" />
      <!-- Desktop: every action with its label, then "…". -->
      <div v-if="actions.length || menu?.length" class="hidden sm:flex items-center gap-2">
        <UButton
          v-for="action in actions"
          :key="action.label"
          :icon="action.icon"
          :label="action.label"
          :color="action.primary ? 'primary' : 'neutral'"
          :variant="action.primary ? 'solid' : 'outline'"
          :to="action.to"
          :target="action.target"
          :loading="action.loading"
          :disabled="action.disabled"
          @click="action.onClick?.()"
        />
        <UDropdownMenu v-if="menu?.length" :items="menu" :content="{ align: 'end' }">
          <UButton icon="i-lucide-ellipsis" color="neutral" variant="outline" square aria-label="More actions" />
        </UDropdownMenu>
      </div>
      <!-- Phone: two icon buttons, the rest in "…". -->
      <div v-if="actions.length || menu?.length" class="sm:hidden flex items-center gap-2">
        <UTooltip v-for="action in actions.slice(0, 2)" :key="action.label" :text="action.label">
          <UButton
            :icon="action.icon"
            :aria-label="action.label"
            :color="action.primary ? 'primary' : 'neutral'"
            :variant="action.primary ? 'solid' : 'outline'"
            square
            :to="action.to"
            :target="action.target"
            :loading="action.loading"
            :disabled="action.disabled"
            @click="action.onClick?.()"
          />
        </UTooltip>
        <UDropdownMenu v-if="phoneMenu.length" :items="phoneMenu" :content="{ align: 'end' }">
          <UButton icon="i-lucide-ellipsis" color="neutral" variant="outline" square aria-label="More actions" />
        </UDropdownMenu>
      </div>
    </template>
  </UDashboardNavbar>
  <div v-if="slots.tabs" :class="[BOX, 'border-b border-default']">
    <slot name="tabs" />
  </div>
  <UDashboardToolbar v-if="slots.toolbar" :ui="{ root: `${BOX} py-2 overflow-visible`, left: 'flex-1 min-w-0 flex-wrap gap-2' }">
    <template #left>
      <slot name="toolbar" />
    </template>
  </UDashboardToolbar>
</template>
