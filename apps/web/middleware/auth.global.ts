// First run's routing: no admin opens the account step, an admin without a
// session sign-in, a session mid-way its step's page, and once first run is
// done every page but the setup pages (lib/firstRun.ts). The backend checks
// the caller on every call; this only picks the page, from inputs kept
// between page changes (lib/routeInputs.ts).
import { api } from '@omnarr/backend/api';

import { routeFor } from '~/lib/firstRun';
import { createRouteInputs, type RouteInputs } from '~/lib/routeInputs';

let inputs: RouteInputs | undefined;

function routeInputs(): RouteInputs {
  const { $auth, $convex } = useNuxtApp();
  return (inputs ??= createRouteInputs(
    {
      fetch: async () => {
        const { data, error } = await $auth.getSession();
        if (error) throw new Error(error.message ?? 'getSession failed');
        return Boolean(data?.user);
      },
      onChange: (listener) => {
        $auth.$store.listen('$sessionSignal', listener);
        // Better Auth's session store answers without a session: a sign-out in another tab (it
        // refetches on that tab's broadcast), or one the server ended.
        $auth.$store.atoms.session!.listen((value: { data: unknown; error: unknown; isPending: boolean }) => {
          if (!value.isPending && !value.error && !value.data) listener();
        });
      },
    },
    { subscribe: (onValue, onError) => $convex.onUpdate(api.api.setup.state, {}, onValue, onError) },
  ));
}

export default defineNuxtRouteMiddleware(async (to) => {
  const source = routeInputs();
  // Taken before the first await, while the Nuxt context is still set.
  const router = useRouter();
  let current;
  try {
    current = await source.read({ fresh: to.path === '/login' || to.path === '/setup' || to.path.startsWith('/setup/') });
  } catch {
    // The backend doesn't answer: only the sign-in page, which says so when signing in fails.
    return to.path === '/login' ? undefined : navigateTo('/login');
  }
  // A session the server ended moves this page on once the check answers, without holding up this click.
  void source.recheck().then((next) => {
    const path = router.currentRoute.value.path;
    const target = next && routeFor(next.state, next.signedIn, path);
    if (target && target !== path) void router.replace(target);
  });
  const target = routeFor(current.state, current.signedIn, to.path);
  if (target && target !== to.path) return navigateTo(target, { replace: true });
});
