// `siteDefinitions.yaml` moves to `siteDefinitionFiles`: the
// picker's catalogue query read every row's file, about 1.2 MB. Until this
// finishes, `definitionYaml` falls back to the row's own `yaml`.
//
// The write is inlined, not the sync's helper, so a later change to that
// helper can't change what this migration does. Batches of 10: a file can be
// up to 900 KB, and 100 of those would pass a transaction's 16 MiB.
import { defineMigration } from './_generated';

export default defineMigration({
  table: 'siteDefinitions',
  batchSize: 10,
  migrateOne: async (ctx, row) => {
    const { yaml, definitionId } = row;
    if (typeof yaml !== 'string' || typeof definitionId !== 'string') return;
    const file = await ctx.db
      .query('siteDefinitionFiles')
      .withIndex('by_definition_id', (q) => q.eq('definitionId', definitionId))
      .unique();
    if (!file) await ctx.db.insert('siteDefinitionFiles', { definitionId, yaml });
    else if (file.yaml !== yaml) await ctx.db.patch(file._id, { yaml });
    return { yaml: undefined };
  },
});
