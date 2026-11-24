<script setup lang="ts">
import { api } from '@omnarr/backend/api';
import type { DownloadClientsDetail, UsenetBackupServerDetail, UsenetLimit } from '@omnarr/contracts';

import {
  configStateText,
  needsLoginTest,
  providerTestText,
  SAVE_CANCELLED_TEXT,
  saveStepAfterTest,
  testOfServer,
  usageText,
  type ProviderValues,
  type SaveInFlight,
} from '~/lib/downloads';

const props = withDefaults(
  defineProps<{
    usenet: DownloadClientsDetail['usenet'];
    workerConnected: boolean;
    /** A backup server: its id (the form makes a new one's) and, once saved, what is stored. */
    backup?: { id: string; server?: UsenetBackupServerDetail };
  }>(),
  { backup: undefined },
);
const emit = defineEmits<{ saved: []; unsaved: [boolean] }>();

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

const saveInFlight = ref<SaveInFlight>();
const storing = ref(false);
const error = ref<string>();

const complete = computed(() => state.host.trim() !== '' && state.port >= 1 && state.port <= 65_535 && state.connections >= 1);
const limitValid = computed(() => settings.monthlyLimitGb === null || (settings.monthlyLimitGb > 0 && settings.resetDay >= 1 && settings.resetDay <= 28));
const testNeeded = computed(() => needsLoginTest(values(), stored.value));
const unsaved = computed(() => testNeeded.value || settingsChanged.value);
const busy = computed(() => saveInFlight.value !== undefined || storing.value);
const canSave = computed(() => !busy.value && complete.value && limitValid.value && unsaved.value);
const result = computed(() => (providerTest.value ? providerTestText(providerTest.value, props.workerConnected) : undefined));

watch(unsaved, (value) => emit('unsaved', value), { immediate: true });

async function save() {
  if (!canSave.value) return;
  error.value = undefined;
  if (!testNeeded.value) return store();
  saveInFlight.value = { values: values(), testBefore: props.usenet.providerTest?.jobId, backupId: props.backup?.id };
  try {
    await testUsenetServer({ input: input(), ...(props.backup ? { backupId: props.backup.id } : {}) });
  } catch {
    saveInFlight.value = undefined;
    error.value = "The login test couldn't be started. Try again.";
  }
}

watch([() => props.usenet.providerTest, () => values()], () => {
  if (!saveInFlight.value) return;
  const step = saveStepAfterTest(saveInFlight.value, values(), props.usenet.providerTest);
  if (step === 'waitForTest') return;
  saveInFlight.value = undefined;
  if (step === 'save') void store();
  if (step === 'formChanged' || step === 'testReplaced') error.value = SAVE_CANCELLED_TEXT[step];
});

async function store() {
  storing.value = true;
  try {
    if (props.backup) {
      const wanted = limit();
      await saveUsenetBackup({ backupId: props.backup.id, input: { ...input(), ...(wanted ? { limit: wanted } : {}) }, priority: settings.priority });
    } else await saveUsenet({ input: input() });
    state.password = '';
    emit('saved');
  } catch {
    error.value = props.backup ? "The backup server couldn't be saved. Try again." : "The provider couldn't be saved. Try again.";
  } finally {
    storing.value = false;
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
      </p>
      <slot name="actions" />
      <UButton type="submit" label="Save" :loading="busy" :disabled="!canSave" />
    </div>
  </UForm>
</template>
