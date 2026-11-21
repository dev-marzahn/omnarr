// The Work page's state bar and its rows' one action.
import type { StateCount, UnitRow } from '@omnarr/contracts';
import { describe, expect, test } from 'vite-plus/test';

import { stateBarSegments, unitDetail, unitRowAction, upgradingTag } from '../lib/unitStates';

describe('stateBarSegments', () => {
  test("in UnitState's order, each with its share", () => {
    const states: StateCount[] = [
      { state: 'wanted', count: 2 },
      { state: 'ready', count: 9 },
      { state: 'failed', count: 1 },
      { state: 'downloading', count: 4 },
      { state: 'notInTargetFormat', count: 1 },
      { state: 'preparing', count: 1 },
    ];
    expect(stateBarSegments(states).map((s) => [s.state, s.count])).toEqual([
      ['failed', 1],
      ['downloading', 4],
      ['preparing', 1],
      ['ready', 9],
      ['notInTargetFormat', 1],
      ['wanted', 2],
    ]);
  });

  test('each segment has the colour of its state', () => {
    const colours = stateBarSegments([
      { state: 'ready', count: 1 },
      { state: 'failed', count: 1 },
      { state: 'preparing', count: 1 },
      { state: 'searching', count: 1 },
      { state: 'notInTargetFormat', count: 1 },
      { state: 'wanted', count: 1 },
    ]).map((s) => [s.state, s.color]);
    expect(colours).toEqual([
      ['failed', 'error'],
      ['preparing', 'secondary'],
      ['ready', 'success'],
      ['notInTargetFormat', 'warning'],
      ['searching', 'info'],
      ['wanted', 'neutral'],
    ]);
  });

  test('Not aired and Not monitored are left out', () => {
    expect(
      stateBarSegments([
        { state: 'notMonitored', count: 7 },
        { state: 'ready', count: 3 },
        { state: 'notAired', count: 2 },
      ]).map((s) => s.state),
    ).toEqual(['ready']);
  });

  test('a Work with none monitored has no segment', () => {
    expect(stateBarSegments([{ state: 'notMonitored', count: 24 }])).toEqual([]);
  });
});

const unit = (overrides: Partial<UnitRow> = {}): UnitRow =>
  ({
    unitId: 'u1',
    kind: 'episode',
    tmdbSeason: 1,
    tmdbEpisode: 1,
    monitored: true,
    state: 'wanted',
    cancelRequested: false,
    ...overrides,
  }) as UnitRow;

const kinds = (action: ReturnType<typeof unitRowAction>) => ({ primary: action.primary?.kind, menu: action.menu.map((item) => item.kind) });

test('unitDetail: a search that left releases of unclear numbering counts them', () => {
  const at = Date.UTC(2026, 10, 18, 4, 0);
  const detail = unitDetail(unit({ lastSearch: { at, outcome: 'noAcceptable', unclearCount: 3 } }))!;
  expect(detail).toMatch(/^Last search .+: no acceptable release · 3 with unclear numbering$/);
  expect(unitDetail(unit({ lastSearch: { at, outcome: 'noAcceptable', unclearCount: 0 } }))).not.toContain('unclear');
});

test('upgradingTag: a ready Unit with an upgrade Grab shows "Upgrading" and its stage', () => {
  expect(upgradingTag(unit({ state: 'ready', upgrading: { grabId: 'g1' as never, stage: 'downloading' } }))).toBe('Upgrading · downloading');
  expect(upgradingTag(unit({ state: 'ready', upgrading: { grabId: 'g1' as never, stage: 'repairUnpack' } }))).toBe('Upgrading · repair / unpack');
  expect(upgradingTag(unit({ state: 'ready' }))).toBeUndefined();
});

describe('unitRowAction: one visible action per state, the rest in "…"', () => {
  test('wanted: Search now, with Search and pick in "…"', () => {
    expect(kinds(unitRowAction(unit()))).toEqual({ primary: 'searchNow', menu: ['searchAndPick', 'openItem', 'stopMonitoring'] });
  });

  test('wanted after a search that left releases of unclear numbering: Search and pick', () => {
    const action = unitRowAction(unit({ lastSearch: { at: 1, outcome: 'noAcceptable', unclearCount: 3 } }));
    expect(kinds(action)).toEqual({ primary: 'searchAndPick', menu: ['searchNow', 'openItem', 'stopMonitoring'] });
    expect(action.primary?.label).toBe('Search and pick');
  });

  test('failed: Fix…, with Search now and Search and pick in "…"', () => {
    const action = unitRowAction(unit({ state: 'failed', openIssue: { issueId: 'i1', failureCode: 'missingArticles' } as UnitRow['openIssue'] }));
    expect(kinds(action)).toEqual({ primary: 'fix', menu: ['searchNow', 'searchAndPick', 'openItem', 'stopMonitoring'] });
    expect(action.primary?.label).toBe('Fix…');
  });

  test('ready in Jellyfin: Open in Jellyfin; without a Jellyfin item, none', () => {
    expect(kinds(unitRowAction(unit({ state: 'ready', jellyfinItemPath: '/web/#/details?id=x' })))).toEqual({
      primary: 'jellyfin',
      menu: ['openItem', 'stopMonitoring'],
    });
    expect(kinds(unitRowAction(unit({ state: 'ready' })))).toEqual({ primary: undefined, menu: ['openItem', 'stopMonitoring'] });
  });

  test('a playable Unit with an open Issue: Open issue', () => {
    expect(
      kinds(
        unitRowAction(
          unit({
            state: 'notInTargetFormat',
            jellyfinItemPath: '/x',
            openIssue: { issueId: 'i1', failureCode: 'transcodeFailed' } as UnitRow['openIssue'],
          }),
        ),
      ),
    ).toEqual({ primary: 'openIssue', menu: ['prepareNow', 'jellyfin', 'openItem', 'stopMonitoring'] });
  });

  test('not in target format: Prepare now is in "…", Jellyfin is the action', () => {
    expect(kinds(unitRowAction(unit({ state: 'notInTargetFormat', jellyfinItemPath: '/x' })))).toEqual({
      primary: 'jellyfin',
      menu: ['prepareNow', 'openItem', 'stopMonitoring'],
    });
  });

  test('preparing: Cancel, which cancels the preparation', () => {
    expect(kinds(unitRowAction(unit({ state: 'preparing' })))).toEqual({ primary: 'cancelPreparation', menu: ['openItem', 'stopMonitoring'] });
  });

  test('a running grab with its Download on the row: Cancel', () => {
    for (const state of ['grabbed', 'downloading', 'repairUnpack'] as const)
      expect(kinds(unitRowAction(unit({ state, download: { grabId: 'g1', protocol: 'usenet', stage: 'downloading' } as UnitRow['download'] })))).toEqual({
        primary: 'cancelGrab',
        menu: ['openItem', 'stopMonitoring'],
      });
  });

  test("a running grab without its Grab on the row: the item page's Cancel grab", () => {
    for (const state of ['grabbed', 'downloading', 'repairUnpack'] as const)
      expect(kinds(unitRowAction(unit({ state })))).toEqual({ primary: undefined, menu: ['openItem', 'stopMonitoring'] });
  });

  test('cancelling, importing and searching: no action', () => {
    expect(kinds(unitRowAction(unit({ state: 'downloading', cancelRequested: true }))).primary).toBeUndefined();
    expect(kinds(unitRowAction(unit({ state: 'importing' })))).toEqual({ primary: undefined, menu: ['openItem', 'stopMonitoring'] });
    expect(kinds(unitRowAction(unit({ state: 'searching' })))).toEqual({ primary: undefined, menu: ['openItem', 'stopMonitoring'] });
  });

  test('not monitored: Monitor in "…"; not aired: nothing to do', () => {
    expect(kinds(unitRowAction(unit({ state: 'notMonitored', monitored: false })))).toEqual({ primary: undefined, menu: ['openItem', 'monitor'] });
    expect(kinds(unitRowAction(unit({ state: 'notAired' })))).toEqual({ primary: undefined, menu: ['openItem', 'stopMonitoring'] });
  });
});
