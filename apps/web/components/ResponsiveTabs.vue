<!--
  Page tabs: UTabs variant="link" with counts as small badges; below sm one USelect with the icon, label and count. The tab
  is in the URL (`?tab=`), so the back button and reloads keep it; the first
  tab is the default and leaves the query clean. With `to`, each tab is its
  own route instead (Libraries & playback's /settings/playback/<kind>), and
  the model is the parent's. `variant="pill"` is the filter look
  (ResponsiveFilter).
-->
<script setup lang="ts">
export type TabItem = { value: string; label: string; icon?: string; count?: number | string; color?: 'error' | 'warning' | 'neutral' };

const props = withDefaults(
  defineProps<{ items: TabItem[]; param?: string; variant?: 'link' | 'pill'; selectIcon?: string; to?: (value: string) => string }>(),
  { param: 'tab', variant: 'link', selectIcon: undefined, to: undefined },
);

const route = useRoute();
const router = useRouter();
const model = defineModel<string>();
const fromQuery = computed(() => {
  const value = route.query[props.param];
  return typeof value === 'string' && props.items.some((item) => item.value === value) ? value : props.items[0]?.value;
});
watch(
  fromQuery,
  (value) => {
    if (!props.to && model.value !== value) model.value = value;
  },
  { immediate: true },
);
function select(value: string | number) {
  const v = String(value);
  if (props.to) {
    void navigateTo(props.to(v));
    return;
  }
  model.value = v;
  void router.replace({ query: { ...route.query, [props.param]: v === props.items[0]?.value ? undefined : v } });
}

const tabs = computed(() =>
  props.items.map((item) => ({
    value: item.value,
    label: props.variant === 'pill' && item.count !== undefined ? `${item.label} ${item.count}` : item.label,
    icon: props.variant === 'link' ? item.icon : undefined,
    badge:
      props.variant === 'link' && item.count !== undefined && item.count !== 0
        ? { label: String(item.count), size: 'sm' as const, color: item.color ?? ('neutral' as const), variant: 'subtle' as const }
        : undefined,
  })),
);
const options = computed(() =>
  props.items.map((item) => ({ value: item.value, label: item.count !== undefined ? `${item.label} · ${item.count}` : item.label, icon: item.icon })),
);
const current = computed(() => props.items.find((item) => item.value === model.value));
</script>

<template>
  <div class="min-w-0">
    <UTabs
      :model-value="model"
      :items="tabs"
      :content="false"
      :variant="variant"
      :size="variant === 'pill' ? 'sm' : 'md'"
      class="hidden sm:flex"
      :ui="variant === 'link' ? { list: 'border-b-0', trigger: 'py-3' } : undefined"
      @update:model-value="select"
    />
    <USelect
      :model-value="model"
      :items="options"
      :icon="selectIcon ?? current?.icon"
      class="sm:hidden w-full"
      :class="variant === 'link' ? 'my-2' : ''"
      :aria-label="variant === 'pill' ? 'Filter' : 'Tab'"
      @update:model-value="select"
    />
  </div>
</template>
