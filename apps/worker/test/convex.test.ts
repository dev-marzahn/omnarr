// The worker's Convex adapter (convex.ts): the parts that aren't a plain call.
import { describe, expect, test, vi } from 'vite-plus/test';

import { resilientWatch, uploadUrlFor } from '../src/convex.ts';

// CI run 44448549101: a subscribed query that hit Convex's 1 s function limit was thrown from the client's
// WebSocket handler, since no onError was given, and the uncaught error ended the worker process.
describe('resilientWatch', () => {
  type Sub = { onValue: (value: number) => void; onError: (error: Error) => void; closed: boolean };
  const fakeQuery = () => {
    const subs: Sub[] = [];
    const subscribe = (onValue: (value: number) => void, onError: (error: Error) => void) => {
      const sub = { onValue, onError, closed: false };
      subs.push(sub);
      return () => void (sub.closed = true);
    };
    return { subs, subscribe };
  };

  test('passes values through', () => {
    const q = fakeQuery();
    const seen: number[] = [];
    resilientWatch(q.subscribe, (value) => seen.push(value), { retryMs: 1000, log: () => {} });
    q.subs[0]!.onValue(1);
    q.subs[0]!.onValue(2);
    expect(seen).toEqual([1, 2]);
  });

  test('a query error is logged, not thrown, and the query is subscribed to again after retryMs', () => {
    vi.useFakeTimers();
    try {
      const q = fakeQuery();
      const seen: number[] = [];
      const logged: string[] = [];
      resilientWatch(q.subscribe, (value) => seen.push(value), { retryMs: 1000, log: (line) => logged.push(line), name: 'jobs/queue:queue' });
      expect(() => q.subs[0]!.onError(new Error('Function execution timed out (maximum duration: 1s)'))).not.toThrow();
      expect(logged).toEqual(['watch jobs/queue:queue failed, again in 1 s: Function execution timed out (maximum duration: 1s)']);
      expect(q.subs[0]!.closed).toBe(true);
      expect(q.subs).toHaveLength(1);
      vi.advanceTimersByTime(1000);
      expect(q.subs).toHaveLength(2);
      q.subs[1]!.onValue(3);
      expect(seen).toEqual([3]);
    } finally {
      vi.useRealTimers();
    }
  });

  test('unwatching stops it, also during the wait before subscribing again', () => {
    vi.useFakeTimers();
    try {
      const q = fakeQuery();
      const unwatch = resilientWatch(q.subscribe, () => {}, { retryMs: 1000, log: () => {} });
      q.subs[0]!.onError(new Error('x'));
      unwatch();
      vi.advanceTimersByTime(5000);
      expect(q.subs).toHaveLength(1);
      const q2 = fakeQuery();
      const unwatch2 = resilientWatch(q2.subscribe, () => {}, { retryMs: 1000, log: () => {} });
      unwatch2();
      expect(q2.subs[0]!.closed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('uploadUrlFor', () => {
  test("resolves the relative upload URL a self-hosted backend without CONVEX_CLOUD_ORIGIN gives against the worker's Convex address", () => {
    // What the e2e stack's backend (convex-backend d1fcbeaf…) answered.
    expect(uploadUrlFor('/api/storage/upload?token=0188ac15', 'http://backend:3210')).toBe('http://backend:3210/api/storage/upload?token=0188ac15');
  });

  test("moves Convex's upload URL onto the address the worker reaches Convex at, keeping its path and token", () => {
    // A backend with CONVEX_CLOUD_ORIGIN writes that public origin into upload URLs; inside the stack's
    // network, 127.0.0.1 is the worker's own container.
    expect(uploadUrlFor('http://127.0.0.1:3210/api/storage/upload?token=abc%2B1', 'http://backend:3210')).toBe(
      'http://backend:3210/api/storage/upload?token=abc%2B1',
    );
  });

  test('keeps an upload URL that is already on that address', () => {
    expect(uploadUrlFor('https://convex.example/api/storage/upload?token=t', 'https://convex.example')).toBe(
      'https://convex.example/api/storage/upload?token=t',
    );
  });
});
