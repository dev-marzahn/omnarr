<!--
  The library: Series, or Movies with ?kind=movies.
  A poster grid by default with a toggle to a list view; the filter, search
  and view are in the URL (?filter=, ?q=, ?view=), and the view is also
  remembered in this browser. Each Work shows its state bar and one status
  line.
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';
import type { LibraryKind } from '@omnarr/contracts';

import { activeDownloadsLine, seedingMarker } from '~/lib/downloads';
import { libraryQuery, libraryState, type LibraryView, workLine } from '~/lib/library';
import { matchesFilter, type WorkFilter } from '~/lib/unitStates';

const route = useRoute();
const router = useRouter();
const toast = useToast();
const kind = computed<LibraryKind>(() => (route.query.kind === 'movies' ? 'movies' : 'series'));
const { data, error } = useQuery(api.api.library.list, () => ({ kind: kind.value }));
const { data: profiles } = useQuery(api.api.releaseProfiles.list, {});
const profileName = (id: string) => profiles.value?.find((p) => p.id === id)?.name ?? '';

// The view, from the URL, else the one this browser remembers, else the grid.
const VIEW_KEY = 'omnarr.library.view';
const remembered = (): LibraryView | undefined => {
  try {
    const value = localStorage.getItem(VIEW_KEY);
    return value === 'list' || value === 'grid' ? value : undefined;
  } catch {
    return undefined;
  }
};
const state = computed(() => libraryState(route.query));
const view = computed<LibraryView>(() => state.value.view ?? remembered() ?? 'grid');
const filter = computed(() => state.value.filter);
const text = ref(state.value.q);
function update(next: Partial<{ view: LibraryView; filter: WorkFilter; q: string }>) {
  const merged = { view: view.value, filter: filter.value, q: text.value, ...next };
  if (next.view) {
    try {
      localStorage.setItem(VIEW_KEY, next.view);
    } catch {
      // A private window keeps the view in the URL only.
    }
  }
  void router.replace({ query: libraryQuery(route.query, merged) as Record<string, string> });
}
watch(text, (q) => update({ q }));

const adding = ref(false);
const works = computed(() => data.value?.works ?? []);
const shown = computed(() => works.value.filter((w) => matchesFilter(w, filter.value) && w.title.toLowerCase().includes(text.value.trim().toLowerCase())));
const filters = computed(() => [
  { value: 'all', label: 'All', count: works.value.length },
  { value: 'missing', label: 'Missing', count: works.value.filter((w) => matchesFilter(w, 'missing')).length },
  { value: 'notInTargetFormat', label: 'Not in target format', count: works.value.filter((w) => matchesFilter(w, 'notInTargetFormat')).length },
  { value: 'issues', label: 'Issues', count: works.value.filter((w) => matchesFilter(w, 'issues')).length },
]);
const noun = computed(() => (kind.value === 'series' ? 'series' : 'movie'));

async function onSubscribed(workId: string, title: string) {
  toast.add({ title: `Subscribed to ${title}`, icon: 'i-lucide-circle-check', color: 'success' });
  await navigateTo(`/library/${workId}`);
}
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <PageHeader
        :title="kind === 'series' ? 'Series' : 'Movies'"
        :actions="data?.library ? [{ label: `Add ${noun}`, icon: 'i-lucide-plus', primary: true, onClick: () => (adding = true) }] : []"
      >
        <template v-if="data?.library && works.length > 0" #toolbar>
          <!-- Writes ?filter= itself; the list reads it back from the route. -->
          <ResponsiveFilter :items="filters" class="flex-1 sm:flex-none" />
          <span class="hidden sm:block flex-1" />
          <UInput v-model="text" icon="i-lucide-search" placeholder="Filter by title" aria-label="Filter by title" class="w-36 sm:w-60" />
          <UFieldGroup>
            <UButton
              icon="i-lucide-layout-grid"
              color="neutral"
              :variant="view === 'grid' ? 'subtle' : 'ghost'"
              square
              aria-label="Grid view"
              :aria-pressed="view === 'grid'"
              @click="update({ view: 'grid' })"
            />
            <UButton
              icon="i-lucide-list"
              color="neutral"
              :variant="view === 'list' ? 'subtle' : 'ghost'"
              square
              aria-label="List view"
              :aria-pressed="view === 'list'"
              @click="update({ view: 'list' })"
            />
          </UFieldGroup>
        </template>
      </PageHeader>
    </template>
    <template #body>
      <PageBody>
        <UAlert
          v-if="error"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          title="The library couldn't be loaded."
          :description="error.message"
        />
        <UAlert
          v-else-if="data && !data.library"
          color="neutral"
          variant="subtle"
          icon="i-lucide-info"
          title="No library yet"
          description="First-run setup creates the Series and Movies libraries."
        />
        <div v-else-if="!data" class="grid grid-cols-2 gap-4 sm:grid-cols-[repeat(auto-fill,minmax(164px,1fr))] sm:gap-5">
          <USkeleton v-for="i in 6" :key="i" class="aspect-[2/3] w-full rounded-lg" />
        </div>

        <template v-else-if="data.library">
          <UEmpty
            v-if="works.length === 0"
            :icon="kind === 'series' ? 'i-lucide-tv' : 'i-lucide-film'"
            :title="kind === 'series' ? 'No series yet' : 'No movies yet'"
            :description="`Find a ${noun} on TMDB and subscribe to it, or import the files you already have.`"
            :actions="[
              { label: `Find a ${noun}`, icon: 'i-lucide-search', onClick: () => (adding = true) },
              { label: 'Scan existing files', icon: 'i-lucide-scan-line', to: '/scan', color: 'neutral', variant: 'outline' },
            ]"
          />
          <p v-else-if="shown.length === 0" class="text-sm text-muted">No titles match this filter.</p>

          <div v-else-if="view === 'grid'" class="grid grid-cols-2 gap-4 sm:grid-cols-[repeat(auto-fill,minmax(164px,1fr))] sm:gap-5">
            <PosterCard v-for="work in shown" :key="work.workId" :work="work" />
          </div>

          <ul v-else class="divide-y divide-default rounded-lg ring ring-default">
            <li v-for="work in shown" :key="work.workId">
              <NuxtLink
                :to="`/library/${work.workId}`"
                class="grid grid-cols-[2.5rem_minmax(0,1fr)] items-center gap-x-4 gap-y-1 px-4 py-3 hover:bg-elevated/50 sm:grid-cols-[2.5rem_minmax(0,2fr)_minmax(0,1fr)_minmax(0,2fr)_8rem]"
              >
                <Poster size="sm" :src="work.posterUrl" :alt="work.title" class="row-span-2 sm:row-span-1" />
                <div class="min-w-0">
                  <p class="truncate font-semibold text-highlighted">{{ work.title }}</p>
                  <p class="flex items-center gap-1.5 text-xs text-muted">
                    <span class="tabular-nums">{{ work.year ?? '—' }}</span>
                    <UBadge
                      v-if="work.numberingScheme === 'anime'"
                      size="sm"
                      color="secondary"
                      variant="outline"
                      label="Anime"
                      class="px-1.5 py-0 text-[11px]"
                    />
                  </p>
                </div>
                <div class="text-xs text-muted">
                  <p>{{ workLine(work).line }}</p>
                  <p
                    v-if="seedingMarker(work.seeding)"
                    class="inline-flex items-center gap-1 text-success tabular-nums whitespace-nowrap"
                    :title="seedingMarker(work.seeding)!.title"
                  >
                    <UIcon name="i-lucide-arrow-up" class="size-3.5" />{{ seedingMarker(work.seeding)!.label }}
                  </p>
                </div>
                <div class="hidden sm:block min-w-0 space-y-1.5">
                  <StateBar :states="work.states" class="max-w-56" />
                  <p v-if="activeDownloadsLine(work.activeDownloads)" class="flex items-center gap-1 text-xs text-info tabular-nums">
                    <UIcon name="i-lucide-download" />{{ activeDownloadsLine(work.activeDownloads)!.line }}
                  </p>
                  <p v-if="workLine(work).issues" class="inline-flex items-center gap-1 text-xs text-error">
                    <UIcon name="i-lucide-triangle-alert" />{{ workLine(work).issues }} open
                  </p>
                </div>
                <p class="hidden sm:block truncate text-xs text-muted">{{ profileName(work.releaseProfileId) }}</p>
              </NuxtLink>
            </li>
          </ul>

          <AddTitleModal v-model:open="adding" :library="data.library" @subscribed="onSubscribed" />
        </template>
      </PageBody>
    </template>
  </UDashboardPanel>
</template>
