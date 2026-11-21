<!--
  One Issue on the Issues page: the poster, the title and episode
  with since when, the Issue's title with its class badge, and what happened;
  its fixes on the right, or under it on a phone. An Issue being fixed shows
  the fixing run's stage, with the download's progress while it downloads.
  The row links to the item, where the same fixes sit on the Issue.
-->
<script setup lang="ts">
import type { IssueRow } from '@omnarr/contracts';

import { downloadLine } from '~/lib/downloads';
import { CLASS_LOOK, issueContext, issueExplanation, issueItemLink, issueTitle } from '~/lib/issues';

const props = defineProps<{ issue: IssueRow }>();
const clock = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const day = new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });
// Today's Issues show the time, older ones the day too.
const formatTime = (ms: number) => (Date.now() - ms < 86_400_000 ? clock.format(ms) : day.format(ms));
const link = computed(() => issueItemLink(props.issue));
const look = computed(() => CLASS_LOOK[props.issue.class]);
const STAGES = {
  searching: 'Searching for a release',
  grabbed: 'Sending to the download client',
  downloading: 'Downloading',
  repairUnpack: 'Repair / unpack',
  importing: 'Importing',
  preparing: 'Preparing',
} as const;
const progress = computed(() => (props.issue.inProgress?.download ? downloadLine(props.issue.inProgress.download) : undefined));
</script>

<template>
  <li class="flex flex-col gap-3 px-4 py-3 sm:flex-row sm:items-start">
    <div class="flex min-w-0 flex-1 gap-3">
      <Poster v-if="issue.unit" :src="issue.posterUrl" :alt="issue.unit.workTitle" size="sm" class="shrink-0 self-start" />
      <div class="min-w-0 flex-1 space-y-1">
        <p class="text-xs text-muted truncate">
          <NuxtLink v-if="link" :to="link" class="hover:underline">{{ issueContext(issue, formatTime) }}</NuxtLink>
          <template v-else>{{ issueContext(issue, formatTime) }}</template>
        </p>
        <div class="flex flex-wrap items-center gap-2">
          <span class="font-medium text-highlighted">{{ issueTitle(issue.failureCode) }}</span>
          <UBadge size="sm" :color="look.color" variant="subtle" :label="look.label" />
          <UBadge v-if="issue.state === 'dismissed'" size="sm" color="neutral" variant="outline" label="Dismissed" />
        </div>
        <!-- A long detail (ffmpeg's last lines) is cut to three lines here; the item page's Issue shows it whole. -->
        <p v-if="issueExplanation(issue)" class="text-sm text-muted whitespace-pre-line break-words line-clamp-3">{{ issueExplanation(issue) }}</p>
        <template v-if="issue.inProgress">
          <DownloadProgress v-if="progress" variant="inline" :percent="progress.percent" :line="`${STAGES[issue.inProgress.stage]} · ${progress.line}`" />
          <p v-else class="flex items-center gap-1.5 text-xs text-info">
            <UIcon name="i-lucide-loader-circle" class="animate-spin" />{{ STAGES[issue.inProgress.stage] }}
          </p>
        </template>
      </div>
    </div>
    <div class="flex shrink-0 justify-end">
      <IssuesIssueActions v-if="issue.state === 'open' && !issue.inProgress" :issue="issue" />
      <UButton v-else-if="link" size="xs" color="neutral" variant="ghost" icon="i-lucide-history" label="Open timeline" :to="link" />
    </div>
  </li>
</template>
