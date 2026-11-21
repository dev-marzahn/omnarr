<!--
  Issues: the tabs Needs action, In progress, System
  and Resolved & dismissed from issues.list's split, a class filter
  and a title filter, and one IssueRow per Issue with its fixes. A fix that
  starts a run moves its Issue to In progress until the run ends.
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';

import { type ClassFilter, classFilters, type IssueTab, issueTabs, ISSUES_EMPTY, matchesIssueFilter } from '~/lib/issues';

const { data, error, isLoading } = useQuery(api.api.issues.list, {});
const tab = ref<string>('needsAction');
const filter = ref<string>('all');
const text = ref('');

const tabs = computed(() => (data.value ? issueTabs(data.value) : []));
const rows = computed(() => (data.value ? data.value[tab.value as IssueTab] : []));
const filters = computed(() => classFilters(rows.value));
const shown = computed(() => rows.value.filter((row) => matchesIssueFilter(row, filter.value as ClassFilter, text.value)));
const HINT: Record<IssueTab, string> = {
  needsAction: 'A fix that starts a run moves its Issue to In progress until the run ends.',
  inProgress: "These Issues close when the fix's run succeeds, and come back here if it fails.",
  system: "Problems with omnarr's own parts. Most resolve themselves once their cause is gone.",
  resolved: 'Issues resolved or dismissed in the last 30 days.',
};
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <PageHeader title="Issues">
        <template #tabs>
          <ResponsiveTabs v-if="tabs.length" v-model="tab" :items="tabs" />
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
          title="The Issues couldn't be loaded."
          :description="error.message"
        />
        <template v-else-if="isLoading">
          <USkeleton v-for="i in 3" :key="i" class="h-20 w-full" />
        </template>
        <template v-else-if="data">
          <p class="text-sm text-muted">{{ HINT[tab as IssueTab] }}</p>
          <div v-if="rows.length" class="flex flex-col gap-3 sm:flex-row sm:items-center">
            <ResponsiveFilter v-if="tab !== 'system'" v-model="filter" :items="filters" class="flex-1" />
            <UInput v-model="text" icon="i-lucide-search" placeholder="Filter by title" size="sm" class="sm:w-60" aria-label="Filter by title" />
          </div>
          <ul v-if="shown.length" class="divide-y divide-default rounded-lg ring ring-default">
            <IssuesIssueRow v-for="issue in shown" :key="issue.issueId" :issue="issue" />
          </ul>
          <UEmpty v-else-if="rows.length" icon="i-lucide-filter-x" title="No Issue matches" description="Change the filter to see the others." />
          <UEmpty v-else icon="i-lucide-circle-check" :title="ISSUES_EMPTY.title" :description="ISSUES_EMPTY.description" />
        </template>
      </PageBody>
    </template>
  </UDashboardPanel>
</template>
