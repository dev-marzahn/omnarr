// The download clients' settings and the worker exchange: saves upsert and
// raise configVersion, secrets stay out of every DTO, the provider test runs
// through a maintenance job, and the reconciler reads `desired` and writes
// `report`.
import type { UsenetBackupInput, UsenetServerInput } from '@omnarr/contracts';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';

import { api } from '../convex/_generated/api';
import { fakeWorker, type FakeWorker } from './fakeWorker';
import { asAdmin, setup, type Backend } from './setup';

let t: Backend;
let admin: Awaited<ReturnType<typeof asAdmin>>;
let w: FakeWorker;

beforeEach(async () => {
  vi.useFakeTimers();
  t = setup();
  admin = await asAdmin(t);
  w = await fakeWorker(t);
});
afterEach(() => vi.useRealTimers());

const PASSWORD = 'planted-usenet-password-91c2';
const provider: UsenetServerInput = { host: 'news.example', port: 563, ssl: true, username: 'reader', password: PASSWORD, connections: 8 };

const get = () => admin.query(api.api.downloadClients.get, {});
const saveUsenet = (input: UsenetServerInput) => admin.mutation(api.api.downloadClients.saveUsenet, { input });
const testLogin = (input: UsenetServerInput) => admin.mutation(api.api.downloadClients.testUsenetServer, { input });
const jobs = () => t.run((ctx) => ctx.db.query('jobs').collect());

describe('downloadClients.get', () => {
  test('without a row, the defaults: no provider, nothing stored', async () => {
    expect((await get()).usenet).toEqual({ enabled: false, hasPassword: false, configVersion: 0, config: 'pending', backupServers: [] });
  });

  test('never returns a secret', async () => {
    await saveUsenet(provider);
    expect(JSON.stringify(await get())).not.toContain(PASSWORD);
    expect(await get()).toMatchObject({
      usenet: {
        enabled: true,
        server: { host: 'news.example', port: 563, ssl: true, username: 'reader', connections: 8, level: 0 },
        hasPassword: true,
        configVersion: 1,
        config: 'pending',
      },
    });
  });
});

describe('downloadClients.saveUsenet', () => {
  test('the first save creates the NZBGet row, enabled, at configVersion 1', async () => {
    await saveUsenet(provider);
    const rows = await t.run((ctx) => ctx.db.query('downloadClients').collect());
    expect(rows).toEqual([expect.objectContaining({ kind: 'nzbget', enabled: true, configVersion: 1, usenetServers: [{ ...provider, level: 0 }] })]);
  });

  test('a change raises configVersion; the same values again change nothing', async () => {
    await saveUsenet(provider);
    await saveUsenet({ ...provider, connections: 20 });
    expect((await get()).usenet.configVersion).toBe(2);
    await saveUsenet({ ...provider, connections: 20 });
    expect((await get()).usenet.configVersion).toBe(2);
  });

  test('a save without a password keeps the stored one', async () => {
    await saveUsenet(provider);
    const { password: _, ...withoutPassword } = provider;
    await saveUsenet({ ...withoutPassword, connections: 12 });
    const [desired] = await w.desiredClients();
    expect(desired!.nzbget!.server).toMatchObject({ password: PASSWORD, connections: 12 });
  });

  test('an invalid port is refused', async () => {
    await expect(saveUsenet({ ...provider, port: 0 })).rejects.toThrow();
  });
});

describe('downloadClients.testUsenetServer', () => {
  test('enqueues the test with the entered values and records it pending', async () => {
    await testLogin(provider);
    const [job] = await jobs();
    expect(job).toMatchObject({ class: 'maintenance', idempotencyKey: 'testUsenetServer:1' });
    expect(job!.payload).toEqual({
      class: 'maintenance',
      action: 'testUsenetServer',
      host: 'news.example',
      port: 563,
      ssl: true,
      username: 'reader',
      password: PASSWORD,
    });
    expect((await get()).usenet.providerTest).toEqual({
      jobId: job!._id,
      outcome: 'pending',
      host: 'news.example',
      port: 563,
      ssl: true,
      at: expect.any(Number),
    });
  });

  test('a blank password tests the stored one', async () => {
    await saveUsenet(provider);
    const { password: _, ...withoutPassword } = provider;
    await testLogin(withoutPassword);
    expect((await jobs())[0]!.payload).toMatchObject({ password: PASSWORD });
  });

  test('the worker writes the outcome, and the payload with the password is cleared', async () => {
    await testLogin(provider);
    const [job] = await w.claim('maintenance');
    await w.complete(job!, { class: 'maintenance', action: 'testUsenetServer', outcome: 'authRejected' });
    expect((await get()).usenet.providerTest).toMatchObject({ outcome: 'authRejected' });
    expect((await jobs())[0]!.payload).toBeUndefined();
  });

  test('a test that fails terminally (NZBGet unreachable on every attempt) writes failed', async () => {
    await testLogin(provider);
    for (let attempt = 0; attempt < 3; attempt++) {
      const [job] = await w.claim('maintenance');
      await w.fail(job!, 'clientUnreachable', 'NZBGet did not answer.');
      await t.run(async (ctx) => {
        for (const row of await ctx.db.query('jobs').collect()) if (row.status === 'waiting') await ctx.db.patch(row._id, { status: 'queued' });
      });
    }
    expect((await jobs())[0]!.status).toBe('failed');
    expect((await get()).usenet.providerTest).toMatchObject({ outcome: 'failed' });
  });

  test('a second test gets a new key, and the form follows the latest one', async () => {
    await testLogin(provider);
    await testLogin({ ...provider, host: 'other.example' });
    expect((await jobs()).map((job) => job.idempotencyKey)).toEqual(['testUsenetServer:1', 'testUsenetServer:2']);
    expect((await get()).usenet.providerTest).toMatchObject({ host: 'other.example', jobId: (await jobs())[1]!._id });
    // An older test's late answer doesn't overwrite the latest one.
    const [first] = await w.claim('maintenance', 1);
    await w.complete(first!, { class: 'maintenance', action: 'testUsenetServer', outcome: 'ok' });
    expect((await get()).usenet.providerTest).toMatchObject({ host: 'other.example', outcome: 'pending' });
  });

  test('a test before any save leaves NZBGet unconfigured: saving the provider is what enables it', async () => {
    await testLogin(provider);
    expect((await get()).usenet).toMatchObject({ enabled: false, hasPassword: false });
    expect(await w.desiredClients()).toEqual([expect.objectContaining({ kind: 'nzbget', enabled: false })]);
  });
});

describe('backup servers', () => {
  const BACKUP_PASSWORD = 'planted-backup-password-5e07';
  const backup: UsenetServerInput = { host: 'bonus.example', port: 443, ssl: true, username: 'reader2', password: BACKUP_PASSWORD, connections: 4 };
  // The form makes a new backup server's id, so its test can name it before the first save.
  const saveBackup = (backupId: string, input: UsenetBackupInput) => admin.mutation(api.api.downloadClients.saveUsenetBackup, { backupId, input });
  const removeBackup = (backupId: string) => admin.mutation(api.api.downloadClients.removeUsenetBackup, { backupId });
  const backups = async () => (await get()).usenet.backupServers;

  test('without one the card lists none, and desired holds the main server alone', async () => {
    await saveUsenet(provider);
    expect(await backups()).toEqual([]);
    expect((await w.desiredClients())[0]!.nzbget).toEqual({ server: { ...provider, level: 0 } });
  });

  test('a saved backup server shows on the card without its password, and raises configVersion', async () => {
    await saveUsenet(provider);
    await saveBackup('b1', backup);
    expect(await backups()).toEqual([
      { id: 'b1', host: 'bonus.example', port: 443, ssl: true, username: 'reader2', connections: 4, priority: 1, hasPassword: true },
    ]);
    expect(JSON.stringify(await get())).not.toContain(BACKUP_PASSWORD);
    expect((await get()).usenet.configVersion).toBe(2);
  });

  test('desired gives the worker each backup server with its password, at level 1', async () => {
    await saveUsenet(provider);
    await saveBackup('b1', backup);
    await saveBackup('b2', { ...backup, host: 'block.example', password: 'other' });
    expect((await w.desiredClients())[0]!.nzbget).toEqual({
      server: { ...provider, level: 0 },
      backupServers: [
        { ...backup, level: 1, id: 'b1' },
        { ...backup, host: 'block.example', password: 'other', level: 1, id: 'b2' },
      ],
    });
  });

  test('a backup server needs the main server saved first', async () => {
    await expect(saveBackup('b1', backup)).rejects.toThrow(/main server/i);
  });

  test('an edit with a blank password keeps that backup server’s stored one; the same values again change nothing', async () => {
    await saveUsenet(provider);
    await saveBackup('b1', backup);
    await saveBackup('b2', { ...backup, password: 'other' });
    const { password: _, ...withoutPassword } = backup;
    await saveBackup('b1', { ...withoutPassword, connections: 6 });
    expect((await backups())[0]).toEqual(expect.objectContaining({ id: 'b1', connections: 6, hasPassword: true }));
    expect((await w.desiredClients())[0]!.nzbget!.backupServers![0]).toEqual({ ...backup, connections: 6, level: 1, id: 'b1' });
    const version = (await get()).usenet.configVersion;
    await saveBackup('b1', { ...withoutPassword, connections: 6 });
    expect((await get()).usenet.configVersion).toBe(version);
  });

  test('removing a backup server drops it and raises configVersion; removing one that is gone changes nothing', async () => {
    await saveUsenet(provider);
    await saveBackup('b1', backup);
    await saveBackup('b2', { ...backup, host: 'block.example' });
    const [, second] = await backups();
    const version = (await get()).usenet.configVersion;
    await removeBackup('b1');
    expect(await backups()).toEqual([second]);
    expect((await get()).usenet.configVersion).toBe(version + 1);
    await removeBackup('b1');
    expect((await get()).usenet.configVersion).toBe(version + 1);
  });

  test('saving the main server keeps the backup servers', async () => {
    await saveUsenet(provider);
    await saveBackup('b1', backup);
    await saveUsenet({ ...provider, connections: 30 });
    expect(await backups()).toHaveLength(1);
    expect((await w.desiredClients())[0]!.nzbget).toMatchObject({ server: { connections: 30, level: 0 }, backupServers: [{ host: 'bonus.example' }] });
  });

  test("a backup server's test with a blank password tests its stored one, and the record names the backup", async () => {
    await saveUsenet(provider);
    await saveBackup('b1', backup);
    const { password: _, ...withoutPassword } = backup;
    await admin.mutation(api.api.downloadClients.testUsenetServer, { input: withoutPassword, backupId: 'b1' });
    expect((await jobs())[0]!.payload).toMatchObject({ host: 'bonus.example', password: BACKUP_PASSWORD });
    expect((await get()).usenet.providerTest).toMatchObject({ host: 'bonus.example', outcome: 'pending', backupId: 'b1' });
    // The main server's test names no backup.
    await testLogin(provider);
    expect((await get()).usenet.providerTest).not.toHaveProperty('backupId');
  });

  test("a backup server's priority is its level, 1 when left out; the card shows it", async () => {
    await saveUsenet(provider);
    await saveBackup('b1', backup);
    await admin.mutation(api.api.downloadClients.saveUsenetBackup, { backupId: 'b2', input: backup, priority: 3 });
    expect((await backups()).map((entry) => [entry.id, entry.priority])).toEqual([
      ['b1', 1],
      ['b2', 3],
    ]);
    expect((await w.desiredClients())[0]!.nzbget!.backupServers!.map((entry) => entry.level)).toEqual([1, 3]);
    await expect(admin.mutation(api.api.downloadClients.saveUsenetBackup, { backupId: 'b3', input: backup, priority: 10 })).rejects.toThrow();
  });

  test('a monthly limit is stored on a backup server; leaving it out clears it; the same limit again changes nothing', async () => {
    const limit = { monthlyLimitGb: 2.5, resetDay: 15 };
    await saveUsenet(provider);
    await saveBackup('b1', { ...backup, limit });
    const { usenet } = await get();
    expect(usenet.backupServers[0]!.limit).toEqual(limit);
    expect((await w.desiredClients())[0]!.nzbget!.backupServers![0]!.limit).toEqual(limit);
    const version = usenet.configVersion;
    await saveBackup('b1', { ...backup, limit });
    expect((await get()).usenet.configVersion).toBe(version);
    await saveBackup('b1', backup);
    expect((await get()).usenet.backupServers[0]).not.toHaveProperty('limit');
    expect((await get()).usenet.configVersion).toBe(version + 1);
  });

  // NZBGet 26.3 never uses a higher level while a lower one has no active server, so pausing the main
  // server would stop every Usenet download.
  test('the main server takes no monthly limit', async () => {
    await expect(saveUsenet({ ...provider, limit: { monthlyLimitGb: 50, resetDay: 1 } } as never)).rejects.toThrow();
    expect((await get()).usenet).not.toHaveProperty('server');
  });

  test("the author's setup: the local main server (75 connections), the other region at priority 1, the limited Bonus server at 2", async () => {
    await saveUsenet({ ...provider, host: 'news.local.example', connections: 75 });
    await admin.mutation(api.api.downloadClients.saveUsenetBackup, {
      backupId: 'region',
      input: { ...backup, host: 'news.region.example', connections: 30 },
      priority: 1,
    });
    await admin.mutation(api.api.downloadClients.saveUsenetBackup, {
      backupId: 'bonus',
      input: { ...backup, host: 'bonus.other.example', connections: 100, limit: { monthlyLimitGb: 50, resetDay: 1 } },
      priority: 2,
    });
    const { nzbget } = (await w.desiredClients())[0]!;
    expect([nzbget!.server, ...nzbget!.backupServers!].map(({ host, level, connections, limit }) => ({ host, level, connections, limit }))).toEqual([
      { host: 'news.local.example', level: 0, connections: 75, limit: undefined },
      { host: 'news.region.example', level: 1, connections: 30, limit: undefined },
      { host: 'bonus.other.example', level: 2, connections: 100, limit: { monthlyLimitGb: 50, resetDay: 1 } },
    ]);
  });

  test("the worker's usage reading shows on each limited backup server's card entry", async () => {
    await saveUsenet(provider);
    await saveBackup('b1', { ...backup, limit: { monthlyLimitGb: 9, resetDay: 1 } });
    await saveBackup('b2', backup);
    await w.reportClients([{ kind: 'nzbget', reachable: true, usenetUsage: [{ backupId: 'b1', usedBytes: 3e9, limitReached: false }] }]);
    const { usenet } = await get();
    expect(usenet.backupServers.map((entry) => entry.usage)).toEqual([{ usedBytes: 3e9, limitReached: false }, undefined]);
  });

  test("a new backup server's test uses the entered password only, never the main server's", async () => {
    await saveUsenet(provider);
    const { password: _, ...withoutPassword } = backup;
    await admin.mutation(api.api.downloadClients.testUsenetServer, { input: withoutPassword, backupId: 'b-new' });
    expect((await jobs())[0]!.payload).toMatchObject({ host: 'bonus.example', password: '' });
    expect((await get()).usenet.providerTest).toMatchObject({ backupId: 'b-new' });
  });
});

describe('downloadClients.saveTorrents', () => {
  const saveTorrents = (enabled: boolean, seedGoal: { ratio?: number; seedTimeMs?: number }) =>
    admin.mutation(api.api.downloadClients.saveTorrents, { input: { enabled, seedGoal } });

  test('without a row, torrents are on with the default goal', async () => {
    expect((await get()).torrents).toEqual({
      enabled: true,
      seedGoal: { ratio: 2, seedTimeMs: 1_209_600_000 },
      configVersion: 0,
      config: 'pending',
      seeding: { count: 0, uploadedBytes: 0 },
    });
  });

  test('the first save creates the qBittorrent row with the switch and the goal, at configVersion 1', async () => {
    await saveTorrents(false, { ratio: 1.5 });
    expect((await get()).torrents).toEqual({
      enabled: false,
      seedGoal: { ratio: 1.5 },
      configVersion: 1,
      config: 'pending',
      seeding: { count: 0, uploadedBytes: 0 },
    });
    const rows = await t.run((ctx) => ctx.db.query('downloadClients').collect());
    expect(rows).toEqual([expect.objectContaining({ kind: 'qbittorrent', enabled: false, configVersion: 1, seedGoal: { ratio: 1.5 } })]);
  });

  test('a change raises configVersion; the same values again change nothing', async () => {
    await saveTorrents(true, { ratio: 2 });
    await saveTorrents(true, { seedTimeMs: 60_000 });
    expect((await get()).torrents.configVersion).toBe(2);
    await saveTorrents(true, { seedTimeMs: 60_000 });
    expect((await get()).torrents.configVersion).toBe(2);
  });

  test('a goal without a limit is refused', async () => {
    await expect(saveTorrents(true, {})).rejects.toThrow();
  });

  test('desired carries the goal; the report’s peer port and connection status show on the card', async () => {
    await saveTorrents(true, { seedTimeMs: 60_000 });
    const rows = await t.run((ctx) => ctx.db.query('downloadClients').collect());
    expect(await w.desiredClients()).toEqual([
      { kind: 'qbittorrent', clientId: rows[0]!._id, enabled: true, configVersion: 1, qbittorrent: { seedGoal: { seedTimeMs: 60_000 } } },
    ]);
    await w.reportClients([
      { kind: 'qbittorrent', reachable: true, clientVersion: 'v5.3.0', appliedConfigVersion: 1, connectionStatus: 'firewalled', peerPort: 6881 },
    ]);
    expect((await get()).torrents).toMatchObject({ config: 'applied', peerPort: 6881, connectionStatus: 'firewalled' });
  });
});

describe('the worker exchange', () => {
  test('desired returns each row with its secrets', async () => {
    await saveUsenet(provider);
    const [row] = await t.run((ctx) => ctx.db.query('downloadClients').collect());
    expect(await w.desiredClients()).toEqual([
      { kind: 'nzbget', clientId: row!._id, enabled: true, configVersion: 1, nzbget: { server: { ...provider, level: 0 } } },
    ]);
  });

  test('desired is empty without rows', async () => {
    expect(await w.desiredClients()).toEqual([]);
  });

  test('a report of the applied version marks the config applied, with the client version', async () => {
    await saveUsenet(provider);
    await w.reportClients([{ kind: 'nzbget', reachable: true, clientVersion: '26.3', appliedConfigVersion: 1 }]);
    expect((await get()).usenet).toMatchObject({ config: 'applied', appliedAt: expect.any(Number) });
    const [desired] = await w.desiredClients();
    expect(desired!.appliedConfigVersion).toBe(1);
  });

  test('a failed apply shows as failed until a later apply succeeds', async () => {
    await saveUsenet(provider);
    await w.reportClients([{ kind: 'nzbget', reachable: false, applyFailure: 'clientUnreachable' }]);
    expect((await get()).usenet).toMatchObject({ config: 'failed', applyFailure: 'clientUnreachable' });
    await w.reportClients([{ kind: 'nzbget', reachable: true, appliedConfigVersion: 1 }]);
    const usenet = (await get()).usenet;
    expect(usenet.config).toBe('applied');
    expect(usenet.applyFailure).toBeUndefined();
  });

  test('a save after an apply is pending again', async () => {
    await saveUsenet(provider);
    await w.reportClients([{ kind: 'nzbget', reachable: true, appliedConfigVersion: 1 }]);
    await saveUsenet({ ...provider, connections: 2 });
    expect((await get()).usenet.config).toBe('pending');
  });

  test('a report for a kind without a row is ignored', async () => {
    await w.reportClients([{ kind: 'qbittorrent', reachable: true }]);
    expect(await t.run((ctx) => ctx.db.query('downloadClients').collect())).toEqual([]);
  });

  test('an unchanged report writes nothing', async () => {
    await saveUsenet(provider);
    await w.reportClients([{ kind: 'nzbget', reachable: true, clientVersion: '26.3', appliedConfigVersion: 1 }]);
    const before = await t.run((ctx) => ctx.db.query('downloadClients').first());
    vi.advanceTimersByTime(30_000);
    await w.reportClients([{ kind: 'nzbget', reachable: true, clientVersion: '26.3', appliedConfigVersion: 1 }]);
    const after = await t.run((ctx) => ctx.db.query('downloadClients').first());
    expect(after).toEqual(before);
  });
});
