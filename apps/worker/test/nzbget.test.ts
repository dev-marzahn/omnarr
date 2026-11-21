// The NZBGet adapter against a fake JSON-RPC server
// that answers as NZBGet 26.3 did (test/fixtures/nzbget/README.md).
import type { DesiredClientConfig, UsenetServer } from '@omnarr/contracts';
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';

import type { FetchedRelease } from '../src/clients/downloadClient.ts';
import { nzbgetClient, periodBytes, type NzbgetClient, type NzbgetGroup } from '../src/clients/nzbget.ts';
import { JobFailure } from '../src/runtime/lease.ts';
import { startFakeNzbget, type FakeNzbget } from './fakes/nzbget.ts';
import { historyEntry, nzbgetFixture, queueEntry, testServerFixture } from './fixtures/nzbget/load.ts';

const CREDENTIALS = { username: 'omnarr', password: 'pl4nted-s3cret' };
const NZB =
  '<?xml version="1.0"?><nzb xmlns="http://www.newzbin.com/DTD/2003/nzb"><file subject="a"><segments><segment number="1">a@b</segment></segments></file></nzb>';
const signal = new AbortController().signal;

let fake: FakeNzbget;
let client: NzbgetClient;

beforeEach(async () => {
  fake = await startFakeNzbget(CREDENTIALS);
  client = nzbgetClient({ url: fake.url, ...CREDENTIALS, reloadPollMs: 5 });
});
afterEach(() => fake.close());

const appends = () => fake.calls.filter((c) => c.method === 'append');
const release = (name = 'Harbour.Lights.S01E02.1080p.WEB-DL.H.264-GRP'): FetchedRelease => ({ kind: 'nzb', name, bytes: new TextEncoder().encode(NZB) });
const submit = (tag = 'grab-1', name?: string) => client.submit(release(name), { correlationTag: tag, category: 'platform-series' }, signal);

describe('submit', () => {
  test('uploads the NZB as content, in the category, tagged, without its duplicate check', async () => {
    const { clientRef } = await client.submit(release(), { correlationTag: 'grab-1', category: 'platform-movies' }, signal);

    expect(fake.queue).toEqual([
      expect.objectContaining({
        NZBID: Number(clientRef),
        Kind: 'NZB',
        Content: NZB,
        Category: 'platform-movies',
        Parameters: [{ Name: 'omnarr', Value: 'grab-1' }],
      }),
    ]);
    // append(NZBFilename, Content, Category, Priority, AddToTop, AddPaused, DupeKey, DupeScore, DupeMode, PPParameters)
    expect(appends()[0]!.params.slice(2)).toEqual(['platform-movies', 0, false, false, '', 0, 'FORCE', [{ omnarr: 'grab-1' }]]);
    expect(appends()[0]!.params[1]).toBe(Buffer.from(NZB).toString('base64'));
  });

  // NZBGet skips its post-unpack renaming for an NZB name it finds "excessively
  // obfuscated", and a Grab ID is.
  test('names the NZB after the release title, so NZBGet deobfuscates; the tag stays in the omnarr parameter', async () => {
    await submit();
    expect(appends()[0]!.params[0]).toBe('Harbour.Lights.S01E02.1080p.WEB-DL.H.264-GRP.nzb');
  });

  test('the NZB name drops characters a file system refuses and is capped in length', async () => {
    await submit('grab-1', ' Show: Part 1/2 "Uncut" <x>|*? \\ ');
    await submit('grab-2', `${'A'.repeat(300)}.mkv`);
    expect(appends().map((call) => call.params[0])).toEqual(['Show Part 12 Uncut x.nzb', `${'A'.repeat(150)}.nzb`]);
  });

  test('without a usable release title, the NZB is named after the tag', async () => {
    await submit('grab-2', ' /:*?. ');
    expect(appends()[0]!.params[0]).toBe('grab-2.nzb');
  });

  test('fails when NZBGet returns no NZBID', async () => {
    fake.appendResult = 0;
    await expect(submit()).rejects.toMatchObject({ code: 'clientUnreachable', detail: 'NZBGet did not accept the NZB (POST /jsonrpc append).' });
  });

  test('a re-claimed submit finds the tagged item and adds nothing', async () => {
    const { clientRef } = await submit();
    expect(await client.findByTag('grab-1', signal)).toMatchObject({ clientRef, correlationTags: ['grab-1'], stage: 'queued' });
    expect(await client.findByTag('grab-2', signal)).toBeNull();
    expect(appends()).toHaveLength(1);
  });

  test('findByTag finds a download that has already finished', async () => {
    fake.history = [historyEntry('grab-ok')];
    expect(await client.findByTag('grab-ok', signal)).toMatchObject({ clientRef: '1', stage: 'completed' });
  });
});

describe('list', () => {
  test('reports a recorded download with its progress and NZBGet status, never a URL', async () => {
    fake.queue = nzbgetFixture<NzbgetGroup>('listgroups-halfway');
    const items = await client.list(signal);
    expect(items[0]).toEqual({
      clientRef: '10',
      correlationTags: ['grab-slow'],
      name: 'slow',
      stage: 'downloading',
      // 2 of 4 articles of 200 000 bytes arrived.
      status: {
        stage: 'DOWNLOADING',
        progress: 0.5,
        doneBytes: 100_000,
        totalBytes: 200_000,
        raw: {
          Kind: 'NZB',
          Status: 'DOWNLOADING',
          ParStatus: 'NONE',
          UnpackStatus: 'NONE',
          MoveStatus: 'NONE',
          DeleteStatus: 'NONE',
          Health: 1000,
          CriticalHealth: 1000,
          FailedArticles: 0,
          TotalArticles: 4,
        },
      },
    });
    expect(items[1]).toMatchObject({ correlationTags: ['grab-slownzb'], stage: 'queued' });
    expect(JSON.stringify(items)).not.toContain('http://');
  });

  test('an uploaded NZB is queued from the start: there is no fetch any more', async () => {
    fake.queue = nzbgetFixture<NzbgetGroup>('listgroups-uploaded');
    expect((await client.list(signal)).map((item) => [item.correlationTags, item.stage])).toEqual([[['grab-uploaded'], 'downloading']]);
  });

  test('progress leaves out paused par files', async () => {
    fake.queue = [{ ...queueEntry('grab-slow'), FileSizeLo: 1_100, RemainingSizeLo: 500, PausedSizeLo: 100 }];
    expect((await client.list(signal))[0]!.status.progress).toBe(0.6);
  });

  // The bytes as progress counts them; the rate is the reconciler's (NZBGet's listgroups has none per item).
  test('the done and total bytes leave out paused par files too, and there is no rate', async () => {
    fake.queue = [{ ...queueEntry('grab-slow'), FileSizeLo: 1_100, RemainingSizeLo: 500, PausedSizeLo: 100 }];
    const { status } = (await client.list(signal))[0]!;
    expect(status).toMatchObject({ doneBytes: 600, totalBytes: 1_000 });
    expect(status.bytesPerSec).toBeUndefined();
  });

  test('sizes past 4 GiB come from the Hi words', async () => {
    fake.queue = [{ ...queueEntry('grab-slow'), FileSizeLo: 0, FileSizeHi: 2, RemainingSizeLo: 0, RemainingSizeHi: 1, PausedSizeLo: 0, PausedSizeHi: 0 }];
    expect((await client.list(signal))[0]!.status).toMatchObject({ doneBytes: 2 ** 32, totalBytes: 2 ** 33 });
  });

  test.each([
    ['QUEUED', 'queued'],
    ['PAUSED', 'queued'],
    ['DOWNLOADING', 'downloading'],
    ['FETCHING', 'downloading'],
    ['PP_QUEUED', 'postProcessing'],
    ['LOADING_PARS', 'postProcessing'],
    ['VERIFYING_SOURCES', 'postProcessing'],
    ['REPAIRING', 'postProcessing'],
    ['VERIFYING_REPAIRED', 'postProcessing'],
    ['RENAMING', 'postProcessing'],
    ['UNPACKING', 'postProcessing'],
    ['MOVING', 'postProcessing'],
    ['EXECUTING_SCRIPT', 'postProcessing'],
    ['PP_FINISHED', 'postProcessing'],
    // No failure is decided from a queue status.
    ['SOMETHING_NEW', 'queued'],
  ])('a queue entry in %s is %s', async (status, stage) => {
    fake.queue = [{ ...queueEntry('grab-slow'), Status: status }];
    expect((await client.list(signal))[0]!.stage).toBe(stage);
  });

  test('a successful history entry is completed, with the folder NZBGet put it in (FinalDir wins)', async () => {
    fake.history = [historyEntry('grab-ok'), { ...historyEntry('grab-unpackok'), FinalDir: '/downloads/moved/unpackok' }];
    expect((await client.list(signal)).map((item) => [item.stage, item.contentPath])).toEqual([
      ['completed', '/downloads/completed/platform-series/ok'],
      ['completed', '/downloads/moved/unpackok'],
    ]);
  });

  test.each([
    ['grab-missing', 'missingArticles'],
    ['grab-parfail', 'parFailed'],
    ['grab-password', 'passwordProtected'],
    ['grab-broken', 'unpackFailed'],
    ['grab-space', 'diskFull'],
    ['grab-markbad', 'releaseFileInvalid'],
    ['grab-bad', 'releaseFileInvalid'],
    ['grab-doesnotexist', 'unknownClientFailure'],
  ])('a history entry tagged %s is failed with %s, and keeps no folder', async (tag, failureCode) => {
    fake.history = [historyEntry(tag)];
    const [item] = await client.list(signal);
    expect(item).toMatchObject({ correlationTags: [tag], stage: 'failed', failureCode });
    expect(item).not.toHaveProperty('contentPath');
  });

  test('a download someone deleted in NZBGet (DELETED/MANUAL) is removed, not failed', async () => {
    fake.history = [historyEntry('grab-parked')];
    const [item] = await client.list(signal);
    expect(item).toMatchObject({ correlationTags: ['grab-parked'], stage: 'removed' });
    expect(item!.failureCode).toBeUndefined();
  });

  test('items the platform did not add have no tags', async () => {
    fake.queue = [{ ...queueEntry('grab-slow'), Parameters: [] }];
    expect((await client.list(signal))[0]!.correlationTags).toEqual([]);
  });
});

describe('remove', () => {
  test('with data, a queued download goes with nothing left in the history', async () => {
    const { clientRef } = await submit();
    expect(await client.remove(clientRef, 'grab-1', true, signal)).toEqual({ removed: true });
    expect(await client.list(signal)).toEqual([]);
  });

  test('without data, a queued download is parked: NZBGet keeps a DELETED/MANUAL record', async () => {
    const { clientRef } = await submit();
    expect(await client.remove(clientRef, undefined, false, signal)).toEqual({ removed: true });
    expect(await client.list(signal)).toEqual([expect.objectContaining({ clientRef, stage: 'removed' })]);
  });

  test.each([true, false])('a history entry goes either way (deleteData %s)', async (deleteData) => {
    fake.history = [historyEntry('grab-ok'), historyEntry('grab-missing')];
    expect(await client.remove('3', undefined, deleteData, signal)).toEqual({ removed: true });
    expect((await client.list(signal)).map((i) => i.correlationTags)).toEqual([['grab-ok']]);
  });

  test.each(['999', 'not-an-id'])('an item NZBGet does not hold (%s) removes nothing', async (clientRef) => {
    fake.history = [historyEntry('grab-ok')];
    expect(await client.remove(clientRef, undefined, true, signal)).toEqual({ removed: false });
    expect(fake.calls.filter((c) => c.method === 'editqueue')).toEqual([]);
  });
});

describe("enforceLimits: a server's monthly limit", () => {
  const main: UsenetServer = { host: 'nntp', port: 119, ssl: false, username: 'r', password: 'p', connections: 4, level: 0 };
  const backup: UsenetServer = { ...main, host: 'bonus.example', level: 1, id: 'b1' };
  const day = (iso: string) => Math.floor(Date.parse(iso) / 86_400_000);
  const GB = 1e9;
  const now = Date.parse('2026-11-19T12:00:00Z');
  const active = () => fake.calls.filter((call) => call.method === 'editserver').map((call) => call.params);
  const configure = async (server: UsenetServer, backupServers: UsenetServer[] = []) =>
    client.applyConfig({ kind: 'nzbget', clientId: 'c1' as never, enabled: true, configVersion: 1, nzbget: { server, backupServers } }, signal);

  test('a server whose period reached its limit is paused at run time; its usage is reported', async () => {
    const limited = { ...backup, limit: { monthlyLimitGb: 10, resetDay: 15 } };
    await configure(main, [limited]);
    // Nov 10 is before the period (from Nov 15); Nov 15 and Nov 19 count: 4 + 6 = 10 GB.
    fake.volumes[2] = { firstDay: day('2026-11-10T00:00:00Z'), days: [50 * GB, 0, 0, 0, 0, 4 * GB, 0, 0, 0, 6 * GB] };
    const usage = await client.enforceLimits({ server: main, backupServers: [limited] }, now, signal);
    expect(usage).toEqual([{ backupId: 'b1', usedBytes: 10 * GB, limitReached: true }]);
    expect(active()).toEqual([[2, false]]);
    expect(fake.serverActive.get(2)).toBe(false);
    // Already paused: nothing more to do.
    await client.enforceLimits({ server: main, backupServers: [limited] }, now, signal);
    expect(active()).toEqual([[2, false]]);
  });

  test('a paused server is resumed when the next period starts', async () => {
    const limited = { ...backup, limit: { monthlyLimitGb: 10, resetDay: 19 } };
    await configure(main, [limited]);
    fake.serverActive.set(2, false);
    // 12 GB on Nov 18, the last day of the previous period; nothing yet on Nov 19.
    fake.volumes[2] = { firstDay: day('2026-11-18T00:00:00Z'), days: [12 * GB, 0] };
    expect(await client.enforceLimits({ server: main, backupServers: [limited] }, now, signal)).toEqual([
      { backupId: 'b1', usedBytes: 0, limitReached: false },
    ]);
    expect(active()).toEqual([[2, true]]);
  });

  test("the author's setup: only the limited Bonus server (Server3) pauses; the main server and the other region keep running", async () => {
    const local = { ...main, host: 'news.local.example', connections: 75 };
    const region = { ...main, host: 'news.region.example', connections: 30, level: 1, id: 'region' };
    const bonus = { ...main, host: 'bonus.other.example', connections: 12, level: 2, id: 'bonus', limit: { monthlyLimitGb: 50, resetDay: 1 } };
    const servers = { server: local, backupServers: [region, bonus] };
    await configure(local, [region, bonus]);
    const today = day('2026-11-19T00:00:00Z');
    // The main server and the region carry far more than 50 GB; they have no limit.
    fake.volumes[1] = { firstDay: today, days: [400 * GB] };
    fake.volumes[2] = { firstDay: today, days: [120 * GB] };
    fake.volumes[3] = { firstDay: today, days: [51 * GB] };
    expect(await client.enforceLimits(servers, now, signal)).toEqual([{ backupId: 'bonus', usedBytes: 51 * GB, limitReached: true }]);
    expect(active()).toEqual([[3, false]]);
    const running = (await fetch(`${fake.url}/jsonrpc`, {
      method: 'POST',
      headers: { authorization: `Basic ${Buffer.from(`${CREDENTIALS.username}:${CREDENTIALS.password}`).toString('base64')}` },
      body: JSON.stringify({ method: 'status', params: [], id: 1 }),
    }).then((r) => r.json())) as { result: { NewsServers: { ID: number; Active: boolean }[] } };
    expect(running.result.NewsServers).toEqual([
      { ID: 1, Active: true },
      { ID: 2, Active: true },
      { ID: 3, Active: false },
    ]);
    // Dec 1 starts the Bonus server's next period: it runs again.
    expect(await client.enforceLimits(servers, Date.parse('2026-12-01T00:05:00Z'), signal)).toEqual([{ backupId: 'bonus', usedBytes: 0, limitReached: false }]);
    expect(active()).toEqual([
      [3, false],
      [3, true],
    ]);
  });

  test('a server without a limit is left alone, even when NZBGet has it paused, and reports nothing', async () => {
    await configure(main, [backup]);
    fake.serverActive.set(2, false);
    fake.volumes[1] = { firstDay: day('2026-11-19T00:00:00Z'), days: [900 * GB] };
    expect(await client.enforceLimits({ server: main, backupServers: [backup] }, now, signal)).toEqual([]);
    expect(active()).toEqual([]);
    // No limit anywhere: not even the stats are read.
    expect(fake.calls.map((call) => call.method)).not.toContain('servervolumes');
  });
});

describe('periodBytes', () => {
  const GB = 1e9;
  const volume = (firstDay: number, days: number[]) => ({
    FirstDay: firstDay,
    BytesPerDays: days.map((bytes) => ({ SizeLo: bytes % 2 ** 32, SizeHi: Math.floor(bytes / 2 ** 32) })),
  });
  test("sums NZBGet's 64-bit day counters from the period's first day; days before it don't count", () => {
    const start = Date.parse('2026-11-15T00:00:00Z');
    const first = Math.floor(Date.parse('2026-11-13T00:00:00Z') / 86_400_000);
    expect(periodBytes(volume(first, [7 * GB, 7 * GB, 5 * GB, 0, 2 * GB]), start)).toBe(7 * GB);
  });
  test('stats that start inside the period all count; none is 0', () => {
    const start = Date.parse('2026-11-01T00:00:00Z');
    expect(periodBytes(volume(Math.floor(Date.parse('2026-11-18T00:00:00Z') / 86_400_000), [3 * GB, 1]), start)).toBe(3 * GB + 1);
    expect(periodBytes(undefined, start)).toBe(0);
  });
});

describe('applyConfig', () => {
  const server: UsenetServer = { host: 'nntp', port: 119, ssl: false, username: 'reader', password: 'pl4nted-provider', connections: 4, level: 0 };
  const desired = (overrides: Partial<UsenetServer> = {}): DesiredClientConfig => ({
    kind: 'nzbget',
    clientId: 'c1' as never,
    enabled: true,
    configVersion: 1,
    nzbget: { server: { ...server, ...overrides } },
  });
  const valueOf = (name: string) => fake.config.find((option) => option.Name === name)?.Value;

  test("reads the file, saves the whole list with the platform's options, reloads, and waits for the restarted NZBGet", async () => {
    fake.reloadDownMs = 30;
    expect(await client.applyConfig(desired(), signal)).toEqual({ applied: true, changed: true, clientVersion: '26.3' });
    const methods = fake.calls.map((call) => call.method);
    expect(methods.filter((method) => ['loadconfig', 'saveconfig', 'reload'].includes(method))).toEqual(['loadconfig', 'saveconfig', 'reload']);
    // NZBGet's old instance answers for a moment after `reload`: only a new uptime shows the restart (fixtures README).
    expect(methods.slice(methods.indexOf('reload') + 1)).toContain('status');
    expect(fake.reloads).toBe(1);
    expect(valueOf('Server1.Host')).toBe('nntp');
    expect(valueOf('MainDir')).toBe('/data/downloads/usenet');
    // The setup container's control login is written back as it was read.
    expect(valueOf('ControlPassword')).toBe('fixture-control-password');
  });

  test('an apply that finds nothing different writes nothing and does not reload', async () => {
    await client.applyConfig(desired(), signal);
    fake.calls = [];
    expect(await client.applyConfig(desired(), signal)).toEqual({ applied: true, changed: false, clientVersion: '26.3' });
    // `status` finds no server paused at run time, so nothing is resumed.
    expect(fake.calls.map((call) => call.method)).toEqual(['loadconfig', 'status', 'version']);
    expect(fake.reloads).toBe(1);
  });

  test('an apply resumes a server paused at run time, though the file is unchanged: a removed limit leaves nothing paused', async () => {
    await client.applyConfig(desired(), signal);
    fake.serverActive.set(1, false);
    fake.calls = [];
    expect(await client.applyConfig(desired(), signal)).toEqual({ applied: true, changed: false, clientVersion: '26.3' });
    expect(fake.calls.filter((call) => call.method === 'editserver').map((call) => call.params)).toEqual([[1, true]]);
    expect(fake.serverActive.get(1)).toBe(true);
    expect(fake.reloads).toBe(1);
  });

  test('a changed provider is saved again', async () => {
    await client.applyConfig(desired(), signal);
    await client.applyConfig(desired({ connections: 20 }), signal);
    expect(valueOf('Server1.Connections')).toBe('20');
    expect(fake.reloads).toBe(2);
  });

  test("the desired config's backup servers are saved as Server2 and up at Level 1", async () => {
    const backup: UsenetServer = { ...server, host: 'bonus.example', password: 'pl4nted-backup', level: 1, id: 'b1' };
    await client.applyConfig({ ...desired(), nzbget: { server, backupServers: [backup] } }, signal);
    expect([valueOf('Server1.Level'), valueOf('Server2.Host'), valueOf('Server2.Level'), valueOf('Server2.Optional')]).toEqual([
      '0',
      'bonus.example',
      '1',
      'yes',
    ]);
  });

  test('a desired config without a provider is refused, and nothing is written', async () => {
    await expect(client.applyConfig({ ...desired(), nzbget: undefined }, signal)).rejects.toMatchObject({ code: 'pipelineError' });
    expect(fake.calls).toEqual([]);
  });

  test('an NZBGet that does not come back within the wait is clientUnreachable', async () => {
    fake.reloadDownMs = 10_000;
    const quick = nzbgetClient({ url: fake.url, ...CREDENTIALS, reloadPollMs: 5, reloadWaitMs: 50 });
    await expect(quick.applyConfig(desired(), signal)).rejects.toMatchObject({
      code: 'clientUnreachable',
      detail: 'NZBGet did not come back after reloading its config (POST /jsonrpc reload).',
    });
  });

  test('a saveconfig NZBGet refuses is a pipelineError, and nothing is reloaded', async () => {
    fake.rpcErrors = { saveconfig: { code: 2, message: 'disk' } };
    await expect(client.applyConfig(desired(), signal)).rejects.toMatchObject({ code: 'pipelineError' });
    expect(fake.reloads).toBe(0);
  });
});

describe('testServer', () => {
  const recorded = testServerFixture();
  const input = { host: 'news.example', port: 563, ssl: true, username: 'reader', password: 'pl4nted-provider' };

  test('calls testserver with strict certificate checks and a 15 s timeout', async () => {
    await client.testServer(input, signal);
    expect(fake.calls).toEqual([{ method: 'testserver', params: ['news.example', 563, 'reader', 'pl4nted-provider', true, '', 15, 2] }]);
  });

  test.each([
    ['ok', 'ok'],
    ['authRejected', 'authRejected'],
    ['unreachable', 'failed'],
  ] as const)("NZBGet 26.3's %s answer is %s", async (recording, outcome) => {
    fake.testServerResult = recorded[recording];
    expect(await client.testServer(input, signal)).toBe(outcome);
  });

  test.each([
    ['482 Authentication commands issued out of sequence', 'authRejected'],
    ['Authorization for test server (x) failed: 502 Permission denied', 'authRejected'],
    ['Could not resolve hostname news.example: Error -2 - Name does not resolve', 'failed'],
    ['Unknown error', 'failed'],
  ])('%s is %s', async (text, outcome) => {
    fake.testServerResult = text;
    expect(await client.testServer(input, signal)).toBe(outcome);
  });
});

test('status says NZBGet answers, with its version', async () => {
  expect(await client.status(signal)).toEqual({ reachable: true, version: '26.3' });
  await fake.close();
  expect(await client.status(signal)).toEqual({ reachable: false });
  fake = await startFakeNzbget(CREDENTIALS);
});

describe('errors', () => {
  /** Expects a JobFailure whose detail holds none of the planted secrets nor NZBGet's own text. */
  async function expectFailure(promise: Promise<unknown>, code: string, detail: string) {
    const error = await promise.then(
      () => expect.fail('expected a failure'),
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(JobFailure);
    expect(error).toMatchObject({ code, detail });
    for (const secret of [fake.url, '127.0.0.1', CREDENTIALS.password, 'pl4nted', 'Invalid']) expect((error as JobFailure).message).not.toContain(secret);
  }

  test('an unreachable NZBGet is clientUnreachable', async () => {
    await fake.close();
    await expectFailure(submit(), 'clientUnreachable', 'NZBGet did not answer (POST /jsonrpc append).');
    fake = await startFakeNzbget(CREDENTIALS);
  });

  test('wrong credentials are clientUnreachable, naming the control username or password', async () => {
    client = nzbgetClient({ url: fake.url, username: 'omnarr', password: 'wrong-pl4nted' });
    await expectFailure(submit(), 'clientUnreachable', 'NZBGet rejected the control username or password (POST /jsonrpc append).');
  });

  test('another HTTP error is clientUnreachable with its status', async () => {
    fake.httpStatus = 502;
    await expectFailure(submit(), 'clientUnreachable', 'NZBGet answered HTTP 502 (POST /jsonrpc append).');
  });

  test("a JSON-RPC error is a pipelineError that leaves out NZBGet's message", async () => {
    fake.rpcErrors = { append: { code: 2, message: 'Invalid parameter pl4nted-k3y' } };
    await expectFailure(submit(), 'pipelineError', 'NZBGet refused append with JSON-RPC error 2 (POST /jsonrpc).');
  });

  test('a body that is not JSON-RPC is clientUnreachable', async () => {
    fake.rawBody = '<html>pl4nted proxy page</html>';
    await expectFailure(submit(), 'clientUnreachable', 'NZBGet sent an answer that is not JSON-RPC (POST /jsonrpc append).');
  });

  test('an NZBGet that answers too late is clientUnreachable', async () => {
    fake.delayMs = 200;
    client = nzbgetClient({ url: fake.url, ...CREDENTIALS, timeoutMs: 20 });
    await expectFailure(submit(), 'clientUnreachable', 'NZBGet did not answer in time (POST /jsonrpc append).');
  });

  test("a cancelled job's call ends with the abort, not a JobFailure", async () => {
    fake.delayMs = 200;
    const controller = new AbortController();
    const pending = client.list(controller.signal);
    controller.abort('cancelled');
    await expect(pending).rejects.toBe('cancelled');
  });
});
