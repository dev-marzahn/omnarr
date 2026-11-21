// `grabs.kind`, added with upgrades: every Grab before it was an initial
// one, since upgrades didn't exist. The field stays optional in the schema
// for this release, so a backend that runs before the
// migration finishes still reads its rows.
import { defineMigration } from './_generated';

export default defineMigration({
  table: 'grabs',
  migrateOne: (_ctx, grab) => (grab.kind === undefined ? { kind: 'initial' as const } : undefined),
});
