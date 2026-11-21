// `workAliases.compact`: each alias's
// normalized title without spaces, which `findWorksByTitle` looks up when the
// exact title misses, so a hyphen on either side still finds the Work.
import { compactTitle } from '@omnarr/parser';

import { defineMigration } from './_generated';

export default defineMigration({
  table: 'workAliases',
  migrateOne: (_ctx, alias) => {
    if (typeof alias.normalized !== 'string') return;
    const compact = compactTitle(alias.normalized);
    if (alias.compact !== compact) return { compact };
  },
});
