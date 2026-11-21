// The session poller: while Jellyfin's connection is ready,
// it asks the target for the running plays every 30 s and reports the set
// only when it changed.
import { type ActivePlay, DEFAULT_LIMITS, type JellyfinConnection } from '@omnarr/contracts';
import { afterEach, beforeEach, describe, expect, test, vi } from 'vite-plus/test';

import { JobFailure } from '../src/runtime/lease.ts';
import { startPlaybackWatch } from '../src/runtime/playbackWatch.ts';
import { FakeBackend } from './fakeBackend.ts';

const TABLET: ActivePlay = {
  deviceId: 'dev-tablet',
  deviceName: 'Spike Tablet',
  client: 'Jellyfin Android',
  itemRef: 'item-e1',
  method: 'directPlay',
  reasons: [],
  rawReasons: [],
};
const CHROME: ActivePlay = {
  deviceId: 'dev-chrome',
  deviceName: 'Chrome',
  client: 'Jellyfin Web',
  itemRef: 'item-e1',
  method: 'transcode',
  reasons: ['audioCodec'],
  rawReasons: ['AudioCodecNotSupported'],
};
const READY: JellyfinConnection = { state: 'ready', apiKey: 'k', adminUserId: 'u', libraries: [] };

let backend: FakeBackend;
let connection: JellyfinConnection | null;
/** What the target answers on each call, in turn; the last one repeats. */
let answers: (ActivePlay[] | Error)[];
let observed: AbortSignal[];
let logs: string[];
let stop: (() => void) | undefined;
let target: { observe: (signal: AbortSignal) => Promise<ActivePlay[]> };

const answering = async (signal: AbortSignal) => {
  observed.push(signal);
  const answer = answers.length > 1 ? answers.shift()! : answers[0]!;
  if (answer instanceof Error) throw answer;
  return answer;
};

const start = () => {
  stop = startPlaybackWatch({ backend, sessionId: 'session1' as never, target, connection: () => connection, log: (line) => logs.push(line) });
};
/** Runs the poller's next pass. */
const poll = (times = 1) => vi.advanceTimersByTimeAsync(times * DEFAULT_LIMITS.playbackPollMs);

beforeEach(() => {
  vi.useFakeTimers();
  backend = new FakeBackend();
  connection = READY;
  answers = [[]];
  observed = [];
  logs = [];
  target = { observe: answering };
});
afterEach(() => {
  stop?.();
  vi.useRealTimers();
});

describe('startPlaybackWatch', () => {
  test('asks the target every 30 s', async () => {
    start();
    await vi.advanceTimersByTimeAsync(DEFAULT_LIMITS.playbackPollMs - 1);
    expect(observed).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(observed).toHaveLength(1);
    await poll(2);
    expect(observed).toHaveLength(3);
  });

  test('the first set after a start is sent once, also when it is empty', async () => {
    start();
    await poll(3);
    expect(backend.playReports).toEqual([{ sessionId: 'session1', plays: [] }]);
  });

  test('only a changed set is reported; the order of the plays is no change', async () => {
    answers = [[TABLET], [TABLET], [TABLET, CHROME], [CHROME, TABLET], [{ ...CHROME, method: 'directStream' }, TABLET], []];
    start();
    await poll(7);
    expect(backend.playReports.map((report) => report.plays)).toEqual([[TABLET], [TABLET, CHROME], [{ ...CHROME, method: 'directStream' }, TABLET], []]);
  });

  test("doesn't run while the connection isn't ready, and starts when it is", async () => {
    connection = null;
    start();
    await poll(2);
    connection = { state: 'settingUp', libraries: [] };
    await poll(2);
    expect(observed).toHaveLength(0);
    expect(backend.playReports).toEqual([]);

    connection = READY;
    answers = [[TABLET]];
    await poll();
    expect(backend.playReports).toEqual([{ sessionId: 'session1', plays: [TABLET] }]);
  });

  test('a failed observe is logged and the loop goes on', async () => {
    answers = [new JobFailure('jellyfinUnavailable', 'Jellyfin did not answer (GET /Sessions).'), [TABLET]];
    start();
    await poll(2);
    expect(logs).toEqual(['playback poll failed: jellyfinUnavailable: Jellyfin did not answer (GET /Sessions).']);
    expect(backend.playReports.map((report) => report.plays)).toEqual([[TABLET]]);
  });

  test('a failed report is logged, and the same set is sent again on the next pass', async () => {
    answers = [[TABLET]];
    backend.reportPlaysError = 'sessionNotAccepted';
    start();
    await poll();
    expect(logs).toEqual(['playback report failed: sessionNotAccepted']);
    backend.reportPlaysError = undefined;
    await poll(2);
    expect(backend.playReports.map((report) => report.plays)).toEqual([[TABLET]]);
  });

  test('stops with the session: no further pass, and a running observe is aborted', async () => {
    let release: () => void = () => {};
    target = {
      observe: async (signal) => {
        observed.push(signal);
        await new Promise<void>((resolve) => (release = resolve));
        return [TABLET];
      },
    };
    start();
    await poll();
    expect(observed).toHaveLength(1);
    stop!();
    expect(observed[0]!.aborted).toBe(true);
    release();
    await poll(3);
    expect(observed).toHaveLength(1);
    expect(backend.playReports).toEqual([]);
  });
});
