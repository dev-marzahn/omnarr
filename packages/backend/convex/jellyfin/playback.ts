// Plays: the session poller's report. The worker sends the set of
// plays Jellyfin shows only when it changed; this compares it with the open
// `playbackReports` rows, so a repeated or duplicate report writes nothing.
import { Ack, type ActivePlay, PlaybackReportRequest } from '@omnarr/contracts';

import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { acceptedSession } from '../jobs/worker';
import { workerMutation } from '../lib/functions';
import { serverRow } from './setup';

/** A play is known by its device and its item. */
const playKey = (play: { deviceId: string; itemRef: string }) => JSON.stringify([play.deviceId, play.itemRef]);

const sameList = (a: readonly string[], b: readonly string[]) => a.length === b.length && a.every((value, i) => value === b[i]);

/** The Unit of a Jellyfin item: its Publication's, the `visible` one when several have the item. */
async function unitOf(ctx: MutationCtx, itemRef: string): Promise<Id<'units'> | undefined> {
  const publications = await ctx.db
    .query('publications')
    .withIndex('by_target_item_ref', (q) => q.eq('targetItemRef', itemRef))
    .collect();
  return (publications.find((publication) => publication.state === 'visible') ?? publications[0])?.unitId;
}

/**
 * `jellyfin.playback.report({ sessionId, plays })`: a new play inserts a
 * row, a known play updates its method and reasons when they changed, and
 * an open row missing from the set ends. Before setup there is no owner, and
 * nothing is written.
 */
export const report = workerMutation({
  args: PlaybackReportRequest.shape,
  returns: Ack,
  handler: async (ctx, { sessionId, plays }) => {
    await acceptedSession(ctx, sessionId);
    const server = await serverRow(ctx);
    if (!server) return null;
    const now = Date.now();
    const open = new Map<string, Doc<'playbackReports'>>();
    for (const row of await ctx.db
      .query('playbackReports')
      .withIndex('by_open', (q) => q.eq('open', true))
      .collect())
      open.set(playKey(row), row);

    const seen = new Set<string>();
    for (const play of plays) {
      const key = playKey(play);
      if (seen.has(key)) continue;
      seen.add(key);
      const row = open.get(key);
      if (!row) await insertPlay(ctx, server.ownerUserId, play, now);
      else if (row.method !== play.method || !sameList(row.reasons, play.reasons) || !sameList(row.rawReasons, play.rawReasons)) {
        await ctx.db.patch(row._id, { method: play.method, reasons: play.reasons, rawReasons: play.rawReasons });
      }
    }
    for (const [key, row] of open) if (!seen.has(key)) await ctx.db.patch(row._id, { open: false, endedAt: now });
    return null;
  },
});

async function insertPlay(ctx: MutationCtx, owner: string, play: ActivePlay, now: number) {
  const unitId = await unitOf(ctx, play.itemRef);
  await ctx.db.insert('playbackReports', {
    owner,
    deviceId: play.deviceId,
    deviceName: play.deviceName,
    client: play.client,
    itemRef: play.itemRef,
    ...(unitId ? { unitId } : {}),
    method: play.method,
    reasons: play.reasons,
    rawReasons: play.rawReasons,
    open: true,
    startedAt: now,
  });
}
