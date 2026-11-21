<!--
  The user menu in the sidebar's footer: Password, Appearance (System,
  Light, Dark) and Sign out.
-->
<script setup lang="ts">
import type { DropdownMenuItem } from '@nuxt/ui';

defineProps<{ collapsed?: boolean }>();

const { $auth } = useNuxtApp();
const session = $auth.useSession();
const colorMode = useColorMode();
const name = computed(() => {
  const user = session.value.data?.user as { username?: string | null; name?: string } | undefined;
  return user?.username ?? user?.name ?? '';
});

const MODES = [
  { value: 'system', label: 'System', icon: 'i-lucide-monitor' },
  { value: 'light', label: 'Light', icon: 'i-lucide-sun' },
  { value: 'dark', label: 'Dark', icon: 'i-lucide-moon' },
] as const;

async function signOut() {
  await $auth.signOut();
  await navigateTo('/login');
}

const items = computed<DropdownMenuItem[][]>(() => [
  [{ type: 'label', label: `Signed in as ${name.value}` }],
  [
    { label: 'Password', icon: 'i-lucide-key-round', to: '/account/password' },
    {
      label: 'Appearance',
      icon: colorMode.value === 'dark' ? 'i-lucide-moon' : 'i-lucide-sun',
      children: MODES.map((mode) => ({
        label: mode.label,
        icon: mode.icon,
        type: 'checkbox' as const,
        checked: colorMode.preference === mode.value,
        onSelect: (e: Event) => {
          e.preventDefault();
          colorMode.preference = mode.value;
        },
      })),
    },
  ],
  [{ label: 'Sign out', icon: 'i-lucide-log-out', onSelect: signOut }],
]);
</script>

<template>
  <UDropdownMenu
    :items="items"
    :content="{ align: 'center', collisionPadding: 12 }"
    :ui="{ content: collapsed ? 'w-48' : 'w-(--reka-dropdown-menu-trigger-width)' }"
  >
    <UButton
      color="neutral"
      variant="ghost"
      block
      :square="collapsed"
      class="data-[state=open]:bg-elevated"
      :aria-label="collapsed ? `User menu: ${name}` : undefined"
      :trailing-icon="collapsed ? undefined : 'i-lucide-chevrons-up-down'"
      :ui="{ trailingIcon: 'text-dimmed ms-auto' }"
    >
      <UAvatar :text="name.slice(0, 1).toUpperCase()" size="xs" />
      <span v-if="!collapsed" class="min-w-0 text-start leading-tight">
        <span class="block truncate font-medium text-highlighted">{{ name }}</span>
        <span class="block text-xs text-muted">Administrator</span>
      </span>
    </UButton>
  </UDropdownMenu>
</template>
