// "Search and pick": an interactive search of one Unit, then its item's
// Candidates tab, where the results are offered. The item is the episode
// page, or a movie's Work page.
import { api } from '@omnarr/backend/api';
import type { Id } from '@omnarr/backend/dataModel';

export function useSearchAndPick() {
  const searchInteractive = useMutation(api.api.units.searchInteractive);
  const toast = useToast();
  return async (unit: { unitId: Id<'units'>; workId?: Id<'works'>; workKind?: 'series' | 'movie' }) => {
    try {
      await searchInteractive({ unitIds: [unit.unitId] });
    } catch {
      toast.add({ title: "The search couldn't start", description: 'Try again.', color: 'error', icon: 'i-lucide-triangle-alert' });
      return;
    }
    const path = unit.workKind === 'movie' && unit.workId ? `/library/${unit.workId}` : `/items/${unit.unitId}`;
    await navigateTo({ path, query: { tab: 'candidates' } });
  };
}
