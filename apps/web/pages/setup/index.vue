<!--
  The first run's admin account step: the setup password, then the admin
  that signs in to omnarr and to Jellyfin. `setup.createAdmin` creates it,
  the libraries and Jellyfin's setup in one go; then the browser signs in.
-->
<script setup lang="ts">
import { api } from '@omnarr/backend/api';
import { MIN_PASSWORD_LENGTH, USERNAME_PATTERN } from '@omnarr/contracts';

import { COPY, refusalText } from '~/lib/firstRun';

definePageMeta({ layout: 'setup', step: 'account' });

const { $auth } = useNuxtApp();
const createAdmin = useAction(api.api.setup.createAdmin);
const state = reactive({ setupPassword: '', username: '', email: '', password: '', repeat: '' });
const error = ref<string>();
const pending = ref(false);

function check(): string | undefined {
  if (!USERNAME_PATTERN.test(state.username)) return refusalText({ error: 'invalidUsername' });
  if (state.password.length < MIN_PASSWORD_LENGTH) return refusalText({ error: 'weakPassword' });
  if (state.password !== state.repeat) return "The two passwords don't match.";
  return undefined;
}

async function submit() {
  error.value = check();
  if (error.value) return;
  pending.value = true;
  try {
    const result = await createAdmin({
      setupPassword: state.setupPassword,
      username: state.username,
      ...(state.email.trim() ? { email: state.email.trim() } : {}),
      password: state.password,
      locale: navigator.language || 'en-US',
    });
    if ('error' in result) {
      error.value = refusalText(result);
      return;
    }
    const { error: failure } = await $auth.signIn.username({ username: state.username, password: state.password });
    await navigateTo(failure ? '/login' : '/setup/address');
  } catch {
    error.value = "omnarr's backend didn't answer. Try again.";
  } finally {
    pending.value = false;
  }
}
</script>

<template>
  <div class="flex flex-col gap-6">
    <div>
      <h1 class="text-xl font-bold text-highlighted">Create the admin account</h1>
      <p class="text-sm text-muted">{{ COPY.accountHint }}</p>
    </div>
    <UCard>
      <UForm :state="state" class="flex flex-col gap-4" @submit="submit">
        <UAlert v-if="error" color="error" variant="subtle" icon="i-lucide-circle-alert" :title="error" />
        <UFormField label="Setup password" name="setupPassword" required>
          <UInput v-model="state.setupPassword" type="password" autocomplete="off" class="w-full" autofocus />
          <template #help>
            You'll find it on the server: run <code>docker compose logs setup</code>, or use the <code>OMNARR_SETUP_PASSWORD</code> you set in
            <code>.env</code>.
          </template>
        </UFormField>
        <USeparator />
        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField label="Username" name="username" required help="Used to sign in here and in Jellyfin.">
            <UInput v-model="state.username" autocomplete="username" class="w-full" />
          </UFormField>
          <UFormField label="Email" name="email" hint="optional">
            <UInput v-model="state.email" type="email" autocomplete="email" placeholder="you@example.com" class="w-full" />
          </UFormField>
        </div>
        <div class="grid gap-4 sm:grid-cols-2">
          <UFormField label="New password" name="password" required>
            <UInput v-model="state.password" type="password" autocomplete="new-password" class="w-full" />
          </UFormField>
          <UFormField label="Repeat new password" name="repeat" required>
            <UInput v-model="state.repeat" type="password" autocomplete="new-password" class="w-full" />
          </UFormField>
        </div>
        <UButton type="submit" :loading="pending" class="self-end max-lg:self-stretch max-lg:justify-center">Continue</UButton>
      </UForm>
    </UCard>
  </div>
</template>
