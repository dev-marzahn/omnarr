// Upgrades: a playable Unit's current release, the
// 24-hour cooldown, and the weekly `upgradeSearch`. Search and RSS pass the
// current releases to the evaluation, which rejects a candidate that isn't
// an upgrade for every playable Unit it covers (`notAnUpgrade`).
import { compare, mostExpensive, ParsedRelease, PreparationStep, type ReleaseProfileContent } from '@omnarr/contracts';
import { parseRelease } from '@omnarr/parser';
import { isUpgrade, meetsCutoff, weigh, type Verdict } from '@omnarr/scoring';
import { zid } from 'convex-helpers/server/zod4';
import { v } from 'convex/values';
import { z } from 'zod';

import { internal } from '../_generated/api';
import type { Doc, Id } from '../_generated/dataModel';
import { internalMutation, type MutationCtx, type QueryCtx } from '../_generated/server';
import { isMissing } from '../lib/derivedState';
import { targetOf } from '../playback/target';

const DAY = 86_400_000;

/** At most this many Units are read per `upgradeSearch` run, and this many are searched. */
export const UPGRADE_READ_CAP = 500;
export const UPGRADE_SEARCH_CAP = 50;

/** A playable Unit's current release, as the evaluation reads it. */
export const CurrentRelease = z.object({
  unitId: zid('units'),
  release: ParsedRelease,
  /** The real preparation of the source file: the comparison with the library's target. */
  step: PreparationStep,
  cooldownActive: z.boolean(),
  /** Every Unit the playable primary file holds: more than this one for a multi-episode file. */
  fileUnitIds: z.array(zid('units')),
});
export type CurrentRelease = z.infer<typeof CurrentRelease>;

/** The Unit's `primary` version whose Publication is visible (or a re-publish, which still plays), if any. */
export async function playablePrimary(ctx: QueryCtx, unitId: Id<'units'>): Promise<Doc<'fileVersions'> | null> {
  const publications = await ctx.db
    .query('publications')
    .withIndex('by_unit', (q) => q.eq('unitId', unitId))
    .collect();
  for (const publication of publications) {
    if (publication.state !== 'visible' && !(publication.state === 'pending' && publication.targetItemRef !== undefined)) continue;
    const version = await ctx.db.get(publication.fileVersionId);
    if (version?.kind === 'primary' && !(await isMissing(ctx, version.fileId))) return version;
  }
  return null;
}

/** An upgrade Grab for the Unit started within 24 hours, read through `grabUnits.by_unit`. */
export async function cooldownActive(ctx: QueryCtx, unitId: Id<'units'>, now = Date.now()): Promise<boolean> {
  const rows = await ctx.db
    .query('grabUnits')
    .withIndex('by_unit', (q) => q.eq('unitId', unitId))
    .order('desc')
    .collect();
  for (const row of rows) {
    if (row._creationTime <= now - DAY) return false;
    if ((await ctx.db.get(row.grabId))?.kind === 'upgrade') return true;
  }
  return false;
}

/**
 * The current release: the release stored on the Unit's source file,
 * its `original` when there is one, else its playable `primary`, parsed from
 * the file name when none is stored; and that file's real preparation.
 * Null when nothing plays.
 */
export async function currentRelease(ctx: QueryCtx, unit: Doc<'units'>, now = Date.now()): Promise<CurrentRelease | null> {
  const primary = await playablePrimary(ctx, unit._id);
  if (!primary) return null;
  const versions = await ctx.db
    .query('fileVersions')
    .withIndex('by_unit', (q) => q.eq('unitId', unit._id))
    .collect();
  const source = versions.find((version) => version.kind === 'original') ?? primary;
  const file = await ctx.db.get(source.fileId);
  const work = await ctx.db.get(unit.workId);
  if (!file || !work) return null;
  const name = file.path.slice(file.path.lastIndexOf('/') + 1);
  const release = file.release ?? parseRelease(name, work.kind);
  const step = file.probe ? mostExpensive(compare(file.probe, await targetOf(ctx, work.libraryId)).steps) : 'none';
  const links = await ctx.db
    .query('fileUnits')
    .withIndex('by_file', (q) => q.eq('fileId', primary.fileId))
    .collect();
  const fileUnitIds = [...new Set([unit._id, ...links.map((link) => link.unitId)])];
  return { unitId: unit._id, release, step, cooldownActive: await cooldownActive(ctx, unit._id, now), fileUnitIds };
}

/** The current releases of the Units that play. */
export async function currentsFor(ctx: QueryCtx, unitIds: Id<'units'>[]): Promise<CurrentRelease[]> {
  const now = Date.now();
  const currents: CurrentRelease[] = [];
  for (const unitId of new Set(unitIds)) {
    const unit = await ctx.db.get(unitId);
    const current = unit && (await currentRelease(ctx, unit, now));
    if (current) currents.push(current);
  }
  return currents;
}

/**
 * The upgrade check of an accepted verdict: for every covered Unit
 * that plays, its cooldown is over, its current release misses the cutoff,
 * and the candidate is an upgrade over it. Undefined when it covers no
 * playable Unit (an ordinary pick). `partial` when it leaves out a Unit a
 * covered Unit's file also holds: the old file would stay for that one, a
 * second file for the upgraded Unit.
 */
export function upgradeVerdict(
  verdict: Pick<Verdict, 'quality' | 'qualityRank' | 'baseScore' | 'score' | 'coveredUnitIds'>,
  parsed: ParsedRelease,
  profile: ReleaseProfileContent,
  currents: CurrentRelease[],
): boolean | 'partial' | undefined {
  const covered = new Set<string>(verdict.coveredUnitIds);
  const playable = currents.filter((current) => covered.has(current.unitId));
  if (playable.length === 0) return undefined;
  if (playable.some((current) => current.fileUnitIds.some((unitId) => !covered.has(unitId)))) return 'partial';
  const candidate = {
    quality: verdict.quality,
    qualityRank: verdict.qualityRank,
    baseScore: verdict.baseScore,
    preparationPoints: verdict.score - verdict.baseScore,
    ...(parsed.group === undefined ? {} : { group: parsed.group }),
    revision: parsed.revision,
  };
  return playable.every((current) => {
    const weighed = weigh(current.release, current.step, profile);
    return !current.cooldownActive && !meetsCutoff(weighed, profile) && isUpgrade(candidate, weighed, profile);
  });
}

/** Monitored, playable, no active Grab, its current release short of the cutoff and its cooldown over. */
export async function isUpgradeable(ctx: QueryCtx, unit: Doc<'units'>, profile: ReleaseProfileContent, now = Date.now()): Promise<boolean> {
  if (!unit.monitored || unit.activeGrabId !== undefined) return false;
  const current = await currentRelease(ctx, unit, now);
  return current !== null && !current.cooldownActive && !meetsCutoff(weigh(current.release, current.step, profile), profile);
}

/** One page of `upgradeSearch`: this many Units in one mutation, within the function's limits. */
export const UPGRADE_PAGE_SIZE = 50;

/** Where a run of `upgradeSearch` is: its start (every page's stamp), the Units read so far, and those chosen. */
export type UpgradePage = { startedAt?: number; read?: number; chosen?: Id<'units'>[] };

/**
 * One page of the weekly run: the next UPGRADE_PAGE_SIZE Units by
 * `units.by_last_search` whose search is older than the run's start. The
 * run stamps each one it checks with its start, so the stamped Units leave
 * that range and the range itself is the cursor (an index cursor wouldn't
 * do: a stamped Unit moves past it). A full page under the read cap
 * schedules the next one; the last page starts the search.
 */
export async function upgradeSearchPage(ctx: MutationCtx, page: UpgradePage): Promise<void> {
  const startedAt = page.startedAt ?? Date.now();
  const read = page.read ?? 0;
  const chosen = [...(page.chosen ?? [])];
  const size = Math.min(UPGRADE_PAGE_SIZE, UPGRADE_READ_CAP - read);
  const units = await ctx.db
    .query('units')
    .withIndex('by_last_search', (q) => q.lt('lastSearchAt', startedAt))
    .take(size);
  // A profile row holds the content `weigh` reads.
  const profiles = new Map<Id<'works'>, ReleaseProfileContent | null>();
  for (const unit of units) {
    await ctx.db.patch(unit._id, { lastSearchAt: startedAt });
    if (chosen.length >= UPGRADE_SEARCH_CAP) continue;
    if (!profiles.has(unit.workId)) {
      const work = await ctx.db.get(unit.workId);
      const profile = work && (await ctx.db.get(work.releaseProfileId));
      profiles.set(unit.workId, profile ?? null);
    }
    const profile = profiles.get(unit.workId);
    if (profile && (await isUpgradeable(ctx, unit, profile, startedAt))) chosen.push(unit._id);
  }
  if (units.length === size && read + size < UPGRADE_READ_CAP) {
    await ctx.scheduler.runAfter(0, internal.pipeline.upgrades.upgradeSearch, { startedAt, read: read + size, chosen });
    return;
  }
  // search.start stamps the searched Units again; scheduled, as search.ts reads this module.
  if (chosen.length > 0) await ctx.scheduler.runAfter(0, internal.pipeline.search.start, { unitIds: chosen, trigger: 'upgrade' });
}

/**
 * The weekly cron: Units by `units.by_last_search`, oldest first, at
 * most UPGRADE_READ_CAP of them, in scheduled pages of UPGRADE_PAGE_SIZE.
 * Each checked Unit gets `lastSearchAt`, and up to UPGRADE_SEARCH_CAP
 * upgradeable ones are searched with the `upgrade` trigger, grouped by
 * season as any search is, within the background share. The cron passes no
 * arguments; a page passes the run's state to the next.
 */
export const upgradeSearch = internalMutation({
  args: { startedAt: v.optional(v.number()), read: v.optional(v.number()), chosen: v.optional(v.array(v.id('units'))) },
  returns: v.null(),
  handler: async (ctx, page) => {
    await upgradeSearchPage(ctx, page);
    return null;
  },
});
