// The client runtime store: what the reconciler learnt this
// session, read by `download.submit`, and the per-client lock that keeps an
// apply apart from a submit or a remove.
import { expect, test } from 'vite-plus/test';

import { ClientRuntimeStore } from '../src/runtime/clientRuntime.ts';

const later = <T>(value: T, ms: number) => new Promise<T>((resolve) => setTimeout(() => resolve(value), ms));

test('a new session starts with every client unconfigured', () => {
  const store = new ClientRuntimeStore();
  expect(store.configured('nzbget')).toBe(false);
  store.markConfigured('nzbget');
  expect(store.configured('nzbget')).toBe(true);
  store.newSession();
  expect(store.configured('nzbget')).toBe(false);
});

test('the latest desired config is kept per kind', () => {
  const store = new ClientRuntimeStore();
  store.setDesired([{ kind: 'nzbget', clientId: 'c1' as never, enabled: true, configVersion: 2 }]);
  expect(store.desired('nzbget')).toMatchObject({ configVersion: 2 });
  expect(store.desired('qbittorrent')).toBeUndefined();
});

test('the lock runs one call per client at a time, in order', async () => {
  const store = new ClientRuntimeStore();
  const events: string[] = [];
  const call = (name: string, ms: number) =>
    store.withClientLock('nzbget', async () => {
      events.push(`${name} start`);
      await later(null, ms);
      events.push(`${name} end`);
      return name;
    });
  const results = await Promise.all([call('apply', 20), call('submit', 1), call('remove', 1)]);
  expect(results).toEqual(['apply', 'submit', 'remove']);
  expect(events).toEqual(['apply start', 'apply end', 'submit start', 'submit end', 'remove start', 'remove end']);
});

test('a failed call releases the lock', async () => {
  const store = new ClientRuntimeStore();
  await expect(store.withClientLock('nzbget', async () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
  await expect(store.withClientLock('nzbget', async () => 'next')).resolves.toBe('next');
});

test("one client's lock doesn't hold another's calls", async () => {
  const store = new ClientRuntimeStore();
  const events: string[] = [];
  const slow = store.withClientLock('nzbget', async () => {
    await later(null, 20);
    events.push('nzbget');
  });
  await store.withClientLock('qbittorrent', async () => events.push('qbittorrent'));
  await slow;
  expect(events).toEqual(['qbittorrent', 'nzbget']);
});
