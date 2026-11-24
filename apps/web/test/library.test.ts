// The library page: the view, filter and search in the URL, and a Work's status line.
import type { WorkSummary } from '@omnarr/contracts';
import { describe, expect, test } from 'vite-plus/test';

import { alreadySearchingToast, libraryQuery, libraryState, workLine } from '../lib/library';

describe('alreadySearchingToast', () => {
  test('nothing when no episode was skipped', () => {
    expect(alreadySearchingToast(0, 'series')).toBeUndefined();
  });

  test('counts the episodes it skipped, and names a movie as the movie', () => {
    expect(alreadySearchingToast(1, 'series')?.title).toBe('1 episode is already being searched');
    expect(alreadySearchingToast(12, 'series')?.title).toBe('12 episodes are already being searched');
    expect(alreadySearchingToast(1, 'movie')?.title).toBe('The movie is already being searched');
  });
});

describe('libraryState and libraryQuery', () => {
  test('defaults: grid, all, no search', () => {
    expect(libraryState({})).toEqual({ view: undefined, filter: 'all', q: '' });
  });

  test('read from the query; unknown values fall back', () => {
    expect(libraryState({ view: 'list', filter: 'missing', q: 'harbor' })).toEqual({ view: 'list', filter: 'missing', q: 'harbor' });
    expect(libraryState({ view: 'tiles', filter: 'everything', q: ['a', 'b'] })).toEqual({ view: undefined, filter: 'all', q: '' });
  });

  test('written back without the defaults, keeping other parameters such as kind', () => {
    expect(libraryQuery({ kind: 'movies' }, { view: 'list', filter: 'issues', q: 'orbit' })).toEqual({
      kind: 'movies',
      view: 'list',
      filter: 'issues',
      q: 'orbit',
    });
    expect(libraryQuery({ kind: 'movies', view: 'list', q: 'x' }, { view: 'grid', filter: 'all', q: '  ' })).toEqual({ kind: 'movies' });
  });
});

const work = (overrides: Partial<WorkSummary> = {}): WorkSummary =>
  ({
    workId: 'w1',
    libraryId: 'l1',
    kind: 'series',
    title: 'The Long Harbor',
    numberingScheme: 'standard',
    releaseProfileId: 'p1',
    monitorNewUnits: true,
    units: 30,
    monitored: 30,
    present: 22,
    states: [],
    openIssues: 0,
    ...overrides,
  }) as WorkSummary;

describe('workLine', () => {
  test('ready of monitored', () => {
    expect(
      workLine(
        work({
          states: [
            { state: 'ready', count: 22 },
            { state: 'wanted', count: 8 },
          ],
        }),
      ),
    ).toEqual({ line: '22 of 30 ready' });
  });

  test('every monitored one present, some not in target format', () => {
    expect(
      workLine(
        work({
          monitored: 22,
          present: 22,
          states: [
            { state: 'ready', count: 20 },
            { state: 'notInTargetFormat', count: 2 },
          ],
        }),
      ),
    ).toEqual({ line: '22 of 22 · 2 not in target format' });
  });

  test('open issues, counted, beside the line', () => {
    expect(workLine(work({ openIssues: 1 }))).toEqual({ issues: '1 issue', line: '22 of 30 ready' });
    expect(workLine(work({ openIssues: 2 })).issues).toBe('2 issues');
  });

  test('nothing present yet: what it is searching for', () => {
    expect(workLine(work({ monitored: 6, present: 0, states: [{ state: 'wanted', count: 6 }] }))).toEqual({ line: 'Searching for 6 episodes' });
    expect(workLine(work({ monitored: 1, present: 0, states: [{ state: 'searching', count: 1 }] })).line).toBe('Searching for 1 episode');
  });

  test('none monitored: how many it has, and that it is not monitored', () => {
    expect(workLine(work({ units: 24, monitored: 0, present: 0, states: [{ state: 'notMonitored', count: 24 }] }))).toEqual({
      line: '24 episodes · not monitored',
    });
  });

  test('a movie: its state', () => {
    expect(workLine(work({ kind: 'movie', units: 1, monitored: 1, present: 0, states: [{ state: 'downloading', count: 1 }] }))).toEqual({
      line: 'Downloading',
    });
    expect(workLine(work({ kind: 'movie', units: 1, monitored: 0, present: 0, states: [{ state: 'notMonitored', count: 1 }] }))).toEqual({
      line: 'Not monitored',
    });
  });
});
