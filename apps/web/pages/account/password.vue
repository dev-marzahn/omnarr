<!--
  Password, opened from the user menu. Calls Better Auth's
  /change-password with revokeOtherSessions: the admin's other omnarr
  sessions are signed out and this one stays. The backend's hook pushes the
  new password to Jellyfin. The warning that Jellyfin and the other browsers
  sign out sits before the button; the result shows inline.
-->
<script setup lang="ts">
import { BEFORE_CHANGE, changeErrorText, CHANGED, type PasswordFields, type PasswordProblems, passwordProblems } from '~/lib/password';

const { $auth } = useNuxtApp();
const state = reactive<PasswordFields>({ current: '', next: '', repeat: '' });
const reveal = reactive({ current: false, next: false, repeat: false });
const touched = ref(false);
const serverError = ref<{ field?: keyof PasswordFields; text: string }>();
const changed = ref(false);
const pending = ref(false);

const problems = computed<PasswordProblems>(() => (touched.value ? passwordProblems(state) : {}));
const errorOf = (field: keyof PasswordFields) => problems.value[field] ?? (serverError.value?.field === field ? serverError.value.text : undefined);

async function onSubmit() {
  touched.value = true;
  serverError.value = undefined;
  changed.value = false;
  if (Object.keys(passwordProblems(state)).length > 0 || state.repeat !== state.next) return;
  pending.value = true;
  const { error } = await $auth.changePassword({ currentPassword: state.current, newPassword: state.next, revokeOtherSessions: true });
  pending.value = false;
  if (error) {
    serverError.value = changeErrorText(error);
    return;
  }
  Object.assign(state, { current: '', next: '', repeat: '' });
  touched.value = false;
  changed.value = true;
}

const FIELDS = [
  { key: 'current', label: 'Current password', autocomplete: 'current-password' },
  { key: 'next', label: 'New password', autocomplete: 'new-password', help: 'At least 8 characters.' },
  { key: 'repeat', label: 'Repeat the new password', autocomplete: 'new-password' },
] as const;
</script>

<template>
  <UDashboardPanel>
    <template #header>
      <PageHeader title="Password" />
    </template>
    <template #body>
      <PageBody>
        <Section title="Change password" description="For omnarr and Jellyfin: both use the same username and password.">
          <UCard>
            <UForm id="password-form" :state="state" class="flex flex-col gap-4" @submit="onSubmit">
              <UFormField
                v-for="field in FIELDS"
                :key="field.key"
                :label="field.label"
                :name="field.key"
                :help="'help' in field ? field.help : undefined"
                :error="errorOf(field.key)"
              >
                <UInput
                  v-model="state[field.key]"
                  :type="reveal[field.key] ? 'text' : 'password'"
                  :autocomplete="field.autocomplete"
                  class="w-full max-w-md"
                  :ui="{ trailing: 'pe-1' }"
                >
                  <template #trailing>
                    <UButton
                      color="neutral"
                      variant="link"
                      size="sm"
                      :icon="reveal[field.key] ? 'i-lucide-eye-off' : 'i-lucide-eye'"
                      :aria-label="reveal[field.key] ? 'Hide password' : 'Show password'"
                      @click="reveal[field.key] = !reveal[field.key]"
                    />
                  </template>
                </UInput>
              </UFormField>

              <UAlert v-if="changed" color="success" variant="subtle" icon="i-lucide-circle-check" :title="CHANGED.title" :description="CHANGED.description" />
              <UAlert
                v-else
                color="warning"
                variant="subtle"
                icon="i-lucide-triangle-alert"
                :title="BEFORE_CHANGE.title"
                :description="BEFORE_CHANGE.description"
              />
              <UAlert v-if="serverError && !serverError.field" color="error" variant="subtle" icon="i-lucide-triangle-alert" :title="serverError.text" />
            </UForm>
            <template #footer>
              <div class="flex justify-end">
                <UButton type="submit" form="password-form" label="Change password" :loading="pending" />
              </div>
            </template>
          </UCard>
        </Section>
      </PageBody>
    </template>
  </UDashboardPanel>
</template>
