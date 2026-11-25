import { defineMigration } from './_generated';

export default defineMigration({
  table: 'mappingSourceState',
  migrateOne: (_ctx, state) => (state.source === 'sceneMapping' && state.version !== undefined ? { version: undefined } : undefined),
});
