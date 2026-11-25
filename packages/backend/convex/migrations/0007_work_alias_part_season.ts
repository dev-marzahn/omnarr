import { defineMigration } from './_generated';

export default defineMigration({
  table: 'workAliases',
  migrateOne: (_ctx, alias) =>
    alias.sceneSeason === undefined
      ? undefined
      : { partSeason: alias.partSeason ?? { season: alias.sceneSeason, ordering: 'scene' as const }, sceneSeason: undefined },
});
