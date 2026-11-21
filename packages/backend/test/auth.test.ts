// The callers each wrapper lets through: admin functions
// want a live admin session and turn away no session, an expired one, a user
// who isn't an admin, a banned admin and the worker token; worker functions
// want the worker token and the backend's protocol version, and turn away a
// session without the token.
import { PROTOCOL_VERSION } from '@omnarr/contracts';
import { beforeEach, describe, expect, test, vi } from 'vite-plus/test';

import { api, components } from '../convex/_generated/api';
import { asAdmin, capabilities, setup, worker, WORKER_TOKEN, type Backend } from './setup';

let t: Backend;
beforeEach(() => {
  t = setup();
});

let users = 0;

/** A signed-in Better Auth user with this role and ban. */
async function signedIn(fields: { role: string; banned?: boolean }) {
  const name = `other${++users}`;
  const { userId, sessionId } = await t.run(async (ctx) => {
    const now = Date.now();
    const create = (input: object) => ctx.runMutation(components.betterAuth.adapter.create, { input } as never) as Promise<{ _id: string }>;
    const user = await create({
      model: 'user',
      data: { name, email: `${name}@users.invalid`, emailVerified: false, username: name, createdAt: now, updatedAt: now, ...fields },
    });
    const session = await create({
      model: 'session',
      data: { userId: user._id, token: `${name}-token`, expiresAt: now + 3_600_000, createdAt: now, updatedAt: now },
    });
    return { userId: user._id, sessionId: session._id };
  });
  return t.withIdentity({ subject: userId, sessionId });
}

/** One function of each admin wrapper. */
const adminCalls = {
  adminQuery: (caller: Pick<Backend, 'query'>) => caller.query(api.api.issues.counts, {}),
  adminMutation: (caller: Pick<Backend, 'mutation'>) => caller.mutation(api.api.system.buildSupportBundle, {}),
  adminAction: (caller: Pick<Backend, 'action'>) => caller.action(api.api.metadata.search, { query: 'harbour' }),
};

describe('admin functions (adminQuery, adminMutation, adminAction)', () => {
  test.each(Object.entries(adminCalls))('%s lets a signed-in admin through', async (_kind, call) => {
    const admin = await asAdmin(t);
    // The action reaches TMDB, which isn't set up here: past the check, it fails on the missing token, not on the caller.
    const message = await (call(admin as never) as Promise<unknown>).then(
      () => '',
      (e: unknown) => (e instanceof Error ? e.message : JSON.stringify(e)),
    );
    expect(message).not.toMatch(/unauthorized/);
  });

  test.each(Object.entries(adminCalls))('%s refuses a call without a session', async (_kind, call) => {
    await expect(call(t as never)).rejects.toThrow(/unauthorized/);
  });

  test.each(Object.entries(adminCalls))('%s refuses a user who is not an admin, and a banned admin', async (_kind, call) => {
    await expect(call((await signedIn({ role: 'user' })) as never)).rejects.toThrow(/unauthorized/);
    await expect(call((await signedIn({ role: 'admin', banned: true })) as never)).rejects.toThrow(/unauthorized/);
  });

  test('an expired session is refused', async () => {
    vi.useFakeTimers();
    try {
      const admin = await asAdmin(t, 1_000);
      vi.advanceTimersByTime(2_000);
      await expect(admin.query(api.api.issues.counts, {})).rejects.toThrow(/unauthorized/);
    } finally {
      vi.useRealTimers();
    }
  });

  test('the worker token is no session: an admin function refuses it', async () => {
    await expect(t.query(api.api.issues.counts, { workerToken: WORKER_TOKEN } as never)).rejects.toThrow();
    await expect(t.query(api.api.issues.counts, {})).rejects.toThrow(/unauthorized/);
  });
});

describe('worker functions (workerQuery, workerMutation)', () => {
  test('the worker token and the protocol version let the worker through', async () => {
    expect(await t.query(api.jobs.queue.queue, { ...worker, classes: ['import'] })).toEqual([{ class: 'import', count: 0 }]);
    expect(await t.mutation(api.jobs.worker.connect, { ...worker, workerId: 'w1', capabilities })).toMatchObject({ accepted: true });
  });

  test('a wrong or empty token is refused, by a query and by a mutation', async () => {
    for (const workerToken of ['wrong-token', '', `${WORKER_TOKEN}x`]) {
      await expect(t.query(api.jobs.queue.queue, { ...worker, workerToken, classes: ['import'] })).rejects.toThrow(/unauthorized/);
      await expect(t.mutation(api.jobs.worker.connect, { ...worker, workerToken, workerId: 'w1', capabilities })).rejects.toThrow(/unauthorized/);
    }
  });

  test('an admin session without the token is refused', async () => {
    const admin = await asAdmin(t);
    await expect(admin.query(api.jobs.queue.queue, { ...worker, workerToken: 'session-token', classes: ['import'] })).rejects.toThrow(/unauthorized/);
  });

  test('another protocol version is refused, except by connect, which answers it', async () => {
    const old = { ...worker, protocolVersion: PROTOCOL_VERSION + 1 };
    await expect(t.query(api.jobs.queue.queue, { ...old, classes: ['import'] })).rejects.toThrow(/protocolMismatch/);
    expect(await t.mutation(api.jobs.worker.connect, { ...old, workerId: 'w1', capabilities })).toEqual({ accepted: false, expectedVersion: PROTOCOL_VERSION });
  });

  test('no worker token is configured: every worker call is refused', async () => {
    delete process.env.WORKER_TOKEN;
    await expect(t.query(api.jobs.queue.queue, { ...worker, classes: ['import'] })).rejects.toThrow(/unauthorized/);
  });
});
