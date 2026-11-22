<!--
  Add or edit an indexer. A new indexer starts with a choice: a Newznab or
  Torznab API (URL and key), or a site (such as Nyaa, no URL or key). A new
  indexer, or a changed URL or key, must pass "Test connection" before Save unlocks; other edits save
  without a test. The key field never shows a stored key, only that one is
  stored. The first run's indexer step reuses this form.
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';
import type { IndexerDetail, IndexerKind, IndexerTestResult, SiteSettings } from '@omnarr/contracts';

import { BUSY_TEXT, capsBlock, failureText, healthBlock, indexerErrorText, parseCategories, SITES, siteName, siteTestText } from '~/lib/indexers';
import { initialSettings, settingsToSend } from '~/lib/sites';

const props = defineProps<{ indexer?: IndexerDetail }>();
const emit = defineEmits<{ saved: [detail: IndexerDetail]; cancel: [] }>();

const testIndexer = useAction(api.api.indexers.test);
const testSite = useAction(api.api.indexers.testSite);
const create = useAction(api.api.indexers.create);
const createSite = useAction(api.api.indexers.createSite);
const update = useAction(api.api.indexers.update);

/** Nyaa, built in, or a definition from the catalogue. */
type Site = (typeof SITES)[number]['kind'] | 'catalogue';
/** An API (URL and key) or a site; a stored indexer keeps its own. */
const source = ref<'api' | 'site'>(props.indexer?.kind === 'nyaa' || props.indexer?.kind === 'definition' ? 'site' : 'api');
const site = ref<Site>(props.indexer?.kind === 'definition' ? 'catalogue' : 'nyaa');
const isSite = computed(() => source.value === 'site');
const isDefinition = computed(() => isSite.value && site.value === 'catalogue');

// A definition: which one, its link and its settings.
const definitionId = ref<string | undefined>(props.indexer?.site?.definitionId);
const { data: definition } = useQuery(api.sites.definitions.get, () => (definitionId.value ? { definitionId: definitionId.value } : 'skip'));
const baseUrl = ref(props.indexer?.site?.baseUrl ?? '');
const siteSettings = ref<SiteSettings>({});
/** The Name the form filled in itself, so a change of site can replace it without touching a typed one. */
let filledName = '';
watch(
  definition,
  (next) => {
    if (!next) return;
    if (!next.meta.links.includes(baseUrl.value) && baseUrl.value !== props.indexer?.site?.baseUrl) baseUrl.value = next.meta.links[0] ?? '';
    siteSettings.value = initialSettings(next.meta, props.indexer?.site?.settings);
    if (!props.indexer) state.name = filledName = next.name;
  },
  { immediate: true },
);

const state = reactive({
  name: props.indexer?.name ?? '',
  url: props.indexer?.apiUrl ?? '',
  apiKey: '',
  kind: props.indexer?.kind as IndexerKind | undefined,
  priority: props.indexer?.priority ?? 25,
  rssIntervalMinutes: props.indexer?.rssIntervalMinutes ?? 15,
  apiLimitMax: props.indexer?.apiLimit?.source === 'user' ? props.indexer.apiLimit.max : undefined,
  series: (props.indexer?.categories.series ?? []).join(', '),
  movies: (props.indexer?.categories.movies ?? []).join(', '),
});

const result = ref<IndexerTestResult>();
const testing = ref(false);
const saving = ref(false);
const error = ref<string>();

/**
 * A new indexer, or a new URL or key, needs a passing test. A site's
 * URL and key are fixed; a stored definition indexer's new link or settings
 * are tested by Save itself.
 */
const needsTest = computed(() => (isSite.value ? !props.indexer : !props.indexer || state.apiKey !== '' || state.url.trim() !== props.indexer.apiUrl));
const canSave = computed(() => state.name.trim() !== '' && (!needsTest.value || result.value?.ok === true));
const canTest = computed(() =>
  isDefinition.value ? definitionId.value !== undefined : isSite.value || (state.url.trim() !== '' && (props.indexer !== undefined || state.apiKey !== '')),
);
watch(
  () => [state.url, state.apiKey, source.value, site.value, definitionId.value, baseUrl.value, JSON.stringify(siteSettings.value)],
  () => {
    result.value = undefined;
  },
);

/** The form's link and settings to send: an empty secret keeps the stored one. */
const siteValues = () => ({ baseUrl: baseUrl.value, settings: definition.value ? settingsToSend(definition.value.meta, siteSettings.value) : {} });
watch([source, site], () => {
  // A site names itself until the user types a name; "Other site" has no name until a definition is picked.
  if (props.indexer || !isSite.value) return;
  const next = site.value === 'catalogue' ? (definition.value?.name ?? '') : (SITES.find((s) => s.kind === site.value)?.label ?? '');
  state.name = siteName(state.name, filledName, next);
  filledName = next;
});

async function runTest() {
  testing.value = true;
  error.value = undefined;
  try {
    if (isDefinition.value) {
      result.value = props.indexer
        ? await testIndexer({ input: { indexerId: props.indexer.id } })
        : await testSite({ kind: 'definition', definitionId: definitionId.value!, ...siteValues() });
      return;
    }
    if (isSite.value) {
      result.value = props.indexer ? await testIndexer({ input: { indexerId: props.indexer.id } }) : await testSite({ kind: 'nyaa' });
      if (result.value.ok && !state.series && !state.movies) {
        state.series = '5070';
        state.movies = '2000';
      }
      return;
    }
    const input = props.indexer
      ? {
          indexerId: props.indexer.id,
          ...(state.url.trim() !== props.indexer.apiUrl ? { url: state.url } : {}),
          ...(state.apiKey ? { apiKey: state.apiKey } : {}),
        }
      : { url: state.url, apiKey: state.apiKey };
    result.value = await testIndexer({ input });
    if (result.value.ok && !state.series && !state.movies) {
      const ids = result.value.categories.map((c) => c.id);
      state.series = ids.filter((id) => (id >= 5000 && id < 6000) || id >= 100_000).join(', ');
      state.movies = ids.filter((id) => id >= 2000 && id < 3000).join(', ');
    }
  } catch (e) {
    error.value = indexerErrorText(e);
  } finally {
    testing.value = false;
  }
}

async function save() {
  saving.value = true;
  error.value = undefined;
  const common = {
    name: state.name.trim(),
    priority: state.priority,
    rssIntervalMinutes: state.rssIntervalMinutes,
    ...(state.apiLimitMax ? { apiLimitMax: state.apiLimitMax } : {}),
    ...(state.series || state.movies ? { categories: { series: parseCategories(state.series), movies: parseCategories(state.movies) } } : {}),
  };
  try {
    let detail: IndexerDetail;
    if (isDefinition.value) {
      // createSite tests and saves the definition with the categories it maps; the form's other settings follow as an edit.
      if (props.indexer) {
        const values = siteValues();
        const linkChanged = values.baseUrl !== props.indexer.site?.baseUrl;
        const settingsChanged = JSON.stringify(values.settings) !== JSON.stringify(initialSettingsSent());
        detail = await update({
          id: props.indexer.id,
          patch: { ...common, ...(linkChanged ? { baseUrl: values.baseUrl } : {}), ...(settingsChanged ? { settings: values.settings } : {}) },
        });
      } else {
        const id = (await createSite({ kind: 'definition', definitionId: definitionId.value!, ...siteValues(), name: common.name })).id;
        detail = await update({ id, patch: common });
      }
    } else if (isSite.value) {
      // createSite saves the site's defaults; the form's other settings follow as an edit.
      const id = props.indexer?.id ?? (await createSite({ kind: 'nyaa', name: common.name })).id;
      detail = await update({ id, patch: common });
    } else if (props.indexer) {
      detail = await update({
        id: props.indexer.id,
        patch: {
          ...common,
          ...(state.kind ? { kind: state.kind } : {}),
          ...(state.url.trim() !== props.indexer.apiUrl ? { url: state.url } : {}),
          ...(state.apiKey ? { apiKey: state.apiKey } : {}),
        },
      });
    } else {
      detail = await create({ ...common, ...(state.kind ? { kind: state.kind } : {}), url: state.url, apiKey: state.apiKey });
    }
    emit('saved', detail);
  } catch (e) {
    error.value = indexerErrorText(e);
  } finally {
    saving.value = false;
  }
}

/** The stored settings as the form first showed them, to tell whether the user changed any. */
const initialSettingsSent = () =>
  definition.value ? settingsToSend(definition.value.meta, initialSettings(definition.value.meta, props.indexer?.site?.settings)) : {};

/** A passed definition test: the site's name and what it searches. */
const definitionTestText = computed(() =>
  result.value?.ok && definition.value
    ? `${definition.value.name}: ${result.value.searchModes
        .filter((m) => m.available)
        .map((m) => m.mode)
        .join(', ')}`
    : '',
);

const time = (ms: number) => new Date(ms).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
const blocks = computed(() =>
  props.indexer
    ? [
        { title: 'Caps', rows: capsBlock(props.indexer) },
        { title: 'Health', rows: healthBlock(props.indexer, time) },
      ]
    : [],
);

const sources = [
  { value: 'api', label: 'Newznab or Torznab', description: 'An indexer API, with its URL and key.' },
  { value: 'site', label: 'Site', description: 'A site omnarr reads itself. No URL or key.' },
];
const sites = [
  ...SITES.map((s) => ({ value: s.kind as Site, label: s.label, description: s.description })),
  { value: 'catalogue' as Site, label: 'Other site', description: "From Prowlarr's site definitions." },
];
const kinds = [
  { value: 'newznab', label: 'Usenet (Newznab)' },
  { value: 'torznab', label: 'Torrent (Torznab)' },
];
</script>

<template>
  <UForm :state="state" class="space-y-4" @submit="save">
    <URadioGroup
      v-if="!indexer"
      v-model="source"
      legend="Type"
      orientation="horizontal"
      variant="card"
      :items="sources"
      :ui="{ fieldset: 'grid gap-2 sm:grid-cols-2' }"
    />
    <URadioGroup v-if="!indexer && isSite" v-model="site" legend="Site" :items="sites" />
    <SiteDefinitionPicker v-if="!indexer && isDefinition" v-model="definitionId" />

    <UFormField label="Name" name="name" required>
      <UInput v-model="state.name" class="w-full" />
    </UFormField>
    <SiteSettingsFields
      v-if="isDefinition && definition"
      v-model:base-url="baseUrl"
      v-model:settings="siteSettings"
      :meta="definition.meta"
      :secrets-set="indexer?.site?.secretsSet"
    />
    <template v-if="!isSite">
      <UFormField label="URL" name="url" required help="The API address. /api is added when it's missing.">
        <UInput v-model="state.url" placeholder="https://indexer.example" class="w-full" />
      </UFormField>
      <UFormField label="API key" name="apiKey" :required="!indexer">
        <UInput v-model="state.apiKey" type="password" autocomplete="off" :placeholder="indexer?.apiKeySet ? 'Stored' : ''" class="w-full" />
      </UFormField>
    </template>

    <div class="flex items-center gap-2">
      <UButton color="neutral" variant="outline" icon="i-lucide-plug" label="Test connection" :loading="testing" :disabled="!canTest" @click="runTest" />
      <span v-if="result?.ok && isDefinition" class="text-sm text-success">{{ definitionTestText }} · {{ result.latencyMs }} ms</span>
      <span v-else-if="result?.ok && isSite && site !== 'catalogue'" class="text-sm text-success">
        {{ siteTestText('nyaa').title }} · {{ siteTestText('nyaa').categories.join(', ') }} · {{ result.latencyMs }} ms
      </span>
      <span v-else-if="result?.ok" class="text-sm text-success">
        {{ result.kind === 'torznab' ? 'Torznab' : result.kind === 'newznab' ? 'Newznab' : 'Connected' }} ·
        {{
          result.searchModes
            .filter((m) => m.available)
            .map((m) => m.mode)
            .join(', ')
        }}
        · {{ result.latencyMs }} ms
        <template v-if="result.apiLimit"> · limit {{ result.apiLimit.max }} a day</template>
      </span>
    </div>
    <UAlert v-if="result && !result.ok && result.failure" color="error" variant="subtle" icon="i-lucide-triangle-alert" :title="failureText(result.failure)" />
    <UAlert v-if="result?.skipped" color="warning" variant="subtle" icon="i-lucide-hourglass" :title="BUSY_TEXT" />
    <URadioGroup v-if="result?.ok && !result.kind" v-model="state.kind" legend="The answer doesn't say which kind this is" :items="kinds" />

    <section v-for="block in blocks" :key="block.title" class="space-y-1">
      <h3 class="text-sm font-medium">{{ block.title }}</h3>
      <dl class="grid grid-cols-[max-content_1fr] gap-x-4 gap-y-1 text-sm">
        <template v-for="row in block.rows" :key="row.label">
          <dt class="text-muted">{{ row.label }}</dt>
          <dd>{{ row.value }}</dd>
        </template>
      </dl>
    </section>

    <div class="grid grid-cols-2 gap-4">
      <UFormField label="Series categories" name="series">
        <UInput v-model="state.series" class="w-full" />
      </UFormField>
      <UFormField label="Movie categories" name="movies">
        <UInput v-model="state.movies" class="w-full" />
      </UFormField>
      <UFormField label="Priority" name="priority" help="1–50; lower wins a tie.">
        <UInputNumber v-model="state.priority" :min="1" :max="50" class="w-full" />
      </UFormField>
      <UFormField
        label="RSS interval (minutes)"
        name="rss"
        :help="indexer ? `Effective: every ${indexer.effectiveRssIntervalMinutes} minutes` : 'At least 10.'"
      >
        <UInputNumber v-model="state.rssIntervalMinutes" :min="10" class="w-full" />
      </UFormField>
      <UFormField label="Daily API limit" name="limit" help="Leave empty to use the limit the indexer reports.">
        <UInputNumber v-model="state.apiLimitMax" :min="1" class="w-full" />
      </UFormField>
    </div>

    <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-triangle-alert" :title="error" />
    <div class="flex justify-end gap-2">
      <UButton color="neutral" variant="ghost" label="Cancel" @click="emit('cancel')" />
      <UButton type="submit" label="Save" :loading="saving" :disabled="!canSave" />
    </div>
  </UForm>
</template>
