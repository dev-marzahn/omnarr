// A review tab's folders, live, a page of
// `scan.groups` at a time. Each loaded page stays subscribed, so an import or
// a match moves folders between the tabs without a reload. A page's cursor is
// the last folder it read, so pages never overlap; a folder that slides onto
// an earlier page when one before it leaves is shown once.
import { api } from '@omnarr/backend/api';
import type { Id } from '@omnarr/backend/dataModel';
import type { ScanGroup, ScanGroupsPage, ScanTab } from '@omnarr/contracts';

import { folderKey } from '~/lib/scan';

export function useScanGroups(scanRunId: MaybeRefOrGetter<Id<'scanRuns'> | undefined>, tab: ScanTab) {
  const { $convex } = useNuxtApp();
  const cursors = ref<(string | null)[]>([null]);
  const pages = shallowRef<(ScanGroupsPage | undefined)[]>([]);
  const error = shallowRef<Error>();

  watch(
    () => toValue(scanRunId),
    () => {
      cursors.value = [null];
      pages.value = [];
    },
  );

  // Re-subscribes every page when one is added; the client answers the
  // pages it already holds from its cache, so nothing flickers.
  watchEffect((onCleanup) => {
    const runId = toValue(scanRunId);
    if (!runId) return;
    const unsubscribes = cursors.value.map((cursor, index) =>
      $convex.onUpdate(
        api.api.scan.groups,
        { scanRunId: runId, tab, cursor },
        (page) => {
          const next = [...pages.value];
          next[index] = page;
          pages.value = next;
          error.value = undefined;
        },
        (e) => {
          error.value = e;
        },
      ),
    );
    onCleanup(() => unsubscribes.forEach((unsubscribe) => unsubscribe()));
  });

  const groups = computed<ScanGroup[]>(() => {
    const seen = new Set<string>();
    return pages.value.flatMap((page) =>
      (page?.groups ?? []).filter((group) => {
        const key = folderKey(group);
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      }),
    );
  });
  const last = computed(() => pages.value[cursors.value.length - 1]);
  /** The cursor of the next page, while there is one. */
  const next = computed(() => last.value?.cursor ?? null);
  /** Every folder is loaded: the tab's folder count is exact. */
  const complete = computed(() => last.value !== undefined && last.value.cursor === null);

  function loadMore() {
    if (next.value !== null && !cursors.value.includes(next.value)) cursors.value = [...cursors.value, next.value];
  }

  return {
    groups,
    error,
    isLoading: computed(() => pages.value[0] === undefined && error.value === undefined),
    hasMore: computed(() => next.value !== null),
    complete,
    loadMore,
  };
}
