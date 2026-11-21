// Settings that span the library (`settings.blocklist`):
// Settings › Blocklist, every Work's entries with removal.
import { Ack, SETTINGS_BLOCKLIST_CAP, SettingsBlocklist, UnblockRequest, type SettingsBlocklistEntry } from '@omnarr/contracts';

import type { Doc, Id } from '../_generated/dataModel';
import type { QueryCtx } from '../_generated/server';
import { adminMutation, adminQuery } from '../lib/functions';
import { unblockEntry } from '../pipeline/blocklist';

/** The newest `SETTINGS_BLOCKLIST_CAP` entries across Works, each with its Work's title and kind: one read per entry and per Work. */
export async function blocklistEntries(ctx: QueryCtx): Promise<SettingsBlocklistEntry[]> {
  const rows = await ctx.db.query('blocklist').order('desc').take(SETTINGS_BLOCKLIST_CAP);
  const works = new Map<Id<'works'>, Doc<'works'> | null>();
  const entries: SettingsBlocklistEntry[] = [];
  for (const row of rows) {
    if (!works.has(row.workId)) works.set(row.workId, await ctx.db.get(row.workId));
    const work = works.get(row.workId);
    // A Work being deleted loses its entries in pages; one already gone has nothing to show.
    if (!work) continue;
    entries.push({
      entryId: row._id,
      workId: row.workId,
      workTitle: work.title,
      workKind: work.kind,
      title: row.title,
      ...(row.protocol ? { protocol: row.protocol } : {}),
      reason: row.reason,
      addedAt: row._creationTime,
    });
  }
  return entries;
}

/** Every Work's blocklist entries, newest first, capped. */
export const blocklist = adminQuery({
  args: {},
  returns: SettingsBlocklist,
  handler: (ctx) => blocklistEntries(ctx),
});

/** "Unblock release": removes only the entry; nothing is grabbed. Same request and effect as `library.unblock`. */
export const unblock = adminMutation({
  args: UnblockRequest.shape,
  returns: Ack,
  handler: async (ctx, { entryId }) => {
    await unblockEntry(ctx, entryId);
    return null;
  },
});
