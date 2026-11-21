<!--
  The Work page. A series: its hero (poster over the faded backdrop, title
  once, meta, state bar and status line), "Search wanted (N)" and "Prepare
  all (N)" in the header bar, and the tabs Episodes and Numbering. Seasons are collapsible lists with their
  roll-up and monitoring switch, or one season at a time from a select on a
  phone; each episode row (UnitRow) has one action and "…". A movie: its
  Work page is its item page too, so it renders the item's content
  (ItemContent) under the hero; /items/:id of a movie redirects here.
  Preparation: "Prepare now" in a row's "…", Cancel on a Preparing one,
  "Prepare all (N)".
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';
import type { Id } from '@omnarr/backend/dataModel';
import type { SetMonitoredRequest, UnitRow } from '@omnarr/contracts';

import { workCrumbs } from '~/lib/breadcrumbs';
import { activeDownloadsLine } from '~/lib/downloads';
import { jellyfinItemUrl, openInJellyfinItems } from '~/lib/jellyfin';
import { seasonKey, workLine, workMenu } from '~/lib/library';
import { prepareAllDialog, prepareAllLabel, prepareAllToast } from '~/lib/preparation';
import { groupBySeason, type SeasonGroup } from '~/lib/seasons';
import { type RowActionKind, upgradingTag } from '~/lib/unitStates';

const route = useRoute();
const toast = useToast();
const workId = computed(() => route.params.workId as Id<'works'>);
const { data, error, isLoading } = useQuery(api.api.library.detail, () => ({ workId: workId.value }));
const setMonitored = useMutation(api.api.units.setMonitored);

const work = computed(() => data.value?.work);
const isMovie = computed(() => work.value?.kind === 'movie');
const movieUnit = computed(() => (isMovie.value ? data.value?.units[0] : undefined));
const seasons = computed(() => groupBySeason(data.value?.units ?? []));
const seasonCount = computed(() => seasons.value.filter((g) => g.season !== undefined && g.season > 0).length);
usePageWorkKind(() => work.value?.kind);
const crumbs = computed(() => workCrumbs(work.value?.kind ?? 'series'));

// A movie's item content reads its Unit's timeline.
const { data: timeline } = useQuery(api.api.units.timeline, () => (movieUnit.value ? { unitId: movieUnit.value.unitId } : 'skip'));

const { data: profiles } = useQuery(api.api.releaseProfiles.list, {});
const profileName = computed(() => profiles.value?.find((p) => p.id === work.value?.releaseProfileId)?.name);
const meta = computed(() => {
  const w = work.value;
  if (!w) return [];
  const profile = profileName.value ? [`Release profile ${profileName.value}`] : [];
  if (w.kind === 'movie') return ['Movie', ...profile, w.monitored > 0 ? 'Monitored' : 'Not monitored'];
  return [
    `Series · ${seasonCount.value} ${seasonCount.value === 1 ? 'season' : 'seasons'}`,
    ...profile,
    w.monitorNewUnits ? 'New episodes monitored' : 'New episodes not monitored',
    ...(w.numberingScheme === 'anime' ? ['Anime numbering'] : []),
  ];
});
const status = computed(() => (work.value ? workLine(work.value) : undefined));

const pending = ref(new Set<string>());
async function run(key: string, task: () => Promise<unknown>, failure: string) {
  pending.value = new Set([...pending.value, key]);
  try {
    await task();
  } catch {
    toast.add({ title: failure, description: 'Try again.', color: 'error', icon: 'i-lucide-triangle-alert' });
  } finally {
    pending.value = new Set([...pending.value].filter((k) => k !== key));
  }
}
const change = (key: string, target: SetMonitoredRequest['target'], monitored: boolean) =>
  run(key, () => setMonitored({ target, monitored }), "Monitoring couldn't be changed");
const toggleSeason = (group: SeasonGroup, on: boolean) =>
  change(
    seasonKey(group.season),
    group.season === undefined ? { kind: 'units', unitIds: group.units.map((u) => u.unitId) } : { kind: 'season', workId: workId.value, season: group.season },
    on,
  );

const searchNow = useMutation(api.api.units.searchNow);
const searchAndPick = useSearchAndPick();
const cancelPreparation = useMutation(api.api.units.cancelPreparation);
const jellyfinAddress = useJellyfinAddress();

// Preparation: "Prepare now" on a Unit, Cancel on a Preparing one, "Prepare all (N)" for the Work.
const { data: playback } = useQuery(api.api.playback.get, () => (work.value ? { libraryId: work.value.libraryId } : 'skip'));
const keepOriginal = computed(() => playback.value?.keepOriginal ?? false);
const preparing = ref<UnitRow>();
// A row's Cancel opens the cancel-grab confirm for its running Grab.
const cancellingGrab = ref<Id<'grabs'>>();
const cancelOpen = computed({
  get: () => cancellingGrab.value !== undefined,
  set: (value) => {
    if (!value) cancellingGrab.value = undefined;
  },
});
const downloading = computed(() => activeDownloadsLine(work.value?.activeDownloads));
const prepareOpen = computed({
  get: () => preparing.value !== undefined,
  set: (value) => {
    if (!value) preparing.value = undefined;
  },
});

/**
 * A row's action. Fix… and Open issue open the item, whose Timeline tab
 * holds the Issue with its fixes; Search and pick opens its Candidates tab
 * on the new search.
 */
function onRowAction(unit: UnitRow, kind: RowActionKind) {
  if (kind === 'searchNow') return run(`row:${unit.unitId}`, () => searchNow({ unitIds: [unit.unitId] }), "The search couldn't start");
  if (kind === 'searchAndPick')
    return run(
      `row:${unit.unitId}`,
      () => searchAndPick({ unitId: unit.unitId, workId: workId.value, workKind: work.value?.kind }),
      "The search couldn't start",
    );
  if (kind === 'cancelGrab' && unit.download) return (cancellingGrab.value = unit.download.grabId);
  if (kind === 'cancelPreparation') return run(`row:${unit.unitId}`, () => cancelPreparation({ unitId: unit.unitId }), "The preparation couldn't be cancelled");
  if (kind === 'prepareNow') return (preparing.value = unit);
  if (kind === 'jellyfin' && unit.jellyfinItemPath) return window.open(jellyfinItemUrl(jellyfinAddress.value, unit.jellyfinItemPath), '_blank', 'noopener');
  if (kind === 'monitor' || kind === 'stopMonitoring') return change(unit.unitId, { kind: 'units', unitIds: [unit.unitId] }, kind === 'monitor');
  return navigateTo(`/items/${unit.unitId}`);
}

const prepareAll = useMutation(api.api.library.prepareAll);
const notInTarget = computed(() => work.value?.notInTargetCount ?? 0);
const confirmPrepareAll = ref(false);
const allDialog = computed(() =>
  work.value ? prepareAllDialog({ count: notInTarget.value, workTitle: work.value.title, keepOriginal: keepOriginal.value }) : undefined,
);
const preparingAll = ref(false);
async function onPrepareAll() {
  preparingAll.value = true;
  try {
    const { queued } = await prepareAll({ workId: workId.value });
    confirmPrepareAll.value = false;
    toast.add({ ...prepareAllToast(queued), color: 'success', icon: 'i-lucide-wand-sparkles' });
  } catch {
    toast.add({ title: "The preparations couldn't be queued", description: 'Try again.', color: 'error', icon: 'i-lucide-triangle-alert' });
  } finally {
    preparingAll.value = false;
  }
}

// The header bar.
const wanted = computed(() => (data.value?.units ?? []).filter((u) => u.monitored && (u.state === 'wanted' || u.state === 'failed')));
const actions = computed(() => {
  const list = [];
  if (wanted.value.length > 0)
    list.push({
      label: isMovie.value ? 'Search now' : `Search wanted (${wanted.value.length})`,
      icon: 'i-lucide-search',
      loading: pending.value.has('searchWanted'),
      onClick: () => run('searchWanted', () => searchNow({ unitIds: wanted.value.map((u) => u.unitId) }), "The search couldn't start"),
    });
  if (notInTarget.value > 0)
    list.push({ label: prepareAllLabel(notInTarget.value), icon: 'i-lucide-wand-sparkles', onClick: () => (confirmPrepareAll.value = true) });
  return list;
});
// A series' Files and Blocklist tabs, and its "…": Open in Jellyfin once a publish has recorded the series' item,
// Edit monitoring and Delete series… A movie reads both for its delete confirm.
const { data: files } = useQuery(api.api.library.files, () => (work.value ? { workId: workId.value } : 'skip'));
const { data: blocklist } = useQuery(api.api.library.blocklist, () => (work.value ? { workId: workId.value } : 'skip'));
const editingMonitoring = ref(false);
const deleting = ref(false);
const deleteFacts = computed(() => {
  const w = work.value;
  if (!w) return undefined;
  const distinct = new Map((files.value ?? []).map((file) => [file.fileId, file.sizeBytes]));
  return {
    kind: w.kind,
    title: w.title,
    units: w.units,
    files: distinct.size,
    sizeBytes: [...distinct.values()].reduce((sum, size) => sum + size, 0),
    blocklist: blocklist.value?.length ?? 0,
    activeDownloads: w.activeDownloads?.count ?? 0,
  };
});

// A movie's "…" mirrors it: Open in Jellyfin, its item's Prepare now and Search and pick, Edit monitoring, Delete movie….
const menu = computed(() => {
  const w = work.value;
  if (!w) return [];
  const editMonitoring = () => (editingMonitoring.value = true);
  const onDelete = () => (deleting.value = true);
  if (!isMovie.value) return workMenu('series', openInJellyfinItems(jellyfinAddress.value, w.jellyfinItemPath), { editMonitoring, delete: onDelete });
  const unit = movieUnit.value;
  if (!unit) return [];
  return workMenu('movie', openInJellyfinItems(jellyfinAddress.value, w.jellyfinItemPath ?? unit.jellyfinItemPath), {
    editMonitoring,
    delete: onDelete,
    ...(unit.state === 'notInTargetFormat' ? { prepareNow: () => (preparing.value = unit) } : {}),
    // A movie's Work page is its item page: Search and pick opens its Candidates tab.
    searchAndPick: () => searchAndPick({ unitId: unit.unitId, workId: workId.value, workKind: 'movie' }),
  });
});

// Seasons: collapsible on a desktop, one at a time from a select on a phone.
const monitoringLabel = { all: 'Monitored', some: 'Partly monitored', none: 'Not monitored' } as const;
const open = ref<Record<string, boolean>>({});
const isOpen = (group: SeasonGroup) => open.value[group.label] ?? group.monitoring !== 'none';
const phoneSeason = ref<string>();
const shownSeason = computed(() => phoneSeason.value ?? seasons.value.find((g) => g.monitoring !== 'none')?.label ?? seasons.value[0]?.label);
const seasonItems = computed(() =>
  seasons.value.map((g) => ({ value: g.label, label: `${g.label} · ${g.units.length} ${g.units.length === 1 ? 'episode' : 'episodes'}` })),
);
const episodesLine = (group: SeasonGroup) => {
  const aired = group.units.filter((u) => u.airDateUtc !== undefined && u.airDateUtc <= Date.now()).length;
  const n = group.units.length;
  return `${n} ${n === 1 ? 'episode' : 'episodes'}${aired < n ? `, ${aired} aired` : ''}`;
};

const tab = ref('episodes');
const tabs = computed(() => [
  { value: 'episodes', label: 'Episodes', icon: 'i-lucide-list' },
  { value: 'files', label: 'Files', icon: 'i-lucide-file', count: deleteFacts.value?.files ?? 0 },
  { value: 'blocklist', label: 'Blocklist', icon: 'i-lucide-circle-slash', count: blocklist.value?.length ?? 0 },
  { value: 'numbering', label: 'Numbering', icon: 'i-lucide-hash' },
]);
</script>

<template>
  <UDashboardPanel :ui="{ body: 'p-0 sm:p-0 gap-0 sm:gap-0' }">
    <template #header>
      <PageHeader :breadcrumb="crumbs" :actions="actions" :menu="menu" />
    </template>
    <template #body>
      <WorkHero
        v-if="work"
        :title="work.title"
        :year="work.year"
        :meta="meta"
        :poster-url="work.posterUrl"
        :backdrop-url="work.backdropUrl"
        :overview="work.overview"
      >
        <template v-if="isMovie && movieUnit">
          <div class="flex flex-wrap items-center gap-2">
            <UnitStateBadge :state="movieUnit.state" />
            <UBadge v-if="movieUnit.openIssue" color="error" variant="subtle" icon="i-lucide-triangle-alert" label="Issue" />
            <UBadge v-if="movieUnit.upgrading" color="info" variant="subtle" icon="i-lucide-arrow-up-circle" :label="upgradingTag(movieUnit)" />
          </div>
        </template>
        <div v-else class="max-w-lg space-y-1.5">
          <StateBar :states="work.states" />
          <p class="flex flex-wrap gap-x-3 text-xs text-muted">
            <span v-if="status?.issues" class="text-error inline-flex items-center gap-1"><UIcon name="i-lucide-triangle-alert" />{{ status.issues }}</span>
            <span>{{ status?.line }}</span>
            <span v-if="downloading" class="text-info inline-flex items-center gap-1 tabular-nums"
              ><UIcon name="i-lucide-download" />{{ downloading.line }}</span
            >
          </p>
        </div>
      </WorkHero>

      <div v-if="work && !isMovie" class="shrink-0 border-b border-default px-4 sm:px-6">
        <div class="mx-auto max-w-6xl">
          <ResponsiveTabs v-model="tab" :items="tabs" />
        </div>
      </div>

      <div class="shrink-0 p-4 sm:p-6">
        <PageBody>
          <UAlert
            v-if="error"
            color="error"
            variant="subtle"
            icon="i-lucide-triangle-alert"
            title="This title couldn't be loaded."
            :description="error.message"
          />
          <UEmpty
            v-else-if="!isLoading && data === null"
            icon="i-lucide-search-x"
            title="This title isn't in the library"
            :actions="[{ label: 'Back to the library', to: crumbs[0]?.to ?? '/library' }]"
          />
          <template v-else-if="isLoading">
            <USkeleton v-for="i in 4" :key="i" class="h-12 w-full" />
          </template>

          <template v-else-if="work && isMovie">
            <ItemContent v-if="timeline && movieUnit" :timeline="timeline" :unit-id="movieUnit.unitId" />
            <USkeleton v-else class="h-40 w-full" />
          </template>

          <template v-else-if="work && tab === 'episodes'">
            <section
              v-for="group in seasons"
              :key="group.label"
              class="rounded-lg ring ring-default"
              :class="group.label === shownSeason ? '' : 'max-sm:hidden'"
            >
              <div class="flex flex-wrap items-center gap-x-3 gap-y-2 px-4 py-3">
                <UButton
                  color="neutral"
                  variant="link"
                  class="hidden sm:inline-flex px-0 font-semibold text-highlighted"
                  :icon="isOpen(group) ? 'i-lucide-chevron-down' : 'i-lucide-chevron-right'"
                  :label="group.label"
                  :aria-expanded="isOpen(group)"
                  @click="open[group.label] = !isOpen(group)"
                />
                <span class="hidden sm:inline text-sm text-muted">· {{ episodesLine(group) }}</span>
                <USelect
                  class="sm:hidden flex-1"
                  :model-value="shownSeason"
                  :items="seasonItems"
                  aria-label="Season"
                  @update:model-value="phoneSeason = String($event)"
                />
                <span class="hidden sm:block flex-1" />
                <span class="hidden md:flex flex-wrap gap-1">
                  <UnitStateBadge v-for="s in group.states" :key="s.state" :state="s.state" :count="s.count" size="sm" />
                </span>
                <span class="hidden sm:inline text-xs text-muted">{{ monitoringLabel[group.monitoring] }}</span>
                <USwitch
                  :model-value="group.monitoring === 'all'"
                  :aria-label="`${group.label}: ${monitoringLabel[group.monitoring]}`"
                  :loading="pending.has(seasonKey(group.season))"
                  @update:model-value="toggleSeason(group, $event)"
                />
              </div>
              <ul
                v-if="isOpen(group) || group.label === shownSeason"
                class="divide-y divide-default border-t border-default"
                :class="isOpen(group) ? '' : 'sm:hidden'"
              >
                <UnitRow
                  v-for="unit in group.units"
                  :key="unit.unitId"
                  :unit="unit"
                  :busy="pending.has(`row:${unit.unitId}`)"
                  @action="onRowAction(unit, $event)"
                />
              </ul>
            </section>
          </template>

          <template v-else-if="work && tab === 'files'">
            <WorkFilesPanel v-if="files" :files="files" :units="data?.units ?? []" @prepare="preparing = $event" />
            <USkeleton v-else class="h-40 w-full" />
          </template>

          <template v-else-if="work && tab === 'blocklist'">
            <WorkBlocklistPanel v-if="blocklist" :entries="blocklist" />
            <USkeleton v-else class="h-40 w-full" />
          </template>

          <WorkNumberingPanel
            v-if="work && (tab === 'numbering' || isMovie)"
            :work-id="workId"
            :kind="work.kind"
            :numbering-scheme="work.numberingScheme"
            :units="data?.units ?? []"
          />

          <TmdbAttribution v-if="work" />
        </PageBody>
      </div>

      <UModal v-if="allDialog" v-model:open="confirmPrepareAll" :title="allDialog.title">
        <template #body>
          <div class="space-y-2 text-sm">
            <p v-for="line in allDialog.lines" :key="line">{{ line }}</p>
          </div>
        </template>
        <template #footer>
          <div class="flex w-full justify-end gap-2">
            <UButton color="neutral" variant="ghost" label="Cancel" @click="confirmPrepareAll = false" />
            <UButton icon="i-lucide-wand-sparkles" :label="allDialog.confirm" :loading="preparingAll" @click="onPrepareAll" />
          </div>
        </template>
      </UModal>
      <TimelineCancelGrab v-if="cancellingGrab" v-model:open="cancelOpen" :grab-id="cancellingGrab" hide-button />
      <WorkMonitoringModal
        v-if="work"
        v-model:open="editingMonitoring"
        :work-id="workId"
        :kind="work.kind"
        :seasons="seasons"
        :monitor-new-units="work.monitorNewUnits"
        :pending="pending"
        @season="toggleSeason"
      />
      <WorkDeleteModal v-if="deleteFacts" v-model:open="deleting" :work-id="workId" :facts="deleteFacts" :back="crumbs[0]?.to ?? '/library'" />
      <PrepareNowModal v-if="preparing && work" v-model:open="prepareOpen" :unit="preparing" :work-title="work.title" :keep-original="keepOriginal" />
    </template>
  </UDashboardPanel>
</template>
