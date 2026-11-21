import { describe, expect, test } from 'vite-plus/test';

import {
  backoff,
  CLIENT_FIX_ACTIONS,
  DEFAULT_LIMITS,
  FAILURE_CLASS,
  FAILURE_SCOPE,
  FailureCode,
  FIX_ACTIONS,
  FixAction,
  IssueAction,
  JellyfinSetupReason,
  raiseRule,
  retryPolicy,
} from '../src/failures.ts';

/** Recorded on the attempt and the indexer's health, never raised as an Issue. */
const INDEXER_CODES = ['indexerTimeout', 'indexerError', 'indexerRateLimited'] as const;
const RAISABLE = FailureCode.options.filter((code) => !(INDEXER_CODES as readonly string[]).includes(code));

describe('the failure table', () => {
  test('every code has a class, a scope and a fix-action list', () => {
    for (const code of FailureCode.options) {
      expect(FAILURE_CLASS[code], code).toBeDefined();
      expect(FAILURE_SCOPE[code], code).toBeDefined();
      expect(Array.isArray(FIX_ACTIONS[code]), code).toBe(true);
    }
  });

  test('among the codes that can be raised, only workerOffline, protocolMismatch, storageUnavailable and vpnDown have no fix action', () => {
    const empty = RAISABLE.filter((code) => FIX_ACTIONS[code].length === 0);
    expect(empty.sort()).toEqual(['protocolMismatch', 'storageUnavailable', 'vpnDown', 'workerOffline']);
  });

  test('the indexer codes are never raised, so they offer no fix action', () => {
    for (const code of INDEXER_CODES) expect(FIX_ACTIONS[code], code).toEqual([]);
  });

  test('every unit-scope code, orphanClientItem and orphanAfterDelete can be dismissed, and no other code', () => {
    const dismissable = FailureCode.options.filter((code) => FIX_ACTIONS[code].includes('dismiss'));
    const expected = FailureCode.options.filter((code) => FAILURE_SCOPE[code] === 'unit' || code === 'orphanClientItem' || code === 'orphanAfterDelete');
    expect(dismissable.sort()).toEqual(expected.sort());
  });

  test('among the codes that can be raised, only workerOffline, protocolMismatch, diskFull, storageUnavailable, vpnDown, the two metadata codes and the two Jellyfin setup codes lack dismiss', () => {
    const lacking = RAISABLE.filter((code) => !FIX_ACTIONS[code].includes('dismiss'));
    expect(lacking.sort()).toEqual(
      [
        'diskFull',
        'jellyfinPasswordNotPushed',
        'jellyfinSetupNeeded',
        'metadataKeyRejected',
        'metadataSourceUnavailable',
        'protocolMismatch',
        'storageUnavailable',
        'vpnDown',
        'workerOffline',
      ].sort(),
    );
  });

  test('every FixAction is offered by at least one code', () => {
    const used = new Set(FailureCode.options.flatMap((code) => FIX_ACTIONS[code]));
    expect([...FixAction.options].filter((action) => !used.has(action))).toEqual([]);
  });

  test('FixAction is exactly the list of fix actions', () => {
    expect([...FixAction.options].sort()).toEqual(
      [
        'enterMetadataKey',
        'moveToLibraryNaming',
        'searchAndPick',
        'retryNow',
        'tryNextBest',
        'retryRelease',
        'blocklistRemove',
        'retryPreparation',
        'downloadLog',
        'rerunJellyfinSetup',
        'resumeRun',
        'cancelRun',
        'removeClientItem',
        'removeOrphans',
        'dismiss',
      ].sort(),
    );
  });

  test('searchAndPick, rerunJellyfinSetup and enterMetadataKey are client actions: the UI runs them, issues.act takes every other one', () => {
    expect([...CLIENT_FIX_ACTIONS].sort()).toEqual(['enterMetadataKey', 'rerunJellyfinSetup', 'searchAndPick']);
    expect([...IssueAction.options].sort()).toEqual(FixAction.options.filter((action) => !CLIENT_FIX_ACTIONS.includes(action)).sort());
  });

  test('jellyfinMisread is a unit-scope system code, raised at once, which offers the move to library naming', () => {
    expect([FAILURE_CLASS.jellyfinMisread, FAILURE_SCOPE.jellyfinMisread, FIX_ACTIONS.jellyfinMisread]).toEqual([
      'system',
      'unit',
      ['moveToLibraryNaming', 'dismiss'],
    ]);
    expect(raiseRule('jellyfinMisread', {})).toBe(true);
  });

  test.each([
    ['clientUnreachable', ['retryNow', 'dismiss']],
    ['releaseFetchFailed', ['retryNow', 'dismiss']],
    ['releaseFileInvalid', ['tryNextBest', 'searchAndPick', 'retryRelease', 'blocklistRemove', 'dismiss']],
    ['unknownClientFailure', ['retryRelease', 'tryNextBest', 'dismiss']],
    ['leaseExpired', ['retryNow', 'dismiss']],
    ['jellyfinUnavailable', ['retryNow', 'dismiss']],
    ['jellyfinSetupNeeded', ['rerunJellyfinSetup']],
    ['jellyfinPasswordNotPushed', ['rerunJellyfinSetup']],
    ['missingArticles', ['tryNextBest', 'searchAndPick', 'retryRelease', 'blocklistRemove', 'dismiss']],
    ['parFailed', ['tryNextBest', 'searchAndPick', 'retryRelease', 'blocklistRemove', 'dismiss']],
    ['unpackFailed', ['tryNextBest', 'searchAndPick', 'retryRelease', 'blocklistRemove', 'dismiss']],
    ['passwordProtected', ['tryNextBest', 'searchAndPick', 'retryRelease', 'blocklistRemove', 'dismiss']],
    ['noMediaFile', ['tryNextBest', 'searchAndPick', 'retryRelease', 'blocklistRemove', 'dismiss']],
    ['fakeOrWrongContent', ['tryNextBest', 'searchAndPick', 'retryRelease', 'blocklistRemove', 'dismiss']],
    ['torrentStalled', ['tryNextBest', 'searchAndPick', 'retryRelease', 'blocklistRemove', 'dismiss']],
    // "Search and pick" comes after the first action on every bad-release code and transcodeFailed.
    ['importMismatch', ['tryNextBest', 'searchAndPick', 'blocklistRemove', 'dismiss']],
    ['transcodeFailed', ['retryPreparation', 'searchAndPick', 'tryNextBest', 'downloadLog', 'dismiss']],
    ['diskFull', ['retryNow']],
    ['workerOffline', []],
    ['protocolMismatch', []],
    ['orphanClientItem', ['removeClientItem', 'dismiss']],
    // Raised by deleteWork's sweep after its cap.
    ['orphanAfterDelete', ['removeOrphans', 'dismiss']],
    ['pipelineError', ['retryRelease', 'dismiss']],
    ['workflowPaused', ['resumeRun', 'cancelRun', 'dismiss']],
    ['metadataKeyRejected', ['enterMetadataKey']],
    ['metadataSourceUnavailable', ['retryNow']],
    // Raised and resolved by the worker's storage check.
    ['storageUnavailable', []],
    // Raised and resolved by downloadClients.report; nothing to click, and it can't be dismissed.
    ['vpnDown', []],
  ] as const)('%s offers its fix actions', (code, actions) => {
    expect(FIX_ACTIONS[code]).toEqual(actions);
  });

  test.each([
    ['missingArticles', 'badRelease', 'unit'],
    ['torrentStalled', 'badRelease', 'unit'],
    ['importMismatch', 'badRelease', 'unit'],
    ['transcodeFailed', 'preparation', 'unit'],
    ['clientUnreachable', 'transient', 'unit'],
    ['releaseFetchFailed', 'transient', 'unit'],
    ['releaseFileInvalid', 'badRelease', 'unit'],
    ['unknownClientFailure', 'system', 'unit'],
    ['jellyfinUnavailable', 'transient', 'unit'],
    ['diskFull', 'system', 'system'],
    ['workerOffline', 'system', 'system'],
    ['pipelineError', 'system', 'unit'],
    ['workflowPaused', 'system', 'unit'],
    ['metadataKeyRejected', 'system', 'system'],
    ['metadataSourceUnavailable', 'system', 'system'],
    ['jellyfinSetupNeeded', 'system', 'system'],
    ['jellyfinPasswordNotPushed', 'system', 'system'],
    ['storageUnavailable', 'system', 'system'],
    ['vpnDown', 'system', 'system'],
  ] as const)('%s is %s with scope %s', (code, cls, scope) => {
    expect(FAILURE_CLASS[code]).toBe(cls);
    expect(FAILURE_SCOPE[code]).toBe(scope);
  });
});

describe('retryPolicy', () => {
  test.each([
    ['clientUnreachable', 'backoff'],
    ['releaseFetchFailed', 'backoff'],
    ['releaseFileInvalid', 'terminal'],
    ['unknownClientFailure', 'terminal'],
    ['leaseExpired', 'backoff'],
    ['jellyfinUnavailable', 'backoff'],
    ['transcodeFailed', 'backoff'],
    ['diskFull', 'diskWait'],
    // A torrent submit waits for the VPN without counting an attempt.
    ['vpnDown', 'vpnWait'],
    ['missingArticles', 'terminal'],
    ['importMismatch', 'terminal'],
    ['pipelineError', 'terminal'],
  ] as const)('%s → %s', (code, policy) => {
    expect(retryPolicy(code)).toBe(policy);
  });

  test('a publish job failing with jellyfinSetupNeeded waits for setup', () => {
    expect(retryPolicy('jellyfinSetupNeeded', 'publish')).toBe('jellyfinSetupWait');
  });

  test('jellyfinSetupNeeded on any other job is terminal, like every system code', () => {
    expect(retryPolicy('jellyfinSetupNeeded', 'maintenance')).toBe('terminal');
    expect(retryPolicy('jellyfinSetupNeeded')).toBe('terminal');
    expect(retryPolicy('jellyfinPasswordNotPushed', 'maintenance')).toBe('terminal');
  });
});

test('JellyfinSetupReason lists the four reasons', () => {
  expect([...JellyfinSetupReason.options].sort()).toEqual(['credentialsNeeded', 'keyRejected', 'libraryMissing', 'setupFailed']);
});

test('the Jellyfin limits', () => {
  expect(DEFAULT_LIMITS).toMatchObject({
    jellyfinSetupRetryMs: 30 * 60_000,
    publishWaitMs: 120_000,
    publishPollMs: 2_000,
    jellyfinReachableMs: 3 * 60_000,
    playbackPollMs: 30_000,
    playbackReportTtlMs: 90 * 86_400_000,
  });
});

describe('backoff', () => {
  test('grows with the attempt', () => {
    const mid = () => 0.5;
    expect(backoff(2, mid)).toBeGreaterThan(backoff(1, mid));
    expect(backoff(3, mid)).toBeGreaterThan(backoff(2, mid));
  });

  test('is never above 30 minutes, whatever the jitter', () => {
    for (const r of [0, 0.5, 0.999]) expect(backoff(50, () => r)).toBeLessThanOrEqual(30 * 60_000);
  });

  test('jitters within ±20 %', () => {
    const low = backoff(1, () => 0);
    const high = backoff(1, () => 0.999);
    expect(low).toBeGreaterThan(0);
    expect(high / low).toBeGreaterThan(1.4);
    expect(high / low).toBeLessThan(1.51);
  });
});

describe('raiseRule: whether a failure becomes an Issue', () => {
  test('a bad release is raised only at the 3rd failed Grab for the Unit', () => {
    expect(raiseRule('missingArticles', { failedGrabs: 1 })).toBe(false);
    expect(raiseRule('importMismatch', { failedGrabs: 2 })).toBe(false);
    expect(raiseRule('missingArticles', { failedGrabs: 3 })).toBe(true);
    expect(raiseRule('torrentStalled', { failedGrabs: 4 })).toBe(true);
  });

  test('a bad release is raised when no acceptable candidate is left', () => {
    expect(raiseRule('missingArticles', { failedGrabs: 1, noneLeft: true })).toBe(true);
  });

  test('transient and preparation failures are raised when the last attempt fails', () => {
    expect(raiseRule('clientUnreachable', { lastAttempt: false })).toBe(false);
    expect(raiseRule('clientUnreachable', { lastAttempt: true })).toBe(true);
    expect(raiseRule('jellyfinUnavailable', { lastAttempt: true })).toBe(true);
    expect(raiseRule('transcodeFailed', { lastAttempt: false })).toBe(false);
    expect(raiseRule('transcodeFailed', { lastAttempt: true })).toBe(true);
  });

  test('system failures are raised at once', () => {
    for (const code of ['pipelineError', 'workflowPaused', 'diskFull', 'protocolMismatch', 'orphanClientItem', 'orphanAfterDelete'] as const)
      expect(raiseRule(code, {}), code).toBe(true);
  });

  test('indexer errors are never raised', () => {
    for (const code of ['indexerTimeout', 'indexerError', 'indexerRateLimited'] as const) expect(raiseRule(code, { lastAttempt: true }), code).toBe(false);
  });
});

test('the download limits', () => {
  expect(DEFAULT_LIMITS).toMatchObject({
    releaseFetchTimeoutMs: 30_000,
    nzbMaxBytes: 64 * 1024 * 1024,
    torrentMaxBytes: 16 * 1024 * 1024,
    vpnDownAfterMs: 2 * 60_000,
    portForwardWaitMs: 5 * 60_000,
    vpnWaitRetryMs: 5 * 60_000,
    seedingLostAfterMs: 60 * 60_000,
    trackerPollMs: 5 * 60_000,
    missingItemPasses: 2,
  });
});

test("the VPN's stable window: down holds, and its timer runs, until the tunnel has been up 2 minutes", () => {
  expect(DEFAULT_LIMITS.vpnStableMs).toBe(2 * 60_000);
});

test('the goal grace: a completed torrent still seeding 10 minutes past its goal is made to refresh', () => {
  expect(DEFAULT_LIMITS.goalGraceMs).toBe(10 * 60_000);
});

test('the import and preparation limits', () => {
  expect(DEFAULT_LIMITS).toMatchObject({
    freeSpaceMarginBytes: 1024 * 1024 * 1024,
    videoSizeRatio: 2,
    prepareGroups: { import: 0, manual: 0, retry: 0, profileEdit: 1, bulk: 1 },
    previewChangeLimit: 4000,
    durationToleranceMs: 2_000,
    durationToleranceRatio: 0.002,
    ffprobeTimeoutMs: 120_000,
    unarTimeoutMs: 60 * 60_000,
    ffmpegStallMs: 10 * 60_000,
  });
});

test('storageUnavailable is raised at once and is terminal, like every system code', () => {
  expect(raiseRule('storageUnavailable', {})).toBe(true);
  expect(retryPolicy('storageUnavailable')).toBe('terminal');
});

test('maxAttempts per class', () => {
  expect(DEFAULT_LIMITS.maxAttempts).toEqual({ 'download.submit': 5, import: 5, publish: 5, prepare: 2, maintenance: 3, indexer: 1 });
});

test('indexer jobs run 4 at a time and are never retried; a definition waits at least 2 s', () => {
  expect(DEFAULT_LIMITS.concurrency.indexer).toBe(4);
  expect(DEFAULT_LIMITS.definitionMinIntervalMs).toBe(2000);
  expect(DEFAULT_LIMITS.relayTimeoutMs).toBe(90_000);
  expect(DEFAULT_LIMITS.relayPollMs).toBe(250);
});
