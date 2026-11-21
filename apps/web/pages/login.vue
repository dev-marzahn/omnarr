<!--
  Sign-in by username. A sign-in goes on to the library, or to the page
  that sent the user here; a signed-in visit goes there straight away (Sign
  out is in the user menu).
-->
<script setup lang="ts">
import { FORGOT_PASSWORD, signInErrorText } from '~/lib/signIn';

definePageMeta({ layout: 'auth' });

const { $auth } = useNuxtApp();
const route = useRoute();
// Only paths inside the app, never another origin.
const next = computed(() =>
  typeof route.query.next === 'string' && route.query.next.startsWith('/') && !route.query.next.startsWith('//') ? route.query.next : '/library',
);
// A signed-in visit goes on. An unreachable backend still shows the form; signing in then says it failed.
const current = await $auth.getSession().catch(() => undefined);
if (current?.data?.user) await navigateTo(next.value, { replace: true });

const state = reactive({ username: '', password: '' });
const error = ref<string>();
const wrongCredentials = ref(false);
const pending = ref(false);
const reveal = ref(false);

async function signIn() {
  error.value = undefined;
  pending.value = true;
  const { error: failure } = await $auth.signIn.username({ username: state.username, password: state.password });
  pending.value = false;
  if (failure) {
    error.value = signInErrorText(failure.status);
    wrongCredentials.value = failure.status === 401;
  } else await navigateTo(next.value);
}
</script>

<template>
  <div class="flex flex-col gap-5">
    <div class="flex flex-col items-center gap-2.5 text-center">
      <span class="size-9 rounded-[10px] bg-inverted text-inverted grid place-items-center">
        <UIcon name="i-lucide-play" class="size-5" />
      </span>
      <div>
        <h1 class="text-xl font-bold text-highlighted">Sign in to omnarr</h1>
        <p class="text-sm text-muted">Use the admin account you created at setup.</p>
      </div>
    </div>
    <UCard>
      <UForm :state="state" class="flex flex-col gap-4" @submit="signIn">
        <UAlert
          v-if="error"
          color="error"
          variant="subtle"
          icon="i-lucide-circle-alert"
          :title="error"
          :description="wrongCredentials ? 'Check both and try again.' : undefined"
        />
        <UFormField label="Username" name="username" required>
          <UInput v-model="state.username" autocomplete="username" class="w-full" autofocus />
        </UFormField>
        <UFormField label="Password" name="password" required>
          <UInput v-model="state.password" :type="reveal ? 'text' : 'password'" autocomplete="current-password" class="w-full" :ui="{ trailing: 'pe-1' }">
            <template #trailing>
              <UButton
                color="neutral"
                variant="link"
                size="sm"
                :icon="reveal ? 'i-lucide-eye-off' : 'i-lucide-eye'"
                :aria-label="reveal ? 'Hide password' : 'Show password'"
                @click="reveal = !reveal"
              />
            </template>
          </UInput>
        </UFormField>
        <UButton type="submit" block :loading="pending">Sign in</UButton>
      </UForm>
    </UCard>
    <p class="text-center text-xs text-muted">Jellyfin uses the same username and password.</p>
    <!-- Recovery is a command on the server; there is no reset by email. -->
    <p class="text-center text-xs text-muted">
      {{ FORGOT_PASSWORD.text }} <code class="text-default whitespace-nowrap">{{ FORGOT_PASSWORD.command }}</code> {{ FORGOT_PASSWORD.after }}
    </p>
  </div>
</template>
