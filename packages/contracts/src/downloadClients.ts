// The managed download clients' settings, runtime state and worker exchange:
// NZBGet, qBittorrent and the VPN (its types are in vpn.ts).
import { zid } from 'convex-helpers/server/zod4';
import { z } from 'zod';

import { FailureCode } from './failures.ts';
import { ClientKind } from './kinds.ts';
import { SeedGoal } from './seedGoal.ts';
import { UsenetLimit, UsenetServerUsage } from './usenetLimit.ts';
import { VpnKind, VpnRuntime, VpnSettings } from './vpn.ts';

/**
 * One Usenet server. `password` is an internal field; `level` is NZBGet's server level: 0 for the main
 * provider, 1 for every backup server. `id` names a backup server, made at its first save.
 */
export const UsenetServer = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65_535),
  ssl: z.boolean(),
  username: z.string(),
  password: z.string(),
  connections: z.number().int().min(1),
  level: z.number().int().min(0),
  id: z.string().optional(),
  /** A backup server's monthly limit; absent: none. The main server never has one. */
  limit: UsenetLimit.optional(),
});
export type UsenetServer = z.infer<typeof UsenetServer>;

/** The stored list: the main server first (level 0), then the backup servers (level 1). */
export const UsenetServers = z.array(UsenetServer);

/**
 * `saveUsenet` and `testUsenetServer`: an absent password keeps the stored one, as an indexer's
 * key does. The main server takes no monthly limit: NZBGet 26.3 never uses a higher level while a lower
 * one has no active server, so pausing it would stop every Usenet download. Strict, so a limit is
 * refused rather than dropped.
 */
export const UsenetServerInput = UsenetServer.omit({ password: true, level: true, id: true, limit: true }).extend({ password: z.string().optional() }).strict();
export type UsenetServerInput = z.infer<typeof UsenetServerInput>;

/** `saveUsenetBackup`: a backup server may have a monthly limit; leaving it out clears it. */
export const UsenetBackupInput = UsenetServerInput.extend({ limit: UsenetLimit.strict().optional() }).strict();
export type UsenetBackupInput = z.infer<typeof UsenetBackupInput>;

/** A backup server's id, made by the form for a new one, so its "Test login" can name it before the first save. */
export const UsenetBackupId = z.string().min(1).max(64);

/** A backup server's priority: NZBGet's level, 1–9; the main server is 0. NZBGet tries lower levels first. */
export const UsenetBackupPriority = z.number().int().min(1).max(9);

/** The worker's last reading of a limited server's period, for its card entry. */
export const UsenetUsageDetail = UsenetServerUsage.omit({ backupId: true }).strict();
export type UsenetUsageDetail = z.infer<typeof UsenetUsageDetail>;

/** A backup server as Settings › Downloads shows it: no password, only a flag that one is stored. */
export const UsenetBackupServerDetail = UsenetServer.omit({ password: true, level: true, id: true, limit: true })
  .extend({
    id: UsenetBackupId,
    priority: UsenetBackupPriority,
    limit: UsenetLimit.strict().optional(),
    hasPassword: z.boolean(),
    usage: UsenetUsageDetail.optional(),
  })
  .strict();
export type UsenetBackupServerDetail = z.infer<typeof UsenetBackupServerDetail>;

/** `saveTorrents`: "Use torrents" and the user's default goal, which applies to new torrents only. */
export const TorrentSettingsInput = z.object({ enabled: z.boolean(), seedGoal: SeedGoal });
export type TorrentSettingsInput = z.infer<typeof TorrentSettingsInput>;

export const ProviderTestOutcome = z.enum(['pending', 'ok', 'authRejected', 'failed']);
export type ProviderTestOutcome = z.infer<typeof ProviderTestOutcome>;

/** The last "Test login". The form shows platform text naming the host, the port and SSL, never NZBGet's. */
export const ProviderTest = z.object({
  jobId: zid('jobs'),
  outcome: ProviderTestOutcome,
  host: z.string(),
  port: z.number(),
  ssl: z.boolean(),
  at: z.number(),
  /** The backup server the test was for, if any: each form shows only its own server's test. */
  backupId: UsenetBackupId.optional(),
});
export type ProviderTest = z.infer<typeof ProviderTest>;

export const ConnectionStatus = z.enum(['connected', 'firewalled', 'disconnected']);
export type ConnectionStatus = z.infer<typeof ConnectionStatus>;

/**
 * A completed torrent qBittorrent reports as missing its files, errored or in
 * an unknown state, since the first pass that saw it.
 */
export const SeedingProblem = z.object({ downloadId: zid('downloads'), state: z.enum(['missingFiles', 'error', 'unknown']), since: z.number() });
export type SeedingProblem = z.infer<typeof SeedingProblem>;

/** What the reconciler last saw of a client; written by `downloadClients.report` on change. */
export const ClientRuntimeStatus = z.object({
  reachable: z.boolean(),
  checkedAt: z.number(),
  connectionStatus: ConnectionStatus.optional(),
  peerPort: z.number().optional(),
  seedingProblems: z.array(SeedingProblem).optional(),
  /** qBittorrent only: the VPN monitor's last reading. */
  vpn: VpnRuntime.optional(),
  /** NZBGet only: each server with a monthly limit, as the worker last read it. */
  usenetUsage: z.array(UsenetServerUsage).optional(),
});
export type ClientRuntimeStatus = z.infer<typeof ClientRuntimeStatus>;

/** `downloadClients.desired`: one per existing row, with secrets, for the reconciler only. */
export const DesiredClientConfig = z.object({
  kind: ClientKind,
  clientId: zid('downloadClients'),
  enabled: z.boolean(),
  configVersion: z.number(),
  appliedConfigVersion: z.number().optional(),
  /** `backupServers` absent or empty: the main server alone. */
  nzbget: z.object({ server: UsenetServer, backupServers: z.array(UsenetServer).optional() }).optional(),
  /** `vpn` absent: "No VPN". */
  qbittorrent: z.object({ seedGoal: SeedGoal, vpn: VpnSettings.optional() }).optional(),
});
export type DesiredClientConfig = z.infer<typeof DesiredClientConfig>;

/** `downloadClients.report`: one per client kind, sent on change. */
export const ClientStatusReport = z.object({
  kind: ClientKind,
  reachable: z.boolean(),
  clientVersion: z.string().optional(),
  appliedConfigVersion: z.number().optional(),
  applyFailure: FailureCode.optional(),
  connectionStatus: ConnectionStatus.optional(),
  peerPort: z.number().optional(),
  seedingProblems: z.array(SeedingProblem).optional(),
  /** qBittorrent only; `report` raises and resolves `vpnDown` from it. */
  vpn: VpnRuntime.optional(),
  /** NZBGet only: each limited server's period usage; absent when no server has a limit. */
  usenetUsage: z.array(UsenetServerUsage).optional(),
});
export type ClientStatusReport = z.infer<typeof ClientStatusReport>;

/** Whether the client runs the saved config: `pending` until the reconciler reports it. */
export const ClientConfigState = z.enum(['applied', 'pending', 'failed']);
export type ClientConfigState = z.infer<typeof ClientConfigState>;

/** `downloadClients.get`: no secret field, only flags that say one is stored. */
export const DownloadClientsDetail = z
  .object({
    usenet: z
      .object({
        enabled: z.boolean(),
        server: UsenetServer.omit({ password: true, limit: true }).strict().optional(),
        hasPassword: z.boolean(),
        configVersion: z.number(),
        config: ClientConfigState,
        appliedAt: z.number().optional(),
        applyFailure: FailureCode.optional(),
        providerTest: ProviderTest.strict().optional(),
        nzbgetReachable: z.boolean().optional(),
        /** Every backup server, one level below the main one; order doesn't matter in v1. */
        backupServers: z.array(UsenetBackupServerDetail),
      })
      .strict(),
    torrents: z
      .object({
        enabled: z.boolean(),
        seedGoal: SeedGoal,
        configVersion: z.number(),
        config: ClientConfigState,
        appliedAt: z.number().optional(),
        applyFailure: FailureCode.optional(),
        /** Read-only: `OMNARR_PEER_PORT`, as the worker last reported it. */
        peerPort: z.number().optional(),
        connectionStatus: ConnectionStatus.optional(),
        /** The torrents still seeding to their goals and the bytes they uploaded so far. */
        seeding: z.object({ count: z.number(), uploadedBytes: z.number() }).strict().optional(),
      })
      .strict(),
    /** The VPN card: `kind` absent is "No VPN"; the secrets show only as flags. */
    vpn: z
      .object({
        kind: VpnKind.optional(),
        serverCountries: z.array(z.string()).optional(),
        staticForwardedPort: z.number().optional(),
        savedAt: z.number().optional(),
        /** A config file (either kind) or ProtonVPN's private key is stored. */
        hasVpnConfig: z.boolean(),
        /** A username and password are stored (OpenVPN file, PIA). */
        hasVpnCredentials: z.boolean(),
        runtime: VpnRuntime.strict().optional(),
      })
      .strict(),
  })
  .strict();
export type DownloadClientsDetail = z.infer<typeof DownloadClientsDetail>;

/** The worker query's and mutation's arguments. */
export const DesiredClientsRequest = z.object({ sessionId: zid('workerSessions') });
export const DesiredClients = z.array(DesiredClientConfig);
export const ClientReportsRequest = z.object({ sessionId: zid('workerSessions'), reports: z.array(ClientStatusReport) });
export type ClientReportsRequest = z.infer<typeof ClientReportsRequest>;
