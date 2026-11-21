// mergeOwnedOptions: NZBGet's `saveconfig` writes the whole file, so
// the platform's options replace NZBGet's in the list `loadconfig` read, and
// every other option stays as NZBGet has it.
import type { UsenetServer } from '@omnarr/contracts';
import { describe, expect, test } from 'vite-plus/test';

import { mergeOwnedOptions, NZBGET_CERT_STORE, type NzbgetOption } from '../src/clients/nzbgetConfig.ts';
import { nzbgetFixture } from './fixtures/nzbget/load.ts';

const server: UsenetServer = { host: 'news.example', port: 563, ssl: true, username: 'reader', password: 'secret', connections: 8, level: 0 };
const valueOf = (options: NzbgetOption[], name: string) => options.find((option) => option.Name === name)?.Value;

/** What NZBGet 26.3's `loadconfig` returned for a file holding only the setup container's control keys. */
const minimal = () => nzbgetFixture<NzbgetOption>('loadconfig');

describe('mergeOwnedOptions', () => {
  test("from the setup container's minimal file: every owned option is set, and the control login is kept", () => {
    const { options, changed } = mergeOwnedOptions(minimal(), { server });
    expect(changed).toBe(true);
    expect(Object.fromEntries(options.map((option) => [option.Name, option.Value]))).toEqual({
      ControlUsername: 'omnarr',
      ControlPassword: 'fixture-control-password',
      ControlIP: '0.0.0.0',
      ControlPort: '6789',
      RestrictedUsername: '',
      AddUsername: '',
      MainDir: '/data/downloads/usenet',
      DestDir: '${MainDir}/completed',
      InterDir: '${MainDir}/intermediate',
      NzbDir: '${MainDir}/nzb',
      QueueDir: '${MainDir}/queue',
      TempDir: '${MainDir}/tmp',
      LockFile: '/config/nzbget.lock',
      LogFile: '/config/nzbget.log',
      ConfigTemplate: '${AppDir}/webui/nzbget.conf.template',
      CertStore: NZBGET_CERT_STORE,
      // NZBGet's built-in default is no, which leaves certificate checks off.
      CertCheck: 'yes',
      'Category1.Name': 'platform-series',
      'Category1.DestDir': '',
      'Category2.Name': 'platform-movies',
      'Category2.DestDir': '',
      AppendCategoryDir: 'yes',
      'Server1.Active': 'yes',
      'Server1.Name': 'provider',
      'Server1.Level': '0',
      'Server1.Group': '0',
      'Server1.Host': 'news.example',
      'Server1.Port': '563',
      'Server1.Encryption': 'yes',
      'Server1.CertVerification': 'strict',
      'Server1.Username': 'reader',
      'Server1.Password': 'secret',
      'Server1.Connections': '8',
      'Server1.Retention': '0',
      HealthCheck: 'delete',
      ParCheck: 'auto',
      ParRepair: 'yes',
      ParRename: 'yes',
      RarRename: 'yes',
      DirectRename: 'yes',
      Unpack: 'yes',
      UnpackCleanupDisk: 'yes',
      Extensions: '',
      // An apply's reload keeps a file's finished articles.
      ContinuePartial: 'yes',
      DupeCheck: 'no',
      KeepHistory: '30',
      NzbCleanupDisk: 'yes',
      SecureControl: 'no',
      AuthorizedIP: '',
      FormAuth: 'no',
      UpdateCheck: 'none',
    });
  });

  test("ConfigTemplate is the pinned image's template, so NZBGet doesn't log that it can't read it", () => {
    expect(valueOf(mergeOwnedOptions(minimal(), { server }).options, 'ConfigTemplate')).toBe('${AppDir}/webui/nzbget.conf.template');
  });

  test("NzbCleanupDisk deletes an NZB's .queued copy once its entry leaves the queue and history", () => {
    // NZBGet 26.3's built-in default is no, which keeps every copy in downloads/usenet/nzb/.
    expect(valueOf(mergeOwnedOptions(minimal(), { server }).options, 'NzbCleanupDisk')).toBe('yes');
  });

  test('CertStore is the CA bundle the pinned image ships, so strict certificate checks work', () => {
    expect(NZBGET_CERT_STORE).toBe('/app/nzbget/cacert.pem');
  });

  test('options the platform does not own stay as NZBGet has them, in their place', () => {
    const current: NzbgetOption[] = [{ Name: 'ArticleCache', Value: '500' }, ...minimal(), { Name: 'WriteBuffer', Value: '1024' }];
    const { options } = mergeOwnedOptions(current, { server });
    expect(options[0]).toEqual({ Name: 'ArticleCache', Value: '500' });
    expect(valueOf(options, 'WriteBuffer')).toBe('1024');
  });

  test('owned options a user changed inside NZBGet are overwritten', () => {
    const current = [...minimal(), { Name: 'HealthCheck', Value: 'park' }, { Name: 'Server1.Host', Value: 'evil.example' }];
    const { options, changed } = mergeOwnedOptions(current, { server });
    expect(changed).toBe(true);
    expect(valueOf(options, 'HealthCheck')).toBe('delete');
    expect(valueOf(options, 'Server1.Host')).toBe('news.example');
  });

  test('every Server2.* and higher, and every Category3.* and higher, is removed', () => {
    const current = [
      ...minimal(),
      { Name: 'Server2.Host', Value: 'backup.example' },
      { Name: 'Server12.Active', Value: 'yes' },
      { Name: 'Category3.Name', Value: 'Movies' },
      { Name: 'Category4.DestDir', Value: '/x' },
      { Name: 'Server1.Optional', Value: 'no' },
    ];
    const { options } = mergeOwnedOptions(current, { server });
    expect(options.map((option) => option.Name)).not.toEqual(expect.arrayContaining(['Server2.Host']));
    expect(options.filter((option) => /^(Server([2-9]|\d{2,})|Category([3-9]|\d{2,}))\./.test(option.Name))).toEqual([]);
    expect(valueOf(options, 'Server1.Optional')).toBe('no');
  });

  test('each backup server is Server2…n at Level 1, optional, with strict certificate checks; the main server stays Level 0', () => {
    const backupServers: UsenetServer[] = [
      { host: 'bonus.example', port: 443, ssl: true, username: 'reader2', password: 'secret2', connections: 4, level: 1 },
      { host: 'block.example', port: 119, ssl: false, username: '', password: '', connections: 2, level: 1 },
    ];
    const { options } = mergeOwnedOptions(minimal(), { server, backupServers });
    const servers = Object.fromEntries(options.filter((option) => /^Server\d+\./.test(option.Name)).map((option) => [option.Name, option.Value]));
    expect(servers).toEqual({
      'Server1.Active': 'yes',
      'Server1.Name': 'provider',
      'Server1.Level': '0',
      'Server1.Group': '0',
      'Server1.Host': 'news.example',
      'Server1.Port': '563',
      'Server1.Encryption': 'yes',
      'Server1.CertVerification': 'strict',
      'Server1.Username': 'reader',
      'Server1.Password': 'secret',
      'Server1.Connections': '8',
      'Server1.Retention': '0',
      'Server2.Active': 'yes',
      'Server2.Name': 'backup-1',
      'Server2.Level': '1',
      'Server2.Optional': 'yes',
      'Server2.Group': '0',
      'Server2.Host': 'bonus.example',
      'Server2.Port': '443',
      'Server2.Encryption': 'yes',
      'Server2.CertVerification': 'strict',
      'Server2.Username': 'reader2',
      'Server2.Password': 'secret2',
      'Server2.Connections': '4',
      'Server2.Retention': '0',
      'Server3.Active': 'yes',
      'Server3.Name': 'backup-2',
      'Server3.Level': '1',
      'Server3.Optional': 'yes',
      'Server3.Group': '0',
      'Server3.Host': 'block.example',
      'Server3.Port': '119',
      'Server3.Encryption': 'no',
      'Server3.CertVerification': 'strict',
      'Server3.Username': '',
      'Server3.Password': '',
      'Server3.Connections': '2',
      'Server3.Retention': '0',
    });
    expect(valueOf(options, 'CertCheck')).toBe('yes');
  });

  test("each backup server's priority is its Level: 0 for the main server, then 1, 2 … as saved; equal levels share the work", () => {
    const at = (level: number, host: string): UsenetServer => ({ ...server, host, level, id: host });
    const { options } = mergeOwnedOptions(minimal(), { server, backupServers: [at(2, 'c.example'), at(1, 'a.example'), at(1, 'b.example')] });
    const levels = ['Server1', 'Server2', 'Server3', 'Server4'].map((n) => [valueOf(options, `${n}.Host`), valueOf(options, `${n}.Level`)]);
    expect(levels).toEqual([
      ['news.example', '0'],
      ['c.example', '2'],
      ['a.example', '1'],
      ['b.example', '1'],
    ]);
  });

  test("the author's setup: the local main server at Level 0, the other region at 1, the limited Bonus server at 2", () => {
    const main: UsenetServer = { ...server, host: 'news.local.example', connections: 75 };
    const region: UsenetServer = { ...server, host: 'news.region.example', connections: 30, level: 1, id: 'region' };
    const bonus: UsenetServer = {
      ...server,
      host: 'bonus.other.example',
      connections: 12,
      level: 2,
      id: 'bonus',
      limit: { monthlyLimitGb: 50, resetDay: 1 },
    };
    const { options } = mergeOwnedOptions(minimal(), { server: main, backupServers: [region, bonus] });
    const fields = ['Name', 'Level', 'Optional', 'Host', 'Connections', 'Active'];
    const of = (n: number) => Object.fromEntries(fields.map((field) => [field, valueOf(options, `Server${n}.${field}`)]));
    expect([of(1), of(2), of(3)]).toEqual([
      { Name: 'provider', Level: '0', Optional: undefined, Host: 'news.local.example', Connections: '75', Active: 'yes' },
      { Name: 'backup-1', Level: '1', Optional: 'yes', Host: 'news.region.example', Connections: '30', Active: 'yes' },
      { Name: 'backup-2', Level: '2', Optional: 'yes', Host: 'bonus.other.example', Connections: '12', Active: 'yes' },
    ]);
    expect(valueOf(options, 'Server4.Host')).toBeUndefined();
  });

  test("a server's monthly limit writes nothing: the worker enforces it at run time", () => {
    const limited = { ...server, limit: { monthlyLimitGb: 50, resetDay: 1 } };
    expect(mergeOwnedOptions(minimal(), { server: limited })).toEqual(mergeOwnedOptions(minimal(), { server }));
  });

  test("with no backup servers the written config is exactly today's", () => {
    // Today's: the full list the first test pins, in NZBGet's order, with no Server2.* and higher.
    const today = mergeOwnedOptions(minimal(), { server });
    expect(mergeOwnedOptions(minimal(), { server, backupServers: [] })).toEqual(today);
    expect(today.options.filter((option) => /^Server([2-9]|\d{2,})\./.test(option.Name))).toEqual([]);
  });

  test("a backup server's options NZBGet added are kept; servers past the last backup are removed", () => {
    const backup: UsenetServer = { host: 'bonus.example', port: 563, ssl: true, username: 'r', password: 'p', connections: 4, level: 1 };
    const current = [
      ...minimal(),
      { Name: 'Server2.Cipher', Value: 'AES' },
      { Name: 'Server2.Host', Value: 'old.example' },
      { Name: 'Server3.Host', Value: 'removed.example' },
    ];
    const { options } = mergeOwnedOptions(current, { server, backupServers: [backup] });
    expect(valueOf(options, 'Server2.Cipher')).toBe('AES');
    expect(valueOf(options, 'Server2.Host')).toBe('bonus.example');
    expect(valueOf(options, 'Server3.Host')).toBeUndefined();
  });

  test('a config that already holds every backup server is unchanged; a removed backup is a change', () => {
    const backup: UsenetServer = { host: 'bonus.example', port: 563, ssl: true, username: 'r', password: 'p', connections: 4, level: 1 };
    const once = mergeOwnedOptions(minimal(), { server, backupServers: [backup] }).options;
    expect(mergeOwnedOptions(once, { server, backupServers: [backup] }).changed).toBe(false);
    const removed = mergeOwnedOptions(once, { server });
    expect(removed.changed).toBe(true);
    expect(removed.options.filter((option) => option.Name.startsWith('Server2.'))).toEqual([]);
  });

  test('the SSL setting maps onto Server1.Encryption', () => {
    expect(valueOf(mergeOwnedOptions(minimal(), { server: { ...server, ssl: false, port: 119 } }).options, 'Server1.Encryption')).toBe('no');
  });

  test('a config that already holds every owned value is unchanged, so nothing is saved', () => {
    const once = mergeOwnedOptions(minimal(), { server }).options;
    expect(mergeOwnedOptions(once, { server })).toEqual({ options: once, changed: false });
  });

  test('a new connection count is a change', () => {
    const once = mergeOwnedOptions(minimal(), { server }).options;
    expect(mergeOwnedOptions(once, { server: { ...server, connections: 20 } }).changed).toBe(true);
  });
});
