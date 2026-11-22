<!--
  The Usenet provider form: host, port, SSL, username, password and
  connections, "Test login", and the applied state. Save unlocks only after
  a passing test of the values on the form; a blank password keeps the
  stored one. It never names NZBGet's address or port. The first run's
  Usenet step reuses it: pass `submitLabel` and `submitPrimary`, and listen
  for `saved` and `unchanged`. With
  `backup` it edits that backup server the same way, with its own test and
  save, plus its priority and monthly limit, which save without a new test
  when the login is unchanged. The main server takes no limit: NZBGet never
  uses a higher level while level 0 has no active server.
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';
import type { DownloadClientsDetail, UsenetBackupServerDetail, UsenetLimit } from '@omnarr/contracts';

import { canSaveProvider, configStateText, needsLoginTest, providerTestText, testOfServer, usageText, type ProviderValues } from '~/lib/downloads';

const props = withDefaults(
  defineProps<{
    usenet: DownloadClientsDetail['usenet'];
    workerConnected: boolean;
    submitLabel?: string;
    /** Whether the submit button is the solid primary; the first run's Usenet step lowers it while its continue button leads. */
    submitPrimary?: boolean;
    /** A backup server: its id (the form makes a new one's) and, once saved, what is stored. */
    backup?: { id: string; server?: UsenetBackupServerDetail };
  }>(),
  { submitLabel: 'Save', submitPrimary: true, backup: undefined },
);
const emit = defineEmits<{ saved: []; unchanged: [unchanged: boolean] }>();

const testUsenetServer = useMutation(api.api.downloadClients.testUsenetServer);
const saveUsenet = useMutation(api.api.downloadClients.saveUsenet);
const saveUsenetBackup = useMutation(api.api.downloadClients.saveUsenetBackup);

/** The stored server, kept current by the query. */
const stored = computed(() => (props.backup ? props.backup.server : props.usenet.server));
const server = stored.value;
const hasPassword = computed(() => (props.backup ? props.backup.server?.hasPassword === true : props.usenet.hasPassword));
/** The row's latest test, if it was of this form's server. */
const providerTest = computed(() => testOfServer(props.usenet.providerTest, props.backup?.id));
const state = reactive({
  host: server?.host ?? '',
  port: server?.port ?? 563,
  ssl: server?.ssl ?? true,
  username: server?.username ?? '',
  password: '',
  connections: server?.connections ?? 20,
});
/** A backup's priority and limit: not part of the login, so changing them alone needs no new test. A blank limit is no limit. */
const storedBackup = props.backup?.server;
const settings = reactive({
  priority: storedBackup?.priority ?? 1,
  monthlyLimitGb: (storedBackup?.limit?.monthlyLimitGb ?? null) as number | null,
  resetDay: storedBackup?.limit?.resetDay ?? 1,
});

const values = (): ProviderValues => ({ ...state, host: state.host.trim() });
const limit = (): UsenetLimit | undefined =>
  props.backup && settings.monthlyLimitGb ? { monthlyLimitGb: settings.monthlyLimitGb, resetDay: settings.resetDay } : undefined;
/** The login, as "Test login" and the main server's save take it. */
const input = () => {
  const { password, ...rest } = values();
  return { ...rest, ...(password ? { password } : {}) };
};
/** Whether a backup's priority or limit differs from what is stored. */
const settingsChanged = computed(() => {
  if (!props.backup) return false;
  const current = props.backup.server;
  const wanted = limit();
  return settings.priority !== current?.priority || wanted?.monthlyLimitGb !== current?.limit?.monthlyLimitGb || wanted?.resetDay !== current?.limit?.resetDay;
});

/** What the form held when "Test login" was last pressed here. */
const tested = ref<ProviderValues>();
const testing = ref(false);
const saving = ref(false);
const error = ref<string>();

const complete = computed(() => state.host.trim() !== '' && state.port >= 1 && state.port <= 65_535 && state.connections >= 1);
const limitValid = computed(() => settings.monthlyLimitGb === null || (settings.monthlyLimitGb > 0 && settings.resetDay >= 1 && settings.resetDay <= 28));
const testNeeded = computed(() => needsLoginTest(values(), stored.value));
/** `unchanged`: whether the login on the form is the stored one (a backup's priority and limit aside). */
watch(testNeeded, (needed) => emit('unchanged', !needed), { immediate: true });
const canSave = computed(
  () =>
    !testing.value &&
    complete.value &&
    limitValid.value &&
    (testNeeded.value ? canSaveProvider(values(), tested.value, providerTest.value) : settingsChanged.value),
);
const result = computed(() => (providerTest.value ? providerTestText(providerTest.value, props.workerConnected) : undefined));

async function runTest() {
  testing.value = true;
  error.value = undefined;
  const snapshot = values();
  try {
    await testUsenetServer({ input: input(), ...(props.backup ? { backupId: props.backup.id } : {}) });
    tested.value = snapshot;
  } catch {
    error.value = "The test couldn't be started. Try again.";
  } finally {
    testing.value = false;
  }
}

async function save() {
  if (!canSave.value) return;
  saving.value = true;
  error.value = undefined;
  try {
    if (props.backup) {
      const wanted = limit();
      await saveUsenetBackup({ backupId: props.backup.id, input: { ...input(), ...(wanted ? { limit: wanted } : {}) }, priority: settings.priority });
    } else await saveUsenet({ input: input() });
    state.password = '';
    tested.value = undefined;
    emit('saved');
  } catch {
    error.value = props.backup ? "The backup server couldn't be saved. Try again." : "The provider couldn't be saved. Try again.";
  } finally {
    saving.value = false;
  }
}

/** The applied-state line's clock, ticking every 30 s. */
const now = ref(Date.now());
let timer: ReturnType<typeof setInterval> | undefined;
onMounted(() => {
  timer = setInterval(() => (now.value = Date.now()), 30_000);
});
onBeforeUnmount(() => clearInterval(timer));

/** The limit line: what the worker last read, under the stored limit. */
const usage = computed(() => usageText(props.backup?.server?.limit, props.backup?.server?.usage, now.value));
</script>

<template>
  <UForm :state="state" class="space-y-4" @submit="save">
    <div class="flex gap-3">
      <UFormField label="Host" name="host" required class="flex-1">
        <UInput v-model="state.host" placeholder="news.provider.example" autocomplete="off" class="w-full font-mono" />
      </UFormField>
      <UFormField label="Port" name="port" required class="w-28">
        <UInputNumber v-model="state.port" :min="1" :max="65535" :format-options="{ useGrouping: false }" class="w-full" />
      </UFormField>
    </div>
    <div class="grid gap-4 sm:grid-cols-2">
      <UFormField label="Username" name="username">
        <UInput v-model="state.username" autocomplete="off" class="w-full" />
      </UFormField>
      <UFormField label="Password" name="password">
        <UInput v-model="state.password" type="password" autocomplete="off" :placeholder="hasPassword ? 'Stored' : ''" class="w-full" />
      </UFormField>
    </div>
    <div class="flex flex-wrap items-start gap-x-6 gap-y-3">
      <USwitch v-model="state.ssl" label="Use SSL" class="mt-7" />
      <UFormField label="Connections" name="connections" help="Your plan's maximum." class="w-40">
        <UInputNumber v-model="state.connections" :min="1" class="w-full" />
      </UFormField>
      <UFormField v-if="backup" label="Priority" name="priority" help="1 is tried first after the main server." class="w-40">
        <UInputNumber v-model="settings.priority" :min="1" :max="9" class="w-full" />
      </UFormField>
    </div>
    <div v-if="backup" class="flex flex-wrap items-start gap-x-6 gap-y-3">
      <UFormField label="Monthly limit (GB)" name="monthlyLimitGb" help="Blank: no limit." class="w-44">
        <UInputNumber v-model="settings.monthlyLimitGb" :min="0.001" :step="1" :step-snapping="false" placeholder="No limit" class="w-full" />
      </UFormField>
      <UFormField label="Resets on day" name="resetDay" help="Your plan's billing day." class="w-40">
        <UInputNumber v-model="settings.resetDay" :min="1" :max="28" :disabled="!settings.monthlyLimitGb" class="w-full" />
      </UFormField>
    </div>
    <p v-if="usage" class="text-sm" :class="usage.startsWith('Limit reached') ? 'text-warning' : 'text-muted'">{{ usage }}</p>

    <UAlert
      v-if="result"
      :color="result.color"
      variant="subtle"
      :icon="result.color === 'success' ? 'i-lucide-circle-check' : result.color === 'error' ? 'i-lucide-triangle-alert' : 'i-lucide-loader'"
      :title="result.title"
      :description="result.description"
    />
    <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-triangle-alert" :title="error" />

    <div class="flex flex-wrap items-center gap-2 border-t border-default pt-4">
      <p class="flex-1 min-w-48 text-xs text-muted">
        {{ configStateText(usenet, now) }}
        <span v-if="!canSave && testNeeded" class="block">Save unlocks after a passing test of these values.</span>
      </p>
      <slot name="actions" />
      <UButton color="neutral" variant="outline" icon="i-lucide-log-in" label="Test login" :loading="testing" :disabled="!complete" @click="runTest" />
      <UButton
        type="submit"
        :color="submitPrimary ? 'primary' : 'neutral'"
        :variant="submitPrimary ? 'solid' : 'outline'"
        :label="submitLabel"
        :loading="saving"
        :disabled="!canSave"
      />
    </div>
  </UForm>
</template>
