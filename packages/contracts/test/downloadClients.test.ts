import { describe, expect, test } from 'vite-plus/test';

import {
  ClientStatusReport,
  DesiredClientConfig,
  DownloadClientsDetail,
  TorrentSettingsInput,
  UsenetBackupInput,
  UsenetServer,
  UsenetServerInput,
  UsenetServers,
} from '../src/downloadClients.ts';
import { DEFAULT_SEED_GOAL, SeedGoal, seedGoalFor } from '../src/seedGoal.ts';

const server = { host: 'news.example', port: 563, ssl: true, username: 'reader', password: 'secret', connections: 8, level: 0 };

describe('the Usenet provider', () => {
  test('one provider is a list of one, with its level', () => {
    expect(UsenetServers.parse([server])).toEqual([server]);
  });

  test('backup servers follow the main one, at level 1 with an id', () => {
    const backup = { ...server, host: 'backup.example', level: 1, id: 'b1' };
    expect(UsenetServers.parse([server, backup])).toEqual([server, backup]);
  });

  test("only a backup server's input takes a monthly limit; the main server's refuses one", () => {
    const login = { host: 'h', port: 563, ssl: true, username: '', connections: 8 };
    const limit = { monthlyLimitGb: 50, resetDay: 1 };
    expect(() => UsenetServerInput.parse({ ...login, limit })).toThrow();
    expect(UsenetBackupInput.parse({ ...login, limit })).toEqual({ ...login, limit });
    expect(UsenetBackupInput.parse(login)).toEqual(login);
  });

  test('a connection count of 100 and more is allowed: no cap below what plans sell', () => {
    expect(UsenetServer.parse({ ...server, connections: 100 }).connections).toBe(100);
    expect(UsenetServerInput.parse({ host: 'h', port: 563, ssl: true, username: '', connections: 150 }).connections).toBe(150);
  });

  test('the port and the connection count are positive whole numbers', () => {
    expect(() => UsenetServer.parse({ ...server, port: 0 })).toThrow();
    expect(() => UsenetServer.parse({ ...server, connections: 0 })).toThrow();
    expect(() => UsenetServer.parse({ ...server, port: 563.5 })).toThrow();
  });

  test('the save input may leave the password out, which keeps the stored one', () => {
    const { password: _, level: __, ...rest } = server;
    expect(UsenetServerInput.parse(rest)).toEqual(rest);
  });
});

describe('DownloadClientsDetail, the DTO', () => {
  const usenet = {
    enabled: true,
    server: { host: 'news.example', port: 563, ssl: true, username: 'reader', connections: 8, level: 0 },
    hasPassword: true,
    configVersion: 2,
    config: 'applied',
    backupServers: [
      {
        id: 'b1',
        host: 'backup.example',
        port: 443,
        ssl: true,
        username: 'reader2',
        connections: 4,
        priority: 2,
        limit: { monthlyLimitGb: 50, resetDay: 1 },
        hasPassword: true,
        usage: { usedBytes: 1e9, limitReached: false },
      },
    ],
  };

  const torrents = { enabled: true, seedGoal: DEFAULT_SEED_GOAL, configVersion: 1, config: 'pending', peerPort: 6881, connectionStatus: 'connected' };

  test('carries the provider without its password, and the torrent settings', () => {
    const vpn = { hasVpnConfig: false, hasVpnCredentials: false };
    expect(DownloadClientsDetail.parse({ usenet, torrents, vpn })).toEqual({ usenet, torrents, vpn });
  });

  test.each(['password', 'apiKey', 'controlPassword'])('rejects the secret key %s anywhere in the provider or the torrent settings', (key) => {
    expect(() => DownloadClientsDetail.parse({ usenet: { ...usenet, server: { ...usenet.server, [key]: 'x' } }, torrents })).toThrow();
    expect(() => DownloadClientsDetail.parse({ usenet: { ...usenet, [key]: 'x' }, torrents })).toThrow();
    expect(() => DownloadClientsDetail.parse({ usenet: { ...usenet, backupServers: [{ ...usenet.backupServers[0], [key]: 'x' }] }, torrents })).toThrow();
    expect(() => DownloadClientsDetail.parse({ usenet, torrents: { ...torrents, [key]: 'x' } })).toThrow();
    expect(() => DownloadClientsDetail.parse({ usenet, torrents, [key]: 'x' })).toThrow();
  });

  test('saveTorrents takes the switch and a goal with at least one limit', () => {
    expect(TorrentSettingsInput.parse({ enabled: false, seedGoal: { ratio: 1 } })).toEqual({ enabled: false, seedGoal: { ratio: 1 } });
    expect(() => TorrentSettingsInput.parse({ enabled: true, seedGoal: {} })).toThrow();
  });
});

describe('the seeding goal', () => {
  const DAY = 86_400_000;

  test('the default is ratio 2.0 or 14 days', () => {
    expect(DEFAULT_SEED_GOAL).toEqual({ ratio: 2, seedTimeMs: 1_209_600_000 });
  });

  test('a goal needs a ratio or a seed time', () => {
    expect(() => SeedGoal.parse({})).toThrow();
    expect(SeedGoal.parse({ ratio: 1.5 })).toEqual({ ratio: 1.5 });
    expect(SeedGoal.parse({ seedTimeMs: DAY })).toEqual({ seedTimeMs: DAY });
    expect(() => SeedGoal.parse({ ratio: -1 })).toThrow();
  });

  test('no tracker minimum: the user’s goal as it is, whichever limit comes first', () => {
    expect(seedGoalFor(DEFAULT_SEED_GOAL)).toEqual(DEFAULT_SEED_GOAL);
    expect(seedGoalFor(DEFAULT_SEED_GOAL, {})).toEqual(DEFAULT_SEED_GOAL);
  });

  test('a time-only minimum gives a time limit only, raised to the user’s 14 days', () => {
    expect(seedGoalFor(DEFAULT_SEED_GOAL, { minimumSeedTimeSec: 72 * 3600 })).toEqual({ seedTimeMs: 14 * DAY });
  });

  test('a time minimum above the user’s time wins', () => {
    expect(seedGoalFor({ ratio: 2, seedTimeMs: DAY }, { minimumSeedTimeSec: 3 * 86_400 })).toEqual({ seedTimeMs: 3 * DAY });
  });

  test('a ratio-only minimum gives a ratio limit only, the higher of the two', () => {
    expect(seedGoalFor(DEFAULT_SEED_GOAL, { minimumRatio: 1 })).toEqual({ ratio: 2 });
    expect(seedGoalFor(DEFAULT_SEED_GOAL, { minimumRatio: 3 })).toEqual({ ratio: 3 });
  });

  test('both minimums give both, each raised to the user’s value on it', () => {
    expect(seedGoalFor(DEFAULT_SEED_GOAL, { minimumRatio: 1, minimumSeedTimeSec: 30 * 86_400 })).toEqual({ ratio: 2, seedTimeMs: 30 * DAY });
  });

  test('a user goal without the reported dimension takes the tracker’s value on it', () => {
    expect(seedGoalFor({ seedTimeMs: DAY }, { minimumRatio: 1.5 })).toEqual({ ratio: 1.5 });
  });

  test('a minimum of 0 is no minimum', () => {
    expect(seedGoalFor(DEFAULT_SEED_GOAL, { minimumRatio: 0, minimumSeedTimeSec: 0 })).toEqual(DEFAULT_SEED_GOAL);
  });
});

describe('the worker exchange', () => {
  test('desired carries the NZBGet server with its password, for the reconciler only', () => {
    const desired = { kind: 'nzbget', clientId: 'c1', enabled: true, configVersion: 3, appliedConfigVersion: 2, nzbget: { server } };
    expect(DesiredClientConfig.parse(desired)).toEqual(desired);
  });

  test('desired carries qBittorrent’s seeding goal', () => {
    const desired = { kind: 'qbittorrent', clientId: 'c2', enabled: true, configVersion: 1, qbittorrent: { seedGoal: DEFAULT_SEED_GOAL } };
    expect(DesiredClientConfig.parse(desired)).toEqual(desired);
  });

  test('a qBittorrent report carries the connection status, the peer port and the seeding problems', () => {
    const report = {
      kind: 'qbittorrent',
      reachable: true,
      clientVersion: 'v5.3.0',
      connectionStatus: 'firewalled',
      peerPort: 6881,
      seedingProblems: [{ downloadId: 'd1', state: 'missingFiles', since: 5 }],
    };
    expect(ClientStatusReport.parse(report)).toEqual(report);
    expect(() => ClientStatusReport.parse({ ...report, seedingProblems: [{ downloadId: 'd1', state: 'stalledUP', since: 5 }] })).toThrow();
  });

  test('a report says whether the client answered, and the version it applied or the apply failure', () => {
    const applied = { kind: 'nzbget', reachable: true, clientVersion: '26.3', appliedConfigVersion: 3 };
    expect(ClientStatusReport.parse(applied)).toEqual(applied);
    const failed = { kind: 'nzbget', reachable: false, applyFailure: 'clientUnreachable' };
    expect(ClientStatusReport.parse(failed)).toEqual(failed);
  });
});
