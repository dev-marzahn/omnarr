// Jellyfin's setup and connection in the backend:
// startSetup, the setup job's result and failures, the publish wait, the
// worker's connection, the admin's status and re-run.
import {
  DEFAULT_LIMITS,
  JellyfinConnection,
  JellyfinStatus,
  type JobResult,
  SetupStep,
  SystemStatus,
  type TargetReading,
  Timeline,
  UnitRow,
} from '@omnarr/contracts';
import { hashPassword } from 'better-auth/crypto';
import { afterEach, beforeEach, describe, expect, test } from 'vite-plus/test';

import { api, components, internal } from '../convex/_generated/api';
import { enqueueJob } from '../convex/jobs/queue';
import type { FakeWorker } from './fakeWorker';
import { E1_RELEASES, pipelineHarness } from './harness';
import { capabilities, worker } from './setup';

const h = pipelineHarness();
let w: FakeWorker;

beforeEach(async () => {
  w = await h.worker();
});
afterEach(() => {
  delete process.env.JELLYFIN_OFFLINE_LIBRARIES;
});

const PASSWORD = 'pl4nted-admin-password';
const startSetup = () => h.t.mutation(internal.jellyfin.setup.startSetup, { username: 'admin', password: PASSWORD, locale: 'de-DE' });
const server = () => h.t.run((ctx) => ctx.db.query('jellyfinServer').first());
const jobs = () => h.all('jobs');
const openIssues = async () => (await h.all('issues')).filter((i) => i.state === 'open');

describe('startSetup (firstRun)', () => {
  test('inserts the jellyfinServer row with the locale and the owner, and enqueues setupJellyfin', async () => {
    await startSetup();
    const row = await server();
    expect(row).toMatchObject({
      state: 'settingUp',
      locale: { uiCulture: 'de-DE', metadataCountry: 'DE', metadataLanguage: 'de' },
      libraries: [],
      steps: [
        { step: 'reachable', state: 'pending' },
        { step: 'wizard', state: 'pending' },
        { step: 'apiKey', state: 'pending' },
        { step: 'libraries', state: 'pending' },
        { step: 'testRefresh', state: 'pending' },
      ],
    });
    expect(row!.ownerUserId).toEqual(expect.any(String));
    const [job] = await jobs();
    expect(job).toMatchObject({ class: 'maintenance', status: 'queued', idempotencyKey: 'setupJellyfin:firstRun' });
    expect(job!.payload).toEqual({
      class: 'maintenance',
      action: 'setupJellyfin',
      mode: 'firstRun',
      admin: { username: 'admin', password: PASSWORD },
      locale: { uiCulture: 'de-DE', metadataCountry: 'DE', metadataLanguage: 'de' },
      libraries: [
        { libraryId: h.libraries.series, name: 'Series', kind: 'series', rootPath: '/data/library/series' },
        { libraryId: h.libraries.movies, name: 'Movies', kind: 'movies', rootPath: '/data/library/movies' },
      ],
      remoteAccess: true,
    });
  });

  test('a second call changes nothing', async () => {
    await startSetup();
    await startSetup();
    expect(await jobs()).toHaveLength(1);
    expect(await h.all('jellyfinServer')).toHaveLength(1);
  });

  test('JELLYFIN_OFFLINE_LIBRARIES makes the libraries offline (tests only)', async () => {
    process.env.JELLYFIN_OFFLINE_LIBRARIES = '1';
    await startSetup();
    expect((await jobs())[0]!.payload).toMatchObject({ offline: true });
  });
});

/** The setup job's result as the worker reports it, with every step done. */
const setupResult = (extra: Partial<Extract<JobResult, { action: 'setupJellyfin' }>> = {}): JobResult => ({
  class: 'maintenance',
  action: 'setupJellyfin',
  serverId: 'srv1',
  version: '12.4.0',
  adminUserId: 'jf-admin',
  apiKey: 'pl4nted-api-key',
  libraries: [
    { libraryId: h.libraries.series, itemId: 'lib-series' },
    { libraryId: h.libraries.movies, itemId: 'lib-movies' },
  ],
  steps: SetupStep.options.map((step) => ({ step, state: 'done' as const, at: 1 })),
  ...extra,
});

async function completeSetup(result = setupResult()) {
  const [job] = (await w.claim('maintenance')).filter((j) => j.payload.class === 'maintenance' && j.payload.action === 'setupJellyfin');
  await w.complete(job!, result);
}

describe('a successful setup', () => {
  test('stores the key, the libraries and ready, and clears the password with the payload', async () => {
    await startSetup();
    await completeSetup();
    expect(await server()).toMatchObject({
      state: 'ready',
      serverId: 'srv1',
      version: '12.4.0',
      adminUserId: 'jf-admin',
      apiKey: 'pl4nted-api-key',
      libraries: [
        { libraryId: h.libraries.series, itemId: 'lib-series' },
        { libraryId: h.libraries.movies, itemId: 'lib-movies' },
      ],
      lastSetupAt: expect.any(Number),
    });
    expect((await server())!.steps.every((s) => s.state === 'done')).toBe(true);
    expect((await jobs())[0]!.payload).toBeUndefined();
  });

  test('wakes the publish jobs that wait for setup; the episode becomes visible', async () => {
    const job = await toLeasedPublish();
    await w.fail(job, 'jellyfinSetupNeeded', 'Jellyfin is not set up yet.');
    await startSetup();
    await completeSetup();
    expect(await h.get(job.jobId)).toMatchObject({ status: 'queued' });

    await w.publishAll();
    await h.settle();
    expect((await h.all('publications'))[0]!.state).toBe('visible');
    expect((await h.all('grabs'))[0]!.state).toBe('done');
  });

  test("a publish that fails as not set up after setup is done (the worker's connection not updated yet) retries after the backoff, not 30 minutes", async () => {
    await startSetup();
    await completeSetup();
    const job = await toLeasedPublish();
    await w.fail(job, 'jellyfinSetupNeeded', "Jellyfin isn't set up yet.");
    const row = await h.get(job.jobId);
    expect(row).toMatchObject({ status: 'waiting', attempt: 0, failureCode: 'jellyfinSetupNeeded' });
    expect(row!.availableAt! - Date.now()).toBeLessThanOrEqual(DEFAULT_LIMITS.backoffBaseMs);
    expect((await server())!.state).toBe('ready');
  });
});

const setupJob = async () => (await w.claim('maintenance')).find((j) => j.payload.class === 'maintenance' && j.payload.action === 'setupJellyfin')!;
const stepOf = async (step: string) => (await server())!.steps.find((s) => s.step === step);
const requeueWaiting = () =>
  h.t.run(async (ctx) => {
    for (const row of await ctx.db.query('jobs').collect())
      if (row.status === 'waiting') await ctx.db.patch(row._id, { status: 'queued', availableAt: undefined });
  });

describe('a setup that fails terminally', () => {
  test('credentialsNeeded is terminal at once: the step fails with its reason, Jellyfin is blocked, one Issue tells the user to remove the config volume', async () => {
    await startSetup();
    const job = await setupJob();
    await w.fail(job, 'jellyfinSetupNeeded', 'Jellyfin refused the admin sign-in (POST /Users/AuthenticateByName).', {
      reason: 'credentialsNeeded',
      step: 'apiKey',
    });

    expect(await h.get(job.jobId)).toMatchObject({ status: 'failed', failureCode: 'jellyfinSetupNeeded' });
    expect(await server()).toMatchObject({ state: 'blocked' });
    expect(await stepOf('reachable')).toMatchObject({ state: 'done' });
    expect(await stepOf('wizard')).toMatchObject({ state: 'done' });
    expect(await stepOf('apiKey')).toMatchObject({ state: 'failed', reason: 'credentialsNeeded', at: expect.any(Number) });
    expect(await stepOf('libraries')).toMatchObject({ state: 'pending' });
    const issues = await openIssues();
    expect(issues).toEqual([expect.objectContaining({ failureCode: 'jellyfinSetupNeeded', scope: 'system', fixActions: ['rerunJellyfinSetup'] })]);
    expect(issues[0]!.detail).toContain('credentialsNeeded');
    expect(issues[0]!.detail).toContain("remove Jellyfin's config volume");
  });

  test('an unreachable Jellyfin is retried, and after the last attempt is setupFailed at its step', async () => {
    await startSetup();
    for (let attempt = 0; attempt < 3; attempt++) {
      const job = await setupJob();
      await w.fail(job, 'jellyfinUnavailable', 'Jellyfin did not answer (GET /System/Info/Public).', { reason: 'setupFailed', step: 'reachable' });
      if (attempt < 2) expect(await openIssues()).toEqual([]);
      await requeueWaiting();
    }
    expect(await server()).toMatchObject({ state: 'blocked' });
    expect(await stepOf('reachable')).toMatchObject({ state: 'failed', reason: 'setupFailed' });
    expect((await openIssues()).map((i) => i.failureCode)).toEqual(['jellyfinSetupNeeded']);
  });

  test('a lease that expires on the last attempt is setupFailed at the step the job last reported', async () => {
    await startSetup();
    const job = await setupJob();
    await h.t.mutation(api.jobs.queue.progress, { ...worker, jobId: job.jobId, leaseEpoch: job.leaseEpoch, fraction: 0.4, detail: 'libraries:pending' });
    await h.t.run(async (ctx) => {
      await ctx.db.patch(job.jobId, { attempt: 2, leaseExpiresAt: Date.now() - 1 });
    });
    await h.t.mutation(internal.jobs.queue.supervise, {});
    expect(await server()).toMatchObject({ state: 'blocked' });
    expect(await stepOf('libraries')).toMatchObject({ state: 'failed', reason: 'setupFailed' });
    expect((await openIssues()).map((i) => i.failureCode)).toContain('jellyfinSetupNeeded');
  });
});

describe('a publish that finds Jellyfin unusable (blockFromPublish)', () => {
  test.each(['keyRejected', 'libraryMissing'] as const)('%s while ready blocks publishing with one Issue, and the job waits', async (reason) => {
    await startSetup();
    await completeSetup();
    const job = await toLeasedPublish();
    await w.fail(job, 'jellyfinSetupNeeded', 'Jellyfin refused the API key (POST /Items/x/Refresh).', { reason });

    expect(await server()).toMatchObject({ state: 'blocked' });
    expect(await h.get(job.jobId)).toMatchObject({ status: 'waiting', attempt: 0 });
    const issues = await openIssues();
    expect(issues).toEqual([expect.objectContaining({ failureCode: 'jellyfinSetupNeeded' })]);
    expect(issues[0]!.detail).toContain(reason);
  });

  test('while not ready, the job only waits: no state change and no Issue', async () => {
    await startSetup();
    const job = await toLeasedPublish();
    await w.fail(job, 'jellyfinSetupNeeded', 'Jellyfin refused the API key (POST /Items/x/Refresh).', { reason: 'keyRejected' });
    expect(await server()).toMatchObject({ state: 'settingUp' });
    expect(await openIssues()).toEqual([]);
  });

  test('data sent with another job is ignored', async () => {
    await startSetup();
    await completeSetup();
    await h.t.mutation(internal.jobs.queue.enqueue, {
      payload: { class: 'maintenance', action: 'cleanStaging', paths: ['/x'] },
      idempotencyKey: 'cleanStaging:x',
    });
    const job = (await w.claim('maintenance')).find((j) => j.payload.class === 'maintenance' && j.payload.action === 'cleanStaging')!;
    await w.fail(job, 'clientUnreachable', 'x', { reason: 'keyRejected' });
    expect(await server()).toMatchObject({ state: 'ready' });
  });
});

describe('jellyfin.setup.connection', () => {
  const connection = () => h.t.query(api.jellyfin.setup.connection, { ...worker, sessionId: w.sessionId });

  test('is null before startSetup, then the state without a key, then the key and the libraries once ready', async () => {
    expect(await connection()).toBeNull();
    await startSetup();
    expect(await connection()).toEqual({ state: 'settingUp', libraries: [] });
    await completeSetup();
    expect(await connection()).toEqual({
      state: 'ready',
      apiKey: 'pl4nted-api-key',
      adminUserId: 'jf-admin',
      libraries: [
        { libraryId: h.libraries.series, itemId: 'lib-series' },
        { libraryId: h.libraries.movies, itemId: 'lib-movies' },
      ],
    });
  });

  test('refuses an admin session and a session the handshake did not accept', async () => {
    await startSetup();
    await expect(h.admin.query(api.jellyfin.setup.connection, { sessionId: w.sessionId } as never)).rejects.toThrow();
    await h.t.mutation(api.jobs.worker.connect, { ...worker, protocolVersion: 0, workerId: 'old', capabilities });
    const old = (await h.all('workerSessions')).find((s) => !s.accepted)!;
    await expect(h.t.query(api.jellyfin.setup.connection, { ...worker, sessionId: old._id })).rejects.toThrow(/sessionNotAccepted/);
  });
});

describe('api.jellyfin.status', () => {
  const status = () => h.admin.query(api.api.jellyfin.status, {});

  test('is notSetUp before startSetup', async () => {
    expect(await status()).toEqual({ state: 'notSetUp', steps: [], pinned: false, libraries: [] });
  });

  test("merges the running setup job's progress into the steps", async () => {
    await startSetup();
    const job = await setupJob();
    await h.t.mutation(api.jobs.queue.progress, { ...worker, jobId: job.jobId, leaseEpoch: job.leaseEpoch, fraction: 0.6, detail: 'apiKey:done' });
    expect((await status()).steps.map((s) => [s.step, s.state])).toEqual([
      ['reachable', 'done'],
      ['wizard', 'done'],
      ['apiKey', 'done'],
      ['libraries', 'pending'],
      ['testRefresh', 'pending'],
    ]);
  });

  test('once ready: the version, whether it is the pinned release, the library names and the last setup, and never the key', async () => {
    await startSetup();
    await completeSetup();
    const result = await status();
    expect(result).toMatchObject({ state: 'ready', version: '12.4.0', pinned: true, libraries: ['Series', 'Movies'], lastSetupAt: expect.any(Number) });
    expect(JSON.stringify(result)).not.toContain('pl4nted');
    expect(Object.keys(result)).not.toContain('apiKey');
  });

  test('another release is not the pinned one', async () => {
    await startSetup();
    await completeSetup(setupResult({ version: '12.5.0' }));
    expect(await status()).toMatchObject({ version: '12.5.0', pinned: false });
  });

  test('needs an admin', async () => {
    await expect(h.t.query(api.api.jellyfin.status, {})).rejects.toThrow();
  });
});

describe('api.jellyfin.rerunSetup', () => {
  /** The admin's credential: Better Auth's account row with the hashed password, as the first run writes it. */
  async function givePassword(password = PASSWORD) {
    const hash = await hashPassword(password);
    await h.t.run(async (ctx) => {
      const user = (await ctx.runQuery(components.betterAuth.adapter.findOne, { model: 'user', where: [{ field: 'username', value: 'admin' }] } as never)) as {
        _id: string;
      };
      const now = Date.now();
      await ctx.runMutation(components.betterAuth.adapter.create, {
        input: { model: 'account', data: { accountId: user._id, providerId: 'credential', userId: user._id, password: hash, createdAt: now, updatedAt: now } },
      } as never);
    });
  }
  const rerun = (password = PASSWORD) => h.admin.action(api.api.jellyfin.rerunSetup, { password });
  const sessions = () =>
    h.t.run((ctx) =>
      ctx.runQuery(components.betterAuth.adapter.findMany, { model: 'session', paginationOpts: { cursor: null, numItems: 100 } } as never),
    ) as Promise<{ page: unknown[] }>;

  beforeEach(() => {
    process.env.BETTER_AUTH_SECRET = 'test-better-auth-secret-0123456789abcdef';
  });

  test('a wrong password is wrongPassword, and enqueues nothing', async () => {
    await givePassword();
    await startSetup();
    await failSetupWith('credentialsNeeded');
    expect(await rerun('not-the-password')).toEqual({ error: 'wrongPassword' });
    expect((await jobs()).filter((j) => j.status === 'queued')).toEqual([]);
  });

  test('while a setup job is queued, waiting or leased it is alreadyRunning', async () => {
    await givePassword();
    await startSetup();
    expect(await rerun()).toEqual({ error: 'alreadyRunning' });
  });

  test("a blocked Jellyfin gets a setupJellyfin re-run with the stored locale; the password check's session is revoked", async () => {
    await givePassword();
    await startSetup();
    await failSetupWith('credentialsNeeded');
    const before = (await sessions()).page.length;
    expect(await rerun()).toEqual({ ok: true });
    expect((await sessions()).page.length).toBe(before);

    const job = (await jobs()).find((j) => j.status === 'queued')!;
    expect(job.idempotencyKey).toMatch(/^setupJellyfin:rerun:/);
    expect(job.payload).toMatchObject({
      action: 'setupJellyfin',
      mode: 'rerun',
      admin: { username: 'admin', password: PASSWORD },
      locale: { uiCulture: 'de-DE', metadataCountry: 'DE', metadataLanguage: 'de' },
    });
  });

  test('a ready Jellyfin with an open jellyfinPasswordNotPushed gets a password push instead', async () => {
    await givePassword();
    await startSetup();
    await completeSetup();
    await h.t.mutation(internal.jobs.queue.enqueuePasswordPush, { userId: 'u', username: 'admin', newPassword: 'p2' });
    const [push] = (await w.claim('maintenance')).filter((j) => j.payload.class === 'maintenance' && j.payload.action === 'pushJellyfinPassword');
    await w.fail(push!, 'jellyfinPasswordNotPushed', 'Jellyfin refused the API key (POST /Users/Password).');

    expect(await rerun()).toEqual({ ok: true });
    const queued = (await jobs()).filter((j) => j.status === 'queued');
    expect(queued).toEqual([
      expect.objectContaining({ payload: { class: 'maintenance', action: 'pushJellyfinPassword', username: 'admin', newPassword: PASSWORD } }),
    ]);
  });
});

describe('"Open in Jellyfin": jellyfinItemPath', () => {
  async function published() {
    await startSetup();
    await completeSetup();
    await toLeasedPublish().then((job) =>
      w.complete(job, {
        class: 'publish',
        targetItemRefs: Object.fromEntries((job.payload.class === 'publish' ? job.payload.publicationIds : []).map((id) => [id, 'jf-item-1'])),
      }),
    );
    await h.settle();
    return (await h.all('units')).find((u) => u.tmdbSeason === 1 && u.tmdbEpisode === 1)!;
  }

  test("links the primary version's visible Publication, on the item page and the Work page", async () => {
    const unit = await published();
    const path = '/web/#/details?id=jf-item-1&serverId=srv1';
    expect(await h.admin.query(api.api.units.timeline, { unitId: unit._id })).toMatchObject({ jellyfinItemPath: path });
    const detail = await h.admin.query(api.api.library.detail, { workId: unit.workId });
    expect(detail!.units.find((row) => row.unitId === unit._id)).toMatchObject({ jellyfinItemPath: path });
  });

  test("the series' own item, from the publish result, on the Work page", async () => {
    await startSetup();
    await completeSetup();
    const job = await toLeasedPublish();
    const ids = job.payload.class === 'publish' ? job.payload.publicationIds : [];
    const unitOf = async () => (await h.all('units')).find((u) => u.tmdbSeason === 1 && u.tmdbEpisode === 1)!;
    expect((await h.admin.query(api.api.library.detail, { workId: (await unitOf()).workId }))!.work).not.toHaveProperty('jellyfinItemPath');
    await w.complete(job, {
      class: 'publish',
      targetItemRefs: Object.fromEntries(ids.map((id) => [id, 'jf-item-1'])),
      seriesItemRefs: Object.fromEntries(ids.map((id) => [id, 'jf-series-1'])),
    });
    await h.settle();
    const unit = await unitOf();
    expect((await h.get(unit.workId))?.jellyfinItemRef).toBe('jf-series-1');
    expect((await h.admin.query(api.api.library.detail, { workId: unit.workId }))!.work).toMatchObject({
      jellyfinItemPath: '/web/#/details?id=jf-series-1&serverId=srv1',
    });
  });

  test('is absent while the Publication is pending', async () => {
    await startSetup();
    await completeSetup();
    await toLeasedPublish();
    const unit = (await h.all('units')).find((u) => u.tmdbSeason === 1 && u.tmdbEpisode === 1)!;
    expect(await h.admin.query(api.api.units.timeline, { unitId: unit._id })).not.toHaveProperty('jellyfinItemPath');
  });

  test("is absent for a version that isn't the primary", async () => {
    const unit = await published();
    await h.t.run(async (ctx) => {
      for (const version of await ctx.db.query('fileVersions').collect()) await ctx.db.patch(version._id, { kind: 'original' });
    });
    expect(await h.admin.query(api.api.units.timeline, { unitId: unit._id })).not.toHaveProperty('jellyfinItemPath');
  });
});

describe('system.status', () => {
  test('carries the Jellyfin status, without the key', async () => {
    await startSetup();
    await completeSetup();
    const status = await h.admin.query(api.api.system.status, {});
    expect(status.jellyfin).toMatchObject({ state: 'ready', version: '12.4.0', pinned: true });
    expect(JSON.stringify(status)).not.toContain('pl4nted');
  });
});

describe("the Jellyfin module's public functions", () => {
  test('each is built from a wrapper with a returns schema', async () => {
    const apiJellyfin = await import('../convex/api/jellyfin');
    const setupModule = await import('../convex/jellyfin/setup');
    expect((apiJellyfin.status as unknown as { __wrapped: string }).__wrapped).toBe('adminQuery');
    expect((apiJellyfin.rerunSetup as unknown as { __wrapped: string }).__wrapped).toBe('adminAction');
    expect((setupModule.connection as unknown as { __wrapped: string }).__wrapped).toBe('workerQuery');
  });

  test('no DTO has an apiKey field; only the worker connection carries the key', () => {
    for (const dto of [JellyfinStatus, SystemStatus, UnitRow, Timeline]) expect(Object.keys(dto.shape)).not.toContain('apiKey');
    expect(Object.keys(JellyfinConnection.shape)).toContain('apiKey');
  });
});

/** Fails the queued setup job terminally with a reason. */
async function failSetupWith(reason: 'credentialsNeeded') {
  const job = await setupJob();
  await w.fail(job, 'jellyfinSetupNeeded', 'Jellyfin refused the admin sign-in.', { reason, step: 'apiKey' });
}

/** The Grab's run up to its publish job, which the worker has claimed. */
async function toLeasedPublish() {
  await h.indexer(E1_RELEASES);
  await h.subscribe();
  await w.submitAll();
  await h.settle();
  await w.completed(await h.activeDownload());
  await h.settle();
  await w.importAll();
  await h.settle();
  const [job] = await w.claim('publish');
  return job!;
}

describe('publishing waits for setup', () => {
  test('a publish failing with jellyfinSetupNeeded waits 30 min without counting an attempt, and raises nothing by itself', async () => {
    const job = await toLeasedPublish();
    await w.fail(job, 'jellyfinSetupNeeded', 'Jellyfin is not set up yet.');
    const row = await h.get(job.jobId);
    expect(row).toMatchObject({ status: 'waiting', attempt: 0, failureCode: 'jellyfinSetupNeeded' });
    expect(row!.availableAt! - Date.now()).toBeGreaterThan(29 * 60_000);
    expect((await h.all('publications'))[0]!.state).toBe('pending');
    expect((await h.all('grabs'))[0]!.state).toBe('publishing');
    expect(await openIssues()).toEqual([]);
  });

  test("a leased publish whose Grab was cancelled doesn't wait for setup: the cancelled-Grab check runs first", async () => {
    const job = await toLeasedPublish();
    await h.admin.mutation(api.api.units.cancelGrab, { grabId: (await h.all('grabs'))[0]!._id });
    await w.fail(job, 'jellyfinSetupNeeded', 'Jellyfin is not set up yet.');
    await h.settle();
    expect(await h.get(job.jobId)).toMatchObject({ status: 'cancelled' });
    expect((await h.all('grabs'))[0]!.state).toBe('cancelled');
  });

  test('a cancel of the Grab ends the waiting publish at once', async () => {
    const job = await toLeasedPublish();
    await w.fail(job, 'jellyfinSetupNeeded', 'Jellyfin is not set up yet.');
    await h.admin.mutation(api.api.units.cancelGrab, { grabId: (await h.all('grabs'))[0]!._id });
    await h.settle();
    expect(await h.get(job.jobId)).toMatchObject({ status: 'cancelled' });
    expect((await h.all('grabs'))[0]!.state).toBe('cancelled');
  });
});

describe("the check at publish: Jellyfin's reading against the Unit", () => {
  /** Completes the run's publish of S01E01 with what Jellyfin read. */
  async function publishAs(reading: TargetReading) {
    const job = await toLeasedPublish();
    const ids = job.payload.class === 'publish' ? job.payload.publicationIds : [];
    await w.complete(job, {
      class: 'publish',
      targetItemRefs: Object.fromEntries(ids.map((id) => [id, 'jf-item-1'])),
      readings: Object.fromEntries(ids.map((id) => [id, reading])),
    });
    await h.settle();
    const unit = (await h.all('units')).find((u) => u.tmdbSeason === 1 && u.tmdbEpisode === 1)!;
    const detail = await h.admin.query(api.api.library.detail, { workId: unit.workId });
    return { unit, row: detail!.units.find((r) => r.unitId === unit._id)!, publications: await h.all('publications'), issues: await openIssues() };
  }

  test('an episode Jellyfin numbers as its Unit is visible, and the run is done', async () => {
    const { row, publications, issues } = await publishAs({ kind: 'episode', season: 1, episode: 1 });
    expect(publications.map((p) => [p.state, p.targetItemRef])).toEqual([['visible', 'jf-item-1']]);
    expect(issues).toEqual([]);
    expect(row.state).not.toBe('failed');
    expect((await h.all('grabs'))[0]!.state).toBe('done');
  });

  test('a double episode matches each of its Units by its range', async () => {
    const { publications, issues } = await publishAs({ kind: 'episode', season: 1, episode: 1, episodeEnd: 2 });
    expect(publications.map((p) => p.state)).toEqual(['visible']);
    expect(issues).toEqual([]);
  });

  test('another season and episode: the Publication fails and one Issue says what Jellyfin read', async () => {
    const { unit, row, publications, issues } = await publishAs({ kind: 'episode', season: 0, episode: 26 });
    expect(publications.map((p) => [p.state, p.targetItemRef])).toEqual([['failed', undefined]]);
    expect(issues.map((i) => [i.unitId, i.failureCode, i.class, i.fixActions, i.detail])).toEqual([
      [
        unit._id,
        'jellyfinMisread',
        'system',
        ['moveToLibraryNaming', 'dismiss'],
        'Jellyfin reads this file as S00E26, not S01E01; rename it to library naming.',
      ],
    ]);
    expect(row.state).toBe('failed');
  });

  test("an episode filed under another folder's series fails, with the series in the Issue", async () => {
    const { issues } = await publishAs({ kind: 'episode', season: 1, episode: 1, otherSeries: true });
    expect(issues.map((i) => i.detail)).toEqual(['Jellyfin files this file under another series than Harbour Lights; rename it to library naming.']);
  });

  test('a movie Jellyfin lists as something other than a movie in the Movies library fails', async () => {
    const { unitId, jobId } = await h.t.run(async (ctx) => {
      const workId = await ctx.db.insert('works', {
        libraryId: h.libraries.movies,
        kind: 'movie',
        title: 'Quiet Harbour',
        year: 2020,
        numberingScheme: 'standard',
        releaseProfileId: h.libraries.releaseProfileId,
        monitorNewUnits: false,
        folder: 'Quiet Harbour (2020)',
      });
      const unitId = await ctx.db.insert('units', { workId, kind: 'movie', title: 'Quiet Harbour', monitored: true, derivedState: 'wanted' });
      const library = (await ctx.db.get(h.libraries.movies))!;
      const path = `${library.rootPath}/Quiet Harbour (2020)/quiet.harbour.mkv`;
      const fileId = await ctx.db.insert('files', { path, sizeBytes: 1, inode: '2049:7', origin: 'scan', role: 'source', keepsName: true });
      await ctx.db.insert('fileUnits', { fileId, unitId });
      const fileVersionId = await ctx.db.insert('fileVersions', { unitId, fileId, kind: 'primary', playbackProfileId: library.playbackProfileId, fits: true });
      const publicationId = await ctx.db.insert('publications', { unitId, fileVersionId, generation: 0, target: 'jellyfin', state: 'pending' });
      const jobId = await enqueueJob(ctx, {
        payload: {
          class: 'publish',
          publicationIds: [publicationId],
          workFolderPath: `${library.rootPath}/Quiet Harbour (2020)`,
          items: [{ publicationId, path }],
          library: { libraryId: library._id, root: library.rootPath, kind: 'movies' },
        },
        idempotencyKey: `${publicationId}:publish:0`,
      });
      await ctx.db.patch(publicationId, { jobId });
      return { unitId, jobId };
    });
    const job = (await w.claim('publish')).find((j) => j.jobId === jobId)!;
    const [publicationId] = job.payload.class === 'publish' ? job.payload.publicationIds : [];
    await w.complete(job, { class: 'publish', targetItemRefs: { [publicationId!]: 'jf-video' }, readings: { [publicationId!]: { kind: 'other' } } });
    expect((await h.all('publications')).map((p) => p.state)).toEqual(['failed']);
    expect((await openIssues()).map((i) => [i.unitId, i.detail])).toEqual([
      [unitId, "Jellyfin doesn't list this file as a movie in the Movies library; rename it to library naming."],
    ]);
  });

  test('a worker that sends no readings is taken at its word', async () => {
    await startSetup();
    await completeSetup();
    const job = await toLeasedPublish();
    const ids = job.payload.class === 'publish' ? job.payload.publicationIds : [];
    await w.complete(job, { class: 'publish', targetItemRefs: Object.fromEntries(ids.map((id) => [id, 'jf-item-1'])) });
    expect((await h.all('publications')).map((p) => p.state)).toEqual(['visible']);
  });
});
