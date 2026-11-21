// What the shell shares with its pages: the Work kind of the
// page on screen, so the sidebar marks Series or Movies for a Work or item
// page, and the Jellyfin address the browser reaches.
import type { WorkKind } from '@omnarr/contracts';

import { resolveUrls, type Urls } from '~/lib/urls';

/** Set by the Work and item pages once they know their Work's kind; cleared when they unmount. */
export function usePageWorkKind(kind?: MaybeRefOrGetter<WorkKind | undefined>) {
  const state = useState<WorkKind | undefined>('page-work-kind', () => undefined);
  if (kind !== undefined) {
    watch(
      () => toValue(kind),
      (value) => {
        state.value = value;
      },
      { immediate: true },
    );
    onScopeDispose(() => {
      state.value = undefined;
    });
  }
  return state;
}

/** The Convex, auth and Jellyfin URLs this browser uses: configured, or this page's hostname with each port. */
export function useUrls(): Urls {
  const config = useRuntimeConfig().public;
  return resolveUrls(
    {
      convexUrl: config.convexUrl,
      convexSiteUrl: config.convexSiteUrl,
      jellyfinPublicUrl: config.jellyfinPublicUrl,
      convexPort: String(config.convexPort),
      convexSitePort: String(config.convexSitePort),
      jellyfinPort: String(config.jellyfinPort),
    },
    window.location,
  );
}

/** `OMNARR_JELLYFIN_URL` when set, otherwise this browser's hostname with Jellyfin's port. */
export function useJellyfinAddress() {
  const urls = useUrls();
  return computed(() => urls.jellyfin);
}
