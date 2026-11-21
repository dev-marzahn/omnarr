// The header bar's breadcrumb: a detail page lists its parents
// only, and its title is the hero's h1. On a phone it becomes a back link to
// the nearest parent, the last crumb.
import type { WorkKind } from '@omnarr/contracts';

export type Crumb = { label: string; to: string; icon?: string };

const LIBRARY: Record<WorkKind, Crumb> = {
  series: { label: 'Series', to: '/library', icon: 'i-lucide-tv' },
  movie: { label: 'Movies', to: '/library?kind=movies', icon: 'i-lucide-film' },
};

/** A Work page (a movie's page too): its library. */
export const workCrumbs = (kind: WorkKind): Crumb[] => [LIBRARY[kind]];

/**
 * An item page: an episode's series under Series. A movie's item page is its
 * Work page, so its only parent is Movies and its title is never repeated.
 */
export function itemCrumbs(item: { workKind: WorkKind; workId: string; workTitle: string } | undefined): Crumb[] {
  if (!item) return [LIBRARY.series];
  if (item.workKind === 'movie') return [LIBRARY.movie];
  return [LIBRARY.series, { label: item.workTitle, to: `/library/${item.workId}` }];
}

/** The phone's back link: the nearest parent. */
export const backLink = (crumbs: readonly Crumb[]): Crumb | undefined => crumbs.at(-1);
