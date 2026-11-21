// A definition's category mappings: site ids to Newznab ids and back,
// as Prowlarr's IndexerCapabilitiesCategories maps them.
import { newznabCategoryId as categoryIdOf, newznabParentOf as parentOf } from '@omnarr/contracts';

import type { Definition } from './definition.ts';

export { parentOf };

/** A definition's site categories: each site id with its Newznab id (or none) and whether it is a default. */
export function categoryMappings(definition: Definition): { siteId: string; newznab?: number; desc?: string; default: boolean }[] {
  const out: { siteId: string; newznab?: number; desc?: string; default: boolean }[] = [];
  for (const [siteId, name] of Object.entries(definition.caps.categories ?? {})) {
    const newznab = categoryIdOf(name);
    if (newznab !== undefined) out.push({ siteId: String(siteId), newznab, default: false });
  }
  for (const mapping of definition.caps.categorymappings ?? []) {
    const newznab = categoryIdOf(mapping.cat);
    if (mapping.cat !== undefined && newznab === undefined) continue;
    out.push({
      siteId: String(mapping.id),
      ...(newznab !== undefined ? { newznab } : {}),
      ...(mapping.desc ? { desc: mapping.desc } : {}),
      default: mapping.default === true,
    });
  }
  return out;
}

/** MapTorznabCapsToTrackers: the site ids for requested Newznab ids (a parent id takes its children's). */
export function siteCategoriesFor(definition: Definition, requested: number[]): string[] {
  const ids = new Set<string>();
  for (const mapping of categoryMappings(definition)) {
    if (mapping.newznab === undefined) continue;
    if (requested.some((id) => id === mapping.newznab || (id % 1000 === 0 && parentOf(mapping.newznab!) === id))) ids.add(mapping.siteId);
  }
  return [...ids];
}

/** MapTrackerCatToNewznab: a row's site category as Newznab ids, with each one's parent. */
export function newznabFor(definition: Definition, siteId: string): number[] {
  const ids = new Set<number>();
  for (const mapping of categoryMappings(definition)) {
    if (mapping.siteId !== siteId || mapping.newznab === undefined) continue;
    ids.add(mapping.newznab);
    ids.add(parentOf(mapping.newznab));
  }
  return [...ids];
}
