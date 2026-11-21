<!--
  A poster (2:3) or still (16:9) from an image URL the backend serves.
  With no image yet, or one that fails to load, it shows bg-elevated with
  an image icon, never a broken image. Sizes: xs 32, sm 40, md 92, lg 132
  px wide, or fill its container.
-->
<script setup lang="ts">
import { mediaUrl } from '~/lib/media';

const props = withDefaults(defineProps<{ src?: string; alt?: string; size?: 'xs' | 'sm' | 'md' | 'lg' | 'fill'; kind?: 'poster' | 'still' }>(), {
  src: undefined,
  alt: '',
  size: 'md',
  kind: 'poster',
});

const failed = ref(false);
watch(
  () => props.src,
  () => (failed.value = false),
);
const WIDTH = { xs: 'w-8', sm: 'w-10', md: 'w-[92px]', lg: 'w-[132px]', fill: 'w-full' } as const;
const ICON = { xs: 'size-3.5', sm: 'size-4', md: 'size-6', lg: 'size-7', fill: 'size-8' } as const;
const { convex } = useUrls();
const url = computed(() => mediaUrl(props.src, convex));
const shown = computed(() => url.value && !failed.value);
</script>

<template>
  <div
    class="relative shrink-0 overflow-hidden ring ring-default bg-elevated"
    :class="[WIDTH[size], kind === 'poster' ? 'aspect-[2/3]' : 'aspect-video', size === 'xs' || size === 'sm' ? 'rounded-md' : 'rounded-lg']"
  >
    <img v-if="shown" :src="url" :alt="alt" loading="lazy" decoding="async" class="absolute inset-0 size-full object-cover" @error="failed = true" />
    <div v-else class="absolute inset-0 grid place-items-center text-dimmed" role="img" :aria-label="alt ? `${alt}: no image yet` : 'No image yet'">
      <UIcon name="i-lucide-image" :class="ICON[size]" />
    </div>
    <slot />
  </div>
</template>
