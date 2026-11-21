// Settings › Downloads. Saves upsert the client's row
// through `by_kind` and raise `configVersion`; the worker's reconciler
// applies the change on its next pass. No DTO carries a secret: an
// absent password keeps the stored one, as `api/indexers.ts` does for keys.
import {
  Ack,
  DownloadClientsDetail,
  mergeVpnSettings,
  TorrentSettingsInput,
  UsenetBackupId,
  UsenetBackupInput,
  UsenetBackupPriority,
  UsenetServerInput,
  VpnSettingsInput,
  type SeedGoal,
  type UsenetServer,
  type VpnSettings,
} from '@omnarr/contracts';
import { ConvexError } from 'convex/values';

import { clientRow, ensureClientRow, toDetail, usenetServersOf } from '../downloadClients/store';
import { enqueueJob } from '../jobs/queue';
import { adminMutation, adminQuery } from '../lib/functions';
import { seedingDownloads } from '../library/read';

export const get = adminQuery({
  args: {},
  returns: DownloadClientsDetail,
  handler: async (ctx) => {
    const detail = toDetail(await clientRow(ctx, 'nzbget'), await clientRow(ctx, 'qbittorrent'));
    // The Torrents card's seeding line.
    const seeding = await seedingDownloads(ctx);
    const uploadedBytes = seeding.reduce((sum, download) => sum + (download.clientStatus?.uploadedBytes ?? 0), 0);
    return { ...detail, torrents: { ...detail.torrents, seeding: { count: seeding.length, uploadedBytes } } };
  },
});

const sameGoal = (a: SeedGoal | undefined, b: SeedGoal) => a !== undefined && a.ratio === b.ratio && a.seedTimeMs === b.seedTimeMs;

/**
 * "Use torrents" and the default goal. The first save creates the
 * row at version 1; a later change raises `configVersion`. Turning torrents
 * off stops new torrent Grabs (a disabled protocol); a changed goal applies
 * to new torrents only, so seeding ones keep theirs.
 */
export const saveTorrents = adminMutation({
  args: { input: TorrentSettingsInput },
  returns: Ack,
  handler: async (ctx, { input }) => {
    const existing = await clientRow(ctx, 'qbittorrent');
    if (!existing) {
      await ctx.db.insert('downloadClients', { kind: 'qbittorrent', enabled: input.enabled, configVersion: 1, seedGoal: input.seedGoal });
      return null;
    }
    if (existing.enabled === input.enabled && sameGoal(existing.seedGoal, input.seedGoal)) return null;
    await ctx.db.patch(existing._id, { enabled: input.enabled, seedGoal: input.seedGoal, configVersion: existing.configVersion + 1 });
    return null;
  },
});

/** Two choices that would write the same `vpn/` files: the save time doesn't count. */
const sameVpn = (a: VpnSettings | undefined, b: VpnSettings) => {
  if (!a) return false;
  const { savedAt: _, ...left } = a;
  const { savedAt: __, ...right } = b;
  return JSON.stringify(left, Object.keys(left).sort()) === JSON.stringify(right, Object.keys(right).sort());
};

/**
 * The VPN card's save: a choice, or `null` for "No VPN". A secret
 * the input leaves out keeps the stored one of the same kind; a WireGuard
 * config must pass `validateWireguardConf`, and a refusal carries the reason
 * for the form. The first save creates qBittorrent's row, with torrents on,
 * since no row means they are. The next reconciler pass writes the
 * `vpn/` files and binds qBittorrent to `tun0`.
 */
export const saveVpn = adminMutation({
  args: { input: VpnSettingsInput.nullable() },
  returns: Ack,
  handler: async (ctx, { input }) => {
    const existing = await clientRow(ctx, 'qbittorrent');
    if (input === null) {
      if (existing?.vpn) await ctx.db.patch(existing._id, { vpn: undefined, configVersion: existing.configVersion + 1 });
      return null;
    }
    const merged = mergeVpnSettings(input, existing?.vpn, Date.now());
    if (!merged.ok) throw new ConvexError({ code: 'invalidVpn', message: merged.message });
    if (!existing) {
      await ctx.db.insert('downloadClients', { kind: 'qbittorrent', enabled: true, configVersion: 1, vpn: merged.settings });
      return null;
    }
    if (sameVpn(existing.vpn, merged.settings)) return null;
    await ctx.db.patch(existing._id, { vpn: merged.settings, configVersion: existing.configVersion + 1 });
    return null;
  },
});

/** The entered server with the stored password filled in when it was left blank. */
function withStoredPassword(input: UsenetServerInput | UsenetBackupInput, stored: UsenetServer | undefined): Omit<UsenetServer, 'level'> {
  const { password, ...rest } = input;
  return { ...rest, password: password ?? stored?.password ?? '' };
}

const FIELDS = ['host', 'port', 'ssl', 'username', 'password', 'connections', 'level', 'id'] as const;

/** Two servers that would run the same: every field, and the limit, set or not. */
const sameServer = (a: UsenetServer | undefined, b: UsenetServer) =>
  a !== undefined && FIELDS.every((key) => a[key] === b[key]) && a.limit?.monthlyLimitGb === b.limit?.monthlyLimitGb && a.limit?.resetDay === b.limit?.resetDay;

/** Saves the main Usenet server: the row is enabled, a change raises `configVersion`, and the backup servers stay. */
export const saveUsenet = adminMutation({
  args: { input: UsenetServerInput },
  returns: Ack,
  handler: async (ctx, { input }) => {
    const row = await ensureClientRow(ctx, 'nzbget');
    const { main: stored, backups } = usenetServersOf(row);
    const server: UsenetServer = { ...withStoredPassword(input, stored), level: 0 };
    if (row.enabled && sameServer(stored, server)) return null;
    // A row a provider test created is still at version 1, which no worker has applied.
    const fresh = row.usenetServers === undefined && row.appliedConfigVersion === undefined;
    await ctx.db.patch(row._id, {
      enabled: true,
      usenetServers: [server, ...backups],
      configVersion: fresh ? row.configVersion : row.configVersion + 1,
    });
    return null;
  },
});

/**
 * Adds or edits a backup server
 * at its priority, NZBGet's level 1–9 (1 when left out), below the main
 * server, which must be saved first. The form makes a new one's id. A change
 * raises `configVersion`.
 */
export const saveUsenetBackup = adminMutation({
  args: { backupId: UsenetBackupId, input: UsenetBackupInput, priority: UsenetBackupPriority.optional() },
  returns: Ack,
  handler: async (ctx, { backupId, input, priority }) => {
    const row = await clientRow(ctx, 'nzbget');
    const { main, backups } = usenetServersOf(row);
    if (!row || !main) throw new ConvexError({ code: 'noMainServer', message: 'Save the main server before adding a backup server.' });
    const stored = backups.find((backup) => backup.id === backupId);
    const server: UsenetServer = { ...withStoredPassword(input, stored), level: priority ?? 1, id: backupId };
    if (sameServer(stored, server)) return null;
    const next = stored ? backups.map((backup) => (backup.id === backupId ? server : backup)) : [...backups, server];
    await ctx.db.patch(row._id, { usenetServers: [main, ...next], configVersion: row.configVersion + 1 });
    return null;
  },
});

/** Removes a backup server; one that is already gone changes nothing. */
export const removeUsenetBackup = adminMutation({
  args: { backupId: UsenetBackupId },
  returns: Ack,
  handler: async (ctx, { backupId }) => {
    const row = await clientRow(ctx, 'nzbget');
    const { main, backups } = usenetServersOf(row);
    if (!row || !main || !backups.some((backup) => backup.id === backupId)) return null;
    await ctx.db.patch(row._id, { usenetServers: [main, ...backups.filter((backup) => backup.id !== backupId)], configVersion: row.configVersion + 1 });
    return null;
  },
});

/**
 * "Test login": a `maintenance.testUsenetServer` job with the
 * entered values, keyed by the row's test counter so each test runs. The
 * password lives only in the job's payload, which is cleared when it ends.
 * With `backupId` it tests that backup server: a blank password is its
 * stored one (none for a new one), and the record names it for its form.
 */
export const testUsenetServer = adminMutation({
  args: { input: UsenetServerInput, backupId: UsenetBackupId.optional() },
  returns: Ack,
  handler: async (ctx, { input, backupId }) => {
    const row = await ensureClientRow(ctx, 'nzbget');
    const { main, backups } = usenetServersOf(row);
    const stored = backupId === undefined ? main : backups.find((backup) => backup.id === backupId);
    const { host, port, ssl, username, password } = withStoredPassword(input, stored);
    const count = (row.providerTestCount ?? 0) + 1;
    const jobId = await enqueueJob(ctx, {
      payload: { class: 'maintenance', action: 'testUsenetServer', host, port, ssl, username, password },
      idempotencyKey: `testUsenetServer:${count}`,
    });
    await ctx.db.patch(row._id, {
      providerTestCount: count,
      providerTest: { jobId, outcome: 'pending', host, port, ssl, at: Date.now(), ...(backupId !== undefined ? { backupId } : {}) },
    });
    return null;
  },
});
