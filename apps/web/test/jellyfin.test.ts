// "Open in Jellyfin": the origin the user's device reaches, and the item link;
// the fixes offered for Jellyfin Issues.
import type { IssueList, IssueRow } from '@omnarr/contracts';
import { describe, expect, test } from 'vite-plus/test';

import { jellyfinActions, jellyfinCardActions, jellyfinItemUrl } from '../lib/jellyfin';

describe("jellyfinActions: each code's fixes, shared by the first-run checklist and System's Jellyfin card", () => {
  test('a setup or password Issue offers "Set up Jellyfin again", which opens the password dialog', () => {
    for (const code of ['jellyfinSetupNeeded', 'jellyfinPasswordNotPushed'] as const)
      expect(jellyfinActions(code)).toEqual([{ action: 'rerunJellyfinSetup', label: 'Set up Jellyfin again' }]);
  });

  test('Jellyfin not answering offers only "Retry now"', () => {
    expect(jellyfinActions('jellyfinUnavailable')).toEqual([{ action: 'retryNow', label: 'Retry now' }]);
  });

  test('any other code offers nothing here', () => {
    expect(jellyfinActions('diskFull')).toEqual([]);
    expect(jellyfinActions('jellyfinMisread')).toEqual([]);
  });
});

describe("jellyfinCardActions: System's Jellyfin card follows the open Jellyfin Issues", () => {
  const issue = (issueId: string, failureCode: IssueRow['failureCode'], scope: IssueRow['scope'] = 'unit') => ({ issueId, failureCode, scope }) as IssueRow;
  const list = (rows: Partial<IssueList>): IssueList => ({ needsAction: [], inProgress: [], system: [], resolved: [], ...rows });

  test('no Jellyfin Issue open: no button', () => {
    expect(jellyfinCardActions(list({ system: [issue('d', 'diskFull', 'system')] }))).toEqual([]);
  });

  test('a setup Issue: "Set up Jellyfin again" once', () => {
    expect(jellyfinCardActions(list({ system: [issue('s', 'jellyfinSetupNeeded', 'system'), issue('p', 'jellyfinPasswordNotPushed', 'system')] }))).toEqual([
      { action: 'rerunJellyfinSetup', label: 'Set up Jellyfin again', issueIds: ['s', 'p'] },
    ]);
  });

  test('Jellyfin not answering on two episodes: one "Retry now" for both Issues', () => {
    expect(
      jellyfinCardActions(list({ needsAction: [issue('a', 'jellyfinUnavailable'), issue('m', 'missingArticles'), issue('b', 'jellyfinUnavailable')] })),
    ).toEqual([{ action: 'retryNow', label: 'Retry now', issueIds: ['a', 'b'] }]);
  });
});

test("jellyfinItemUrl puts the origin in front of the backend's item path", () => {
  expect(jellyfinItemUrl('http://192.168.1.20:8096', '/web/#/details?id=abc&serverId=s1')).toBe('http://192.168.1.20:8096/web/#/details?id=abc&serverId=s1');
});
