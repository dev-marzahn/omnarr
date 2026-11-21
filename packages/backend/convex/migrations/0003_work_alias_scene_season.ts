// `workAliases.sceneSeason`: the scene season XEM lists a name under.
// Stored rows can't be backfilled from what they hold, because the season comes from XEM's
// `/map/names`, so every Work with an XEM alias is due for a sync now; the
// next `metadata.tick` enqueues it, and its alias diff replaces the rows.
import { defineMigration } from './_generated';

export default defineMigration({
  table: 'workMetadata',
  migrateOne: async (ctx, row) => {
    const now = Date.now();
    const { workId, nextSyncAt } = row;
    if (workId === undefined || (typeof nextSyncAt === 'number' && nextSyncAt <= now)) return;
    const aliases = await ctx.db
      .query('workAliases')
      .withIndex('by_work', (q) => q.eq('workId', workId))
      .collect();
    if (aliases.some((alias) => alias.source === 'xem')) return { nextSyncAt: now };
  },
});
