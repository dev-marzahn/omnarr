import { describe, expect, test } from 'vite-plus/test';

import { canTransition, deriveUnitState, type UnitSnapshot } from '../src/states.ts';

const NOW = Date.UTC(2026, 10, 17);
const DAY = 24 * 60 * 60 * 1000;

/** A monitored Unit that aired yesterday and has nothing else: "wanted". */
const unit = (overrides: Partial<UnitSnapshot> = {}): UnitSnapshot => ({
  now: NOW,
  monitored: true,
  airDateUtc: NOW - DAY,
  hasOpenIssue: false,
  hasPendingRendition: false,
  versions: [],
  ...overrides,
});

const visibleFitting = { kind: 'primary', fits: true, visible: true } as const;
const visibleNotFitting = { kind: 'primary', fits: false, visible: true } as const;

describe('deriveUnitState: one test per rule', () => {
  test('1: an unmonitored Unit is "not monitored"', () => {
    expect(deriveUnitState(unit({ monitored: false }))).toBe('notMonitored');
  });

  test('2: an open Issue, nothing playable and no running Grab is "failed"', () => {
    expect(deriveUnitState(unit({ hasOpenIssue: true }))).toBe('failed');
  });

  test('3: a running Grab that is downloading is "downloading"', () => {
    expect(deriveUnitState(unit({ activeGrab: { state: 'downloading', paused: false, clientStage: 'downloading' } }))).toBe('downloading');
  });

  test('3: a download still queued in its client is "downloading"', () => {
    expect(deriveUnitState(unit({ activeGrab: { state: 'downloading', paused: false, clientStage: 'queued' } }))).toBe('downloading');
  });

  test('3: a download in post-processing is "repair/unpack"', () => {
    expect(deriveUnitState(unit({ activeGrab: { state: 'downloading', paused: false, clientStage: 'postProcessing' } }))).toBe('repairUnpack');
  });

  test.each(['importing', 'publishing'] as const)('4: a running Grab that is %s is "importing"', (state) => {
    expect(deriveUnitState(unit({ activeGrab: { state, paused: false } }))).toBe('importing');
  });

  test('5: a running Grab that is submitting is "grabbed"', () => {
    expect(deriveUnitState(unit({ activeGrab: { state: 'submitting', paused: false } }))).toBe('grabbed');
  });

  test('6: a pending Rendition of one of its files is "preparing"', () => {
    expect(deriveUnitState(unit({ hasPendingRendition: true, versions: [visibleNotFitting] }))).toBe('preparing');
  });

  test('6: a staged version with a pending Publication is "preparing", between the swap and the publish', () => {
    const staged = { kind: 'staged', fits: true, visible: false, pendingPublication: true } as const;
    expect(deriveUnitState(unit({ versions: [visibleNotFitting, staged] }))).toBe('preparing');
    expect(deriveUnitState(unit({ versions: [staged] }))).toBe('preparing');
  });

  test('6: a pending Publication of a version that is not staged is not "preparing"', () => {
    expect(deriveUnitState(unit({ versions: [{ kind: 'primary', fits: true, visible: false, pendingPublication: true }] }))).toBe('wanted');
    expect(deriveUnitState(unit({ versions: [visibleNotFitting, { kind: 'staged', fits: true, visible: false }] }))).toBe('notInTargetFormat');
  });

  test('7: a fitting primary version with a visible Publication is "ready"', () => {
    expect(deriveUnitState(unit({ versions: [visibleFitting] }))).toBe('ready');
  });

  test('8: a visible version that does not fit is "not yet in target format"', () => {
    expect(deriveUnitState(unit({ versions: [visibleNotFitting] }))).toBe('notInTargetFormat');
  });

  test('9: a running last SearchAttempt is "searching"', () => {
    expect(deriveUnitState(unit({ lastSearchState: 'running' }))).toBe('searching');
  });

  test('10: an unknown air date is "not aired"', () => {
    expect(deriveUnitState(unit({ airDateUtc: undefined }))).toBe('notAired');
  });

  test('10: an air date in the future is "not aired"', () => {
    expect(deriveUnitState(unit({ airDateUtc: NOW + DAY }))).toBe('notAired');
  });

  test('11: an aired, monitored Unit with nothing else is "wanted"', () => {
    expect(deriveUnitState(unit())).toBe('wanted');
  });
});

describe('deriveUnitState: the order of the rules', () => {
  test('not monitored wins over an open Issue and a running Grab', () => {
    const snapshot = unit({ monitored: false, hasOpenIssue: true, activeGrab: { state: 'downloading', paused: false } });
    expect(deriveUnitState(snapshot)).toBe('notMonitored');
  });

  // A scanned file of a Unit that is tracked, not monitored, shows whether it fits.
  test('a playable file wins over not monitored: ready, or not yet in target format', () => {
    expect(deriveUnitState(unit({ monitored: false, versions: [visibleFitting] }))).toBe('ready');
    expect(deriveUnitState(unit({ monitored: false, versions: [visibleNotFitting] }))).toBe('notInTargetFormat');
  });

  test('an unmonitored Unit with a playable file shows its file’s state over an open Issue, a running Grab and a pending Rendition', () => {
    const grab = { activeGrab: { state: 'downloading', paused: false } } as const;
    expect(deriveUnitState(unit({ monitored: false, versions: [visibleNotFitting], hasOpenIssue: true }))).toBe('notInTargetFormat');
    expect(deriveUnitState(unit({ monitored: false, versions: [visibleNotFitting], ...grab }))).toBe('notInTargetFormat');
    expect(deriveUnitState(unit({ monitored: false, versions: [visibleNotFitting], hasPendingRendition: true }))).toBe('preparing');
  });

  test('an unmonitored Unit whose only file is not visible yet is "not monitored"', () => {
    expect(deriveUnitState(unit({ monitored: false, versions: [{ kind: 'primary', fits: true, visible: false }] }))).toBe('notMonitored');
  });

  test('an open Issue on a playable Unit shows its playable state, not "failed"', () => {
    expect(deriveUnitState(unit({ hasOpenIssue: true, versions: [visibleNotFitting] }))).toBe('notInTargetFormat');
    expect(deriveUnitState(unit({ hasOpenIssue: true, versions: [visibleFitting] }))).toBe('ready');
  });

  test('a running next-best Grab shows its stage over an open Issue', () => {
    expect(deriveUnitState(unit({ hasOpenIssue: true, activeGrab: { state: 'downloading', paused: false, clientStage: 'downloading' } }))).toBe('downloading');
  });

  test('a paused run is not running: with nothing playable and its Issue open, the Unit is "failed"', () => {
    expect(deriveUnitState(unit({ hasOpenIssue: true, activeGrab: { state: 'importing', paused: true } }))).toBe('failed');
  });

  test('a paused run on a playable Unit shows the playable state, never a frozen stage', () => {
    expect(deriveUnitState(unit({ hasOpenIssue: true, activeGrab: { state: 'importing', paused: true }, versions: [visibleFitting] }))).toBe('ready');
  });

  test('a visible version without a published Publication is not playable', () => {
    expect(deriveUnitState(unit({ hasOpenIssue: true, versions: [{ kind: 'primary', fits: true, visible: false }] }))).toBe('failed');
  });

  test('"ready" needs the primary version: a fitting original alone is not ready', () => {
    expect(deriveUnitState(unit({ versions: [{ kind: 'original', fits: true, visible: true }] }))).toBe('wanted');
  });

  test('preparing wins over a playable version that does not fit yet', () => {
    expect(deriveUnitState(unit({ hasPendingRendition: true, versions: [visibleNotFitting] }))).toBe('preparing');
  });

  test('a search that found nothing acceptable leaves the Unit "wanted"', () => {
    expect(deriveUnitState(unit({ lastSearchState: 'noAcceptable' }))).toBe('wanted');
  });

  test('a running search wins over "not aired"', () => {
    expect(deriveUnitState(unit({ airDateUtc: undefined, lastSearchState: 'running' }))).toBe('searching');
  });
});

describe('deriveUnitState: an upgrade Grab', () => {
  test.each(['submitting', 'downloading', 'importing', 'publishing'] as const)('a ready Unit stays ready while its upgrade Grab is %s', (state) => {
    expect(deriveUnitState(unit({ activeGrab: { state, paused: false, kind: 'upgrade' }, versions: [visibleFitting] }))).toBe('ready');
  });

  test('a Unit not in target format stays so while an upgrade Grab runs', () => {
    expect(deriveUnitState(unit({ activeGrab: { state: 'downloading', paused: false, kind: 'upgrade' }, versions: [visibleNotFitting] }))).toBe(
      'notInTargetFormat',
    );
  });
});

describe('TRANSITIONS: SearchAttempt, Grab and Download', () => {
  test('a SearchAttempt moves from running to picked, noAcceptable or failed, and never back', () => {
    for (const to of ['picked', 'noAcceptable', 'failed'] as const) expect(canTransition('searchAttempt', 'running', to)).toBe(true);
    expect(canTransition('searchAttempt', 'picked', 'running')).toBe(false);
    expect(canTransition('searchAttempt', 'failed', 'picked')).toBe(false);
  });

  test('an interactive attempt is offered instead of picked, and a grab from it picks it', () => {
    expect(canTransition('searchAttempt', 'running', 'offered')).toBe(true);
    expect(canTransition('searchAttempt', 'offered', 'picked')).toBe(true);
    expect(canTransition('searchAttempt', 'offered', 'noAcceptable')).toBe(false);
    expect(canTransition('searchAttempt', 'picked', 'offered')).toBe(false);
  });

  test('a Grab follows submitting → downloading → importing → publishing → done, and any non-final state can fail or be cancelled', () => {
    expect(canTransition('grab', 'submitting', 'downloading')).toBe(true);
    expect(canTransition('grab', 'downloading', 'importing')).toBe(true);
    expect(canTransition('grab', 'importing', 'publishing')).toBe(true);
    expect(canTransition('grab', 'publishing', 'done')).toBe(true);
    expect(canTransition('grab', 'submitting', 'importing')).toBe(false);
    for (const from of ['submitting', 'downloading', 'importing', 'publishing'] as const) {
      expect(canTransition('grab', from, 'failed')).toBe(true);
      expect(canTransition('grab', from, 'cancelled')).toBe(true);
    }
    for (const from of ['done', 'failed', 'cancelled'] as const) expect(canTransition('grab', from, 'failed')).toBe(false);
  });

  test('a Download ends from active, and only a final Download is removed', () => {
    for (const to of ['completed', 'failed', 'stalled', 'removed'] as const) expect(canTransition('download', 'active', to)).toBe(true);
    for (const from of ['completed', 'failed', 'stalled'] as const) expect(canTransition('download', from, 'removed')).toBe(true);
    expect(canTransition('download', 'completed', 'active')).toBe(false);
    expect(canTransition('download', 'removed', 'active')).toBe(false);
  });
});

describe('TRANSITIONS: ImportJob, Rendition and Publication', () => {
  test('an ImportJob moves from pending to recorded, failed or cancelled, and never back', () => {
    for (const to of ['recorded', 'failed', 'cancelled'] as const) expect(canTransition('importJob', 'pending', to)).toBe(true);
    expect(canTransition('importJob', 'recorded', 'pending')).toBe(false);
    expect(canTransition('importJob', 'failed', 'recorded')).toBe(false);
  });

  test('a Rendition moves from pending to done, failed or cancelled, and never back', () => {
    for (const to of ['done', 'failed', 'cancelled'] as const) expect(canTransition('rendition', 'pending', to)).toBe(true);
    expect(canTransition('rendition', 'done', 'cancelled')).toBe(false);
  });

  test('a Publication moves from pending to visible or failed, and back to pending only for a re-publish', () => {
    for (const to of ['visible', 'failed'] as const) expect(canTransition('publication', 'pending', to)).toBe(true);
    // A rename or replacement re-publishes.
    expect(canTransition('publication', 'visible', 'pending')).toBe(true);
    // So does the move of a file Jellyfin misread.
    expect(canTransition('publication', 'failed', 'pending')).toBe(true);
    expect(canTransition('publication', 'failed', 'visible')).toBe(false);
  });
});
