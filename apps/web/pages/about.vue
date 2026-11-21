<!-- About: the running version and worker protocol, the licence, and the data sources with their credits. -->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';

import { TMDB_NOTICE } from '~/lib/metadata';

const config = useRuntimeConfig();
const { data: status } = useQuery(api.api.system.status, {});
const sources = [
  { name: 'TheXEM', line: "Scene numbering, the community's episode mapping service.", to: 'https://thexem.info' },
  { name: 'Anime-Lists', line: 'Anime numbering and AniDB links.', to: 'https://github.com/Anime-Lists/anime-lists' },
];
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <PageHeader title="About" />
    </template>
    <template #body>
      <PageBody>
        <Section title="omnarr" description="Free software under the GNU General Public License, version 3.">
          <UCard>
            <dl class="grid grid-cols-[8.5rem_1fr] gap-y-2 text-sm">
              <dt class="text-muted">Version</dt>
              <dd class="tabular-nums">{{ config.public.omnarrVersion || 'Development build' }}</dd>
              <dt class="text-muted">Worker protocol</dt>
              <dd class="tabular-nums">{{ status?.worker ? `v${status.worker.expectedVersion}` : '—' }}</dd>
              <dt class="text-muted">Licence</dt>
              <dd>GPL-3.0</dd>
            </dl>
          </UCard>
        </Section>

        <Section title="Data sources" description="Each installation fetches these sources itself; omnarr doesn't republish their data.">
          <ul class="divide-y divide-default rounded-lg ring ring-default">
            <li class="flex items-center gap-4 px-4 py-3">
              <div class="min-w-0 flex-1">
                <a href="https://www.themoviedb.org" target="_blank" rel="noopener" class="font-medium text-highlighted hover:underline">TMDB</a>
                <p class="text-xs text-muted">Titles, posters, seasons and air dates. {{ TMDB_NOTICE }}</p>
              </div>
              <TmdbAttribution logo-only />
            </li>
            <li v-for="source in sources" :key="source.name" class="flex items-center gap-4 px-4 py-3">
              <div class="min-w-0 flex-1">
                <p class="font-medium text-highlighted">{{ source.name }}</p>
                <p class="text-xs text-muted">{{ source.line }}</p>
              </div>
              <UButton
                :to="source.to"
                target="_blank"
                icon="i-lucide-external-link"
                color="neutral"
                variant="ghost"
                size="xs"
                square
                :aria-label="`Open ${source.name}`"
              />
            </li>
          </ul>
        </Section>
      </PageBody>
    </template>
  </UDashboardPanel>
</template>
