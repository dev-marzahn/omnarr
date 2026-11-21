// The `downloadClients` rows: one per client kind, read through
// `by_kind`, and the DTO built from them with no secret field.
import { DEFAULT_SEED_GOAL } from '@omnarr/contracts';
import type { ClientConfigState, ClientKind, DownloadClientsDetail, ProviderTestOutcome, SeedGoal, UsenetServer, UsenetUsageDetail } from '@omnarr/contracts';

import type { Doc, Id } from '../_generated/dataModel';
import type { MutationCtx, QueryCtx } from '../_generated/server';

export const clientRow = (ctx: QueryCtx, kind: ClientKind): Promise<Doc<'downloadClients'> | null> =>
  ctx.db
    .query('downloadClients')
    .withIndex('by_kind', (q) => q.eq('kind', kind))
    .first();

/** The row of this kind, created disabled at configVersion 1 when absent (the first save creates it). */
export async function ensureClientRow(ctx: MutationCtx, kind: ClientKind): Promise<Doc<'downloadClients'>> {
  const existing = await clientRow(ctx, kind);
  if (existing) return existing;
  const id = await ctx.db.insert('downloadClients', { kind, enabled: false, configVersion: 1 });
  return (await ctx.db.get(id))!;
}

/** Whether the client runs the saved config: the last report applied it, failed to, or hasn't come yet. */
export function configState(row: Doc<'downloadClients'> | null): ClientConfigState {
  if (!row) return 'pending';
  if (row.applyFailure) return 'failed';
  return row.appliedConfigVersion !== undefined && row.appliedConfigVersion >= row.configVersion ? 'applied' : 'pending';
}

/** The user's default goal: the row's, else `DEFAULT_SEED_GOAL`. */
export const userSeedGoal = (qbittorrent: Doc<'downloadClients'> | null): SeedGoal => qbittorrent?.seedGoal ?? { ...DEFAULT_SEED_GOAL };

/** The VPN card: the choice without its secrets, flags for what is stored, and the worker's last reading. */
function vpnDetail(qbittorrent: Doc<'downloadClients'> | null): DownloadClientsDetail['vpn'] {
  const vpn = qbittorrent?.vpn;
  const runtime = qbittorrent?.status?.vpn;
  return {
    ...(vpn
      ? {
          kind: vpn.kind,
          ...(vpn.serverCountries ? { serverCountries: vpn.serverCountries } : {}),
          ...(vpn.staticForwardedPort !== undefined ? { staticForwardedPort: vpn.staticForwardedPort } : {}),
          savedAt: vpn.savedAt,
        }
      : {}),
    hasVpnConfig: Boolean(vpn?.wireguardConf || vpn?.openvpnConf || vpn?.wireguardPrivateKey),
    hasVpnCredentials: Boolean(vpn?.username && vpn.password),
    ...(runtime ? { runtime } : {}),
  };
}

/** The stored list split: the main server (level 0, first) and the backup servers (level 1). */
export function usenetServersOf(row: Doc<'downloadClients'> | null): { main?: UsenetServer; backups: UsenetServer[] } {
  const servers = row?.usenetServers ?? [];
  return { ...(servers[0] ? { main: servers[0] } : {}), backups: servers.slice(1) };
}

/** A limited backup server's last usage reading; none once its limit is gone. */
function usageOf(row: Doc<'downloadClients'> | null, backupId: string | undefined, server: UsenetServer | undefined): { usage?: UsenetUsageDetail } {
  if (!backupId || !server?.limit) return {};
  const reading = row?.status?.usenetUsage?.find((entry) => entry.backupId === backupId);
  return reading ? { usage: { usedBytes: reading.usedBytes, limitReached: reading.limitReached } } : {};
}

export function toDetail(nzbget: Doc<'downloadClients'> | null, qbittorrent: Doc<'downloadClients'> | null): DownloadClientsDetail {
  const { main: server, backups } = usenetServersOf(nzbget);
  // The main server takes no limit (UsenetServerInput), so its detail has none.
  const { password, limit: _, ...shown } = server ?? { password: '' };
  return {
    vpn: vpnDetail(qbittorrent),
    // Without a row torrents are on: a protocol is disabled only by a row that says so.
    torrents: {
      enabled: qbittorrent?.enabled ?? true,
      seedGoal: userSeedGoal(qbittorrent),
      configVersion: qbittorrent?.configVersion ?? 0,
      config: configState(qbittorrent),
      ...(qbittorrent?.appliedAt !== undefined ? { appliedAt: qbittorrent.appliedAt } : {}),
      ...(qbittorrent?.applyFailure ? { applyFailure: qbittorrent.applyFailure } : {}),
      ...(qbittorrent?.status?.peerPort !== undefined ? { peerPort: qbittorrent.status.peerPort } : {}),
      ...(qbittorrent?.status?.connectionStatus ? { connectionStatus: qbittorrent.status.connectionStatus } : {}),
    },
    usenet: {
      enabled: nzbget?.enabled ?? false,
      ...(server ? { server: shown as NonNullable<DownloadClientsDetail['usenet']['server']> } : {}),
      hasPassword: password !== '',
      configVersion: nzbget?.configVersion ?? 0,
      config: configState(nzbget),
      ...(nzbget?.appliedAt !== undefined ? { appliedAt: nzbget.appliedAt } : {}),
      ...(nzbget?.applyFailure ? { applyFailure: nzbget.applyFailure } : {}),
      ...(nzbget?.providerTest ? { providerTest: nzbget.providerTest } : {}),
      backupServers: backups.map(({ id, host, port, ssl, username, connections, password: secret, level, limit }, index) => ({
        id: id!,
        host,
        port,
        ssl,
        username,
        connections,
        priority: level,
        ...(limit ? { limit } : {}),
        hasPassword: secret !== '',
        ...usageOf(nzbget, id, backups[index]),
      })),
    },
  };
}

/** A provider test's answer lands on its row, unless a later test has replaced it. */
export async function recordProviderTest(ctx: MutationCtx, jobId: Id<'jobs'>, outcome: ProviderTestOutcome): Promise<void> {
  const row = await clientRow(ctx, 'nzbget');
  if (row?.providerTest?.jobId === jobId) await ctx.db.patch(row._id, { providerTest: { ...row.providerTest, outcome } });
}
