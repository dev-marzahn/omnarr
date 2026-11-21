// First run's routing: no admin opens the account step, an admin without a
// session sign-in, a session mid-way its step's page, and once first run is
// done every page but the setup pages (lib/firstRun.ts). The backend checks
// the caller on every call; this only picks the page.
import { api } from '@omnarr/backend/api';
import type { SetupState } from '@omnarr/contracts';

import { routeFor } from '~/lib/firstRun';

export default defineNuxtRouteMiddleware(async (to) => {
  const { $auth, $convex } = useNuxtApp();
  const session = await $auth.getSession().catch(() => undefined);
  const signedIn = Boolean(session?.data?.user);
  let state: SetupState;
  try {
    state = await $convex.query(api.api.setup.state, {});
    // Right after sign-in the Convex client may still be fetching its token; the step comes with it.
    for (let tries = 0; signedIn && state.adminExists && state.step === undefined && tries < 10; tries++) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      state = await $convex.query(api.api.setup.state, {});
    }
  } catch {
    // The backend doesn't answer: only the sign-in page, which says so when signing in fails.
    return to.path === '/login' ? undefined : navigateTo('/login');
  }
  const target = routeFor(state, signedIn, to.path);
  if (target && target !== to.path) return navigateTo(target, { replace: true });
});
