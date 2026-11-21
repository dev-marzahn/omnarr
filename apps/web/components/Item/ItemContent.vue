<!--
  An item's content, shared by the episode page and a movie's Work page:
  the running download's progress at the top, then the tabs Timeline,
  Candidates, Files and Plays. Runs are numbered oldest first and shown
  newest first, with a toggle; a failed run a later run took over from
  collapses. Each Rendition is a "Preparation" entry among the runs. Plays
  come from units.plays. The Unit's open Issues sit at the top of Timeline
  with their fixes; Candidates picks a search and, on an offered "Search and
  pick", grabs any row through the grab confirm; a picked release that
  failed offers both searches. An episode's Candidates tab starts with
  "Might be this episode" when its last search has no picked or acceptable
  release (after "Possibly misread"), then a line per indexer of the chosen
  search: what it found, or why it was skipped or failed.
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';
import type { Id } from '@omnarr/backend/dataModel';
import type { CandidateRow, Timeline } from '@omnarr/contracts';

import { downloadLine, seedingLine } from '~/lib/downloads';
import { issueExplanation, issueTitle } from '~/lib/issues';
import { misreadRows } from '~/lib/misread';
import { fileRows, preparationEntries } from '~/lib/preparation';
import {
  pickedReleaseFailed,
  playText,
  runHeader,
  runPercent,
  searchOfferState,
  searchIndexerLines,
  searchOptions,
  searchSummary,
  timelineCards,
  triggerLabel,
  unclearCount,
} from '~/lib/timeline';

const props = defineProps<{ timeline: Timeline; unitId: Id<'units'> }>();
const route = useRoute();
const toast = useToast();

const preparation = computed(() => preparationEntries(props.timeline.events));
const others = computed(() => preparation.value.others.filter((event) => event.stage !== 'search' || event.kind !== 'stageStarted'));
const order = ref<'newest' | 'oldest'>('newest');
const cards = computed(() => timelineCards(props.timeline.runs, preparation.value.entries, order.value));
const files = computed(() => fileRows(props.timeline.files));
const { data: plays } = useQuery(api.api.units.plays, () => ({ unitId: props.unitId }));
const playTime = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

// The Candidates tab: which search, newest first; a new search (Search and pick) becomes the shown one.
const newestRun = computed(() => [...props.timeline.runs].sort((a, b) => b.startedAt - a.startedAt)[0]);
const searches = computed(() => searchOptions(props.timeline));
const chosen = ref<string>();
watch(
  () => searches.value[0]?.value,
  (newest) => (chosen.value = newest),
  { immediate: true },
);
const search = computed(() => searches.value.find((option) => option.value === chosen.value)?.search ?? searches.value[0]?.search);

// An offered "Search and pick" is open for an hour; the clock moves the state on.
const now = ref(Date.now());
const tick = setInterval(() => (now.value = Date.now()), 15_000);
onScopeDispose(() => clearInterval(tick));
const offer = computed(() => (search.value ? searchOfferState(search.value, now.value) : undefined));
const unclear = computed(() => (search.value ? unclearCount(search.value) : 0));

// "Might be this episode": the last search's releases the parser may have misread, when it has no picked or acceptable release.
const { data: misread } = useQuery(api.api.units.mightBeThisEpisode, () => (props.timeline.workKind === 'series' ? { unitId: props.unitId } : 'skip'));
const mightBe = computed(() => (misread.value?.length && props.timeline.lastSearch ? misreadRows(misread.value, props.timeline.lastSearch, now.value) : []));
// Each indexer's part in the chosen search (the last one or a run's): what it found, or why it was skipped or failed.
const indexerLines = computed(() => searchIndexerLines(search.value?.indexers ?? []));

const searchAndPick = useSearchAndPick();
const pickAgain = () => searchAndPick({ unitId: props.unitId, workId: props.timeline.workId, workKind: props.timeline.workKind });
const searchNow = useMutation(api.api.units.searchNow);
const searchAutomatically = () =>
  searchNow({ unitIds: [props.unitId] }).then(
    () => toast.add({ title: 'Searching', color: 'success', icon: 'i-lucide-search' }),
    () => toast.add({ title: "The search couldn't start", description: 'Try again.', color: 'error', icon: 'i-lucide-triangle-alert' }),
  );

// The grab confirm; after a grab, the Timeline tab shows the new run.
const grabbing = ref<CandidateRow>();
const grabOpen = computed({
  get: () => grabbing.value !== undefined,
  set: (value) => {
    if (!value) grabbing.value = undefined;
  },
});
const runIds = computed(() => [...props.timeline.runs].sort((a, b) => a.startedAt - b.startedAt).map((run) => run.grabId as string));
const toTimeline = () => navigateTo({ query: { ...route.query, tab: undefined } }, { replace: true });
// The release the user picked failed, and omnarr tried no other.
const pickFailed = computed(() => pickedReleaseFailed(props.timeline));

// The running download, its stage and the percent the client last reported.
const active = computed(() => {
  const run = newestRun.value;
  if (!run || !['submitting', 'downloading'].includes(run.state) || run.cancelRequested) return undefined;
  const number = props.timeline.runs.length;
  const torrent = (props.timeline.download?.protocol ?? run.search.candidates.find((c) => c.outcome === 'picked')?.protocol) === 'torrent';
  const context = `${runHeader(run, number).label} · ${torrent ? 'Torrent · qBittorrent' : 'Usenet · NZBGet'}`;
  // Timeline.download has the bytes and speed; without it, the run's last reported percent.
  if (props.timeline.download) return { run, context, ...downloadLine(props.timeline.download) };
  const stage = run.download?.clientStage === 'postProcessing' ? 'Repair / unpack' : run.download?.clientStage === 'downloading' ? 'Downloading' : 'Queued';
  const percent = runPercent(run);
  return { run, context, stage, percent, line: percent === undefined ? 'Waiting for the download client…' : '' };
});

// Once the download is done, its torrent seeding to its goal.
const seeding = computed(() => (active.value || !props.timeline.seeding ? undefined : seedingLine(props.timeline.seeding)));

const tab = ref('timeline');
const tabs = computed(() => [
  { value: 'timeline', label: 'Timeline', icon: 'i-lucide-history' },
  { value: 'candidates', label: 'Candidates', icon: 'i-lucide-list', count: search.value?.candidates.length ?? 0 },
  { value: 'files', label: 'Files', icon: 'i-lucide-file', count: files.value.length },
  { value: 'plays', label: 'Plays', icon: 'i-lucide-play', count: plays.value?.length ?? 0 },
]);
const summary = computed(() => {
  const runs = props.timeline.runs.length;
  const preps = preparation.value.entries.length;
  return [
    runs === 0 ? 'No run yet' : `${runs} ${runs === 1 ? 'run' : 'runs'}`,
    ...(preps ? [`${preps} ${preps === 1 ? 'preparation' : 'preparations'}`] : []),
  ].join(' · ');
});
</script>

<template>
  <DownloadProgress
    v-if="active"
    :stage="active.stage"
    :context="active.context"
    :percent="active.percent"
    :line="active.line || undefined"
    :release="active.run.title"
  >
    <template #actions><TimelineCancelGrab :grab-id="active.run.grabId" /></template>
  </DownloadProgress>
  <DownloadProgress
    v-else-if="seeding"
    :stage="seeding.stage"
    context="Torrent · qBittorrent"
    :percent="seeding.percent"
    :line="seeding.line"
    :release="timeline.seeding?.releaseTitle"
    color="success"
  />

  <ResponsiveTabs v-model="tab" :items="tabs" class="-mt-2 sm:border-b sm:border-default" />

  <template v-if="tab === 'timeline'">
    <!-- Each open Issue with its fixes, above the run that raised it. -->
    <UAlert
      v-for="issue in timeline.issues"
      :key="issue.issueId"
      color="error"
      variant="subtle"
      icon="i-lucide-triangle-alert"
      :title="issueTitle(issue.failureCode)"
      :description="issueExplanation(issue)"
      :ui="{ description: 'whitespace-pre-line', actions: 'flex-wrap' }"
    >
      <template #actions>
        <IssuesIssueActions :issue="issue" on-item size="sm" />
      </template>
    </UAlert>
    <UAlert
      v-if="pickFailed"
      color="warning"
      variant="subtle"
      icon="i-lucide-hand"
      title="The release you picked failed"
      :description="`omnarr didn't try another by itself. It is blocklisted for ${timeline.workTitle}. Pick another, or let omnarr search.`"
    >
      <template #actions>
        <UButton size="sm" icon="i-lucide-list-checks" label="Search and pick" @click="pickAgain" />
        <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-search" label="Search now" @click="searchAutomatically" />
      </template>
    </UAlert>

    <div class="flex flex-wrap items-center gap-2">
      <span class="flex-1 text-xs text-muted">{{ summary }}</span>
      <UTabs
        v-model="order"
        size="xs"
        variant="pill"
        :content="false"
        :items="[
          { label: 'Newest first', value: 'newest' },
          { label: 'Oldest first', value: 'oldest' },
        ]"
      />
    </div>

    <UCard v-if="timeline.lastSearch" :ui="{ body: 'py-3 sm:py-3' }">
      <div class="flex flex-wrap items-center gap-2 text-sm">
        <UIcon name="i-lucide-search" class="text-muted" />
        <span class="font-semibold text-highlighted">Search</span>
        <UBadge size="sm" color="neutral" variant="outline" :label="triggerLabel(timeline.lastSearch.trigger)" />
        <span class="text-xs text-muted">{{ searchSummary(timeline.lastSearch) }}</span>
        <UButton class="ms-auto" size="xs" color="neutral" variant="ghost" label="See candidates" @click="tab = 'candidates'" />
      </div>
    </UCard>

    <template v-for="card in cards" :key="card.key">
      <TimelineRun v-if="'run' in card" :run="card.run" :number="card.number" :recovered="card.recovered" />
      <TimelinePreparation v-else :entry="card.entry" :unit-id="unitId" />
    </template>
    <UEmpty
      v-if="cards.length === 0 && !timeline.lastSearch"
      icon="i-lucide-history"
      title="Nothing has happened yet"
      description="Searches, downloads and preparations show here as they happen."
    />

    <UCard v-if="others.length">
      <template #header><h3 class="text-sm font-semibold text-highlighted">Other events</h3></template>
      <ul class="space-y-1">
        <TimelineStage v-for="(event, i) in others" :key="i" :stage="event" />
      </ul>
    </UCard>
  </template>

  <template v-else-if="tab === 'candidates'">
    <ItemMightBeThisEpisode v-if="mightBe.length" :rows="mightBe" @grab="grabbing = $event" @search-again="pickAgain" />
    <ItemSearchIndexers v-if="indexerLines.length" :lines="indexerLines" />
    <UCard v-if="search">
      <template #header>
        <div class="flex flex-wrap items-center gap-2 text-sm">
          <USelect v-if="searches.length > 1" v-model="chosen" :items="searches" size="sm" class="w-full sm:w-64" aria-label="Search" />
          <UBadge v-else size="sm" color="neutral" variant="outline" :label="triggerLabel(search.trigger)" />
          <span class="text-muted">{{ searchSummary(search) }}</span>
          <span class="flex-1" />
          <template v-if="offer?.state === 'offered'">
            <span class="text-xs text-muted tabular-nums">Open for {{ offer.minutesLeft }} more {{ offer.minutesLeft === 1 ? 'minute' : 'minutes' }}</span>
            <UButton size="sm" color="neutral" variant="outline" icon="i-lucide-refresh-cw" label="Search again" @click="pickAgain" />
          </template>
          <UButton
            v-else-if="offer?.state === 'expired' || offer?.state === 'picked'"
            size="sm"
            color="neutral"
            variant="outline"
            icon="i-lucide-list-checks"
            label="Search again"
            @click="pickAgain"
          />
        </div>
      </template>
      <div class="space-y-3">
        <div v-if="offer?.state === 'running'" class="flex items-center gap-2 text-sm text-muted">
          <UIcon name="i-lucide-loader-circle" class="animate-spin" />
          <span>Searching the indexers… {{ search.candidates.length }} results so far. Nothing is grabbed by itself; the results open here for an hour.</span>
        </div>
        <UAlert
          v-if="offer?.state === 'offered' && unclear > 0"
          color="warning"
          variant="subtle"
          icon="i-lucide-circle-help"
          :description="`${unclear} ${unclear === 1 ? 'release' : 'releases'} may be this episode, but ${unclear === 1 ? 'its' : 'their'} numbering is unclear. omnarr can't tell which episode ${unclear === 1 ? 'it is' : 'they are'}, so it didn't grab one. Check the titles and pick one; it is imported as this episode.`"
        />
        <p v-if="offer?.state === 'expired'" class="text-sm text-muted">These results are over an hour old. Search again to grab from fresh ones.</p>
        <TimelineCandidateTable :candidates="search.candidates" :search="search" :now="now" @grab="grabbing = $event" />
      </div>
    </UCard>
    <UEmpty
      v-else
      icon="i-lucide-list"
      title="No search yet"
      description="The candidates of the latest search show here. Search and pick lists them without grabbing one."
      :actions="[{ label: 'Search and pick', icon: 'i-lucide-list-checks', onClick: pickAgain }]"
    />
    <TimelineGrabConfirm
      v-if="grabbing"
      v-model:open="grabOpen"
      :candidate="grabbing"
      :unit-title="timeline.title"
      :work-title="timeline.workTitle"
      :run-ids="runIds"
      @grabbed="toTimeline"
      @search-again="pickAgain"
    />
  </template>

  <template v-else-if="tab === 'files'">
    <UEmpty v-if="files.length === 0" icon="i-lucide-file" title="No file yet" description="The file shows here once a download is imported." />
    <ul v-else class="divide-y divide-default rounded-lg ring ring-default">
      <li v-for="file in files" :key="`${file.fileId}:${file.kind}`" class="space-y-1 px-4 py-3 text-sm">
        <div class="flex flex-wrap items-center gap-2">
          <UBadge size="sm" color="neutral" variant="subtle" :label="file.kind" />
          <UBadge size="sm" color="neutral" variant="outline" :label="file.origin" />
          <span class="text-xs" :class="file.fit.fits ? 'text-success' : 'text-warning'">{{ file.fit.text }}</span>
        </div>
        <p class="font-mono text-xs break-all text-highlighted">{{ file.name }}</p>
        <p class="font-mono text-xs text-muted break-all">{{ file.folder }}</p>
        <p v-if="file.sidecars.length" class="text-xs text-muted">Subtitle files: {{ file.sidecars.join(', ') }}</p>
      </li>
    </ul>
  </template>

  <template v-else>
    <UEmpty
      v-if="!plays?.length"
      icon="i-lucide-play"
      title="Not played yet"
      description="Plays in Jellyfin show here, with how each device played the file."
    />
    <ul v-else class="divide-y divide-default rounded-lg ring ring-default text-sm">
      <li v-for="(play, i) in plays" :key="i" class="px-4 py-2.5">{{ playText(play, playTime.format) }}</li>
    </ul>
  </template>
</template>
