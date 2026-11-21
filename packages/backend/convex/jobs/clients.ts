// The reconciler's client exchange: `desired` gives each
// client row's config with its secrets, and `report` records what the worker
// applied and saw, writing only on change. A qBittorrent report's VPN state
// raises and resolves `vpnDown`, and its transition to `up` wakes the
// torrent submits that wait for it.
import {
  Ack,
  ClientReportsRequest,
  DesiredClients,
  DesiredClientsRequest,
  type ClientStatusReport,
  type DesiredClientConfig,
  type VpnRuntime,
} from '@omnarr/contracts';

import type { Doc } from '../_generated/dataModel';
import type { MutationCtx } from '../_generated/server';
import { clientRow, usenetServersOf, userSeedGoal } from '../downloadClients/store';
import { workerMutation, workerQuery } from '../lib/functions';
import { raiseIssue, resolveSystemIssue } from '../lib/issues';
import { acceptedSession } from './worker';

function desiredOf(row: Doc<'downloadClients'>): DesiredClientConfig {
  const { main: server, backups } = usenetServersOf(row);
  return {
    kind: row.kind,
    clientId: row._id,
    enabled: row.enabled,
    configVersion: row.configVersion,
    ...(row.appliedConfigVersion !== undefined ? { appliedConfigVersion: row.appliedConfigVersion } : {}),
    ...(row.kind === 'nzbget' && server ? { nzbget: { server, ...(backups.length ? { backupServers: backups } : {}) } } : {}),
    ...(row.kind === 'qbittorrent' ? { qbittorrent: { seedGoal: userSeedGoal(row), ...(row.vpn ? { vpn: row.vpn } : {}) } } : {}),
  };
}

/** One entry per existing row, with secrets: the one worker function that returns the user's client secrets. */
export const desired = workerQuery({
  args: DesiredClientsRequest.shape,
  returns: DesiredClients,
  handler: async (ctx, { sessionId }) => {
    await acceptedSession(ctx, sessionId);
    const rows = await ctx.db.query('downloadClients').collect();
    return rows.map(desiredOf);
  },
});

/** The row's fields a report writes; `undefined` clears an optional one. */
function patchOf(row: Doc<'downloadClients'>, report: ClientStatusReport, now: number): Partial<Doc<'downloadClients'>> {
  const status = {
    reachable: report.reachable,
    checkedAt: now,
    ...(report.connectionStatus ? { connectionStatus: report.connectionStatus } : {}),
    ...(report.peerPort !== undefined ? { peerPort: report.peerPort } : {}),
    ...(report.seedingProblems?.length ? { seedingProblems: report.seedingProblems } : {}),
    ...(report.vpn ? { vpn: report.vpn } : {}),
    ...(report.usenetUsage?.length ? { usenetUsage: report.usenetUsage } : {}),
  };
  const patch: Partial<Doc<'downloadClients'>> = { status };
  if (report.clientVersion !== undefined) patch.clientVersion = report.clientVersion;
  if (report.applyFailure) patch.applyFailure = report.applyFailure;
  if (report.appliedConfigVersion !== undefined) {
    // A successful apply clears the last failure.
    patch.applyFailure = undefined;
    if (report.appliedConfigVersion !== row.appliedConfigVersion) {
      patch.appliedConfigVersion = report.appliedConfigVersion;
      patch.appliedAt = now;
    }
  }
  return patch;
}

/** A status without its check times, for comparing. */
function seen(status: Doc<'downloadClients'>['status'] | undefined): unknown {
  if (!status) return {};
  const { checkedAt: _, vpn, ...rest } = status;
  if (!vpn) return rest;
  const { checkedAt: __, ...reading } = vpn;
  return { ...rest, vpn: reading };
}

/** Whether the patch changes anything but the time of the check. */
function changes(row: Doc<'downloadClients'>, patch: Partial<Doc<'downloadClients'>>): boolean {
  const { status, ...fields } = patch;
  if (JSON.stringify(seen(status)) !== JSON.stringify(seen(row.status))) return true;
  return (Object.keys(fields) as (keyof typeof fields)[]).some((key) => fields[key] !== row[key]);
}

/** The user's step for "chosen, not active". */
const NOT_ACTIVE =
  'A VPN is chosen, but the VPN layout isn’t in use yet, so torrents wait. Add COMPOSE_FILE=compose.yml:compose.vpn.yml to .env, then run docker compose up -d.';
const DOWN = 'The VPN tunnel is down. qBittorrent moves no traffic until it is back, and torrent downloads wait.';
/** Only while gluetun answers `running` and healthy and lacks just its exit IP, whose lookup may have failed. */
const RESTART_STEP = 'If the tunnel works, run docker compose restart gluetun.';

/**
 * `vpnDown` opens for `notActive` while a VPN is chosen, and for
 * `down`; `up` and `off` resolve it; `connecting` leaves it as it is. On `up`
 * the submits waiting on `vpnWait` are queued again, so they don't sit out
 * the rest of their `vpnWaitRetryMs`.
 */
async function applyVpn(ctx: MutationCtx, row: Doc<'downloadClients'>, vpn: VpnRuntime): Promise<void> {
  if (vpn.state === 'down') return void (await raiseIssue(ctx, { code: 'vpnDown', detail: vpn.exitIpMissing ? `${DOWN} ${RESTART_STEP}` : DOWN }));
  if (vpn.state === 'notActive') {
    if (row.vpn) await raiseIssue(ctx, { code: 'vpnDown', detail: NOT_ACTIVE });
    return;
  }
  if (vpn.state === 'connecting') return;
  await resolveSystemIssue(ctx, 'vpnDown');
  if (vpn.state !== 'up') return;
  const waiting = await ctx.db
    .query('jobs')
    .withIndex('by_status_class', (q) => q.eq('status', 'waiting').eq('class', 'download.submit'))
    .collect();
  for (const job of waiting) if (job.failureCode === 'vpnDown') await ctx.db.patch(job._id, { status: 'queued', availableAt: undefined });
}

export const report = workerMutation({
  args: ClientReportsRequest.shape,
  returns: Ack,
  handler: async (ctx, { sessionId, reports }) => {
    await acceptedSession(ctx, sessionId);
    const now = Date.now();
    for (const entry of reports) {
      const row = await clientRow(ctx, entry.kind);
      if (!row) continue;
      const patch = patchOf(row, entry, now);
      if (changes(row, patch)) await ctx.db.patch(row._id, patch);
      if (entry.kind === 'qbittorrent' && entry.vpn) await applyVpn(ctx, row, entry.vpn);
    }
    return null;
  },
});
