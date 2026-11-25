<!--
  Settings › Metadata: test and store your own TMDB API
  Read Access Token, see which token is in use, and each source's health:
  one badge and one line. The token itself is never shown.
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';
import { SOURCE_LABEL } from '@omnarr/contracts';

import { sourceHealth } from '~/lib/metadata';
import { formatAirDate } from '~/lib/unitStates';

const { data: settings, error } = useQuery(api.api.metadata.settings, {});
const testKey = useAction(api.api.metadata.testKey);
const clearUserToken = useMutation(api.api.metadata.clearUserToken);

const token = ref('');
const testing = ref(false);
const result = ref<{ color: 'success' | 'error' | 'warning'; title: string }>();

const RESULT = {
  valid: { color: 'success', title: 'TMDB accepted this token. It is used from now on.' },
  rejected: { color: 'error', title: 'TMDB rejected this token (HTTP 401). The previous token stays in use.' },
  unreachable: { color: 'warning', title: "Couldn't reach TMDB to test the token. Nothing was changed." },
} as const;

async function test() {
  testing.value = true;
  result.value = undefined;
  try {
    const { outcome } = await testKey({ token: token.value.trim() });
    result.value = RESULT[outcome];
    if (outcome === 'valid') token.value = '';
  } catch {
    result.value = RESULT.unreachable;
  } finally {
    testing.value = false;
  }
}

const time = new Intl.DateTimeFormat(undefined, { hour: '2-digit', minute: '2-digit' });
const when = (at: number) => (Date.now() - at < 86_400_000 ? time.format(at) : `${formatAirDate(at)} ${time.format(at)}`);
const sources = computed(() => (settings.value?.sources ?? []).map((source) => ({ name: SOURCE_LABEL[source.name], ...sourceHealth(source, when) })));
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <PageHeader title="Metadata" />
    </template>
    <template #body>
      <PageBody>
        <p class="text-sm text-muted max-w-2xl">Titles, posters and episode lists come from TMDB. A token is built in, so you don't need your own.</p>
        <UAlert
          v-if="error"
          color="error"
          variant="subtle"
          icon="i-lucide-triangle-alert"
          title="The metadata settings couldn't be loaded."
          :description="error.message"
        />

        <Section title="TMDB token" description="Use TMDB's API Read Access Token, not the API key. Only a token TMDB accepts is stored.">
          <UCard>
            <template #header>
              <div class="flex items-center gap-2">
                <h3 class="text-sm font-semibold text-highlighted">Token</h3>
                <UBadge
                  size="sm"
                  color="neutral"
                  variant="subtle"
                  :label="settings?.tokenSource === 'user' ? 'Using your token' : 'Using the built-in token'"
                />
              </div>
            </template>
            <div class="space-y-3">
              <form class="flex gap-2" @submit.prevent="test">
                <UInput
                  v-model="token"
                  type="password"
                  placeholder="API Read Access Token"
                  autocomplete="off"
                  class="flex-1"
                  aria-label="API Read Access Token"
                />
                <UButton type="submit" color="neutral" variant="outline" label="Test" :loading="testing" :disabled="!token.trim()" />
              </form>
              <UAlert v-if="result" :color="result.color" variant="subtle" :title="result.title" />
            </div>
            <template v-if="settings?.tokenSource === 'user'" #footer>
              <div class="flex items-center gap-2 text-sm text-muted">
                <span class="flex-1">Your token was last tested {{ settings.userTokenCheckedAt ? when(settings.userTokenCheckedAt) : '—' }}.</span>
                <UButton size="sm" color="neutral" variant="outline" label="Use the built-in token" @click="clearUserToken({})" />
              </div>
            </template>
          </UCard>
        </Section>

        <Section title="Sources" description="Each installation fetches these itself.">
          <ul class="divide-y divide-default rounded-lg ring ring-default">
            <li v-for="source in sources" :key="source.name" class="flex flex-wrap items-center gap-x-4 gap-y-1 px-4 py-3">
              <span class="w-full sm:w-48 font-medium text-highlighted">{{ source.name }}</span>
              <span class="flex-1 min-w-0 text-xs tabular-nums" :class="source.failing ? 'text-warning' : 'text-muted'">{{ source.line }}</span>
              <UBadge size="sm" variant="subtle" :color="source.badge.color" :label="source.badge.label" />
            </li>
          </ul>
        </Section>

        <TmdbAttribution />
      </PageBody>
    </template>
  </UDashboardPanel>
</template>
