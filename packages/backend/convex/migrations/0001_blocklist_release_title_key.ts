// The blocklist's title key under the new rule: brackets and
// parentheses are separators and a trailing CRC32 tag goes, so a row stored
// under the old rule matches the candidates `normalizeReleaseTitle` keys now.
import { normalizeReleaseTitle } from '@omnarr/parser';

import { defineMigration } from './_generated';

export default defineMigration({
  table: 'blocklist',
  migrateOne: (_ctx, row) => {
    if (typeof row.title !== 'string') return;
    const normalizedTitle = normalizeReleaseTitle(row.title);
    if (row.normalizedTitle !== normalizedTitle) return { normalizedTitle };
  },
});
