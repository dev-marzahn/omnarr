// The password-push hold: at most one leased push per user, a newer push
// held until the leased one ends, and a superseded push never retried.
import { createHash } from 'node:crypto';

import type { JobPayload, LeasedJob } from '@omnarr/contracts';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';

import { api, components, internal } from '../convex/_generated/api';
import type { Id } from '../convex/_generated/dataModel';
import { capabilities, setup, shippedProfile, skipDefinitionSync, worker, type Backend } from './setup';

let t: Backend;
let sessionId: Id<'workerSessions'>;

beforeEach(async () => {
  vi.useFakeTimers();
  t = setup();
  await skipDefinitionSync(t);
  const response = await t.mutation(api.jobs.worker.connect, { ...worker, workerId: 'w1', capabilities });
  if (!response.accepted) throw new Error('not accepted');
  sessionId = response.sessionId;
});
afterEach(() => vi.useRealTimers());

const push = (newPassword: string, userId = 'u1') => t.mutation(internal.jobs.queue.enqueuePasswordPush, { userId, username: 'leon', newPassword });
const claim = (max = 10): Promise<LeasedJob[]> => t.mutation(api.jobs.queue.claim, { ...worker, sessionId, class: 'maintenance', max });
const complete = (job: LeasedJob) =>
  t.mutation(api.jobs.queue.complete, {
    ...worker,
    jobId: job.jobId,
    leaseEpoch: job.leaseEpoch,
    result: { class: 'maintenance', action: 'pushJellyfinPassword', pushed: true },
  });
const fail = (job: LeasedJob, failureCode: 'jellyfinUnavailable' | 'jellyfinPasswordNotPushed') =>
  t.mutation(api.jobs.queue.fail, { ...worker, jobId: job.jobId, leaseEpoch: job.leaseEpoch, failureCode, detail: 'Failed.' });
const job = (jobId: Id<'jobs'>) => t.run((ctx) => ctx.db.get(jobId));
const expireLeases = () =>
  t.run(async (ctx) => {
    for (const j of await ctx.db.query('jobs').collect()) if (j.leaseExpiresAt) await ctx.db.patch(j._id, { leaseExpiresAt: Date.now() - 1 });
  });
const newPassword = (leased: LeasedJob) =>
  leased.payload.class === 'maintenance' && leased.payload.action === 'pushJellyfinPassword' ? leased.payload.newPassword : undefined;
const sessions = () =>
  t.run(
    async (ctx) =>
      (
        (await ctx.runQuery(components.betterAuth.adapter.findMany, { model: 'session', paginationOpts: { numItems: 100, cursor: null } } as never)) as {
          page: unknown[];
        }
      ).page,
  );
const openIssues = async () => (await t.run((ctx) => ctx.db.query('issues').collect())).filter((i) => i.state === 'open').map((i) => i.failureCode);

describe('a newer push waits for the leased one', () => {
  test('the race: push 2 is held while push 1 is leased, then lands after it', async () => {
    const first = await push('p2');
    const [leased] = await claim();
    expect(newPassword(leased!)).toBe('p2');

    const second = await push('p3');
    expect(await job(second)).toMatchObject({ status: 'waiting' });
    expect((await job(second))!.availableAt).toBeUndefined();
    // Nothing is claimable meanwhile, and no wake is scheduled for the held push.
    expect(await claim()).toEqual([]);
    await t.finishAllScheduledFunctions(() => vi.runAllTimers());
    expect(await claim()).toEqual([]);

    await complete(leased!);
    expect(await job(first)).toMatchObject({ status: 'done' });
    expect(await job(second)).toMatchObject({ status: 'queued' });
    const [next] = await claim();
    expect(newPassword(next!)).toBe('p3');
    await complete(next!);
    expect(await job(second)).toMatchObject({ status: 'done' });
  });

  test("expiry: push 1's lease expires with cancelRequested, so it ends cancelled and push 2 is queued", async () => {
    const first = await push('p2');
    await claim();
    const second = await push('p3');
    expect(await job(first)).toMatchObject({ status: 'leased', cancelRequested: true });

    await expireLeases();
    await t.mutation(internal.jobs.queue.supervise, {});
    expect(await job(first)).toMatchObject({ status: 'cancelled' });
    expect(await job(second)).toMatchObject({ status: 'queued' });
    const [next] = await claim();
    expect(newPassword(next!)).toBe('p3');
  });

  test('a retryable failure of a superseded push ends it cancelled, and push 2 is queued', async () => {
    const first = await push('p2');
    const [leased] = await claim();
    const second = await push('p3');

    await fail(leased!, 'jellyfinUnavailable');
    expect(await job(first)).toMatchObject({ status: 'cancelled' });
    expect(await job(second)).toMatchObject({ status: 'queued' });
  });

  test('three pushes: push 3 cancels the held push 2 at enqueue, and is queued when push 1 ends', async () => {
    await push('p2');
    const [leased] = await claim();
    const second = await push('p3');
    const third = await push('p4');
    expect(await job(second)).toMatchObject({ status: 'cancelled' });
    expect(await job(third)).toMatchObject({ status: 'waiting' });
    expect(await claim()).toEqual([]);

    await complete(leased!);
    expect(await job(third)).toMatchObject({ status: 'queued' });
    const [next] = await claim();
    expect(newPassword(next!)).toBe('p4');
  });

  test('only the end of a leased push releases: a held push cancelled at enqueue releases nothing', async () => {
    await push('p2');
    await claim();
    await push('p3');
    // p3 is cancelled here while held; that end must not release p4 past the leased p2.
    const third = await push('p4');
    expect(await job(third)).toMatchObject({ status: 'waiting' });
    expect(await claim()).toEqual([]);
  });

  test('pushes of different users are independent', async () => {
    await push('p2', 'u1');
    await claim();
    const other = await push('q2', 'u2');
    expect(await job(other)).toMatchObject({ status: 'queued' });
  });
});

describe('a push that cannot land', () => {
  test('a push that finds no ready connection ends failed and raises jellyfinPasswordNotPushed; the next successful push resolves it', async () => {
    const first = await push('p2');
    const [leased] = await claim();
    await fail(leased!, 'jellyfinPasswordNotPushed');
    expect(await job(first)).toMatchObject({ status: 'failed', failureCode: 'jellyfinPasswordNotPushed' });
    expect((await job(first))!.payload).toBeUndefined();
    expect(await openIssues()).toEqual(['jellyfinPasswordNotPushed']);

    await push('p3');
    const [next] = await claim();
    await complete(next!);
    expect(await openIssues()).toEqual([]);
  });

  test('a push that runs out of attempts raises jellyfinPasswordNotPushed', async () => {
    await push('p2');
    for (let attempt = 0; attempt < 3; attempt++) {
      await t.finishAllScheduledFunctions(() => vi.runAllTimers());
      const [leased] = await claim();
      await fail(leased!, 'jellyfinUnavailable');
    }
    expect(await openIssues()).toEqual(['jellyfinPasswordNotPushed']);
  });

  test('an expired lease at maxAttempts raises jellyfinPasswordNotPushed', async () => {
    const first = await push('p2');
    await t.run((ctx) => ctx.db.patch(first, { attempt: 2 }));
    await claim();
    await expireLeases();
    await t.mutation(internal.jobs.queue.supervise, {});
    expect(await job(first)).toMatchObject({ status: 'failed' });
    expect(await openIssues()).toContain('jellyfinPasswordNotPushed');
  });

  test("a push's terminal failure releases the held push", async () => {
    await push('p2');
    const [leased] = await claim();
    const second = await push('p3');
    // cancelRequested is set, but a terminal code is not a retry: it fails, and still releases.
    await fail(leased!, 'jellyfinPasswordNotPushed');
    expect(await job(second)).toMatchObject({ status: 'queued' });
  });
});

describe('/change-password', () => {
  test('signs out every other session whatever the client sends, keeps this one, and enqueues the push', async () => {
    vi.useRealTimers();
    process.env.SETUP_PASSWORD_HASH = createHash('sha256').update('setup-pw').digest('hex');
    process.env.BETTER_AUTH_SECRET = 'test-better-auth-secret-0123456789abcdef';
    process.env.CONVEX_SITE_URL = 'http://127.0.0.1:3211';
    await t.run((ctx) => ctx.db.insert('releaseProfiles', shippedProfile()));
    await t.action(api.api.setup.createAdmin, { setupPassword: 'setup-pw', username: 'leon', password: 'the-old-password', locale: 'en-US' });
    const headers = { 'content-type': 'application/json', origin: 'http://192.168.1.20:3000' };
    const signIn = () =>
      // An empty Better-Auth-Cookie asks the crossDomain plugin for the session in Set-Better-Auth-Cookie, as its client does.
      t.fetch('/api/auth/sign-in/username', {
        method: 'POST',
        headers: { ...headers, 'better-auth-cookie': '' },
        body: JSON.stringify({ username: 'leon', password: 'the-old-password' }),
      });
    const first = await signIn();
    expect(first.status).toBe(200);
    await signIn();
    // What the crossDomain client sends back: each cookie's name=value.
    const cookie = first.headers
      .get('set-better-auth-cookie')!
      .split(/,\s*(?=[^;,=\s]+=)/)
      .map((part) => part.split(';')[0]!.trim())
      .join('; ');
    expect(await sessions()).toHaveLength(2);

    const change = await t.fetch('/api/auth/change-password', {
      method: 'POST',
      headers: { ...headers, 'better-auth-cookie': cookie },
      body: JSON.stringify({ currentPassword: 'the-old-password', newPassword: 'the-new-password', revokeOtherSessions: false }),
    });
    expect(change.status).toBe(200);
    expect(await sessions()).toHaveLength(1);
    const pushes = await t.run(async (ctx) =>
      (await ctx.db.query('jobs').collect()).filter((j) => j.payload?.class === 'maintenance' && j.payload.action === 'pushJellyfinPassword'),
    );
    expect(pushes).toHaveLength(1);
  });
});

describe('other jobs', () => {
  const cleanStaging = (path: string): JobPayload => ({ class: 'maintenance', action: 'cleanStaging', paths: [path] });

  test('a maintenance job of another action is unaffected by the hold and its release', async () => {
    await push('p2');
    const [leased] = await claim(1);
    await push('p3');
    const other = await t.mutation(internal.jobs.queue.enqueue, { payload: cleanStaging('/a'), idempotencyKey: 'cleanStaging:a' });
    expect(await job(other)).toMatchObject({ status: 'queued' });

    const [cleaning] = await claim();
    expect(cleaning!.jobId).toBe(other);
    await t.mutation(api.jobs.queue.fail, { ...worker, jobId: other, leaseEpoch: cleaning!.leaseEpoch, failureCode: 'clientUnreachable', detail: 'x' });
    expect(await job(other)).toMatchObject({ status: 'waiting' });
    expect((await job(other))!.availableAt).toBeDefined();
    await complete(leased!);
    expect(await openIssues()).toEqual([]);
  });
});
