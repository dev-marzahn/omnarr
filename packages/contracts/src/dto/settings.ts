// Settings DTOs that span the library: Settings › Blocklist
// (`settings.blocklist`).
import { zid } from 'convex-helpers/server/zod4';
import { z } from 'zod';

import { BlocklistReason } from '../failures.ts';
import { DownloadProtocol } from '../indexer.ts';
import { WorkKind } from './library.ts';

/** A row of Settings › Blocklist: the release, its Work, protocol and reason. */
export const SettingsBlocklistEntry = z.object({
  entryId: zid('blocklist'),
  workId: zid('works'),
  workTitle: z.string(),
  workKind: WorkKind,
  title: z.string(),
  /** Absent on entries from before the protocol was stored: never guessed. */
  protocol: DownloadProtocol.optional(),
  reason: BlocklistReason,
  addedAt: z.number(),
});
export type SettingsBlocklistEntry = z.infer<typeof SettingsBlocklistEntry>;

/** The most entries Settings › Blocklist reads: the table only grows, so the page shows the newest this many and says so. */
export const SETTINGS_BLOCKLIST_CAP = 500;

/** `settings.blocklist()`: every Work's entries, newest first, at most `SETTINGS_BLOCKLIST_CAP`. */
export const SettingsBlocklist = z.array(SettingsBlocklistEntry);
