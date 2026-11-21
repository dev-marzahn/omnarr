import { afterEach, beforeEach, expect, test, vi } from 'vite-plus/test';

import { ProgressReporter } from '../src/runtime/progress.ts';

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

test('writes at most once every 5 s, and the latest value last', async () => {
  const sent: number[] = [];
  const reporter = new ProgressReporter(async (fraction) => void sent.push(fraction), 5_000);
  reporter.report(0.1);
  reporter.report(0.2);
  reporter.report(0.3);
  await vi.advanceTimersByTimeAsync(0);
  expect(sent).toEqual([0.1]);
  await vi.advanceTimersByTimeAsync(5_000);
  expect(sent).toEqual([0.1, 0.3]);
  await vi.advanceTimersByTimeAsync(20_000);
  expect(sent).toEqual([0.1, 0.3]);
});

test('sends nothing after it is closed', async () => {
  const sent: number[] = [];
  const reporter = new ProgressReporter(async (fraction) => void sent.push(fraction), 5_000);
  reporter.report(0.1);
  reporter.report(0.2);
  reporter.close();
  await vi.advanceTimersByTimeAsync(10_000);
  expect(sent).toEqual([0.1]);
});
