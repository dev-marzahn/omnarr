import type { FailureCode } from '@omnarr/contracts';
import { describe, expect, test } from 'vite-plus/test';

import { errorFailureCode, ffmpegFailure, nzbgetHistoryState, type NzbgetHistoryState, qbittorrentState } from '../src/failures.ts';
import { historyEntries, historyEntry, tagOf } from './fixtures/nzbget/load.ts';

describe('qbittorrentState: the qBittorrent table, first matching row', () => {
  const GiB = 1024 ** 3;
  const state = (name: string, progress = 0.5, free = 100 * GiB) => qbittorrentState({ state: name, progress }, free);

  test.each(['queuedDL', 'checkingDL', 'checkingResumeData', 'allocating'])('1. %s is queued', (name) => {
    expect(state(name).stage).toBe('queued');
  });

  test('1. checking and allocating never count towards a stall; a queued download is not checking', () => {
    expect([state('checkingDL').checking, state('checkingResumeData').checking, state('allocating').checking, state('queuedDL').checking]).toEqual([
      true,
      true,
      true,
      undefined,
    ]);
  });

  test('1. moving below progress 1 is queued; at progress 1 it is no change, never completed', () => {
    expect(state('moving', 0.4)).toEqual({ stage: 'queued', checking: true });
    expect(state('moving', 1)).toEqual({ stage: 'queued', unchanged: true });
  });

  test.each(['metaDL', 'downloading', 'forcedDL', 'stalledDL', 'stoppedDL', 'pausedDL'])('2. %s is downloading', (name) => {
    expect(state(name)).toEqual({ stage: 'downloading' });
  });

  test.each(['uploading', 'stalledUP', 'queuedUP', 'forcedUP'])('3. %s is completed and seeding', (name) => {
    expect(state(name, 1)).toEqual({ stage: 'completed' });
  });

  test.each(['stoppedUP', 'pausedUP'])('3. %s is completed and stopped (5.x spells it stopped, 4.x paused)', (name) => {
    expect(state(name, 1)).toEqual({ stage: 'completed', stopped: true });
  });

  test('3. checkingUP is completed, and checking', () => {
    expect(state('checkingUP', 1)).toEqual({ stage: 'completed', checking: true });
  });

  test('4. missingFiles is unknownClientFailure, a seeding problem once completed', () => {
    expect(state('missingFiles')).toEqual({ stage: 'failed', failureCode: 'unknownClientFailure', problem: 'missingFiles' });
  });

  test('5. error is diskFull below 1 GiB free under downloads, else unknownClientFailure', () => {
    expect(state('error', 0.5, GiB - 1)).toEqual({ stage: 'failed', failureCode: 'diskFull', problem: 'error' });
    expect(state('error', 0.5, GiB)).toEqual({ stage: 'failed', failureCode: 'unknownClientFailure', problem: 'error' });
  });

  test.each(['unknown', 'somethingNew'])('6. %s is unknownClientFailure', (name) => {
    expect(state(name)).toEqual({ stage: 'failed', failureCode: 'unknownClientFailure', problem: 'unknown' });
  });
});

const completed: NzbgetHistoryState = { stage: 'completed' };
const removed: NzbgetHistoryState = { stage: 'removed' };
const failed = (failureCode: FailureCode): NzbgetHistoryState => ({ stage: 'failed', failureCode });

// The NZBGet history table (failures.ts), keyed on the fixtures' omnarr tag (README.md says how each entry was made).
const HISTORY: Record<string, NzbgetHistoryState> = {
  // recorded (NZBGet 26.3)
  'grab-ok': completed, // row 1
  'grab-unpackok': completed, // row 1
  'grab-missing': failed('missingArticles'), // row 4, FAILURE/HEALTH
  'grab-partmissing': failed('missingArticles'), // row 4
  'grab-parfail': failed('parFailed'), // row 5
  'grab-password': failed('passwordProtected'), // row 6, WARNING/PASSWORD
  'grab-broken': failed('unpackFailed'), // row 7, FAILURE/UNPACK
  'grab-markbad': failed('releaseFileInvalid'), // row 8, FAILURE/BAD
  // An earlier version's URL records: the worker uploads the NZB now, so none comes any more; one would be row 9.
  'grab-doesnotexist': failed('unknownClientFailure'),
  'grab-paused': failed('unknownClientFailure'),
  'grab-queued': failed('unknownClientFailure'),
  // An NZB NZBGet can't parse is FAILURE/SCAN on 26.3: row 8 too.
  'grab-badxml': failed('releaseFileInvalid'),
  'grab-bad': failed('releaseFileInvalid'),
  // derived
  'grab-repaired': completed, // row 1: par repaired the missing articles
  'grab-space': failed('diskFull'), // row 3 wins over the repaired articles
  'grab-damaged': failed('missingArticles'), // row 4: WARNING/DAMAGED with failed articles
  'grab-parmissing': failed('missingArticles'), // row 4 wins over row 5
  'grab-deletedhealth': failed('missingArticles'), // row 4, DELETED/HEALTH
  'grab-parked': removed, // row 2, DELETED/MANUAL
};

test('the table covers every history fixture', () => {
  const tags = historyEntries().map(tagOf);
  expect(tags).toHaveLength(Object.keys(HISTORY).length);
  expect(new Set(tags)).toEqual(new Set(Object.keys(HISTORY)));
});

test.each(Object.entries(HISTORY))('nzbgetHistoryState: %s', (tag, state) => {
  expect(nzbgetHistoryState(historyEntry(tag))).toEqual(state);
});

// Statuses no fixture holds, written onto a recorded entry.
const base = historyEntry('grab-broken');
const withStatus = (Status: string, extra: Partial<typeof base> = {}) => ({ ...base, ParStatus: 'NONE', UnpackStatus: 'NONE', Status, ...extra });

test.each<[string, Partial<typeof base>, NzbgetHistoryState]>([
  ['DELETED/DUPE', {}, removed], // row 2
  ['WARNING/SPACE', {}, failed('diskFull')], // row 3
  ['FAILURE/UNPACK', { UnpackStatus: 'SPACE' }, failed('diskFull')], // row 3: UnpackStatus SPACE
  ['WARNING/REPAIRABLE', {}, failed('parFailed')], // row 5
  ['FAILURE/PAR', { ParStatus: 'FAILURE' }, failed('parFailed')], // row 5
  ['WARNING/PASSWORD', {}, failed('passwordProtected')], // row 6
  ['FAILURE/UNPACK', {}, failed('unpackFailed')], // row 7
  ['FAILURE/BAD', {}, failed('releaseFileInvalid')], // row 8
  ['FAILURE/SCRIPT', {}, failed('unknownClientFailure')], // row 9
  ['FAILURE/MOVE', {}, failed('unknownClientFailure')], // row 9
  ['WARNING/DAMAGED', { Health: 1000, FailedArticles: 0 }, failed('unknownClientFailure')], // row 9: no failed articles
  ['WARNING/SCRIPT', {}, failed('unknownClientFailure')], // row 9
  ['FAILURE/SOMETHINGNEW', {}, failed('unknownClientFailure')], // row 9: an unknown status
])('nzbgetHistoryState: %s with %o', (status, extra, state) => {
  expect(nzbgetHistoryState(withStatus(status, extra))).toEqual(state);
});

test.each<[number | null, FailureCode | undefined]>([
  [0, undefined],
  [1, 'transcodeFailed'],
  [255, 'transcodeFailed'],
  // killed by a signal
  [null, 'transcodeFailed'],
])('ffmpegFailure: exit %s → %s', (exitCode, code) => {
  expect(ffmpegFailure(exitCode)).toBe(code);
});

const systemError = (code: string) => Object.assign(new Error(`connect ${code} 10.0.0.1:6789`), { code });

test.each<[string, unknown, FailureCode | undefined]>([
  ['ECONNREFUSED', systemError('ECONNREFUSED'), 'clientUnreachable'],
  ['ECONNRESET', systemError('ECONNRESET'), 'clientUnreachable'],
  ['EHOSTUNREACH', systemError('EHOSTUNREACH'), 'clientUnreachable'],
  ['ENOTFOUND', systemError('ENOTFOUND'), 'clientUnreachable'],
  ['ENOSPC', systemError('ENOSPC'), 'diskFull'],
  ["fetch's TypeError around ECONNREFUSED", new TypeError('fetch failed', { cause: systemError('ECONNREFUSED') }), 'clientUnreachable'],
  ["fetch's TypeError with no cause", new TypeError('fetch failed'), 'clientUnreachable'],
  ['AbortSignal.timeout', new DOMException('The operation was aborted due to timeout', 'TimeoutError'), 'clientUnreachable'],
  ['an undici connect timeout', new TypeError('fetch failed', { cause: systemError('UND_ERR_CONNECT_TIMEOUT') }), 'clientUnreachable'],
  ['a TypeError from a bug', new TypeError('x is not a function'), undefined],
  ['a plain abort (cancellation)', new DOMException('This operation was aborted', 'AbortError'), undefined],
  ['an unrelated error', new Error('boom'), undefined],
  ['a non-error value', 'boom', undefined],
])('errorFailureCode: %s', (_name, error, code) => {
  expect(errorFailureCode(error)).toBe(code);
});
