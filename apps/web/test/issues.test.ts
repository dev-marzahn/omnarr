// The Issues page's wording and structure.
import { FailureCode, type IssueList, type IssueRow } from '@omnarr/contracts';
import { describe, expect, test } from 'vite-plus/test';

import {
  actErrorMessage,
  classFilters,
  FIX_LABELS,
  fixConfirm,
  fixToast,
  issueActions,
  issueContext,
  issueExplanation,
  issueItemLink,
  issueTabs,
  issueTitle,
  ISSUES_EMPTY,
  matchesIssueFilter,
} from '../lib/issues';

const row = (overrides: object = {}): IssueRow =>
  ({
    issueId: 'i1',
    scope: 'unit',
    failureCode: 'missingArticles',
    class: 'badRelease',
    state: 'open',
    fixActions: ['tryNextBest', 'searchAndPick', 'retryRelease', 'blocklistRemove', 'dismiss'],
    raisedAt: Date.UTC(2026, 10, 18, 14, 21),
    unit: { unitId: 'u1', workId: 'w1', workTitle: 'The Long Harbor', workKind: 'series', tmdbSeason: 2, tmdbEpisode: 9, title: 'Breakwater' },
    ...overrides,
  }) as IssueRow;
const hhmm = (ms: number) => new Date(ms).toISOString().slice(11, 16);

describe('issueTitle', () => {
  test.each([
    ['missingArticles', 'Missing articles'],
    ['parFailed', 'Repair failed'],
    ['noMediaFile', 'No video file in the download'],
    ['importMismatch', 'Wrong episode in the download'],
    ['transcodeFailed', 'Preparation failed'],
    ['diskFull', 'Not enough free space'],
    ['workflowPaused', 'Run paused after an upgrade'],
    // The same copy as the first-run checklist and System's Jellyfin card.
    ['jellyfinUnavailable', "Jellyfin didn't respond"],
  ] as const)('%s: %s', (code, title) => expect(issueTitle(code)).toBe(title));

  test('every failure code has a title', () => {
    for (const code of FailureCode.options) expect(issueTitle(code), code).not.toBe(code);
  });
});

describe('issueContext: the line above the title', () => {
  test('an episode: the series, its number and title, and since when', () => {
    expect(issueContext(row(), hhmm)).toBe('The Long Harbor · S02E09 Breakwater · since 14:21');
  });

  test('a movie: its title and year, "Movie"', () => {
    const movie = row({ unit: { unitId: 'u2', workId: 'w2', workTitle: 'Northern Line', workKind: 'movie', year: 2023 } });
    expect(issueContext(movie, hhmm)).toBe('Northern Line (2023) · Movie · since 14:21');
  });

  test('a system Issue: since when', () => {
    expect(issueContext(row({ scope: 'system', unit: undefined, failureCode: 'diskFull', class: 'system' }), hhmm)).toBe('since 14:21');
  });
});

test("issueExplanation is the Issue's detail, else a line on what to do", () => {
  expect(issueExplanation(row({ detail: '6.4 % of the articles are missing.' }))).toBe('6.4 % of the articles are missing.');
  expect(issueExplanation(row({ failureCode: 'workerOffline', scope: 'system', class: 'system', fixActions: [] }))).toMatch(/Restart the worker/);
});

describe('issueActions: the first fix is the button, the rest are in "More fixes"', () => {
  test('on the Issues page, "Open timeline" goes before Dismiss', () => {
    expect(issueActions(row())).toEqual({ primary: 'tryNextBest', more: ['searchAndPick', 'retryRelease', 'blocklistRemove', 'openTimeline', 'dismiss'] });
  });

  test('on the item page there is no "Open timeline"', () => {
    expect(issueActions(row(), { onItem: true }).more).toEqual(['searchAndPick', 'retryRelease', 'blocklistRemove', 'dismiss']);
  });

  test('a system Issue has no timeline; one without fixes has no button', () => {
    expect(issueActions(row({ scope: 'system', unit: undefined, fixActions: ['retryNow'] }))).toEqual({ primary: 'retryNow', more: [] });
    expect(issueActions(row({ scope: 'system', unit: undefined, fixActions: [] }))).toEqual({ primary: undefined, more: [] });
  });
});

test('every fix action has its label', () => {
  expect(FIX_LABELS).toMatchObject({
    retryNow: 'Retry now',
    tryNextBest: 'Try next-best release',
    searchAndPick: 'Search and pick',
    retryRelease: 'Retry this release',
    blocklistRemove: 'Unblock release',
    retryPreparation: 'Retry preparation',
    downloadLog: 'Download ffmpeg log',
    rerunJellyfinSetup: 'Set up Jellyfin again',
    resumeRun: 'Resume run',
    cancelRun: 'Cancel run',
    removeClientItem: 'Remove from client',
    removeOrphans: 'Remove the records',
    dismiss: 'Dismiss',
  });
});

test("Remove the records repeats the Issue's detail and says nothing on disk or in the client changes", () => {
  const leftovers = row({
    scope: 'system',
    unit: undefined,
    failureCode: 'orphanAfterDelete',
    detail: 'A deleted series or movie left 1 job that never ended.',
  });
  expect(fixConfirm('removeOrphans', leftovers)).toEqual({
    title: 'Remove the leftover records?',
    description: 'A deleted series or movie left 1 job that never ended. omnarr deletes them now, finished or not.',
    note: 'Files on disk and items in the download client stay as they are.',
    confirm: 'Remove the records',
    destructive: true,
  });
});

describe('fixConfirm: the fixes that ask before they run', () => {
  test('Try next-best says what happens without naming a release', () => {
    const confirm = fixConfirm('tryNextBest', row())!;
    expect(confirm).toMatchObject({ title: 'Try the next-best release?', confirm: 'Try next-best release' });
    expect(confirm.description).toBe(
      "omnarr searches your indexers again and grabs the best release for S02E09 that isn't blocklisted. That starts a new run.",
    );
    expect(confirm.note).toBe('The failed releases stay blocklisted. The Issue moves to In progress and closes when the new run succeeds.');
  });

  test('on a missing file it is a plain search again, with no blocklist', () => {
    const confirm = fixConfirm('tryNextBest', row({ failureCode: 'fileMissing' }))!;
    expect(confirm).toMatchObject({ title: 'Search again?', confirm: 'Search again' });
    expect(confirm.description).toBe('omnarr searches your indexers and grabs the best release for S02E09. That starts a new run.');
  });

  test('Retry this release names it; Remove from client names the items', () => {
    expect(fixConfirm('retryRelease', row({ release: 'The.Long.Harbor.S02E09-GRPA' }))!.description).toContain('The.Long.Harbor.S02E09-GRPA');
    const orphan = row({ scope: 'system', unit: undefined, failureCode: 'orphanClientItem', detail: 'nzbget 41: Stray.Show.S01E01' });
    expect(fixConfirm('removeClientItem', orphan)).toMatchObject({
      title: 'Remove from the download client?',
      description: expect.stringContaining('Stray.Show.S01E01'),
    });
    expect(fixConfirm('cancelRun', row({ failureCode: 'workflowPaused' }))).toMatchObject({ confirm: 'Cancel run', destructive: true });
  });

  test('the others run at once', () => {
    for (const action of ['retryNow', 'blocklistRemove', 'retryPreparation', 'dismiss', 'resumeRun', 'downloadLog'] as const)
      expect(fixConfirm(action, row())).toBeUndefined();
  });
});

test('fixToast says what happens next', () => {
  expect(fixToast('tryNextBest')).toBe('Searching for the next-best release · a new run starts when one is found');
  expect(fixToast('dismiss')).toBe('Issue dismissed');
});

test("actErrorMessage reads the backend's reason", () => {
  expect(actErrorMessage({ data: 'The episode already has a running grab. Cancel that grab first.' })).toBe(
    'The episode already has a running grab. Cancel that grab first.',
  );
  expect(actErrorMessage(new Error('network'))).toBe('Try again.');
});

test('issueItemLink: an episode opens its item page, a movie its Work page; a system Issue has none', () => {
  expect(issueItemLink(row())).toBe('/items/u1');
  expect(issueItemLink(row({ unit: { unitId: 'u2', workId: 'w2', workTitle: 'N', workKind: 'movie' } }))).toBe('/library/w2');
  expect(issueItemLink(row({ scope: 'system', unit: undefined }))).toBeUndefined();
});

describe('tabs and filters', () => {
  const list: IssueList = {
    needsAction: [row(), row({ issueId: 'i2', failureCode: 'transcodeFailed', class: 'preparation' })],
    inProgress: [row({ issueId: 'i3', inProgress: { stage: 'downloading' } })],
    system: [row({ issueId: 'i4', scope: 'system', unit: undefined, failureCode: 'diskFull', class: 'system' })],
    resolved: [],
  };

  test('the tabs with their counts; Needs action and System in red', () => {
    expect(issueTabs(list).map(({ value, label, count, color }) => ({ value, label, count, color }))).toEqual([
      { value: 'needsAction', label: 'Needs action', count: 2, color: 'error' },
      { value: 'inProgress', label: 'In progress', count: 1, color: 'neutral' },
      { value: 'system', label: 'System', count: 1, color: 'error' },
      { value: 'resolved', label: 'Resolved & dismissed', count: undefined, color: 'neutral' },
    ]);
  });

  test('the class filter counts the rows of the tab; Run is the run errors of a Unit', () => {
    expect(classFilters(list.needsAction).map(({ value, count }) => [value, count])).toEqual([
      ['all', 2],
      ['badRelease', 1],
      ['preparation', 1],
      ['transient', 0],
      ['run', 0],
    ]);
    expect(matchesIssueFilter(row({ failureCode: 'pipelineError', class: 'system' }), 'run', '')).toBe(true);
    expect(matchesIssueFilter(row(), 'preparation', '')).toBe(false);
  });

  test('the text filter matches the title, the episode and the release', () => {
    expect(matchesIssueFilter(row(), 'all', 'long har')).toBe(true);
    expect(matchesIssueFilter(row(), 'all', 's02e09')).toBe(true);
    expect(matchesIssueFilter(row({ release: 'GRPA' }), 'all', 'grpa')).toBe(true);
    expect(matchesIssueFilter(row(), 'all', 'orchard')).toBe(false);
  });
});

test('the empty state', () => {
  expect(ISSUES_EMPTY).toEqual({ title: 'No issues', description: "Failures that fix themselves show only on the item's timeline." });
});
